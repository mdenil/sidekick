/**
 * @fileoverview Click-freeze diagnostic instrumentation.
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
 *   - Cap dictation skip-focus path leaving textarea unfocused +
 *     iOS WebView keyboard not honoring tap-to-focus
 *
 * Five complementary signals, all diag-level (off in prod):
 *
 *   [click-diag] pointerdown
 *     Capture-phase. Logs target + body-class flags + first ancestor
 *     with computed pointer-events:none. Fires per tap.
 *
 *   [heartbeat]
 *     1Hz tick. Captures stalls (gap in ticks = page stuck). Includes
 *     body-class flags so we can see what state the page was in
 *     during a freeze even if no pointer events fired.
 *
 *   [body-class]
 *     MutationObserver on <body class>. Logs every flip with the new
 *     class set. Reveals stuck body classes that block clicks even
 *     when no pointerdown happens to coincide with the flip.
 *
 *   [composer-focus]
 *     focus/blur on #composer-input. Tells us whether iOS actually
 *     transitioned focus on a tap (the dictation skip-focus path
 *     leaves the textarea unfocused; tap should focus it but
 *     sometimes doesn't).
 *
 *   [keyboard-vis]
 *     visualViewport.resize. iOS keyboard appears/disappears as a
 *     viewport-height change. Direct signal for "keyboard didn't
 *     show after tap" symptom.
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

  // 1Hz heartbeat — distinguishes "page stalled" from "user wasn't
  // tapping." A gap in heartbeat ticks during a reported freeze means
  // the JS event loop was blocked (worth chasing); steady ticks during
  // a freeze means the page is alive but input was being eaten by
  // something downstream (overlay / focus rejection / WebView gate).
  // The interval also surfaces body-class state on every tick so we
  // see what flags were set during the freeze even with no other events.
  setInterval(() => {
    diag(`[heartbeat] body-flags=${bodyFlags()}`);
  }, 1000);

  // body class flip observer. Fires the moment a class is added or
  // removed from <body>; lets us see (e.g.) ptt-pressing or
  // settings-just-closed flipping on/off independent of pointer events.
  // Some of these flips are nominal lifecycle (memo-mode entry / exit)
  // so the log gets chatty in dev mode — that's fine, we only look
  // at it during a known-bad repro.
  try {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'class') {
          diag(`[body-class] flip → flags=${bodyFlags()}`);
          break;
        }
      }
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  } catch (e: any) {
    diag(`[body-class] observer failed: ${e?.message || e}`);
  }

  // Composer focus/blur — the dictation Cap-skip-focus path is
  // suspected of leaving the textarea unfocused while text streams in,
  // then iOS not honoring tap-to-focus on subsequent taps. Logging
  // both events confirms whether iOS DID transition focus on a tap.
  // Late-bind via a tiny poll because composer markup may render after
  // this init runs.
  const wireFocusListeners = () => {
    const ci = document.getElementById('composer-input') as HTMLTextAreaElement | null;
    if (!ci) return false;
    ci.addEventListener('focus', () => {
      diag(`[composer-focus] focus (active=${document.activeElement === ci})`);
    });
    ci.addEventListener('blur', () => {
      diag(`[composer-focus] blur`);
    });
    return true;
  };
  if (!wireFocusListeners()) {
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if (wireFocusListeners() || tries > 50) clearInterval(t);
    }, 200);
  }

  // Keyboard visibility on iOS surfaces as visualViewport.height
  // shrinking when the keyboard appears (and re-expanding on dismiss).
  // Reports the height delta so we can see whether the keyboard did/
  // didn't appear after a tap that should have triggered it.
  try {
    const vv = (window as any).visualViewport as VisualViewport | undefined;
    if (vv) {
      let lastH = vv.height;
      vv.addEventListener('resize', () => {
        const h = vv.height;
        const delta = Math.round(h - lastH);
        diag(`[keyboard-vis] visualViewport ${Math.round(lastH)}→${Math.round(h)} delta=${delta}`);
        lastH = h;
      });
    } else {
      diag('[keyboard-vis] visualViewport unavailable');
    }
  } catch (e: any) {
    diag(`[keyboard-vis] init failed: ${e?.message || e}`);
  }
}
