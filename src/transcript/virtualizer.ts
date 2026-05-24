/**
 * @fileoverview Phase 1 — transcript virtualizer scaffolding.
 *
 * Pure window-math + per-spec height cache + DOM-binding factory. No
 * consumers yet — main.ts / sessionResume / chat.ts still drive the
 * reconciler directly against #transcript. Phase 2 will route them
 * through bindVirtualizer behind a feature flag.
 *
 * Layering (current):
 *
 *   transcriptStore  ──► projection  ──► reconciler ──► #transcript
 *
 * Layering (post Phase 5):
 *
 *   transcriptStore  ──► projection  ──► virtualizer ──► renderWindow ──► #transcript
 *                                          │
 *                                          ├── heightCache
 *                                          └── visibleWindow math + spacers
 *
 * The virtualizer owns:
 *   - heightCache: Map<key, measuredHeightPx>; per-kind defaults for
 *     uncached entries (Phase 2 will populate via ResizeObserver on
 *     first mount).
 *   - visible-window state derived from cache + scrollTop + viewport.
 *   - synthetic spacer divs that pad scrollHeight so the browser
 *     scrollbar tracks the full virtual list, not just the rendered
 *     window.
 *
 * The virtualizer does NOT own:
 *   - transcriptStore (canonical source of truth — out of scope).
 *   - projection (also out of scope; produces BubbleSpec[] verbatim).
 *   - bubble DOM creation (reconciler.reconcile is the renderWindow
 *     implementation in Phase 2+).
 *
 * Anchor model: scroll position is captured as `{messageKey, offsetPx}`
 * (the topmost partially-visible spec + its top's pixel offset relative
 * to viewport top). This is invariant under height changes anywhere ELSE
 * in the chat: late image loads / tool-row expansions adjust the
 * spacers but not the anchored spec's relative position. Restore-on-
 * switch reads the anchor and recomputes scrollTop from current heights
 * — that's the long-term fix to the partial-render at-edge bug that
 * `9420f77`'s atBottom flag patched at the heuristic level.
 *
 * All pure functions (`computeVisibleWindow`, `computeAnchor`,
 * `scrollTopForAnchor`) take their inputs explicitly so they're
 * exhaustively unit-testable with no DOM dependency. The DOM-binding
 * `bindVirtualizer` factory is the small wrapper that ties them to a
 * real element.
 */

import type { BubbleSpec } from './types.ts';

/** Per-kind default heights used when a spec isn't in the cache yet.
 *  Wrong-but-bounded: real measurements drift in within a frame of first
 *  paint via the ResizeObserver Phase 2 wires up. These exist so the
 *  initial scrollHeight estimate is roughly the right shape — a long
 *  chat doesn't render with a 50px scrollbar then jump to 12000px
 *  once measurements catch up. */
const DEFAULT_HEIGHTS: Record<BubbleSpec['kind'], number> = {
  user: 80,
  assistant: 160,
  notification: 60,
  activityRow: 80,
};

/** Number of specs to render above and below the strictly-visible
 *  window. Covers fast-scroll jitter — when the user flicks, the next
 *  rerender lands before the freshly-visible specs are blank.
 *  6-each-side ≈ 1 viewport of nominal-height bubbles. */
const DEFAULT_OVERSCAN = 6;

/** Scroll-restore handoff between save site (getAnchor) and restore
 *  site (restoreAnchor). The same shape will be persisted to IDB in
 *  Phase 3 when chatScrollPositions migrates from raw scrollTop. */
export interface SavedAnchor {
  /** BubbleSpec.key of the spec the saved position anchored to. */
  key: string;
  /** Pixel offset of the anchor spec's top relative to the viewport
   *  top at save time. Positive means the spec's top is ABOVE the
   *  viewport top (i.e. the user has scrolled into the bubble). */
  offsetPx: number;
}

export interface VisibleWindow {
  /** Inclusive start index into the specs array. */
  visibleFrom: number;
  /** Exclusive end index. specs.slice(visibleFrom, visibleTo) is the
   *  rendered window (including overscan). */
  visibleTo: number;
  /** Sum of heights of specs[0..visibleFrom). Drives top spacer. */
  topSpacerPx: number;
  /** Sum of heights of specs[visibleTo..specs.length). Drives bottom spacer. */
  bottomSpacerPx: number;
}

export interface HeightCache {
  /** Return measured height for `key`, or the per-kind default if
   *  unmeasured. Never throws; never returns NaN. */
  get(key: string, kind: BubbleSpec['kind']): number;
  /** Record a measured height (floored, clamped ≥0). */
  set(key: string, heightPx: number): void;
  /** Drop a measurement — used on unmount. */
  delete(key: string): void;
  /** Drop all — used on chat switch. */
  clear(): void;
  /** Iterate measured (key, px) pairs for snapshot serialization. */
  entries(): IterableIterator<[string, number]>;
}

export function createHeightCache(): HeightCache {
  const map = new Map<string, number>();
  return {
    get(key, kind) {
      const v = map.get(key);
      return typeof v === 'number' ? v : DEFAULT_HEIGHTS[kind];
    },
    set(key, heightPx) {
      map.set(key, Math.max(0, Math.floor(heightPx)));
    },
    delete(key) { map.delete(key); },
    clear() { map.clear(); },
    entries() { return map.entries(); },
  };
}

/** Compute which specs intersect the viewport (with overscan), plus
 *  the cumulative height above and below. Pure — no DOM access, no
 *  module state. */
export function computeVisibleWindow(args: {
  specs: BubbleSpec[];
  cache: HeightCache;
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
}): VisibleWindow {
  const { specs, cache, scrollTop, viewportHeight } = args;
  const overscan = args.overscan ?? DEFAULT_OVERSCAN;

  if (specs.length === 0) {
    return { visibleFrom: 0, visibleTo: 0, topSpacerPx: 0, bottomSpacerPx: 0 };
  }

  const viewportBottom = scrollTop + viewportHeight;

  // Single pass: track cumulative top of spec[i] in `topPx`. The first
  // spec whose bottom edge passes the viewport top is firstVisible;
  // the first spec whose top edge is at-or-past the viewport bottom
  // ends the visible range.
  let topPx = 0;
  let firstVisible = -1;
  let firstAfter = specs.length;

  for (let i = 0; i < specs.length; i++) {
    const h = cache.get(specs[i].key, specs[i].kind);
    if (firstVisible < 0 && topPx + h > scrollTop) {
      firstVisible = i;
    }
    if (firstVisible >= 0 && topPx >= viewportBottom) {
      firstAfter = i;
      break;
    }
    topPx += h;
  }
  // scrollTop past the end of all content: render the trailing overscan
  // window so the bottom is "ready" if the user scrolls up.
  if (firstVisible < 0) firstVisible = specs.length;

  const visibleFrom = Math.max(0, firstVisible - overscan);
  const visibleTo = Math.min(specs.length, firstAfter + overscan);

  let topSpacerPx = 0;
  for (let i = 0; i < visibleFrom; i++) {
    topSpacerPx += cache.get(specs[i].key, specs[i].kind);
  }
  let bottomSpacerPx = 0;
  for (let i = visibleTo; i < specs.length; i++) {
    bottomSpacerPx += cache.get(specs[i].key, specs[i].kind);
  }

  return { visibleFrom, visibleTo, topSpacerPx, bottomSpacerPx };
}

/** Identify the topmost spec the viewport intersects and the offset of
 *  that spec's top relative to the viewport top. Used to capture an
 *  anchor for scroll-restore that survives layout shift elsewhere in
 *  the chat. Pure. */
export function computeAnchor(args: {
  specs: BubbleSpec[];
  cache: HeightCache;
  scrollTop: number;
}): SavedAnchor | null {
  const { specs, cache, scrollTop } = args;
  if (specs.length === 0) return null;
  let topPx = 0;
  for (let i = 0; i < specs.length; i++) {
    const h = cache.get(specs[i].key, specs[i].kind);
    if (topPx + h > scrollTop) {
      return { key: specs[i].key, offsetPx: scrollTop - topPx };
    }
    topPx += h;
  }
  // scrollTop past total content: anchor on the last spec at its base.
  return { key: specs[specs.length - 1].key, offsetPx: 0 };
}

/** Inverse of `computeAnchor`: given an anchor + current spec heights,
 *  compute the scrollTop that places the anchor spec at its saved
 *  offset. Returns null if the anchor's key isn't in `specs` (caller
 *  falls back to bottom or default). Pure. */
export function scrollTopForAnchor(args: {
  specs: BubbleSpec[];
  cache: HeightCache;
  anchor: SavedAnchor;
}): number | null {
  const { specs, cache, anchor } = args;
  let topPx = 0;
  for (let i = 0; i < specs.length; i++) {
    if (specs[i].key === anchor.key) {
      return Math.max(0, topPx + anchor.offsetPx);
    }
    topPx += cache.get(specs[i].key, specs[i].kind);
  }
  return null;
}

// ── DOM-binding factory ───────────────────────────────────────────────

const SLOT_CLASS = 'transcript-slot';
const SPACER_TOP_CLASS = 'transcript-spacer-top';
const SPACER_BOTTOM_CLASS = 'transcript-spacer-bottom';

export interface VirtualizerOpts {
  /** The scrollable element. Phase 2 binds this to `#transcript`. */
  transcriptEl: HTMLElement;
  /** Caller-supplied render: paint `specs` into `slotEl`. Phase 2 will
   *  pass `reconciler.reconcile`. Stays pluggable so the unit + dev
   *  tests can supply a stub without dragging in the projection model. */
  renderWindow: (slotEl: HTMLElement, specs: BubbleSpec[]) => void;
  /** Specs above/below the strictly-visible window to keep mounted.
   *  Defaults to 6 each side (≈1 viewport of nominal bubbles). */
  overscan?: number;
}

export interface VirtualizerHandle {
  /** Set the current spec list. Recomputes the visible window and
   *  invokes renderWindow with the slice. */
  setSpecs(specs: BubbleSpec[]): void;
  /** Scroll so the spec with this key is visible. block='start' aligns
   *  its top to the viewport top; block='center' centers it. No-op if
   *  the key isn't in the current spec list. */
  scrollToKey(key: string, opts?: { block?: 'start' | 'center' }): void;
  /** Capture the current anchor (key + offsetPx) for later restore. */
  getAnchor(): SavedAnchor | null;
  /** Apply a previously-captured anchor. Returns true if the anchor
   *  key was found in the current specs; false means caller should
   *  fall back (e.g. scroll to bottom). */
  restoreAnchor(anchor: SavedAnchor): boolean;
  /** Distance from the live edge ≤ thresholdPx. */
  isPinnedToBottom(thresholdPx?: number): boolean;
  /** Scroll to the absolute bottom. */
  scrollToBottom(behavior?: ScrollBehavior): void;
  /** Direct access to the height cache. Phase 2's ResizeObserver
   *  writes through this; Phase 4's snapshot path reads `entries()`. */
  getHeightCache(): HeightCache;
  /** Tear down DOM + listeners. Tests use this; production never
   *  unbinds (the transcript element lives for the app's lifetime). */
  dispose(): void;
}

/** Bind a virtualizer to a transcript element. Sets up `topSpacer`,
 *  `slot`, `bottomSpacer` as children of `transcriptEl` (wiping any
 *  prior content — caller must ensure nothing else writes here on
 *  the virtualized path). setSpecs windows + rerenders; scroll events
 *  trigger a debounced rerender via requestAnimationFrame.
 *
 *  Height measurement (Decision 1A from the design doc): each visible
 *  bubble is observed by a ResizeObserver. The RO callback updates
 *  the height cache and schedules a rerender so spacer heights stay
 *  in sync. Bubbles unmounted on the next windowing pass naturally
 *  drop out of the observation set when the RO is replaced. */
export function bindVirtualizer(opts: VirtualizerOpts): VirtualizerHandle {
  const { transcriptEl, renderWindow } = opts;
  const overscan = opts.overscan ?? DEFAULT_OVERSCAN;
  const cache = createHeightCache();
  let currentSpecs: BubbleSpec[] = [];

  transcriptEl.innerHTML = '';
  const topSpacer = document.createElement('div');
  topSpacer.className = SPACER_TOP_CLASS;
  topSpacer.style.height = '0px';
  const slot = document.createElement('div');
  slot.className = SLOT_CLASS;
  // Disable the browser's scroll-anchoring inside the slot. By default
  // browsers preserve the user's visible content when DOM mutations
  // happen above the viewport — for the reconciler's insertBefore
  // at slot[0] during window expansion (user scrolling up), the
  // browser bumps scrollTop by the inserted bubble's height to
  // "keep the user where they are visually." For a traditional chat
  // that's right, but in a virtualizer the inserted bubble's content
  // is intended to BE the newly-visible content above — we want the
  // user's wheel to reach it, not have scrollTop chase the insertion
  // upward forever. overflow-anchor: none disables that preservation
  // for the slot's mutations specifically; the transcript element
  // itself keeps default anchoring.
  slot.style.overflowAnchor = 'none';
  const bottomSpacer = document.createElement('div');
  bottomSpacer.className = SPACER_BOTTOM_CLASS;
  bottomSpacer.style.height = '0px';
  transcriptEl.appendChild(topSpacer);
  transcriptEl.appendChild(slot);
  transcriptEl.appendChild(bottomSpacer);

  // ResizeObserver wires the per-bubble height cache. One observer
  // for the whole slot — its callback fires once per frame with a
  // batch of changed entries, which is cheaper than N observers.
  // `typeof` guard for older browsers / non-DOM test contexts.
  const ro: ResizeObserver | null = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver((entries) => {
        let any = false;
        for (const entry of entries) {
          const target = entry.target as HTMLElement;
          const key = target.getAttribute('data-key');
          if (!key) continue;
          // contentBoxSize includes padding/border per the spec; we
          // want the FULL outer height that contributes to scrollHeight.
          // borderBoxSize is exactly that.
          const box = entry.borderBoxSize?.[0];
          const heightPx = box
            ? box.blockSize
            : (entry.contentRect?.height ?? target.offsetHeight);
          const prev = cache.get(key, 'user');  // kind doesn't matter for ===
          const floored = Math.max(0, Math.floor(heightPx));
          if (prev !== floored) {
            cache.set(key, floored);
            any = true;
          }
        }
        if (any) scheduleRerender();
      })
    : null;

  /** Re-observe the current slot children. Cheap: we disconnect + re-
   *  add. RO doesn't expose a "currently observing" set, and the
   *  child-set churn per rerender is bounded by the visible-window
   *  size (~viewport-ful + overscan). */
  function syncObservations(): void {
    if (!ro) return;
    ro.disconnect();
    for (const child of Array.from(slot.children) as HTMLElement[]) {
      if (child.hasAttribute('data-key')) ro.observe(child);
    }
  }

  function rerender(): void {
    const win = computeVisibleWindow({
      specs: currentSpecs,
      cache,
      scrollTop: transcriptEl.scrollTop,
      viewportHeight: transcriptEl.clientHeight,
      overscan,
    });
    topSpacer.style.height = `${win.topSpacerPx}px`;
    bottomSpacer.style.height = `${win.bottomSpacerPx}px`;
    renderWindow(slot, currentSpecs.slice(win.visibleFrom, win.visibleTo));
    syncObservations();
  }

  // Coalesce scroll-driven rerenders to one per animation frame —
  // wheel + touchmove fire dozens of scroll events per second and
  // each would otherwise compute window math + invoke renderWindow.
  let rerenderQueued = false;
  function scheduleRerender(): void {
    if (rerenderQueued) return;
    rerenderQueued = true;
    requestAnimationFrame(() => {
      rerenderQueued = false;
      rerender();
    });
  }
  transcriptEl.addEventListener('scroll', scheduleRerender, { passive: true });

  return {
    setSpecs(specs) {
      currentSpecs = specs;
      rerender();
    },
    scrollToKey(key, opts = {}) {
      const i = currentSpecs.findIndex(s => s.key === key);
      if (i < 0) return;
      let topPx = 0;
      for (let j = 0; j < i; j++) {
        topPx += cache.get(currentSpecs[j].key, currentSpecs[j].kind);
      }
      const itemHeight = cache.get(currentSpecs[i].key, currentSpecs[i].kind);
      const targetTop = opts.block === 'center'
        ? topPx - (transcriptEl.clientHeight - itemHeight) / 2
        : topPx;
      transcriptEl.scrollTo({ top: Math.max(0, targetTop), behavior: 'instant' as ScrollBehavior });
    },
    getAnchor() {
      return computeAnchor({ specs: currentSpecs, cache, scrollTop: transcriptEl.scrollTop });
    },
    restoreAnchor(anchor) {
      const top = scrollTopForAnchor({ specs: currentSpecs, cache, anchor });
      if (top === null) return false;
      transcriptEl.scrollTo({ top, behavior: 'instant' as ScrollBehavior });
      return true;
    },
    isPinnedToBottom(thresholdPx = 300) {
      const distance = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight;
      return distance <= thresholdPx;
    },
    scrollToBottom(behavior = 'instant') {
      transcriptEl.scrollTo({ top: transcriptEl.scrollHeight, behavior: behavior as ScrollBehavior });
    },
    getHeightCache() { return cache; },
    dispose() {
      ro?.disconnect();
      transcriptEl.removeEventListener('scroll', scheduleRerender);
      transcriptEl.innerHTML = '';
    },
  };
}
