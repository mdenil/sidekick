// Phase 1 — virtualizer pure-math at scale.
//
// Feeds 1000 mock specs (mixed kinds, irregular cached heights) through
// computeVisibleWindow / computeAnchor / scrollTopForAnchor across a
// dense sweep of scrollTop values. Sanity checks:
//
//   - visibleFrom <= visibleTo, both in [0, specs.length]
//   - topSpacerPx + sum(visible heights) + bottomSpacerPx = total height
//   - overscan adds N specs above/below (when in range)
//   - scrollTop round-trips through compute/scrollTopForAnchor exactly
//   - height-shift invariant: anchored spec position stays put when
//     heights elsewhere change
//
// Pure node — no DOM, no Playwright. Phase 2's dev-test will exercise
// bindVirtualizer in a real browser once the factory has a consumer.
//
// Run from sidekick repo root:
//   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/dev-tests/virtualizer-window-math.mjs

import {
  createHeightCache,
  computeVisibleWindow,
  computeAnchor,
  scrollTopForAnchor,
} from '../../src/transcript/virtualizer.ts';

const N = 1000;
const KINDS = ['user', 'assistant', 'notification', 'activityRow'];

function mkSpec(i) {
  const kind = KINDS[i % KINDS.length];
  if (kind === 'user') return { kind, key: `k-${i}`, text: '', timestamp: i };
  if (kind === 'assistant') return { kind, key: `k-${i}`, text: '', timestamp: i };
  if (kind === 'notification') return { kind, key: `k-${i}`, text: '', timestamp: i, notificationKind: 'cron' };
  return { kind, key: `k-${i}`, timestamp: i, tools: [], complete: true };
}

const specs = Array.from({ length: N }, (_, i) => mkSpec(i));
const cache = createHeightCache();

// Stamp some heights that diverge from per-kind defaults. About 1 in 5
// specs gets a custom height, to test mixed-defaults/measured behavior.
for (let i = 0; i < N; i += 5) {
  cache.set(specs[i].key, 100 + ((i * 37) % 400));
}

let totalPx = 0;
for (const s of specs) totalPx += cache.get(s.key, s.kind);

const viewport = 700;
let failures = 0;
const report = (msg) => { console.error('FAIL:', msg); failures++; };

// Sweep scrollTop across the full range plus past-end.
const stops = [];
for (let t = 0; t <= totalPx + 5000; t += 137) stops.push(t);
console.log(`[virtualizer-dev-test] specs=${N} totalPx=${totalPx} viewport=${viewport} stops=${stops.length}`);

for (const scrollTop of stops) {
  const w = computeVisibleWindow({ specs, cache, scrollTop, viewportHeight: viewport });

  // Index bounds.
  if (w.visibleFrom < 0 || w.visibleFrom > w.visibleTo || w.visibleTo > N) {
    report(`scrollTop=${scrollTop}: bad indices ${w.visibleFrom}..${w.visibleTo}`);
    continue;
  }

  // Spacer sum invariant.
  let visiblePx = 0;
  for (let i = w.visibleFrom; i < w.visibleTo; i++) {
    visiblePx += cache.get(specs[i].key, specs[i].kind);
  }
  if (w.topSpacerPx + visiblePx + w.bottomSpacerPx !== totalPx) {
    report(`scrollTop=${scrollTop}: top(${w.topSpacerPx}) + visible(${visiblePx}) + bottom(${w.bottomSpacerPx}) ≠ total(${totalPx})`);
  }

  // Anchor round-trip — only meaningful when scrollTop is within the
  // actual content range; past-end is documented to anchor at the
  // last spec at offset 0, which is lossy and won't round-trip.
  if (scrollTop <= totalPx) {
    const anchor = computeAnchor({ specs, cache, scrollTop });
    if (!anchor) {
      report(`scrollTop=${scrollTop}: anchor null with non-empty specs`);
      continue;
    }
    const restored = scrollTopForAnchor({ specs, cache, anchor });
    if (restored !== scrollTop) {
      // Skip the documented past-end-of-content case where computeAnchor
      // intentionally returns {last spec, 0}: scrollTopForAnchor on that
      // returns the spec's start, which is less than scrollTop.
      const lastSpecTop = totalPx - cache.get(specs[N - 1].key, specs[N - 1].kind);
      if (scrollTop >= lastSpecTop && anchor.key === specs[N - 1].key && anchor.offsetPx === 0) continue;
      report(`scrollTop=${scrollTop}: round-trip restored=${restored} (anchor=${JSON.stringify(anchor)})`);
    }
  }
}

// Height-shift invariant: anchor at scrollTop=5000. Then balloon
// spec[10]'s height by +500px. Restored scrollTop should be original
// + 500 (since the anchored spec is past index 10, all 500px lands
// above it).
{
  const anchor = computeAnchor({ specs, cache, scrollTop: 5000 });
  if (!anchor) {
    report('shift invariant: anchor null at scrollTop=5000');
  } else {
    const c2 = createHeightCache();
    for (const [k, v] of cache.entries()) c2.set(k, v);
    const oldH = c2.get(specs[10].key, specs[10].kind);
    c2.set(specs[10].key, oldH + 500);
    const restored = scrollTopForAnchor({ specs, cache: c2, anchor });
    // The anchor was past spec[10] (cumulative height ~750-1500 vs scrollTop=5000),
    // so the bump lands above the anchor → restored scrollTop = original + 500.
    if (restored !== 5500) {
      report(`shift invariant: expected restored=5500, got ${restored} (anchor=${JSON.stringify(anchor)} oldH=${oldH})`);
    } else {
      console.log(`[virtualizer-dev-test] height-shift invariant OK: scrollTop 5000 → 5500 after +500px at spec[10]`);
    }
  }
}

// Overscan accounting on a randomly-chosen scrollTop.
{
  const scrollTop = 2400;
  const overscan = 4;
  const w = computeVisibleWindow({ specs, cache, scrollTop, viewportHeight: viewport, overscan });
  // Visible range with overscan should match strict-visible ± overscan,
  // clamped to [0, N].
  const wStrict = computeVisibleWindow({ specs, cache, scrollTop, viewportHeight: viewport, overscan: 0 });
  const expFrom = Math.max(0, wStrict.visibleFrom - overscan);
  const expTo = Math.min(N, wStrict.visibleTo + overscan);
  if (w.visibleFrom !== expFrom || w.visibleTo !== expTo) {
    report(`overscan: expected [${expFrom}, ${expTo}), got [${w.visibleFrom}, ${w.visibleTo})`);
  } else {
    console.log(`[virtualizer-dev-test] overscan=${overscan} adds ±${overscan} specs around strict [${wStrict.visibleFrom}, ${wStrict.visibleTo})`);
  }
}

if (failures > 0) {
  console.error(`[virtualizer-dev-test] ${failures} failure(s)`);
  process.exit(1);
}
console.log(`[virtualizer-dev-test] all checks passed across ${stops.length} scroll positions`);
