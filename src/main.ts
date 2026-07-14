// MiddleGround — application controller.
// Wires: speech recognition → turns/wake → Min state machine → fact-check
// scheduler → session report, plus views, settings, and persistence.

import './styles.css';
import type { ClaimVerdict, FactNotice, MinState, SessionData, Turn } from './types';
import { Cell, uid } from './state/store';
import { LiveRecognizer, speechSupported } from './audio/speech';
import { Voice, ttsSupported } from './audio/tts';
import { TurnManager } from './core/turns';
import { detectWake } from './core/wake';
import { ContextManager } from './core/context';
import * as storage from './core/storage';
import { answerQuestion, summarizeForContext } from './ai/min';
import { busy as groqBusy, testKey } from './ai/groq';
import {
  DEFAULT_GATE, decide, isDuplicate, normalizeClaim, passesScreen, screenClaims, verifyClaim, verifyClaimOffline,
  type GateState
} from './ai/factcheck';
import { generateReport } from './ai/report';
import {
  $, showView, renderTurn, updateTurnEl, renderInterim, scrollToBottom,
  setStatus, showNotice, transientNotice, renderReport
} from './ui/render';

// ── app state ────────────────────────────────────────────────────
const turns = new TurnManager();
const context = new ContextManager();
const minState = new Cell<MinState>('idle');
let session: SessionData | null = null;
let sessionActive = false;
let questionTimer: number | null = null;
let pendingQuestion = '';
let minAbort: AbortController | null = null;
let interruptCount = 0;
const gate: GateState = { lastInterruptTs: 0, checkedClaims: [], processing: false };
let unscreenedFinals: string[] = [];
let pendingClaims: string[] = [];
let factTimer: number | null = null;
let saveTimer: number | null = null;

const transcriptEl = () => $('transcript');

const voice = new Voice(
  () => { /* speaking started — recognition already suppressed */ },
  () => {
    // finished speaking → resume listening if session still running
    if (sessionActive && minState.get() !== 'processing') {
      recognizer.resume();
      if (minState.get() === 'speaking') minState.set('idle');
    }
    $('btn-skip').classList.add('hidden');
  }
);

const recognizer = new LiveRecognizer({
  onInterim(text) {
    if (!sessionActive) return;
    renderInterim(transcriptEl(), text);
    scrollToBottom(transcriptEl());
  },
  onFinal(text, ts) {
    if (!sessionActive) return;
    renderInterim(transcriptEl(), '');

    // question capture mode: this utterance IS the question
    if (minState.get() === 'capturing' || minState.get() === 'acknowledged') {
      captureQuestionText(text);
      return;
    }
    if (minState.get() === 'processing' || minState.get() === 'speaking') {
      // Min is busy; treat speech as normal conversation
      appendFinal(text, ts);
      return;
    }

    const wake = detectWake(text);
    if (wake) {
      onWake(wake.question);
      return;
    }
    appendFinal(text, ts);
  },
  onState(state, detail) {
    if (!sessionActive) return;
    if (state === 'listening') setStatus('listening', 'Listening');
    else if (state === 'error') {
      if (detail === 'permission') {
        setStatus('error', 'Microphone blocked');
        transientNotice('Microphone access was denied. Enable it in Settings → Safari → Microphone, then tap Record again.', 12_000);
        endSession(false);
      } else if (detail === 'unsupported') {
        setStatus('error', 'Speech recognition unavailable');
      } else {
        setStatus('error', 'Reconnecting…');
      }
    }
  }
});

function appendFinal(text: string, ts: number): void {
  const before = turns.turns.length;
  const turn = turns.addFinal(text, ts);
  if (turns.turns.length > before) {
    transcriptEl().append(renderTurn(turn, id => { turns.cycleSpeaker(id); rerenderTranscript(); }));
  } else {
    updateTurnEl(transcriptEl(), turn);
  }
  markCurrent(turn.id);
  scrollToBottom(transcriptEl());
  unscreenedFinals.push(text);
  scheduleSave();
  maybeCompressContext();
}

function markCurrent(turnId: string): void {
  transcriptEl().querySelectorAll('.turn.current').forEach(e => e.classList.remove('current'));
  transcriptEl().querySelector(`[data-turn-id="${turnId}"]`)?.classList.add('current');
}

function rerenderTranscript(): void {
  const c = transcriptEl();
  c.textContent = '';
  for (const t of turns.turns) c.append(renderTurn(t, id => { turns.cycleSpeaker(id); rerenderTranscript(); }));
  scrollToBottom(c);
  scheduleSave();
}

// ── Min question flow ────────────────────────────────────────────
function onWake(inlineQuestion: string): void {
  if (minState.get() !== 'idle') return;
  if (inlineQuestion && inlineQuestion.split(' ').length >= 3) {
    // whole question arrived with the wake word
    runQuestion(inlineQuestion);
    return;
  }
  // acknowledge and open a capture window
  minState.set('acknowledged');
  setStatus('min-active', 'Min is listening');
  $('btn-min').classList.add('active');
  pendingQuestion = inlineQuestion;
  const ackTurn = turns.addMinTurn("I'm listening.", 'ack');
  transcriptEl().append(renderTurn(ackTurn));
  scrollToBottom(transcriptEl());
  recognizer.suppress();
  voice.speak("I'm listening.", storage.getPref('voice')).then(() => {
    if (!sessionActive) return;
    if (minState.get() === 'acknowledged') {
      minState.set('capturing');
      recognizer.resume();
      // give them 9 seconds to ask
      questionTimer = window.setTimeout(() => {
        if (minState.get() === 'capturing') {
          if (pendingQuestion.trim()) runQuestion(pendingQuestion);
          else cancelMin('No question heard.');
        }
      }, 9_000);
    }
  });
}

function captureQuestionText(text: string): void {
  pendingQuestion = (pendingQuestion + ' ' + text).trim();
  // Heard a chunk — extend briefly in case they're still talking, then run.
  if (questionTimer) clearTimeout(questionTimer);
  questionTimer = window.setTimeout(() => {
    if (pendingQuestion.trim()) runQuestion(pendingQuestion);
    else cancelMin('No question heard.');
  }, 1_600);
}

function manualAsk(): void {
  if (!sessionActive) return;
  if (minState.get() === 'speaking') { skipSpeaking(); return; }
  if (minState.get() !== 'idle') { cancelMin(); return; }
  minState.set('capturing');
  pendingQuestion = '';
  setStatus('min-active', 'Min is listening');
  $('btn-min').classList.add('active');
  questionTimer = window.setTimeout(() => {
    if (minState.get() === 'capturing') cancelMin('No question heard.');
  }, 10_000);
}

async function runQuestion(question: string): Promise<void> {
  if (questionTimer) { clearTimeout(questionTimer); questionTimer = null; }
  pendingQuestion = '';
  minState.set('processing');
  setStatus('min-active', 'Min is thinking…');
  recognizer.suppress();

  minAbort = new AbortController();
  let answerText = '';
  let sources: Turn['sources'] = [];
  let degraded: string | undefined;
  try {
    const a = await answerQuestion(storage.getGroqKey(), question, context.buildContext(turns.turns), minAbort.signal);
    answerText = a.text || "I don't have a good answer for that.";
    sources = a.sources;
    degraded = a.degraded;
  } catch (e: any) {
    if (e?.name === 'AbortError') { cancelMin(); return; }
    answerText = e?.kind === 'auth'
      ? 'My API key was rejected — check it in Settings.'
      : "I couldn't process that question. Please try again.";
  }
  if (!sessionActive) return;

  const t = turns.addMinTurn(answerText, 'answer', sources?.length ? sources : undefined);
  transcriptEl().append(renderTurn(t));
  scrollToBottom(transcriptEl());
  if (degraded) transientNotice(degraded, 9_000);
  scheduleSave();

  minState.set('speaking');
  setStatus('min-active', 'Min is speaking');
  $('btn-skip').classList.remove('hidden');
  await voice.speak(answerText, storage.getPref('voice'));
  if (minState.get() === 'speaking') minState.set('idle');
  if (sessionActive) setStatus('listening', 'Listening');
  $('btn-min').classList.remove('active');
}

function cancelMin(msg?: string): void {
  if (questionTimer) { clearTimeout(questionTimer); questionTimer = null; }
  minAbort?.abort();
  minAbort = null;
  voice.cancel();
  pendingQuestion = '';
  minState.set('idle');
  $('btn-min').classList.remove('active');
  $('btn-skip').classList.add('hidden');
  if (sessionActive) {
    recognizer.resume();
    setStatus('listening', 'Listening');
    if (msg) transientNotice(msg, 4_000);
  }
}

function skipSpeaking(): void {
  voice.cancel();
  minState.set('idle');
  $('btn-min').classList.remove('active');
  $('btn-skip').classList.add('hidden');
  if (sessionActive) { recognizer.resume(); setStatus('listening', 'Listening'); }
}

// ── automatic fact-checking ─────────────────────────────────────
function startFactLoop(): void {
  stopFactLoop();
  factTimer = window.setInterval(() => { void factTick(); }, 22_000);
}
function stopFactLoop(): void {
  if (factTimer) { clearInterval(factTimer); factTimer = null; }
}

async function factTick(): Promise<void> {
  if (!sessionActive || gate.processing) return;
  if (!storage.getPref('factcheck')) { unscreenedFinals = []; return; }
  const key = storage.getGroqKey();
  if (!key) { unscreenedFinals = []; return; }
  if (minState.get() !== 'idle' || groqBusy()) return;
  const segment = unscreenedFinals.join(' ').trim();
  if (segment.split(' ').length < 12) return; // not enough new speech

  gate.processing = true;
  unscreenedFinals = [];
  try {
    // One claim per tick, to stay under free-tier search limits. Claims that
    // could not be verified (throttling) wait in a small queue for later ticks.
    let claimText: string | null = pendingClaims.shift() ?? null;
    if (!claimText) {
      const screened = await screenClaims(key, segment);
      const c = screened.find(x => passesScreen(x) &&
        !gate.checkedClaims.some(prev => prev === normalizeClaim(x.claim)) &&
        !isDuplicate(x.claim, gate.checkedClaims));
      claimText = c?.claim ?? null;
    }
    if (claimText) {
      let verdict;
      try {
        verdict = await verifyClaim(key, claimText);
      } catch {
        // search model throttled — try the conservative no-search verifier
        try { verdict = await verifyClaimOffline(key, claimText); }
        catch {
          if (pendingClaims.length < 3) pendingClaims.push(claimText); // retry later
          verdict = null;
        }
      }
      if (verdict) {
        gate.checkedClaims.push(normalizeClaim(claimText));
        const decision = decide(verdict, gate, DEFAULT_GATE, Date.now(), interruptCount, minState.get() !== 'idle' || voice.isSpeaking());
        if (decision !== 'ignore') await deliverFactNote(verdict, decision);
      }
    }
  } catch { /* screening failed (offline/rate limit) - try again next tick */ }
  finally { gate.processing = false; }
}

async function deliverFactNote(verdict: ClaimVerdict, decision: 'speak' | 'notice'): Promise<void> {
  const note: FactNotice = {
        id: uid(),
        claim: verdict.claim,
        note: verdict.correction || `The claim "${verdict.claim}" may not be accurate.`,
        sources: verdict.sources,
        spoken: decision === 'speak',
        ts: Date.now()
      };
      session?.notices.push(note);

      if (decision === 'speak' && sessionActive && minState.get() === 'idle') {
        gate.lastInterruptTs = Date.now();
        interruptCount++;
        const t = turns.addMinTurn(note.note, 'correction', verdict.sources.length ? verdict.sources : undefined);
        transcriptEl().append(renderTurn(t));
        scrollToBottom(transcriptEl());
        minState.set('speaking');
        setStatus('min-active', 'Min — a factual note');
        recognizer.suppress();
        $('btn-skip').classList.remove('hidden');
        await voice.speak(note.note, storage.getPref('voice'));
        if (minState.get() === 'speaking') minState.set('idle');
        if (sessionActive) setStatus('listening', 'Listening');
  } else {
    showNotice(note);
  }
  scheduleSave();
}

// ── context compression ─────────────────────────────────────────
function maybeCompressContext(): void {
  const key = storage.getGroqKey();
  if (!key || !context.needsCompression(turns.turns)) return;
  void context.compress(turns.turns, text => summarizeForContext(key, text)).then(() => {
    if (session) { session.contextSummary = context.summary; scheduleSave(); }
  });
}

// ── session lifecycle ────────────────────────────────────────────
function startSession(): void {
  if (!speechSupported()) {
    transientNoticeHome('This browser does not support live speech recognition. On iPhone, use Safari.');
    return;
  }
  session = { id: uid(), startedAt: Date.now(), endedAt: null, turns: [], notices: [], contextSummary: '', report: null };
  turns.restore([]);
  context.restore('');
  session.turns = turns.turns;
  unscreenedFinals = [];
  interruptCount = 0;
  gate.lastInterruptTs = 0;
  gate.checkedClaims = [];
  sessionActive = true;
  minState.set('idle');
  transcriptEl().textContent = '';
  $('notice-area').textContent = '';
  showView('live');
  setStatus('listening', 'Starting…');
  const ok = recognizer.start();
  if (!ok) { setStatus('error', 'Speech recognition unavailable'); return; }
  startFactLoop();
  // Warm up TTS on this user gesture (iOS requires a gesture before audio).
  if (ttsSupported()) { try { speechSynthesis.getVoices(); } catch { /* noop */ } }
  if (!storage.getGroqKey()) {
    transientNotice('No Groq key set — Min will use basic reference lookups only, and automatic fact-checking is off. Add a free key in Settings.', 10_000);
  }
}

async function endSession(generate = true): Promise<void> {
  sessionActive = false;
  stopFactLoop();
  cancelMinQuiet();
  recognizer.stop();
  if (!session) { showView('home'); return; }
  session.endedAt = Date.now();
  session.turns = turns.turns;
  session.contextSummary = context.summary;
  storage.saveSession(session);

  if (!generate) { showView('home'); return; }
  showView('report');
  renderReportLoading();
  const report = await generateReport(storage.getGroqKey(), turns.turns, context.summary);
  session.report = report;
  storage.saveSession(session);
  renderReport($('report-body'), report);
  $('btn-last-report').classList.remove('hidden');
}

function cancelMinQuiet(): void {
  if (questionTimer) { clearTimeout(questionTimer); questionTimer = null; }
  minAbort?.abort(); minAbort = null;
  voice.cancel();
  pendingQuestion = '';
  minState.set('idle');
  $('btn-min').classList.remove('active');
  $('btn-skip').classList.add('hidden');
}

function renderReportLoading(): void {
  const b = $('report-body');
  b.textContent = '';
  const s = document.createElement('div');
  s.className = 'report-section';
  s.innerHTML = '';
  const h = document.createElement('p');
  h.textContent = 'Reading the conversation and looking for common ground…';
  h.style.color = 'var(--text-dim)';
  s.append(h);
  b.append(s);
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    if (session) {
      session.turns = turns.turns;
      session.contextSummary = context.summary;
      storage.saveSession(session);
    }
  }, 3_000);
}

function transientNoticeHome(text: string): void {
  const hint = document.querySelector<HTMLElement>('.record-hint');
  if (hint) {
    const orig = 'Tap to begin';
    hint.textContent = text;
    hint.style.color = 'var(--amber)';
    setTimeout(() => { hint.textContent = orig; hint.style.color = ''; }, 8_000);
  }
}

// ── transcript view ─────────────────────────────────────────────
function renderFullTranscript(): void {
  const c = $('transcript-full');
  c.textContent = '';
  const src = session?.turns ?? turns.turns;
  for (const t of src) c.append(renderTurn(t));
}

// ── settings ────────────────────────────────────────────────────
function initSettings(): void {
  const keyInput = $('input-groq-key') as HTMLInputElement;
  const keyStatus = $('key-status');
  keyInput.value = storage.getGroqKey();
  keyInput.addEventListener('change', async () => {
    const k = keyInput.value.trim();
    storage.setGroqKey(k);
    if (!k) { keyStatus.textContent = 'No key — Min runs in basic lookup mode.'; keyStatus.className = 'setting-status'; return; }
    keyStatus.textContent = 'Checking key…';
    keyStatus.className = 'setting-status';
    const ok = await testKey(k);
    keyStatus.textContent = ok ? 'Key works. Full features enabled.' : 'That key was rejected by Groq — double-check it.';
    keyStatus.className = `setting-status ${ok ? 'ok' : 'bad'}`;
  });
  const fc = $('toggle-factcheck') as HTMLInputElement;
  fc.checked = storage.getPref('factcheck');
  fc.addEventListener('change', () => storage.setPref('factcheck', fc.checked));
  const tv = $('toggle-voice') as HTMLInputElement;
  tv.checked = storage.getPref('voice');
  tv.addEventListener('change', () => storage.setPref('voice', tv.checked));
}

// ── boot ────────────────────────────────────────────────────────
function boot(): void {
  initSettings();

  $('btn-record').addEventListener('click', startSession);
  $('btn-stop').addEventListener('click', () => { void endSession(true); });
  $('btn-min').addEventListener('click', manualAsk);
  $('btn-skip').addEventListener('click', skipSpeaking);
  $('btn-settings').addEventListener('click', () => showView('settings'));
  $('btn-settings-back').addEventListener('click', () => showView('home'));
  $('btn-report-home').addEventListener('click', () => showView('home'));
  $('btn-view-transcript').addEventListener('click', () => { renderFullTranscript(); showView('transcript'); });
  $('btn-transcript-back').addEventListener('click', () => showView(session?.report ? 'report' : 'home'));
  $('btn-last-report').addEventListener('click', () => {
    if (session?.report) { renderReport($('report-body'), session.report); showView('report'); }
  });
  $('btn-clear-session').addEventListener('click', () => {
    storage.clearSession();
    session = null;
    turns.restore([]);
    $('btn-last-report').classList.add('hidden');
    showView('home');
  });

  // restore a previous session (refresh protection / last report)
  const saved = storage.loadSession();
  if (saved) {
    session = saved;
    turns.restore(saved.turns);
    context.restore(saved.contextSummary);
    if (saved.report) $('btn-last-report').classList.remove('hidden');
    else if (!saved.endedAt && saved.turns.length > 0) {
      // an active session was interrupted by a refresh — keep it reachable
      $('btn-last-report').classList.remove('hidden');
      $('btn-last-report').textContent = 'Resume last transcript';
      $('btn-last-report').addEventListener('click', () => { renderFullTranscript(); showView('transcript'); }, { once: true });
    }
  }

  // stop cleanly if the page is being hidden mid-session (iOS lock/switch)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && sessionActive) {
      scheduleSave();
      setStatus('paused', 'Paused — screen was hidden');
    } else if (!document.hidden && sessionActive) {
      recognizer.resume();
      setStatus('listening', 'Listening');
    }
  });

  // service worker for offline shell + installability
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => { /* offline shell unavailable */ });
    });
  }

  showView('home');
}

boot();
