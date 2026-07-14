import { describe, it, expect } from 'vitest';
import { detectWake, interimLooksLikeWake } from '../src/core/wake';
import { TurnManager } from '../src/core/turns';
import { decide, isDuplicate, normalizeClaim, passesScreen, DEFAULT_GATE, type GateState } from '../src/ai/factcheck';
import { needsSearch } from '../src/ai/min';
import { ContextManager } from '../src/core/context';
import { extractSources, stripCitationMarks } from '../src/ai/groq';
import type { ClaimVerdict, Turn } from '../src/types';

// ── wake word ───────────────────────────────────────────────────
describe('wake word', () => {
  it('detects Min at start of utterance with inline question', () => {
    const hit = detectWake('Min is that true');
    expect(hit).not.toBeNull();
    expect(hit!.question).toBe('is that true');
  });
  it('detects hey Min', () => {
    expect(detectWake('Hey Min, what did he say earlier?')!.question).toContain('what did he say');
  });
  it('ignores mid-sentence min (wait a min)', () => {
    expect(detectWake('wait a min I was talking')).toBeNull();
  });
  it('ignores casual mention of the name mid-sentence', () => {
    expect(detectWake('I think min wage should be higher')).toBeNull();
  });
  it('accepts mis-hearings only in address position', () => {
    expect(detectWake('Mint what is the inflation rate')).not.toBeNull();
    expect(detectWake('I like mint ice cream')).toBeNull();
  });
  it('bare wake word yields empty question (capture window)', () => {
    expect(detectWake('Min')!.question).toBe('');
  });
  it('interim detection', () => {
    expect(interimLooksLikeWake('hey min')).toBe(true);
    expect(interimLooksLikeWake('the minimum')).toBe(false);
  });
});

// ── speaker turns ───────────────────────────────────────────────
describe('turn manager', () => {
  it('merges quick continuations into one turn', () => {
    const tm = new TurnManager();
    tm.addFinal('I think taxes', 1000);
    tm.addFinal('are too high', 1500);
    expect(tm.turns.length).toBe(1);
    expect(tm.turns[0].text).toBe('I think taxes are too high');
  });
  it('switches speaker after a long pause', () => {
    const tm = new TurnManager();
    tm.addFinal('First point', 1000);
    tm.addFinal('I disagree completely', 1000 + 3000);
    expect(tm.turns.length).toBe(2);
    expect(tm.turns[0].speaker).toBe(1);
    expect(tm.turns[1].speaker).toBe(2);
  });
  it('same speaker for medium pause (new paragraph, same voice)', () => {
    const tm = new TurnManager();
    tm.addFinal('First', 1000);
    tm.addFinal('Second thought', 1000 + 1800);
    expect(tm.turns.length).toBe(2);
    expect(tm.turns[1].speaker).toBe(1);
  });
  it('cycleSpeaker corrects attribution and sticks', () => {
    const tm = new TurnManager();
    tm.addFinal('Hello there', 1000);
    tm.cycleSpeaker(tm.turns[0].id);
    expect(tm.turns[0].speaker).toBe(2);
  });
  it('min turns reset pause tracking', () => {
    const tm = new TurnManager();
    tm.addFinal('A claim', 1000);
    tm.addMinTurn('A correction', 'correction');
    tm.addFinal('continuing after min spoke', 60_000);
    const humanTurns = tm.turns.filter(t => t.speaker !== 'min');
    expect(humanTurns[1].speaker).toBe(1); // not flipped by the long gap
  });
});

// ── fact-check gate ─────────────────────────────────────────────
function verdict(v: ClaimVerdict['verdict'], conf: number, claim = 'the moon is made of cheese'): ClaimVerdict {
  return { claim, verdict: v, confidence: conf, correction: 'note', sources: [] };
}
function freshGate(): GateState { return { lastInterruptTs: 0, checkedClaims: [], processing: false }; }

describe('fact-check gating', () => {
  it('speaks only for confident false claims', () => {
    expect(decide(verdict('false', 0.9), freshGate(), DEFAULT_GATE, 200_000, 0, false)).toBe('speak');
  });
  it('never speaks for true or unverified', () => {
    expect(decide(verdict('true', 0.99), freshGate(), DEFAULT_GATE, 200_000, 0, false)).toBe('ignore');
    expect(decide(verdict('unverified', 0.99), freshGate(), DEFAULT_GATE, 200_000, 0, false)).toBe('ignore');
  });
  it('medium confidence → visual notice only', () => {
    expect(decide(verdict('false', 0.75), freshGate(), DEFAULT_GATE, 200_000, 0, false)).toBe('notice');
  });
  it('low confidence → ignored', () => {
    expect(decide(verdict('false', 0.5), freshGate(), DEFAULT_GATE, 200_000, 0, false)).toBe('ignore');
  });
  it('respects cooldown → downgraded to notice', () => {
    const g = freshGate();
    g.lastInterruptTs = 190_000;
    expect(decide(verdict('false', 0.95), g, DEFAULT_GATE, 200_000, 1, false)).toBe('notice');
  });
  it('respects per-session interrupt cap', () => {
    expect(decide(verdict('false', 0.95), freshGate(), DEFAULT_GATE, 500_000, DEFAULT_GATE.maxInterruptsPerSession, false)).toBe('notice');
  });
  it('never interrupts while Min is busy', () => {
    expect(decide(verdict('false', 0.95), freshGate(), DEFAULT_GATE, 500_000, 0, true)).toBe('notice');
  });
  it('suppresses duplicate claims', () => {
    const g = freshGate();
    g.checkedClaims.push(normalizeClaim('the moon is made of cheese'));
    expect(decide(verdict('false', 0.95, 'The moon is made of cheese!'), g, DEFAULT_GATE, 500_000, 0, false)).toBe('ignore');
  });
  it('near-duplicate detection', () => {
    expect(isDuplicate('The moon is really made of cheese', [normalizeClaim('the moon is made of cheese')])).toBe(true);
    expect(isDuplicate('Inflation hit 50 percent last year', [normalizeClaim('the moon is made of cheese')])).toBe(false);
  });
  it('screen filter requires all conditions', () => {
    expect(passesScreen({ claim: 'x'.repeat(20), checkable: true, material: true, likely_false: true, confidence: 0.8 })).toBe(true);
    expect(passesScreen({ claim: 'x'.repeat(20), checkable: true, material: true, likely_false: false, confidence: 0.9 })).toBe(false);
    expect(passesScreen({ claim: 'x'.repeat(20), checkable: false, material: true, likely_false: true, confidence: 0.9 })).toBe(false);
  });
});

// ── search routing ──────────────────────────────────────────────
describe('search routing', () => {
  it('routes current-info questions to search', () => {
    expect(needsSearch('What is the current inflation rate?')).toBe(true);
    expect(needsSearch('Search for the latest news about that')).toBe(true);
    expect(needsSearch('Who is the president right now?')).toBe(true);
  });
  it('keeps timeless questions on the reasoning model', () => {
    expect(needsSearch('What did he say earlier?')).toBe(false);
    expect(needsSearch('Explain what she means by socialism')).toBe(false);
    expect(needsSearch('Did those two claims contradict each other?')).toBe(false);
  });
});

// ── context manager ─────────────────────────────────────────────
function fakeTurns(n: number): Turn[] {
  return Array.from({ length: n }, (_, i) => ({
    id: String(i), speaker: (i % 2 === 0 ? 1 : 2) as 1 | 2, text: `utterance number ${i}`, ts: i * 1000
  }));
}

describe('context manager', () => {
  it('does not compress short conversations', () => {
    const cm = new ContextManager();
    expect(cm.needsCompression(fakeTurns(10))).toBe(false);
  });
  it('compresses long conversations and folds into summary', async () => {
    const cm = new ContextManager();
    const turns = fakeTurns(80);
    expect(cm.needsCompression(turns)).toBe(true);
    const n = await cm.compress(turns, async () => 'a compact summary');
    expect(n).toBeGreaterThan(0);
    expect(cm.summary).toBe('a compact summary');
    const ctx = cm.buildContext(turns);
    expect(ctx).toContain('a compact summary');
    expect(ctx).toContain('utterance number 79');
  });
  it('keeps working when summarizer fails', async () => {
    const cm = new ContextManager();
    const n = await cm.compress(fakeTurns(80), async () => { throw new Error('offline'); });
    expect(n).toBe(0);
    expect(cm.summary).toBe('');
  });
});

// ── source extraction ───────────────────────────────────────────
describe('groq source extraction', () => {
  it('extracts sources from executed_tools and citation marks', () => {
    const msg = {
      executed_tools: [{
        type: 'search',
        output: 'Title: CBS News | Breaking\nURL: https://www.cbsnews.com\nContent: something'
      }]
    };
    const text = 'The rate is 4.5%【https://www.federalreserve.gov】';
    const s = extractSources(msg, text);
    expect(s.length).toBe(2);
    expect(s[0].url).toContain('cbsnews.com');
    expect(s[1].url).toContain('federalreserve.gov');
  });
  it('rejects non-http URLs and strips citation marks', () => {
    expect(extractSources(null, 'x【javascript:alert(1)】')).toEqual([]);
    expect(stripCitationMarks('fact【https://a.com】 done')).toBe('fact done');
  });
});

describe('fact-check ordering regression', () => {
  it('a fresh claim is not suppressed as its own duplicate', () => {
    const g = freshGate();
    const v = verdict('false', 1, 'The Great Wall is visible from the moon');
    const decision = decide(v, g, DEFAULT_GATE, 500_000, 0, false);
    expect(decision).toBe('speak');
    // marking as checked AFTER deciding is the correct order
    g.checkedClaims.push(normalizeClaim(v.claim));
    expect(decide(v, g, DEFAULT_GATE, 900_000, 1, false)).toBe('ignore');
  });
});
