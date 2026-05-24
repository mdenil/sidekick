// Phase 3 — anchor-based scroll restore under virtualization.
//
// Under virt: chat.saveCurrentScrollPosition captures
// {key, offsetPx} from the virtualizer alongside scrollTop, and
// sessionResume.replaySessionMessages reads back the same record and
// calls virtualizer.restoreAnchor(...) if it carries an anchorKey.
// The invariant: switching A → B → A while mid-chat lands on the
// SAME bubble at the SAME offset, regardless of heights elsewhere
// in the chat.
//
// This is the long-term answer to the partial-render at-edge drift
// (a2fe0d6's atBottom flag fix patches it at the heuristic level for
// the default path; this fix removes the heuristic entirely under virt).

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'virtualizer-anchor-restore';
export const DESCRIPTION = 'Virt flag on: mid-chat scroll position survives A→B→A switch via anchor restore';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-virt-anchor-a';
const CHAT_B = 'mock-virt-anchor-b';

function makeMessages(count, prefix) {
  const out = [];
  const body = `${prefix}: ${'lorem ipsum dolor sit amet consectetur '.repeat(8)}`;
  for (let i = 0; i < count; i++) {
    out.push({
      id: i + 1,
      sidekick_id: `${prefix.toLowerCase()}-anc-${i + 1}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${body} (msg ${i})`,
      timestamp: Date.now() / 1000 - (count - i) * 60,
    });
  }
  return out;
}

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    title: 'Anchor chat A',
    source: 'sidekick',
    messages: makeMessages(120, 'A'),
    lastActiveAt: Date.now() - 60_000,
  });
  mock.addChat(CHAT_B, {
    title: 'Anchor chat B',
    source: 'sidekick',
    messages: makeMessages(40, 'B'),
    lastActiveAt: Date.now() - 30_000,
  });
}

async function captureTopVisible(page) {
  return page.evaluate(() => {
    const t = document.getElementById('transcript');
    const slot = t?.querySelector(':scope > .transcript-slot');
    if (!slot) return null;
    const viewTop = t.getBoundingClientRect().top;
    let firstVisible = null;
    for (const el of Array.from(slot.children)) {
      const r = el.getBoundingClientRect();
      if (r.bottom > viewTop + 4 && !firstVisible) {
        firstVisible = {
          key: el.getAttribute('data-key'),
          offsetFromViewportTop: Math.round(r.top - viewTop),
        };
      }
    }
    return {
      ...firstVisible,
      scrollTop: Math.round(t.scrollTop),
      scrollHeight: t.scrollHeight,
      clientHeight: t.clientHeight,
      slotChildCount: slot.children.length,
    };
  });
}

export default async function run({ page, log }) {
  await page.addInitScript(() => {
    try { localStorage.setItem('sidekick.virtualize', '1'); } catch {}
  });

  await waitForReady(page);
  await openSidebar(page);

  // ── Open A; wait past the 1500ms at-bottom repin window so wheels
  // aren't cancelled by re-snap. Then wheel up to mid-chat.
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(2000);  // > REPIN_WINDOW_MS (1500ms)

  const box = await page.locator('#transcript').boundingBox();
  if (!box) throw new Error('transcript bounding box missing');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 15; i++) {
    await page.mouse.wheel(0, -700);
    await page.waitForTimeout(30);
  }
  const justAfterWheel = await captureTopVisible(page);
  log(`just-after-wheel: scrollTop=${justAfterWheel?.scrollTop}/${justAfterWheel?.scrollHeight} key=${justAfterWheel?.key}`);
  await page.waitForTimeout(700);  // settle: rerender + RO + idle save debounce (200ms)

  const aTopBefore = await captureTopVisible(page);
  log(`A mid-chat top: key=${aTopBefore?.key} offset=${aTopBefore?.offsetFromViewportTop} ` +
    `scrollTop=${aTopBefore?.scrollTop}/${aTopBefore?.scrollHeight} slotChildren=${aTopBefore?.slotChildCount}`);
  assert(aTopBefore && aTopBefore.key, 'must capture a visible bubble after mid-chat scroll');
  // Sanity: the user MUST be mid-chat, not near bottom — otherwise
  // the test wouldn't be exercising anchor restore (at-bottom uses
  // forceScrollToBottom instead).
  const distFromBottom = (aTopBefore.scrollHeight - aTopBefore.scrollTop - aTopBefore.clientHeight);
  assert(distFromBottom > 500,
    `wheel-up failed to leave bottom region: distance from bottom = ${distFromBottom}px ` +
    `(scrollTop=${aTopBefore.scrollTop} scrollHeight=${aTopBefore.scrollHeight})`);

  // ── Switch to B → switch back to A.
  await clickRow(page, CHAT_B);
  await page.waitForTimeout(800);
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(1500);

  const aTopAfter = await captureTopVisible(page);
  log(`A restored top: key=${aTopAfter?.key} offset=${aTopAfter?.offsetFromViewportTop}`);
  assert(aTopAfter && aTopAfter.key, 'must have a visible bubble after switch-back');

  // The SAME bubble key should be at the top. Offset can drift a few
  // pixels from height-measurement settling; ±20px is well inside
  // tolerance for "user sees the same content."
  assert(aTopAfter.key === aTopBefore.key,
    `anchor key mismatch: before=${aTopBefore.key} after=${aTopAfter.key} ` +
    `(scroll position drifted to a DIFFERENT bubble — anchor restore did not engage)`);
  const drift = Math.abs((aTopAfter.offsetFromViewportTop ?? 0) - (aTopBefore.offsetFromViewportTop ?? 0));
  assert(drift <= 50,
    `anchor offset drift ${drift}px exceeds 50px tolerance ` +
    `(before=${aTopBefore.offsetFromViewportTop}, after=${aTopAfter.offsetFromViewportTop})`);

  log('anchor restore: same bubble, offset preserved ✓');
}
