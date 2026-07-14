// Conservative automatic fact-checking pipeline.
//
// Stage 1 (screen): batch recent utterances → classify which sentences are
//   concrete, material, checkable factual claims that are likely false.
// Stage 2 (verify): for flagged claims only, search the live web and judge
//   against evidence.
// Gate: speak only when verdict is false/misleading AND confidence ≥ 0.85,
//   with cooldowns and duplicate suppression. 0.70–0.85 → silent visual note.
// False positives are worse than missed corrections.

import { chat, REASON_MODEL, SEARCH_MODEL } from './groq';
import type { ClaimVerdict } from '../types';

export interface GateState {
  lastInterruptTs: number;
  checkedClaims: string[]; // normalized claims already handled
  processing: boolean;
}

export interface GateConfig {
  interruptCooldownMs: number;
  speakThreshold: number;
  noticeThreshold: number;
  maxInterruptsPerSession: number;
}

export const DEFAULT_GATE: GateConfig = {
  interruptCooldownMs: 90_000,
  speakThreshold: 0.85,
  noticeThreshold: 0.7,
  maxInterruptsPerSession: 6
};

export function normalizeClaim(c: string): string {
  return c.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function isDuplicate(claim: string, checked: string[]): boolean {
  const n = normalizeClaim(claim);
  if (!n) return true;
  const nWords = new Set(n.split(' '));
  for (const prev of checked) {
    const pWords = prev.split(' ');
    if (pWords.length === 0) continue;
    let overlap = 0;
    for (const w of pWords) if (nWords.has(w)) overlap++;
    if (overlap / Math.max(pWords.length, nWords.size) > 0.6) return true;
  }
  return false;
}

export type GateDecision = 'speak' | 'notice' | 'ignore';

/** Final decision gate — pure and unit-testable. */
export function decide(
  verdict: ClaimVerdict,
  gate: GateState,
  cfg: GateConfig,
  now: number,
  interruptCount: number,
  minBusy: boolean
): GateDecision {
  if (verdict.verdict !== 'false' && verdict.verdict !== 'misleading') return 'ignore';
  if (isDuplicate(verdict.claim, gate.checkedClaims)) return 'ignore';
  if (verdict.confidence >= cfg.speakThreshold) {
    const cooled = now - gate.lastInterruptTs >= cfg.interruptCooldownMs;
    const underCap = interruptCount < cfg.maxInterruptsPerSession;
    if (cooled && underCap && !minBusy) return 'speak';
    return 'notice';
  }
  if (verdict.confidence >= cfg.noticeThreshold) return 'notice';
  return 'ignore';
}

// ── Stage 1: screening ──────────────────────────────────────────
const SCREEN_SYSTEM = `You screen live conversation transcript segments for factual claims worth checking. Respond ONLY with JSON: {"claims":[{"claim":"...","checkable":bool,"material":bool,"likely_false":bool,"confidence":0..1}]}

A claim qualifies ONLY if it is a concrete, verifiable, factual assertion (statistics, historical events, scientific facts, laws, prices, records). These NEVER qualify: opinions, value judgments, predictions, preferences, hypotheticals, sarcasm, exaggeration for effect, personal experiences, vague generalities, minor wording slips.
Set likely_false=true only when you have strong reason to believe the assertion is false or materially misleading as stated. When unsure, set likely_false=false. Return {"claims":[]} when nothing qualifies. Extract at most 2 claims.`;

export interface ScreenedClaim {
  claim: string; checkable: boolean; material: boolean; likely_false: boolean; confidence: number;
}

export async function screenClaims(key: string, segment: string): Promise<ScreenedClaim[]> {
  const r = await chat(key, REASON_MODEL, [
    { role: 'system', content: SCREEN_SYSTEM },
    { role: 'user', content: `Transcript segment:\n${segment}` }
  ], { json: true, maxTokens: 400, temperature: 0 });
  try {
    const data = JSON.parse(r.text);
    const arr = Array.isArray(data?.claims) ? data.claims : [];
    return arr.filter((c: any) => typeof c?.claim === 'string' && c.claim.length > 8)
      .map((c: any) => ({
        claim: c.claim,
        checkable: Boolean(c.checkable),
        material: Boolean(c.material),
        likely_false: Boolean(c.likely_false),
        confidence: Number(c.confidence) || 0
      }));
  } catch { return []; }
}

export function passesScreen(c: ScreenedClaim): boolean {
  return c.checkable && c.material && c.likely_false && c.confidence >= 0.6;
}

// ── Stage 2: verification with live evidence ────────────────────
const VERIFY_SYSTEM = `You are a careful fact-checker. Verify the claim using web search. Then respond ONLY with JSON:
{"verdict":"false"|"misleading"|"true"|"unverified","confidence":0..1,"correction":"one or two calm sentences correcting or contextualizing the claim, phrased like 'A quick factual note: ...' — never accusatory, never 'you are wrong'"}
Rules: verdict "false" or "misleading" requires clear, well-sourced evidence. If sources disagree or evidence is thin, use "unverified" with low confidence. Distinguish what is known from what is disputed.`;

export async function verifyClaim(key: string, claim: string, signal?: AbortSignal): Promise<ClaimVerdict> {
  const r = await chat(key, SEARCH_MODEL, [
    { role: 'system', content: VERIFY_SYSTEM },
    { role: 'user', content: `Claim made in conversation: "${claim}"` }
  ], { maxTokens: 700, temperature: 0, signal });
  let parsed: any = null;
  try {
    const m = r.text.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch { /* fall through */ }
  const verdict = ['false', 'misleading', 'true', 'unverified'].includes(parsed?.verdict) ? parsed.verdict : 'unverified';
  return {
    claim,
    verdict,
    confidence: Math.max(0, Math.min(1, Number(parsed?.confidence) || 0)),
    correction: typeof parsed?.correction === 'string' ? parsed.correction : '',
    sources: r.sources
  };
}

// Fallback verification without live search (used when the search model is
// throttled). Extra-conservative: only well-established knowledge may yield
// a false/misleading verdict, and no sources are attached.
const VERIFY_OFFLINE_SYSTEM = `You are a careful fact-checker working WITHOUT live web access. Judge the claim against well-established knowledge only. Respond ONLY with JSON:
{"verdict":"false"|"misleading"|"true"|"unverified","confidence":0..1,"correction":"one or two calm sentences, phrased like 'A quick factual note: ...' — never accusatory"}
Only use "false" or "misleading" for claims contradicted by thoroughly established, uncontroversial knowledge (basic science, geography, math, well-documented history). For anything recent, statistical, close, or possibly changed, use "unverified" with low confidence.`;

export async function verifyClaimOffline(key: string, claim: string, signal?: AbortSignal): Promise<ClaimVerdict> {
  const r = await chat(key, REASON_MODEL, [
    { role: 'system', content: VERIFY_OFFLINE_SYSTEM },
    { role: 'user', content: `Claim made in conversation: "${claim}"` }
  ], { json: true, maxTokens: 300, temperature: 0, signal });
  let parsed: any = null;
  try { parsed = JSON.parse(r.text); } catch { /* fall through */ }
  const verdict = ['false', 'misleading', 'true', 'unverified'].includes(parsed?.verdict) ? parsed.verdict : 'unverified';
  return {
    claim,
    verdict,
    confidence: Math.max(0, Math.min(1, Number(parsed?.confidence) || 0)),
    correction: typeof parsed?.correction === 'string' ? parsed.correction : '',
    sources: []
  };
}
