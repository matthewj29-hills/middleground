// Conversation context management: rolling transcript window plus a
// compressed summary of older material so long sessions stay usable
// without sending the entire raw transcript on every request.

import type { Turn } from '../types';

export interface ContextConfig {
  /** Turns kept verbatim in the rolling window. */
  windowTurns: number;
  /** Compress when total turns exceed this. */
  compressAt: number;
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  windowTurns: 36,
  compressAt: 60
};

export function speakerLabel(s: Turn['speaker']): string {
  return s === 'min' ? 'Min' : `Speaker ${s}`;
}

export function formatTurns(turns: Turn[]): string {
  return turns.map(t => `${speakerLabel(t.speaker)}: ${t.text}`).join('\n');
}

export class ContextManager {
  private cfg: ContextConfig;
  summary = '';
  private compressing = false;

  constructor(cfg: ContextConfig = DEFAULT_CONTEXT_CONFIG) { this.cfg = cfg; }

  /** Full prompt-ready context: summary of older turns + recent verbatim window. */
  buildContext(turns: Turn[]): string {
    const recent = turns.slice(-this.cfg.windowTurns);
    const parts: string[] = [];
    if (this.summary) parts.push(`Summary of the earlier conversation:\n${this.summary}`);
    parts.push(`Recent transcript:\n${formatTurns(recent)}`);
    return parts.join('\n\n');
  }

  needsCompression(turns: Turn[]): boolean {
    return !this.compressing && turns.length > this.cfg.compressAt;
  }

  /** Which turns should be folded into the summary (older half beyond the window). */
  turnsToCompress(turns: Turn[]): Turn[] {
    return turns.slice(0, Math.max(0, turns.length - this.cfg.windowTurns));
  }

  async compress(
    turns: Turn[],
    summarize: (text: string) => Promise<string>
  ): Promise<number> {
    if (this.compressing) return 0;
    this.compressing = true;
    try {
      const old = this.turnsToCompress(turns);
      if (old.length === 0) return 0;
      const text = (this.summary ? `Earlier summary:\n${this.summary}\n\n` : '') +
        `Transcript to fold in:\n${formatTurns(old)}`;
      const s = await summarize(text);
      if (s && s.trim()) this.summary = s.trim();
      return old.length;
    } catch {
      return 0; // keep old turns verbatim; retry later
    } finally {
      this.compressing = false;
    }
  }

  restore(summary: string): void { this.summary = summary || ''; }
}
