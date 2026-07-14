// Wake-word detection over the recognized text stream.
// "Min" must be used as an address (start of an utterance, or preceded by
// "hey"/"ok"), not merely mentioned mid-sentence, to reduce false triggers.

const WAKE_FORMS = ['min', 'minh', 'mihn', 'mint', 'men'];
// "mint"/"men" are common recognizer mis-hearings of "Min" — accepted only
// in strong address position (see below) to keep false positives rare.
const STRONG_ONLY = new Set(['mint', 'men']);

export interface WakeHit {
  /** The question text that followed the wake word, if any. */
  question: string;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Detect a wake-word address in a final utterance.
 * Returns null when Min was not addressed.
 */
export function detectWake(finalText: string): WakeHit | null {
  const norm = normalize(finalText);
  if (!norm) return null;
  const words = norm.split(' ');

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!WAKE_FORMS.includes(w)) continue;

    const prev = i > 0 ? words[i - 1] : '';
    const atStart = i === 0;
    const heyBefore = prev === 'hey' || prev === 'ok' || prev === 'okay';
    const strongPosition = atStart || (heyBefore && i <= 1);

    if (STRONG_ONLY.has(w) && !strongPosition) continue;
    // Mid-sentence "min" (e.g. "wait a min") is not an address.
    if (!strongPosition) continue;

    const rest = words.slice(i + 1).join(' ').trim();
    return { question: rest };
  }
  return null;
}

/** True if an interim fragment looks like it's starting to address Min. */
export function interimLooksLikeWake(interim: string): boolean {
  const norm = normalize(interim);
  return /^(hey |ok |okay )?(min|minh|mihn)\b/.test(norm);
}
