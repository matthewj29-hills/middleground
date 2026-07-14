// Live integration tests against the real Groq API.
// Run only when GROQ_KEY is provided; excluded from the default suite.
import { describe, it, expect } from 'vitest';
import { screenClaims, verifyClaim, passesScreen, decide, DEFAULT_GATE } from '../src/ai/factcheck';
import { answerQuestion } from '../src/ai/min';
import { generateReport } from '../src/ai/report';
import type { Turn } from '../src/types';

const KEY = (globalThis as any).process?.env?.GROQ_KEY ?? '';
const d = describe.skipIf(!KEY);

const conversation: Turn[] = [
  { id: '1', speaker: 1, text: "I just think we spend way too much on foreign aid. It's like a quarter of the federal budget.", ts: 1 },
  { id: '2', speaker: 2, text: "That's not even close. I think it's around one percent. And in my opinion it's worth every penny.", ts: 2 },
  { id: '3', speaker: 1, text: "Well I still think charity should start at home. We have homeless veterans here.", ts: 3 },
  { id: '4', speaker: 2, text: "I agree we should take care of veterans. That's not mutually exclusive though.", ts: 4 }
];

d('live: claim screening', () => {
  it('flags the false budget claim, not the opinions', async () => {
    const seg = conversation.map(t => `Speaker ${t.speaker}: ${t.text}`).join('\n');
    const claims = await screenClaims(KEY, seg);
    const flagged = claims.filter(passesScreen);
    expect(flagged.length).toBeGreaterThanOrEqual(1);
    expect(flagged.some(c => /quarter|25|foreign aid/i.test(c.claim))).toBe(true);
    // opinions must not be flagged
    expect(flagged.some(c => /charity should start at home|worth every penny/i.test(c.claim))).toBe(false);
  }, 60_000);

  it('does not flag true or opinion-only segments', async () => {
    const claims = await screenClaims(KEY, 'Speaker 1: Water boils at 100 degrees Celsius at sea level.\nSpeaker 2: I love hiking, best hobby ever in my opinion.');
    expect(claims.filter(passesScreen).length).toBe(0);
  }, 60_000);
});

d('live: verification + gate', () => {
  it('verifies a clearly false claim with sources and would speak', async () => {
    const v = await verifyClaim(KEY, 'Foreign aid is about a quarter of the US federal budget');
    expect(['false', 'misleading']).toContain(v.verdict);
    expect(v.confidence).toBeGreaterThanOrEqual(0.8);
    expect(v.correction.length).toBeGreaterThan(20);
    const decision = decide(v, { lastInterruptTs: 0, checkedClaims: [], processing: false }, DEFAULT_GATE, Date.now(), 0, false);
    expect(['speak', 'notice']).toContain(decision);
  }, 90_000);

  it('does not condemn a true claim', async () => {
    const v = await verifyClaim(KEY, 'The Earth orbits the Sun');
    expect(['true', 'unverified']).toContain(v.verdict);
  }, 90_000);
});

d('live: Min Q&A', () => {
  const ctx = 'Recent transcript:\n' + conversation.map(t => `Speaker ${t.speaker}: ${t.text}`).join('\n');
  it('answers a context question', async () => {
    const a = await answerQuestion(KEY, 'What did Speaker 1 say foreign aid costs?', ctx);
    expect(a.text.toLowerCase()).toMatch(/quarter|25/);
  }, 60_000);
  it('answers a current-info question with sources', async () => {
    const a = await answerQuestion(KEY, 'What is the current US federal minimum wage right now?', ctx);
    expect(a.text.length).toBeGreaterThan(10);
    expect(a.sources.length).toBeGreaterThan(0);
  }, 90_000);
});

d('live: report', () => {
  it('generates a fair common-ground report', async () => {
    const r = await generateReport(KEY, conversation, '');
    expect(r.summary.length).toBeGreaterThan(20);
    expect(r.agreements.length).toBeGreaterThan(0); // veterans agreement should be caught
    expect(r.coreDisagreement.length).toBeGreaterThan(10);
    expect(JSON.stringify(r).toLowerCase()).not.toMatch(/winner|won the/);
  }, 90_000);
});
