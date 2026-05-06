/**
 * @fileoverview Drag-from-track behavior for range sliders, primarily a
 * fix for iOS Safari.
 *
 * Native `<input type=range>` on iOS handles touchstart-on-track as
 * "jump value to that point" but does NOT continue tracking the finger
 * if it's still down — the user has to lift, find the thumb, then drag
 * from there. With the small native thumb that's an awful UX.
 *
 * Fix: on pointerdown anywhere on the slider, jump value AND set pointer
 * capture so subsequent pointermove events arrive at this slider
 * regardless of finger drift. Pointer capture also prevents the gesture
 * from being claimed by the parent's vertical scroll, which was eating
 * drags inside the bottom-sheet on iOS.
 *
 * Wires once, idempotent: re-calling on the same root scans for sliders
 * that don't already have the data-pointer-drag flag set, leaving
 * already-wired ones alone. Cheap to call after schema/menu rebuilds.
 */

/** Wire pointer-capture drag onto every range slider under `root`.
 *  Pass `document` to wire the whole page. */
export function attachSliderTouchAll(root: ParentNode = document): void {
  const sliders = root.querySelectorAll<HTMLInputElement>('input[type="range"]');
  for (const el of Array.from(sliders)) {
    if (el.dataset.pointerDrag === '1') continue;
    el.dataset.pointerDrag = '1';
    attachOne(el);
  }
}

function attachOne(slider: HTMLInputElement): void {
  // Pointer down: capture this pointer to the slider so subsequent moves
  // arrive here regardless of where the finger drifts. Also nudge value
  // toward the touch x — the browser's default jump-to-value already
  // does this, but we set it again from a known geometry to be robust
  // against vendor differences.
  slider.addEventListener('pointerdown', (e: PointerEvent) => {
    // Don't fight the native thumb-grab path on mouse — pointer capture
    // there is fine but unnecessary. Only intervene for touch / pen.
    if (e.pointerType === 'mouse') return;
    try {
      slider.setPointerCapture(e.pointerId);
    } catch { /* some browsers don't support this — fail open */ }
    updateFromPointer(slider, e.clientX);
  });
  slider.addEventListener('pointermove', (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    // Only track if we have capture (i.e. pointerdown originated on us).
    if (!slider.hasPointerCapture(e.pointerId)) return;
    updateFromPointer(slider, e.clientX);
  });
  slider.addEventListener('pointerup', (e: PointerEvent) => {
    try { slider.releasePointerCapture(e.pointerId); } catch {}
  });
  slider.addEventListener('pointercancel', (e: PointerEvent) => {
    try { slider.releasePointerCapture(e.pointerId); } catch {}
  });
}

function updateFromPointer(slider: HTMLInputElement, clientX: number): void {
  const rect = slider.getBoundingClientRect();
  if (rect.width <= 0) return;
  const min = parseFloat(slider.min || '0');
  const max = parseFloat(slider.max || '100');
  const step = parseFloat(slider.step || '1') || 1;
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  let value = min + (max - min) * ratio;
  // Snap to step grid.
  value = Math.round((value - min) / step) * step + min;
  value = Math.max(min, Math.min(max, value));
  const str = String(value);
  if (slider.value === str) return;
  slider.value = str;
  // Fire the same event chain a native interaction would — listeners
  // (settings.ts hydrate handlers, the inline range val span updaters,
  // etc.) all hang off `input` and `change`.
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  slider.dispatchEvent(new Event('change', { bubbles: true }));
}
