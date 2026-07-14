// Speech synthesis wrapper: single-utterance queue, skip support,
// and callbacks so the recognizer can be suppressed while speaking.

export function ttsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export class Voice {
  private speaking = false;
  private onStart: () => void;
  private onEnd: () => void;

  constructor(onStart: () => void, onEnd: () => void) {
    this.onStart = onStart;
    this.onEnd = onEnd;
  }

  /** Speak text aloud. Resolves when done (or immediately if unsupported). */
  speak(text: string, enabled: boolean): Promise<void> {
    return new Promise(resolve => {
      if (!enabled || !ttsSupported() || !text.trim()) { resolve(); return; }
      this.cancel();
      const u = new SpeechSynthesisUtterance(this.cleanForSpeech(text));
      u.rate = 1.02;
      u.pitch = 1.0;
      const voices = speechSynthesis.getVoices();
      const preferred = voices.find(v => v.lang.startsWith('en') && /samantha|ava|allison|serena|daniel/i.test(v.name))
        ?? voices.find(v => v.lang.startsWith(navigator.language?.slice(0, 2) || 'en'));
      if (preferred) u.voice = preferred;

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.speaking = false;
        this.onEnd();
        resolve();
      };
      u.onstart = () => { this.speaking = true; this.onStart(); };
      u.onend = finish;
      u.onerror = finish;
      // Safety: if the utterance never fires events (muted/failed), don't hang.
      const est = Math.min(4000 + text.length * 65, 45000);
      setTimeout(finish, est);
      try { speechSynthesis.speak(u); } catch { finish(); }
    });
  }

  cancel(): void {
    if (!ttsSupported()) return;
    try { speechSynthesis.cancel(); } catch { /* noop */ }
    if (this.speaking) { this.speaking = false; this.onEnd(); }
  }

  isSpeaking(): boolean { return this.speaking; }

  private cleanForSpeech(text: string): string {
    return text
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1') // markdown links → title
      .replace(/https?:\/\/\S+/g, '')                        // bare URLs
      .replace(/[*_#`]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
}
