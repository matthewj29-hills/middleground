// Groq API client. The key comes from device localStorage (entered by the
// user in Settings) — it is never present in the deployed source code.
// CORS is open on api.groq.com, so the browser calls it directly:
// zero servers, zero cost beyond the free tier.

import type { SourceRef } from '../types';

const BASE = 'https://api.groq.com/openai/v1/chat/completions';
export const REASON_MODEL = 'llama-3.3-70b-versatile';
export const SEARCH_MODEL = 'groq/compound-mini';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }

export interface GroqResult {
  text: string;
  sources: SourceRef[];
  searched: boolean;
}

export class GroqError extends Error {
  kind: 'no-key' | 'auth' | 'rate' | 'network' | 'other';
  constructor(kind: GroqError['kind'], msg: string) { super(msg); this.kind = kind; }
}

let inflight = 0;
export function busy(): boolean { return inflight > 0; }

export async function chat(
  key: string,
  model: string,
  messages: ChatMessage[],
  opts: { json?: boolean; maxTokens?: number; signal?: AbortSignal; temperature?: number; retried?: boolean } = {}
): Promise<GroqResult> {
  if (!key) throw new GroqError('no-key', 'No API key configured');
  const body: any = {
    model,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 1024
  };
  if (opts.json) body.response_format = { type: 'json_object' };

  inflight++;
  let res: Response;
  try {
    res = await fetch(BASE, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal ?? null
    });
  } catch (e: any) {
    inflight--;
    if (e?.name === 'AbortError') throw e;
    throw new GroqError('network', 'Could not reach Groq');
  }
  inflight--;

  if (res.status === 401 || res.status === 403) throw new GroqError('auth', 'API key rejected');
  if (res.status === 429) {
    // Per-minute free-tier throttle: wait once for the window, then give up
    // gracefully (callers degrade: fact-checks skip, Min falls back).
    if (!opts.retried) {
      await new Promise(r => setTimeout(r, 2500));
      return chat(key, model, messages, { ...opts, retried: true });
    }
    throw new GroqError('rate', 'Rate limit reached');
  }
  if (res.status === 413) {
    // Compound models intermittently reject requests on the free tier
    // ("request too large"). Retry once after a short pause with a smaller
    // completion budget, then degrade gracefully.
    if (!opts.retried) {
      await new Promise(r => setTimeout(r, 1500));
      return chat(key, model, messages, { ...opts, maxTokens: Math.min(opts.maxTokens ?? 1024, 300), retried: true });
    }
    throw new GroqError('rate', 'Free-tier capacity limit reached');
  }
  if (!res.ok) throw new GroqError('other', `Groq error ${res.status}`);

  const data = await res.json();
  const msg = data?.choices?.[0]?.message;
  const text: string = msg?.content ?? '';
  const sources = extractSources(msg, text);
  return { text: stripCitationMarks(text), sources, searched: Boolean(msg?.executed_tools?.length) };
}

/** Pull source URLs out of compound's executed_tools + citation marks. */
export function extractSources(msg: any, text: string): SourceRef[] {
  const out: SourceRef[] = [];
  const seen = new Set<string>();
  const add = (title: string, url: string) => {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return;
      if (seen.has(u.href)) return;
      seen.add(u.href);
      out.push({ title: title || u.hostname, url: u.href });
    } catch { /* invalid URL */ }
  };

  const tools = msg?.executed_tools;
  if (Array.isArray(tools)) {
    for (const t of tools) {
      const output: string = typeof t?.output === 'string' ? t.output : '';
      const re = /Title:\s*([^\n]+)\nURL:\s*(https?:\/\/\S+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(output)) !== null) add(m[1].trim(), m[2].trim());
    }
  }
  // compound cites inline as 【https://...】
  const cite = /【(https?:\/\/[^】\s]+)】/g;
  let m2: RegExpExecArray | null;
  while ((m2 = cite.exec(text)) !== null) add('', m2[1]);
  return out.slice(0, 5);
}

export function stripCitationMarks(text: string): string {
  return text.replace(/【[^】]*】/g, '').replace(/ {2,}/g, ' ').trim();
}

/** Test whether a key works (used by Settings). */
export async function testKey(key: string): Promise<boolean> {
  try {
    await chat(key, 'llama-3.1-8b-instant', [{ role: 'user', content: 'Say OK' }], { maxTokens: 4 });
    return true;
  } catch (e) {
    if (e instanceof GroqError && (e.kind === 'rate')) return true; // key valid, just throttled
    return false;
  }
}
