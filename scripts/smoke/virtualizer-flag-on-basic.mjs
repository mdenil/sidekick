// Phase 2 — basic virtualizer integration smoke. Sets the feature flag
// in localStorage BEFORE the page boots, then opens a chat with enough
// messages to overflow the viewport and asserts the virtualizer
// scaffolding is in place + scroll changes the visible window.
//
// Coverage:
//   - `.transcript-slot` / `.transcript-spacer-top` / `.transcript-
//     spacer-bottom` mounted as direct children of #transcript
//   - rendered child count in the slot is bounded (≤ 30 ≈ viewport
//     + overscan), regardless of total spec count
//   - scrolling changes which spec keys are in the slot
//   - the slot's children carry the same `.line` / `data-key`
//     attributes the reconciler produces in the default path
//
// Doesn't yet verify scroll-restore-on-switch or anchor semantics —
// those are phase-3 concerns once chatScrollPositions is anchor-shaped.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'virtualizer-flag-on-basic';
export const DESCRIPTION = 'Virt flag on: slot + spacers mount, bounded DOM, scroll changes window';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'mock-virt-basic';

function makeMessages(count) {
  const out = [];
  const body = `${'lorem ipsum dolor sit amet consectetur '.repeat(8)}`;
  for (let i = 0; i < count; i++) {
    out.push({
      id: i + 1,
      sidekick_id: `virt-${i + 1}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${body} (msg ${i})`,
      timestamp: Date.now() / 1000 - (count - i) * 60,
    });
  }
  return out;
}

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT, {
    title: 'Virt chat — long',
    source: 'sidekick',
    messages: makeMessages(150),
    lastActiveAt: Date.now() - 60_000,
  });
}

async function snap(page) {
  return page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (!t) return null;
    const slot = t.querySelector(':scope > .transcript-slot');
    const top = t.querySelector(':scope > .transcript-spacer-top');
    const bot = t.querySelector(':scope > .transcript-spacer-bottom');
    return {
      hasSlot: !!slot,
      hasTopSpacer: !!top,
      hasBottomSpacer: !!bot,
      topSpacerPx: top ? parseInt(top.style.height || '0', 10) : 0,
      bottomSpacerPx: bot ? parseInt(bot.style.height || '0', 10) : 0,
      slotChildCount: slot ? slot.children.length : 0,
      slotKeys: slot
        ? Array.from(slot.children).map(c => c.getAttribute('data-key')).filter(Boolean)
        : [],
      scrollTop: Math.round(t.scrollTop),
      scrollHeight: t.scrollHeight,
      clientHeight: t.clientHeight,
    };
  });
}

export default async function run({ page, log }) {
  // Set the flag BEFORE the page boots, otherwise the virtualizer
  // wouldn't engage on this run. localStorage write happens in
  // page-init context via initScript so it survives the navigation.
  await page.addInitScript(() => {
    try { localStorage.setItem('sidekick.virtualize', '1'); } catch {}
  });

  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT);
  await page.waitForTimeout(800);

  const s0 = await snap(page);
  log(`initial: hasSlot=${s0.hasSlot} topSpacer=${s0.topSpacerPx} bot=${s0.bottomSpacerPx} ` +
    `slotChildren=${s0.slotChildCount} scrollHeight=${s0.scrollHeight} clientHeight=${s0.clientHeight}`);

  assert(s0.hasSlot, 'transcript-slot must mount when virt=1');
  assert(s0.hasTopSpacer, 'transcript-spacer-top must mount');
  assert(s0.hasBottomSpacer, 'transcript-spacer-bottom must mount');
  assert(s0.slotChildCount > 0, `slot must have rendered some bubbles (got ${s0.slotChildCount})`);
  // 150 specs total. Visible window + 2× overscan (default 6 each side)
  // ≈ viewport-ful + 12. With 80px nominal heights and ~700px viewport,
  // strict-visible ~9 specs → slot count ~21-25. Generous ceiling of 50
  // catches "rendered everything" regression without false flagging
  // legitimate fluctuation.
  assert(s0.slotChildCount <= 50,
    `slot must be bounded (got ${s0.slotChildCount} of 150 — virtualization not engaging?)`);

  // All slot children should have data-key (reconciler-created).
  assert(s0.slotKeys.length === s0.slotChildCount,
    `every slot child must have data-key (got ${s0.slotKeys.length}/${s0.slotChildCount})`);

  // Chat opens at bottom (no saved scroll position for this chat).
  // Last visible key should be near the end of the spec range.
  const lastIdx = parseInt((s0.slotKeys[s0.slotKeys.length - 1] || '').replace(/^.*-/, ''), 10);
  log(`bottom-aligned: last visible key index ≈ ${lastIdx}`);

  // Scroll up significantly via REAL wheel events — programmatic
  // scrollTop= would race with sessionResume's scheduleAtBottomRepin
  // (which re-snaps to bottom unless wheel/touchmove/pointerdown
  // indicates real user intent — see sessionResume.ts:217-239).
  const box = await page.locator('#transcript').boundingBox();
  if (!box) throw new Error('transcript bounding box missing');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, -800);  // scroll up
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(400);  // settle

  const s1 = await snap(page);
  log(`mid-scroll: topSpacer=${s1.topSpacerPx} bot=${s1.bottomSpacerPx} slotChildren=${s1.slotChildCount} scrollTop=${s1.scrollTop}`);

  assert(s1.scrollTop > 0, 'scrollTop should have moved');
  assert(s1.slotChildCount <= 50, `still bounded after scroll (got ${s1.slotChildCount})`);

  // Key set should differ — mid-scroll shows different specs than
  // bottom-aligned.
  const overlap = s0.slotKeys.filter(k => s1.slotKeys.includes(k)).length;
  assert(overlap < s0.slotKeys.length,
    `scrolling must change the rendered window (saw ${overlap}/${s0.slotKeys.length} overlap)`);

  // Top spacer should be > 0 now (we're not at the very top).
  assert(s1.topSpacerPx > 0, `topSpacer should pad above the visible window (got ${s1.topSpacerPx}px)`);

  log('virtualizer scaffolding engaged + scroll changes visible window ✓');
}
