/**
 * @fileoverview Swipe-to-open / swipe-to-close drawer (mobile only).
 *
 * Gesture model (mimics ChatGPT iOS):
 *   • Pointerdown anywhere on screen registers intent (opening when
 *     drawer is collapsed, closing when expanded). Nothing else happens
 *     until the gesture is classified.
 *   • Once total displacement crosses MIN_DISTANCE_PX (~3-4 chars, the
 *     minimum that feels intentional), classify as horizontal vs.
 *     vertical: if |dy| >= |dx|, abandon and let the browser scroll;
 *     otherwise commit as a drawer drag and ignore dy from then on.
 *   • The 45° boundary is inclusive of vertical (ties go to vertical
 *     scroll), making the gesture appropriately predisposed to scroll.
 *
 * Snap on release:
 *   • pointerup: velocity (>0.5 px/ms) or position (past widthPx/2)
 *     decides the snap direction.
 *   • pointercancel: iOS Safari standalone-PWA fires this mid-drag for
 *     system-level gestures we can't suppress (edge takeovers, arbiter
 *     handoffs — touch-action: none does NOT stop them). The user was
 *     still actively dragging, so honor the committed direction unless
 *     the last observed motion was a clear reversal.
 *
 * Desktop: no-op (window.innerWidth >= 700).
 */

import { diag } from './util/log.ts';

// ~3-4 character widths in chat font; the minimum motion that feels
// like a deliberate drag rather than a tap or scroll wobble.
const MIN_DISTANCE_PX = 30;
const VELOCITY_SNAP_PX_MS = 0.5;
const SNAP_DURATION_MS = 180;
const MOBILE_BREAKPOINT_PX = 700;

/** Bail the gesture entirely if the touch landed on something that
 *  owns horizontal motion natively. Two cases:
 *    1. Text inputs (textarea / input / contenteditable) — drag = caret
 *       /selection range; iOS's text selection requires touch-action to
 *       stay default, but body.swipe-active sets touch-action:none.
 *    2. Range sliders — drag = value. Same touch-action conflict.
 *    3. Anything inside a horizontal-scrollable container (pre/code,
 *       wide tables) — drag = scrollLeft.
 *  Faster to short-circuit at pointerdown than to detect the conflict
 *  mid-gesture. */
function targetOwnsHorizontalMotion(target: EventTarget | null): boolean {
  let el = target as Element | null;
  if (!el) return false;
  while (el && el !== document.body) {
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLInputElement) {
      // Range sliders use horizontal drag for value; text/url/search/etc.
      // use it for caret. checkbox/radio/button are point-only — fine.
      const t = el.type;
      if (t === 'range' || t === 'text' || t === 'search'
          || t === 'url' || t === 'email' || t === 'tel'
          || t === 'password' || t === 'number') return true;
    }
    if (el instanceof HTMLElement && el.isContentEditable) return true;
    // Horizontal-scrollable container — pre/code blocks (app.css:1488),
    // wide tables. Cheap check: computed overflow-x.
    if (el instanceof HTMLElement) {
      const ox = getComputedStyle(el).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth) return true;
    }
    el = el.parentElement;
  }
  return false;
}

interface SwipeOptions {
  setExpanded: (exp: boolean) => void;
  isExpanded: () => boolean;
}

export function init(opts: SwipeOptions): void {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  type Intent = 'opening' | 'closing';
  let intent: Intent | null = null;
  let pointerId = -1;
  let committed = false;
  let startX = 0, startY = 0;
  let lastX = 0, lastT = 0;
  let widthPx = 280;
  // Most recent move's instantaneous velocity (px/ms). Used on
  // pointercancel since the cancel event itself has bogus clientX
  // and we can't compute velocity from it.
  let lastVelocity = 0;

  const isMobile = () => window.innerWidth < MOBILE_BREAKPOINT_PX;
  const measureWidth = () => sidebar.getBoundingClientRect().width || 280;

  const setInlineTransform = (translatePx: number) => {
    sidebar.style.transition = 'none';
    sidebar.style.transform = `translateX(${translatePx}px)`;
  };

  // Toggles `body.swipe-active`, whose CSS rule sets `touch-action:
  // none !important` on body and every descendant. Two roles:
  //   - Pre-commit: iOS classification protection. Originally we set
  //     this at pointerdown so iOS couldn't classify the first
  //     pointermoves as scroll. Modern WebKit (iOS 16+) honors
  //     preventDefault on pointermove (passive: false) reliably,
  //     which already does the same job. Setting at pointerdown
  //     was belt-and-suspenders that turned every tap into a
  //     potential stuck-class bug if pointerup was lost.
  //   - Post-commit: prevents iOS from firing pointercancel on
  //     vertical drift during a committed horizontal swipe. THIS is
  //     the role we still need.
  //
  // Field bug 2026-05-10 (Jonathan): the eager lock + iOS occasionally
  // dropping pointerup left swipe-active stuck → UI frozen for 2s
  // until the safety-net poll caught it. Fix: lazy lock — set ONLY
  // at the commit transition in onPointerMove. Taps never set it
  // (pointerdown alone doesn't trigger), so the stuck-class bug
  // can't happen on taps. The narrow surface that remains is
  // "committed swipe loses pointerup" — the safety nets below
  // handle that residual case.
  //
  // lockSetAt: timestamp ms when the lock was last applied. Lets the
  // poll-cleanup distinguish "lock just set, gesture in flight" from
  // "lock has been on for ages, must be stuck". Set to 0 when cleared.
  let lockSetAt = 0;
  const setSwipeLock = (lock: boolean) => {
    const had = document.body.classList.contains('swipe-active');
    document.body.classList.toggle('swipe-active', lock);
    if (lock && !had) {
      lockSetAt = Date.now();
      diag('[swipe-lock] set (intent=' + intent + ')');
    } else if (!lock && had) {
      lockSetAt = 0;
      diag('[swipe-lock] clear (normal)');
    }
  };

  const snap = (open: boolean) => {
    const target = open ? 0 : -widthPx;
    sidebar.style.transition = `transform ${SNAP_DURATION_MS}ms ease`;
    sidebar.style.transform = `translateX(${target}px)`;

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      sidebar.removeEventListener('transitionend', onEnd);
      sidebar.style.transform = '';
      sidebar.style.transition = '';
      setSwipeLock(false);
      opts.setExpanded(open);
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.propertyName === 'transform') cleanup();
    };
    sidebar.addEventListener('transitionend', onEnd);
    setTimeout(cleanup, SNAP_DURATION_MS + 60);
  };

  const reset = () => {
    intent = null;
    committed = false;
    pointerId = -1;
    lastVelocity = 0;
    setSwipeLock(false);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (intent) return;
    if (!isMobile()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    // If the touch started on the right-side pin drawer, the gesture
    // is its concern — not ours. Without this, swipes on the pin
    // drawer (when both panels are open) fall through to the sidebar
    // open-from-anywhere handler and post the sidebar underneath
    // (Jonathan field bug 2026-05-12). Mirrors Jonathan's invariant
    // ("whoever came out most recently is on top, swipes act on the
    // top panel") — once the pin drawer has its own swipe-to-close
    // handler, this bail lets that handler receive the gesture cleanly.
    const targetEl = e.target as Element | null;
    if (targetEl?.closest?.('#pin-drawer')) return;

    // Bail on inputs / sliders / horizontal-scrollables BEFORE applying
    // the swipe-lock CSS class. Otherwise the lock disables iOS's
    // native text-selection / range-drag / horizontal-scroll, even if
    // the gesture later gets rejected on direction (the user has
    // already missed the first frames of selection / drag / scroll).
    if (targetOwnsHorizontalMotion(e.target)) return;

    const expanded = opts.isExpanded();

    if (!expanded) {
      // Open-drawer gesture engages from anywhere on screen (matches
      // ChatGPT iOS app affordance — no edge requirement). What
      // protects content interactions is `targetOwnsHorizontalMotion`
      // above, which bails before swipe-lock applies. Anything else
      // (transcript, agent bubbles, system rows, etc.) drags the
      // drawer in.
      intent = 'opening';
    } else {
      if (!sidebar.contains(e.target as Node)) return;
      intent = 'closing';
    }

    pointerId = e.pointerId;
    startX = e.clientX; lastX = e.clientX;
    startY = e.clientY;
    lastT = e.timeStamp;
    widthPx = measureWidth() || 280;
    committed = false;
    // NO setSwipeLock(true) here — moved to the commit transition in
    // onPointerMove. Taps never call setSwipeLock; vertical scrolls
    // never call setSwipeLock; only confirmed horizontal swipes do.
    // This eliminates the stuck-class freeze that happens when
    // pointerup is lost on a tap. See the lazy-lock comment block
    // above setSwipeLock for full rationale.
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!intent || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!committed) {
      // Pre-commit: preventDefault on every pointermove so iOS
      // doesn't start scroll-classification before we know which
      // direction the user is going. Modern WebKit honors this with
      // passive: false; it replaces the older body.swipe-active
      // belt-and-suspenders that used to fire at pointerdown.
      if (e.cancelable) e.preventDefault();

      if (dx * dx + dy * dy < MIN_DISTANCE_PX * MIN_DISTANCE_PX) return;
      if (Math.abs(dy) >= Math.abs(dx)) { reset(); return; }
      if (intent === 'opening' && dx <= 0) { reset(); return; }
      if (intent === 'closing' && dx >= 0) { reset(); return; }

      // Confirmed horizontal swipe — lock now. Prevents iOS from
      // dispatching pointercancel on vertical drift during the
      // committed gesture. This is the EARLIEST point we know we
      // need the lock; setting it any earlier would risk leaking
      // it on a tap or vertical-scroll that never gets here.
      setSwipeLock(true);
      if (intent === 'opening') {
        widthPx = 280;
        setInlineTransform(Math.max(-widthPx, Math.min(0, -widthPx + dx)));
        opts.setExpanded(true);
      } else {
        widthPx = measureWidth() || 280;
        setInlineTransform(Math.max(-widthPx, Math.min(0, dx)));
      }
      committed = true;
      sidebar.setPointerCapture?.(pointerId);
    } else {
      const translatePx = intent === 'opening'
        ? Math.max(-widthPx, Math.min(0, -widthPx + dx))
        : Math.max(-widthPx, Math.min(0, dx));
      setInlineTransform(translatePx);
    }

    if (committed && e.cancelable) e.preventDefault();

    const dt = Math.max(1, e.timeStamp - lastT);
    lastVelocity = (e.clientX - lastX) / dt;
    lastX = e.clientX;
    lastT = e.timeStamp;
  };

  const onPointerEnd = (e: PointerEvent) => {
    if (!intent || e.pointerId !== pointerId) return;
    const wasCommitted = committed;
    const wasIntent = intent;
    sidebar.releasePointerCapture?.(pointerId);
    reset();

    if (!wasCommitted) return;

    const isCancel = e.type === 'pointercancel';
    const finalX = isCancel ? lastX : e.clientX;
    const dx = finalX - startX;
    const dt = Math.max(1, e.timeStamp - lastT);
    const velocity = isCancel ? lastVelocity : (e.clientX - lastX) / dt;

    let openFinal: boolean;
    if (isCancel) {
      // iOS yanked the gesture; user was still dragging. Honor the
      // committed direction unless the last motion was a clear reversal.
      const reversing = wasIntent === 'opening'
        ? velocity < -VELOCITY_SNAP_PX_MS
        : velocity > VELOCITY_SNAP_PX_MS;
      openFinal = reversing
        ? wasIntent !== 'opening'
        : wasIntent === 'opening';
    } else if (wasIntent === 'opening') {
      if (velocity > VELOCITY_SNAP_PX_MS) openFinal = true;
      else if (velocity < -VELOCITY_SNAP_PX_MS) openFinal = false;
      else openFinal = dx > widthPx / 2;
    } else {
      if (velocity < -VELOCITY_SNAP_PX_MS) openFinal = false;
      else if (velocity > VELOCITY_SNAP_PX_MS) openFinal = true;
      else openFinal = dx > -widthPx / 2;
    }
    snap(openFinal);
  };

  window.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerEnd);
  window.addEventListener('pointercancel', onPointerEnd);

  // Defensive cleanup paths — the body.swipe-active CSS rule sets
  // `touch-action: none !important` on body and ALL descendants while
  // the lock is held. Normally cleared on pointerup/cancel or on
  // snap()'s transitionend, but if any of those fire-and-forget paths
  // break (iOS swallows pointerup, app backgrounded mid-gesture,
  // exception in transitionend, gesture handed off to a different
  // page), the class stays on body and the entire app becomes
  // unscrollable until reload. Field-reported by Jonathan 2026-05-09:
  // "chat scroll freezes and can't scroll" intermittently.
  //
  // Three safety nets, all idempotent:
  //   1. visibilitychange → on tab/app return-to-foreground, clear.
  //      Covers the "backgrounded mid-gesture" and iOS task-switch
  //      cases where pointer events get lost across the suspend.
  //   2. Stale-state check on the next pointerdown — if body still
  //      has swipe-active before we set it, something previously got
  //      stuck; clear it then re-evaluate normally.
  //   3. Safety timeout — if a real swipe is in progress it'll clear
  //      via the normal path within ~500ms. If the lock has been on
  //      for >2s with no activity, force-clear.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && document.body.classList.contains('swipe-active')) {
      const ageMs = lockSetAt ? Date.now() - lockSetAt : -1;
      diag('[swipe-lock] clear (visibilitychange, ageMs=' + ageMs + ')');
      document.body.classList.remove('swipe-active');
      lockSetAt = 0;
    }
  });
  // Wrap onPointerDown to clear stale lock before honoring the new
  // gesture. Don't muck with the original handler logic; just
  // pre-clean if we detect leftover state. Age-based, NOT intent-
  // based — see the 2s poll comment below for why.
  window.addEventListener('pointerdown', () => {
    if (!document.body.classList.contains('swipe-active')) return;
    const ageMs = lockSetAt ? Date.now() - lockSetAt : -1;
    // Allow ~500ms grace for legitimate gestures (snap animation
    // is 180ms, plus event-loop tick slack). If older, force-clear.
    if (ageMs >= 0 && ageMs < 500) return;
    diag('[swipe-lock] clear (capture-pointerdown, ageMs=' + ageMs + ', intent=' + intent + ')');
    document.body.classList.remove('swipe-active');
    lockSetAt = 0;
    // Reset gesture state too — if intent was stuck non-null, the
    // next gesture's bail-out path would never run because
    // `if (intent) return` at the top of onPointerDown short-circuits
    // before re-locking. Clearing here lets the next pointerdown
    // start fresh.
    intent = null;
    committed = false;
    pointerId = -1;
  }, { passive: true, capture: true });
  // Last-resort timeout. Polls every 2s; if the lock has been on for
  // longer than that, force-clear regardless of `intent` state.
  //
  // FIELD BUG 2026-05-10 (Jonathan): the prior `intent === null` guard
  // here was a footgun. If a pointerdown set intent='opening' (e.g. a
  // tap on the settings-close button — sidebarSwipe listens globally)
  // and the matching pointerup never reached onPointerEnd cleanly
  // (close-button removed from DOM mid-gesture, focus shift, iOS
  // synthetic-event quirk), `intent` stayed stuck at 'opening' AND
  // swipe-active stayed on. The 2s poll's `intent === null` check
  // skipped clearing because state-machine said "gesture in progress."
  // UI froze for the whole duration the user kept tapping.
  //
  // Age-based check eliminates the dependency on the state-machine
  // self-reporting correctly. If the lock has been on >2s, the
  // gesture is stuck regardless of what intent says — clear and
  // reset state. Snap animations are 180ms + slack, so 2s is well
  // beyond any legitimate in-flight gesture.
  setInterval(() => {
    if (!document.body.classList.contains('swipe-active')) return;
    const ageMs = lockSetAt ? Date.now() - lockSetAt : -1;
    if (ageMs >= 0 && ageMs < 2000) return;
    diag('[swipe-lock] clear (poll-2s, ageMs=' + ageMs + ', intent=' + intent + ')');
    document.body.classList.remove('swipe-active');
    lockSetAt = 0;
    intent = null;
    committed = false;
    pointerId = -1;
  }, 2000);
}
