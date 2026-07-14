// Live speech recognition built on the browser's native SpeechRecognition
// (webkit-prefixed on iOS Safari). Handles the iOS quirks: recognition
// stops on its own after silence, so we run a supervised restart loop,
// and we suppress recognition entirely while Min is speaking so Min's
// voice is not transcribed as a participant.

type SR = any;

export interface SpeechEvents {
  onInterim(text: string): void;
  onFinal(text: string, ts: number): void;
  onState(state: 'listening' | 'stopped' | 'error', detail?: string): void;
}

function getSRClass(): (new () => SR) | null {
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function speechSupported(): boolean {
  return getSRClass() !== null;
}

export class LiveRecognizer {
  private rec: SR | null = null;
  private active = false;        // user wants us listening
  private suppressed = false;    // temporarily paused (Min speaking)
  private restartTimer: number | null = null;
  private consecutiveErrors = 0;
  private ev: SpeechEvents;

  constructor(ev: SpeechEvents) { this.ev = ev; }

  start(): boolean {
    const Cls = getSRClass();
    if (!Cls) { this.ev.onState('error', 'unsupported'); return false; }
    this.active = true;
    this.suppressed = false;
    this.consecutiveErrors = 0;
    this.spin(Cls);
    return true;
  }

  private spin(Cls: new () => SR): void {
    if (!this.active || this.suppressed) return;
    try { this.rec?.abort?.(); } catch { /* noop */ }
    const rec: any = new Cls();
    this.rec = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';

    rec.onresult = (e: any) => {
      this.consecutiveErrors = 0;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = (r[0]?.transcript ?? '').trim();
        if (!t) continue;
        if (r.isFinal) this.ev.onFinal(t, Date.now());
        else interim += (interim ? ' ' : '') + t;
      }
      if (interim) this.ev.onInterim(interim);
    };

    rec.onerror = (e: any) => {
      const code = e?.error ?? 'unknown';
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        this.active = false;
        this.ev.onState('error', 'permission');
        return;
      }
      // no-speech / aborted / network are recoverable - onend restarts us
      this.consecutiveErrors++;
    };

    rec.onend = () => {
      if (!this.active || this.suppressed) { this.ev.onState('stopped'); return; }
      // iOS ends recognition after pauses; restart with a small backoff.
      if (this.consecutiveErrors > 8) {
        this.ev.onState('error', 'unstable');
        this.consecutiveErrors = 0;
      }
      const delay = Math.min(250 + this.consecutiveErrors * 400, 2500);
      this.restartTimer = window.setTimeout(() => this.spin(Cls), delay);
    };

    try {
      rec.start();
      this.ev.onState('listening');
    } catch {
      // start() throws if called while already started - retry shortly
      this.restartTimer = window.setTimeout(() => this.spin(Cls), 600);
    }
  }

  /** Pause recognition while Min speaks (prevents self-transcription). */
  suppress(): void {
    this.suppressed = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    try { this.rec?.abort?.(); } catch { /* noop */ }
  }

  /** Resume after Min finishes speaking. */
  resume(): void {
    if (!this.active) return;
    this.suppressed = false;
    const Cls = getSRClass();
    if (Cls) this.spin(Cls);
  }

  stop(): void {
    this.active = false;
    this.suppressed = false;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    try { this.rec?.stop?.(); } catch { /* noop */ }
    this.rec = null;
    this.ev.onState('stopped');
  }

  isActive(): boolean { return this.active; }
  isSuppressed(): boolean { return this.suppressed; }
}
