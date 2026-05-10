/**
 * @fileoverview Click-freeze diagnostic — capture-phase pointerdown logger.
 *
 * Field bug: tapping buttons becomes dead while the rest of the app
 * still appears responsive. Reload fixes. Sometimes co-occurs with the
 * scroll-freeze (body.swipe-active stuck) but not always — `swipe-active`
 * sets `touch-action: none !important` which kills scroll/pan but does
 * NOT kill clicks, so an additional mechanism is intercepting taps.
 *
 * Likely culprits (none yet confirmed):
 *   - Stuck `pointer-events: none` on a fullscreen overlay
 *   - `.settings-just-closed` 350ms timeout that didn't fire
 *   - `.settings-modal-open` left on after dismiss
 *   - Pocket-lock overlay engaged
 *   - `.voice-active` / `body.ptt-pressing` on without state to match
 *
 * What this captures: every pointerdown anywhere on the app, in
 * capture phase (so it sees the event before any other listener).
 * Logs: target tag/id/class, the body classes that act as global
 * gates, and the computed `pointer-events` walking up the ancestor
 * chain. When the user taps a "should respond" element and clicks
 * are dead, one log line will reveal which ancestor has
 * `pointer-events: none` (or that the chain is clean and the freeze
 * is something else).
 *
 * Diag-level only — does nothing in production unless dev mode is on.
 */

import { diag } from './util/log.ts';

const BODY_FLAGS = [
  'swipe-active',
  'settings-modal-open',
  'settings-just-closed',
  'voice-active',
  'ptt-pressing',
  'sidebar-resizing',
  'pocket-locked',
  'pocket-locked-tutorial',
] as const;

function describeTarget(t: EventTarget | null): string {
  if (!(t instanceof Element)) return '?';
  const tag = t.tagName.toLowerCase();
  const id = t.id ? `#${t.id}` : '';
  const cls = (t as HTMLElement).className;
  const clsStr = typeof cls === 'string' && cls
    ? '.' + cls.split(/\s+/).filter(Boolean).slice(0, 4).join('.')
    : '';
  return tag + id + clsStr;
}

function bodyFlags(): string {
  const set = new Set(document.body.classList);
  const on = BODY_FLAGS.filter(f => set.has(f));
  return on.length ? on.join(',') : '(none)';
}

/** Walk up from `start` to <body>, finding the first ancestor whose
 *  computed `pointer-events` is `none`. Most clicks-dead bugs are a
 *  stuck full-screen overlay or a body class with this style — this
 *  pinpoints which. Returns null if the whole chain is clickable. */
function firstPointerEventsNone(start: Element | null): string | null {
  let el: Element | null = start;
  let depth = 0;
  while (el && el !== document.body && depth < 30) {
    try {
      const pe = getComputedStyle(el).pointerEvents;
      if (pe === 'none') return `${describeTarget(el)} (pe=none, depth=${depth})`;
    } catch { /* noop */ }
    el = el.parentElement;
    depth++;
  }
  // Body itself
  try {
    if (document.body && getComputedStyle(document.body).pointerEvents === 'none') {
      return `body (pe=none)`;
    }
  } catch { /* noop */ }
  return null;
}

let installed = false;

export function init(): void {
  if (installed) return;
  installed = true;
  // Capture phase: runs before any per-element listener, so we see
  // events even if some downstream listener calls stopPropagation.
  // Passive: we never preventDefault here. This must NOT alter
  // behavior — it's pure observation.
  window.addEventListener('pointerdown', (e: PointerEvent) => {
    const target = e.target as Element | null;
    const blocker = firstPointerEventsNone(target);
    const tag = describeTarget(target);
    const flags = bodyFlags();
    const blockerStr = blocker ? ` blocked-by=${blocker}` : '';
    diag(`[click-diag] pointerdown target=${tag} body-flags=${flags}${blockerStr}`);
  }, { capture: true, passive: true });
}
