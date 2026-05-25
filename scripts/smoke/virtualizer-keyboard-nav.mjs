// Phase 4 nicety — transcriptHighlight ↑↓ keyboard navigation under
// virtualization. The legacy `bubbles()` DOM walk only sees the
// rendered window (~30 bubbles); ↑ past the slot edge would treat
// the slot's first bubble as the chat's first message. Under virt,
// `move()` now walks `virtualizer.getKeys({navigable:true})` — the
// full chat — and uses `scrollToKey` to mount a key that's outside
// the current window before highlighting.
//
// Verifies:
//   - composer ↑ from empty enters highlight mode (most-recent bubble)
//   - subsequent ↑ presses navigate through the chat, crossing slot
//     boundaries (mounted bubble shifts from index N-1 to index 0)
//   - the highlight class lands on the actual `data-key` of each
//     stop, not on whatever happens to be visible after a scroll

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'virtualizer-keyboard-nav';
export const DESCRIPTION = 'Virt: composer ↑↓ navigates the full chat including bubbles outside the rendered slot';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'mock-virt-keynav';

function makeMessages(count) {
  const out = [];
  const body = `${'lorem ipsum dolor sit amet '.repeat(6)}`;
  for (let i = 0; i < count; i++) {
    out.push({
      id: i + 1,
      sidekick_id: `kn-${i + 1}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${body} (#${i})`,
      timestamp: Date.now() / 1000 - (count - i) * 60,
    });
  }
  return out;
}

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT, {
    title: 'Keyboard nav chat',
    source: 'sidekick',
    messages: makeMessages(80),
    lastActiveAt: Date.now() - 60_000,
  });
}

async function highlightedKey(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.transcript-highlight');
    return el ? el.getAttribute('data-key') : null;
  });
}

export default async function run({ page, log }) {
  await page.addInitScript(() => {
    try { localStorage.setItem('sidekick.virtualize', '1'); } catch {}
  });
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT);
  await page.waitForTimeout(1000);

  // Sanity: virt slot mounted (means we're testing the path we
  // think we're testing — phase 5a default would otherwise let
  // this run pass on the legacy path by accident).
  const slotMounted = await page.evaluate(() => !!document.querySelector(
    '#transcript > .transcript-slot',
  ));
  assert(slotMounted, 'virt slot must be mounted; phase 5a default did not engage');

  // Focus composer, press ↑ from empty → enters highlight mode at the
  // most-recent NAVIGABLE message. Mock injects 80 alternating
  // user/assistant; that's also exactly the navigable count under
  // this chat config (no system rows / pending sends), so the
  // last navigable key is kn-80.
  await page.focus('#composer-input');
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(200);

  const k0 = await highlightedKey(page);
  log(`entry highlight key: ${k0}`);
  // Accept either kn-80 (full mock) or kn-79 (last assistant) — both
  // are fine; what matters is that the next ↑ moves us properly.
  assert(k0 === 'kn-80' || k0 === 'kn-79', `expected last navigable (kn-79/kn-80), got ${k0}`);
  const lastIdx = parseInt(k0.replace(/^kn-/, ''), 10);

  // Press ↑ enough times to traverse PAST the rendered slot's edge
  // (default overscan covers ~6 specs each side; slot holds ~15-20).
  // 30 presses takes us well past where the slot started; under
  // virt, the slot must rerender to mount the new top.
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('ArrowUp');
    // Brief tick for the scrollToKey rAFs to settle.
    await page.waitForTimeout(60);
  }

  const kAfter = await highlightedKey(page);
  const targetIdx = lastIdx - 30;
  const targetKey = `kn-${targetIdx}`;
  log(`after 30× ↑: highlight key=${kAfter} (expected ${targetKey})`);
  assert(kAfter === targetKey, `expected ${targetKey} after 30 ups, got ${kAfter}`);

  // The highlighted bubble must be in DOM with the highlight class.
  const inDom = await page.evaluate(() => {
    const el = document.querySelector('.transcript-highlight');
    if (!el) return null;
    return {
      key: el.getAttribute('data-key'),
      classes: el.className,
    };
  });
  assert(inDom && inDom.key === targetKey && /transcript-highlight/.test(inDom.classes),
    `highlighted bubble must be the ${targetKey} element in DOM, got ${JSON.stringify(inDom)}`);

  log('keyboard nav crosses slot boundaries ✓');
}
