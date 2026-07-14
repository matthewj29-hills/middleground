// Speaker-turn segmentation. Fully automatic diarization is not possible
// with the browser SpeechRecognition API (it exposes text only, not voice
// features), so we use the strongest honest heuristic available:
// pause-based turn boundaries with alternation, plus tap-to-correct.
// This is documented as a limitation in the app and handoff guide.

import type { Speaker, Turn } from '../types';
import { uid } from '../state/store';

export interface TurnConfig {
  /** Silence gap (ms) between final results that suggests a speaker change. */
  speakerGapMs: number;
  /** Gap (ms) that merely starts a new paragraph for the same speaker. */
  turnGapMs: number;
}

export const DEFAULT_TURN_CONFIG: TurnConfig = {
  speakerGapMs: 2600,
  turnGapMs: 1200
};

export class TurnManager {
  private cfg: TurnConfig;
  turns: Turn[] = [];
  private lastFinalTs = 0;
  private currentSpeaker: Speaker = 1;
  private knownSpeakers = 1;

  constructor(cfg: TurnConfig = DEFAULT_TURN_CONFIG) { this.cfg = cfg; }

  /** Feed one final recognition result. Returns the turn it landed in. */
  addFinal(text: string, ts: number): Turn {
    const fresh = this.lastFinalTs === 0; // first utterance, or right after Min spoke
    const gap = fresh ? 0 : ts - this.lastFinalTs;
    const last = this.lastSpeakerTurn();
    // Only merge into the last human turn if nothing (e.g. a Min turn) came after it.
    const lastIsTail = last !== null && this.turns[this.turns.length - 1] === last;

    let turn: Turn;
    if (last && lastIsTail && !fresh && gap < this.cfg.turnGapMs) {
      // continuation of the current turn
      last.text = (last.text + ' ' + text).trim();
      turn = last;
    } else {
      if (last && !fresh && gap >= this.cfg.speakerGapMs) {
        // long pause: assume the other person is talking now
        this.currentSpeaker = this.currentSpeaker === 1 ? 2 : 1;
        this.knownSpeakers = Math.max(this.knownSpeakers, 2);
      }
      turn = { id: uid(), speaker: this.currentSpeaker, text, ts };
      this.turns.push(turn);
    }
    this.lastFinalTs = ts;
    return turn;
  }

  addMinTurn(text: string, kind: 'answer' | 'correction' | 'ack', sources?: Turn['sources']): Turn {
    const t: Turn = { id: uid(), speaker: 'min', text, ts: Date.now(), kind, sources };
    this.turns.push(t);
    // A Min interjection resets pause tracking so the next human utterance
    // is not misread as a speaker change.
    this.lastFinalTs = 0;
    return t;
  }

  /** Tap-to-correct: cycle a turn's speaker 1 -> 2 -> 3 -> 1. */
  cycleSpeaker(turnId: string): void {
    const t = this.turns.find(x => x.id === turnId);
    if (!t || t.speaker === 'min') return;
    const next = (t.speaker % 3) + 1 as Speaker;
    t.speaker = next;
    this.knownSpeakers = Math.max(this.knownSpeakers, next);
    // If this is the latest human turn, continue attributing to the corrected speaker.
    if (t === this.lastSpeakerTurn()) this.currentSpeaker = next;
  }

  private lastSpeakerTurn(): Turn | null {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i];
      if (t.speaker !== 'min') return t;
    }
    return null;
  }

  restore(turns: Turn[]): void {
    this.turns = turns;
    const last = this.lastSpeakerTurn();
    if (last && last.speaker !== 'min') this.currentSpeaker = last.speaker as Speaker;
    this.lastFinalTs = 0;
  }
}
