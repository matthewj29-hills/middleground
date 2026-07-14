// DOM rendering. All dynamic text goes through textContent / createElement —
// no innerHTML with untrusted content, so transcripts and model output are
// always rendered as text, never as markup.

import type { FactNotice, Report, Turn } from '../types';
import { speakerLabel } from '../core/context';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function $(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing element #${id}`);
  return e;
}

export type ViewName = 'home' | 'live' | 'report' | 'transcript' | 'settings';
const VIEWS: ViewName[] = ['home', 'live', 'report', 'transcript', 'settings'];

export function showView(name: ViewName): void {
  for (const v of VIEWS) $(`view-${v}`).classList.toggle('hidden', v !== name);
}

// ── transcript ──────────────────────────────────────────────────
function speakerClass(t: Turn): string {
  if (t.speaker === 'min') return 'min-turn';
  return `s${t.speaker}`;
}

export function renderTurn(t: Turn, onTapSpeaker?: (id: string) => void): HTMLElement {
  const div = el('div', `turn ${speakerClass(t)}`);
  div.dataset.turnId = t.id;
  const tag = el('button', 'speaker-tag', t.speaker === 'min' ? (t.kind === 'correction' ? 'Min · fact check' : 'Min') : speakerLabel(t.speaker));
  if (t.speaker !== 'min' && onTapSpeaker) {
    tag.title = 'Tap to correct the speaker';
    tag.addEventListener('click', () => onTapSpeaker(t.id));
  }
  const text = el('div', 'turn-text', t.text);
  div.append(tag, text);
  if (t.sources?.length) {
    const src = el('div', 'sources');
    for (const s of t.sources) {
      const a = el('a', '', s.title || s.url);
      a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      src.append(a);
    }
    div.append(src);
  }
  return div;
}

export function updateTurnEl(container: HTMLElement, t: Turn): void {
  const existing = container.querySelector<HTMLElement>(`[data-turn-id="${t.id}"] .turn-text`);
  if (existing) existing.textContent = t.text;
}

export function renderInterim(container: HTMLElement, text: string): void {
  let node = container.querySelector<HTMLElement>('.turn.interim');
  if (!text) { node?.remove(); return; }
  if (!node) {
    node = el('div', 'turn interim');
    node.append(el('span', 'speaker-tag', '…'), el('div', 'turn-text', text));
    container.append(node);
  } else {
    const t = node.querySelector('.turn-text');
    if (t) t.textContent = text;
    container.append(node); // keep at bottom
  }
}

export function scrollToBottom(elm: HTMLElement): void {
  elm.scrollTop = elm.scrollHeight;
}

// ── status ──────────────────────────────────────────────────────
export type StatusKind = 'listening' | 'min-active' | 'paused' | 'error';
export function setStatus(kind: StatusKind, text: string): void {
  const pill = $('status-pill');
  pill.className = `status-pill ${kind}`;
  $('status-text').textContent = text;
}

// ── notices ─────────────────────────────────────────────────────
export function showNotice(n: FactNotice): void {
  const area = $('notice-area');
  const div = el('div', 'notice fact');
  div.append(el('strong', '', 'Worth checking: '), document.createTextNode(n.note));
  if (n.sources.length) {
    const a = el('a', '', ` ${n.sources[0].title || 'source'}`);
    a.href = n.sources[0].url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    (a.style as any).color = 'var(--purple)';
    div.append(a);
  }
  area.append(div);
  setTimeout(() => div.remove(), 25_000);
}

export function transientNotice(text: string, ms = 6000): void {
  const area = $('notice-area');
  const div = el('div', 'notice', text);
  area.append(div);
  setTimeout(() => div.remove(), ms);
}

// ── report ──────────────────────────────────────────────────────
export function renderReport(container: HTMLElement, r: Report): void {
  container.textContent = '';
  const section = (title: string, cls = '') => {
    const s = el('div', 'report-section');
    const h = el('h3', cls, title);
    s.append(h);
    container.append(s);
    return s;
  };
  const list = (parent: HTMLElement, items: string[]) => {
    const ul = el('ul');
    for (const it of items) ul.append(el('li', '', it));
    parent.append(ul);
  };

  if (r.degraded) {
    const s = section('Note');
    s.append(el('p', '', r.degraded));
  }
  if (r.summary) { const s = section('What this was about'); s.append(el('p', '', r.summary)); }
  if (r.viewpoints.length) { const s = section('Main viewpoints'); list(s, r.viewpoints); }
  if (r.agreements.length) { const s = section('Where you already agree', 'agree'); list(s, r.agreements); }
  if (r.verifiedFacts.length) {
    const s = section('Verified facts');
    const ul = el('ul');
    for (const f of r.verifiedFacts) {
      const li = el('li', '', f.fact);
      if (f.source) {
        const src = el('span', 'src');
        if (/^https?:\/\//.test(f.source)) {
          const a = el('a', '', f.source.replace(/^https?:\/\//, '').slice(0, 60));
          a.href = f.source; a.target = '_blank'; a.rel = 'noopener noreferrer';
          src.append(a);
        } else src.textContent = f.source;
        li.append(src);
      }
      ul.append(li);
    }
    s.append(ul);
  }
  if (r.disputed.length) { const s = section('Still unsettled'); list(s, r.disputed); }
  if (r.misunderstandings.length) { const s = section('Misunderstandings'); list(s, r.misunderstandings); }
  if (r.coreDisagreement) { const s = section('The core disagreement', 'core'); s.append(el('p', '', r.coreDisagreement)); }
  if (r.commonGround) { const s = section('Possible common ground', 'agree'); s.append(el('p', '', r.commonGround)); }
  if (r.takeaways.length) { const s = section('Takeaways'); list(s, r.takeaways); }
}
