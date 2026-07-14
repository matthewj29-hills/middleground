import type { SessionData } from '../types';

const SESSION_KEY = 'mg.session.v1';
const KEY_KEY = 'mg.groqKey';
const PREF_FACTCHECK = 'mg.pref.factcheck';
const PREF_VOICE = 'mg.pref.voice';

function safeGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k: string, v: string): void {
  try { localStorage.setItem(k, v); } catch { /* storage full or blocked — session continues in memory */ }
}
function safeDel(k: string): void {
  try { localStorage.removeItem(k); } catch { /* ignore */ }
}

export function saveSession(s: SessionData): void {
  safeSet(SESSION_KEY, JSON.stringify(s));
}
export function loadSession(): SessionData | null {
  const raw = safeGet(SESSION_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as SessionData;
    if (!s || !Array.isArray(s.turns)) return null;
    return s;
  } catch { return null; }
}
export function clearSession(): void { safeDel(SESSION_KEY); }

export function getGroqKey(): string { return safeGet(KEY_KEY) ?? ''; }
export function setGroqKey(k: string): void {
  if (k) safeSet(KEY_KEY, k.trim()); else safeDel(KEY_KEY);
}

export function getPref(name: 'factcheck' | 'voice'): boolean {
  const v = safeGet(name === 'factcheck' ? PREF_FACTCHECK : PREF_VOICE);
  return v === null ? true : v === '1';
}
export function setPref(name: 'factcheck' | 'voice', on: boolean): void {
  safeSet(name === 'factcheck' ? PREF_FACTCHECK : PREF_VOICE, on ? '1' : '0');
}
