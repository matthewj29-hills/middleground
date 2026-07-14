// Min's question-answering. Routes between the reasoning model, the
// live-search model (for current-information questions), and an honest
// Wikipedia-retrieval fallback when no Groq key is configured.

import { chat, GroqError, REASON_MODEL, SEARCH_MODEL } from './groq';
import type { GroqResult } from './groq';
import type { SourceRef } from '../types';

const MIN_SYSTEM = `You are Min, a calm, neutral conversation companion inside the app MiddleGround. You are listening to a live conversation between people (labeled Speaker 1, Speaker 2, ...). Speaker labels come from an imperfect heuristic, so treat attributions as approximate and say so if it matters.

Rules:
- Be concise: 1-4 sentences unless the question truly needs more. Your answer is read aloud.
- Apply the same evidentiary standard to every speaker. Never pick a winner.
- Separate facts from values. Say "I don't know" when evidence is insufficient.
- Use calibrated language ("the evidence suggests", "this is disputed") rather than false certainty.
- Never moralize about or judge the participants.
- If asked about the conversation, ground your answer in the transcript context you were given.`;

/** Heuristic: does this question need live/current information? */
export function needsSearch(q: string): boolean {
  const s = q.toLowerCase();
  const timely = /\b(current|currently|latest|today|tonight|yesterday|this (week|month|year)|right now|recent|recently|news|update)\b/;
  const volatile = /\b(price|prices|cost|rate|rates|inflation|stock|score|weather|poll|polls|election|president|prime minister|ceo|champion|record high|market)\b/;
  const year = /\b(202[4-9]|20[3-9]\d)\b/;
  const search = /\b(search|look (it |that )?up|google|find (out|the latest))\b/;
  return search.test(s) || timely.test(s) || volatile.test(s) || year.test(s);
}

export interface MinAnswer {
  text: string;
  sources: SourceRef[];
  degraded?: string; // honest note when a fallback was used
}

export async function answerQuestion(
  key: string,
  question: string,
  context: string,
  signal?: AbortSignal
): Promise<MinAnswer> {
  if (!key) return wikipediaFallback(question, signal);

  const wantSearch = needsSearch(question);
  const messages = [
    { role: 'system' as const, content: MIN_SYSTEM },
    { role: 'user' as const, content: `${context}\n\nA participant asks Min: "${question}"\n\nAnswer as Min.` }
  ];

  try {
    if (wantSearch) {
      const r = await chat(key, SEARCH_MODEL, messages, { signal, maxTokens: 600 });
      if (!r.searched) {
        return { ...r, degraded: r.sources.length ? undefined : 'Answered without live sources — could not verify against current web results.' };
      }
      return r;
    }
    return await chat(key, REASON_MODEL, messages, { signal, maxTokens: 600 });
  } catch (e) {
    if ((e as any)?.name === 'AbortError') throw e;
    if (e instanceof GroqError && (e.kind === 'network' || e.kind === 'rate')) {
      // degrade honestly to retrieval
      const fb = await wikipediaFallback(question, signal);
      fb.degraded = e.kind === 'rate'
        ? 'The free AI service hit its rate limit, so this is a basic reference lookup instead.'
        : 'Could not reach the AI service, so this is a basic reference lookup instead.';
      return fb;
    }
    throw e;
  }
}

/** Summarize text (used for context compression). */
export async function summarizeForContext(key: string, text: string): Promise<string> {
  const r = await chat(key, REASON_MODEL, [
    { role: 'system', content: 'Compress this conversation into a dense factual summary (under 200 words). Preserve: who claimed what, key facts, agreements, disagreements, corrections made, definitions in dispute. No commentary.' },
    { role: 'user', content: text }
  ], { maxTokens: 400 });
  return r.text;
}

// ── No-key fallback: Wikipedia retrieval (CORS-open, free, no key) ──
export async function wikipediaFallback(question: string, signal?: AbortSignal): Promise<MinAnswer> {
  const degraded = 'No Groq key is set, so Min can only do basic reference lookups. Add a free key in Settings for full answers.';
  try {
    const q = question.replace(/[?.!]/g, '').trim();
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=2&format=json&origin=*`;
    const res = await fetch(url, { signal: signal ?? null });
    if (!res.ok) throw new Error('wiki http');
    const data = await res.json();
    const hits = data?.query?.search ?? [];
    if (!hits.length) {
      return { text: "I couldn't find a reference article for that.", sources: [], degraded };
    }
    const top = hits[0];
    const sumRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(top.title)}`, { signal: signal ?? null });
    const sum = sumRes.ok ? await sumRes.json() : null;
    const extract: string = sum?.extract || top.snippet?.replace(/<[^>]+>/g, '') || '';
    return {
      text: extract ? `From Wikipedia's article on ${top.title}: ${extract}` : `The closest reference article is "${top.title}".`,
      sources: [{ title: `Wikipedia: ${top.title}`, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(top.title.replace(/ /g, '_'))}` }],
      degraded
    };
  } catch (e) {
    if ((e as any)?.name === 'AbortError') throw e;
    return { text: "I couldn't reach any reference sources right now.", sources: [], degraded };
  }
}

export type { GroqResult };
