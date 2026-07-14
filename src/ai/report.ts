// Post-conversation common-ground report.

import { chat, REASON_MODEL } from './groq';
import type { Report, Turn } from '../types';
import { formatTurns } from '../core/context';

const REPORT_SYSTEM = `You produce a short post-conversation "common ground" report for the app MiddleGround. Speaker labels come from an imperfect heuristic — hedge attributions when the transcript is ambiguous. Never declare a winner, never grade anyone, never moralize. Be fair to every speaker; do not exaggerate or invent positions. Keep every item short — people should actually read this.

Respond ONLY with JSON:
{
 "summary": "2-3 sentences: what the conversation was about",
 "viewpoints": ["Speaker 1: ...", "Speaker 2: ..."],
 "agreements": ["shared beliefs, concerns, goals, or values — including agreement hidden by different wording"],
 "verifiedFacts": [{"fact":"...","source":"source name or url, omit if none"}],
 "disputed": ["claims that could not be settled, with what would resolve them"],
 "misunderstandings": ["different definitions, mishearings, talking past each other — [] if none"],
 "coreDisagreement": "the clearest underlying form of the disagreement (values? predictions? definitions? an open factual question?); name multiple if genuinely multiple",
 "commonGround": "1-3 sentences of realistic common ground without pretending disagreement vanished",
 "takeaways": ["2-4 useful next thoughts or clarifying questions"]
}
Every array may be empty if the conversation doesn't support it. Do not fabricate.`;

export async function generateReport(
  key: string,
  turns: Turn[],
  contextSummary: string
): Promise<Report> {
  if (!key) return basicReport(turns, 'No Groq key is set, so this is a basic structural summary rather than a full analysis. Add a free key in Settings for complete reports.');

  const transcript = (contextSummary ? `Summary of earlier part:\n${contextSummary}\n\n` : '') +
    `Transcript:\n${formatTurns(turns)}`;
  try {
    const r = await chat(key, REASON_MODEL, [
      { role: 'system', content: REPORT_SYSTEM },
      { role: 'user', content: transcript }
    ], { json: true, maxTokens: 1800, temperature: 0.2 });
    const d = JSON.parse(r.text);
    return {
      summary: str(d.summary),
      viewpoints: arr(d.viewpoints),
      agreements: arr(d.agreements),
      verifiedFacts: Array.isArray(d.verifiedFacts)
        ? d.verifiedFacts.filter((f: any) => f && typeof f.fact === 'string')
            .map((f: any) => ({ fact: f.fact, source: typeof f.source === 'string' && f.source ? f.source : undefined }))
        : [],
      disputed: arr(d.disputed),
      misunderstandings: arr(d.misunderstandings),
      coreDisagreement: str(d.coreDisagreement),
      commonGround: str(d.commonGround),
      takeaways: arr(d.takeaways)
    };
  } catch {
    return basicReport(turns, 'The AI summary could not be generated (service unreachable or rate-limited). This is a basic structural summary instead — the full transcript is intact.');
  }
}

function str(v: any): string { return typeof v === 'string' ? v : ''; }
function arr(v: any): string[] {
  return Array.isArray(v) ? v.filter((x: any) => typeof x === 'string' && x.trim()) : [];
}

/** Honest no-LLM fallback: structure only, no invented analysis. */
export function basicReport(turns: Turn[], degraded: string): Report {
  const speakers = new Set(turns.filter(t => t.speaker !== 'min').map(t => t.speaker));
  const minAnswers = turns.filter(t => t.speaker === 'min' && t.kind === 'answer').length;
  const corrections = turns.filter(t => t.speaker === 'min' && t.kind === 'correction').length;
  const words = turns.filter(t => t.speaker !== 'min').reduce((n, t) => n + t.text.split(/\s+/).length, 0);
  return {
    summary: `A conversation with ${speakers.size || 1} identified speaker${speakers.size === 1 ? '' : 's'}, about ${words} words spoken. Min answered ${minAnswers} question${minAnswers === 1 ? '' : 's'} and made ${corrections} factual correction${corrections === 1 ? '' : 's'}.`,
    viewpoints: [],
    agreements: [],
    verifiedFacts: [],
    disputed: [],
    misunderstandings: [],
    coreDisagreement: '',
    commonGround: '',
    takeaways: ['Read the full transcript to revisit the discussion.'],
    degraded
  };
}
