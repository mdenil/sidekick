// Contract (#214 TFC-E): at the BOTTOM of a floating deep-jump window,
// a pull-up gesture (touch drag / wheel down) loads the next NEWER page.
// maybeLoadLater previously ran only on scroll events — at the window's
// bottom edge scrollTop is already at max, so the gesture produces NO
// scroll event and nothing loads. Field complaint: "when i drag down it
// doesn't load (it should)".
//
// Test plan (mocked):
//   1. Seed a 120-msg chat. Open tail-anchored, pin a deep message
//      (idx 5), drill → floating around-window (ids ~1..18).
//   2. While the drill's lazy-load suppression is still active, scroll
//      to the window's very bottom. Wait out the suppression → STUCK
//      state: at max scroll, no newer page loaded, gap pill visible.
//   3. Touch drag up (the mobile gesture) → next newer page appends.
//   4. Repeat scroll-to-bottom + pull (wheel leg) until the window
//      connects to the live tail → tail message in DOM, gap pill hides.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'pull-up-loads-newer';
export const DESCRIPTION = 'pull-up gesture at the bottom of a floating deep window loads newer pages toward the live tail';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-pull-up-newer';
const TOTAL_MSGS = 120;
const DEEP_IDX = 5;

export function MOCK_SETUP(mock) {
  mock.setHistoryFirstPageLimit(30);
  const messages = [];
  for (let i = 0; i < TOTAL_MSGS; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user' ? `user marker ${idx}` : `agent reply ${idx}`,
      sidekick_id: `pullup-msg-${idx}`,
      timestamp: Date.now() / 1000 - (TOTAL_MSGS - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Pull-up loads newer',
    source: 'sidekick',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
}

const maxRenderedIdx = (page) => page.evaluate(() => {
  let max = 0;
  document.querySelectorAll('#transcript .line[data-message-id]').forEach((el) => {
    const m = /^pullup-msg-(\d+)$/.exec(el.dataset.messageId || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return max;
});

const gapPillVisible = (page) => page.evaluate(() =>
  document.getElementById('transcript-gap-newer')?.classList.contains('visible') ?? false);

const scrollToWindowBottom = (page) => page.evaluate(() => {
  const el = document.getElementById('transcript');
  el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
  el.dispatchEvent(new Event('scroll'));
});

const touchPullUp = (page) => page.evaluate(() => {
  const el = document.getElementById('transcript');
  const mk = (type, y) => new TouchEvent(type, {
    bubbles: true, cancelable: true,
    touches: [new Touch({ identifier: 1, target: el, clientX: 160, clientY: y })],
  });
  el.dispatchEvent(mk('touchstart', 400));
  el.dispatchEvent(mk('touchmove', 370));
  el.dispatchEvent(mk('touchmove', 330));
});

const wheelPullUp = (page) => page.evaluate(() => {
  document.getElementById('transcript')?.dispatchEvent(
    new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
});

export default async function run({ page, log }) {
  await waitForReady(page);

  // Open tail-anchored, pin the deep message, drill via the pin drawer.
  await page.evaluate((cid) => {
    document.body.classList.add('sidebar-expanded');
    document.querySelector(`#sessions-list li[data-chat-id="${cid}"] .sess-body`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, CHAT_ID);
  await page.waitForTimeout(800);

  const deepMsg = `pullup-msg-${DEEP_IDX}`;
  const tailMsg = `pullup-msg-${TOTAL_MSGS}`;

  await page.evaluate(({ chatId, msgId, idx }) =>
    import('/build/pins/store.mjs').then((mod) => mod.pinMessage({
      chatId, msgId, role: 'user', text: `user marker ${idx}`, timestamp: Date.now(),
    })), { chatId: CHAT_ID, msgId: deepMsg, idx: DEEP_IDX });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    (document.getElementById('btn-pin-drawer-rail') || document.getElementById('btn-pin-drawer'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(250);
  await page.evaluate((mid) => {
    document.querySelector(`#pin-drawer-list .pin-drawer-item[data-msg-id="${mid}"] .pin-item-jump-btn`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, deepMsg);
  await page.waitForFunction(
    (mid) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
    deepMsg, { timeout: 8_000, polling: 60 });

  // 2. Scroll to the window's bottom WHILE the drill suppression is
  //    still active (armed for 1200ms before the window rendered), so
  //    the scroll event's maybeLoadLater bails. Then wait it out.
  await page.waitForTimeout(300);
  await scrollToWindowBottom(page);
  await page.waitForTimeout(1500);

  const windowMax = await maxRenderedIdx(page);
  assert(windowMax > 0 && windowMax < TOTAL_MSGS,
    `setup: should be in a floating window (max rendered idx ${windowMax})`);
  assert(await gapPillVisible(page), 'setup: gap pill visible while windowed');
  const atBottom = await page.evaluate(() => {
    const el = document.getElementById('transcript');
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 5;
  });
  assert(atBottom, 'setup: must sit at the very bottom of the floating window');
  log(`stuck state staged: window max idx ${windowMax}, at bottom, no newer page loaded ✓`);

  // 3. Touch drag up — the field gesture — must load the next newer page.
  await touchPullUp(page);
  await page.waitForFunction(
    (n) => {
      let max = 0;
      document.querySelectorAll('#transcript .line[data-message-id]').forEach((el) => {
        const m = /^pullup-msg-(\d+)$/.exec(el.dataset.messageId || '');
        if (m) max = Math.max(max, parseInt(m[1], 10));
      });
      return max > n;
    },
    windowMax, { timeout: 6_000, polling: 100 });
  const afterTouch = await maxRenderedIdx(page);
  log(`touch pull-up loaded newer page: max idx ${windowMax} → ${afterTouch} ✓`);

  // 4. Walk the rest of the way to the live tail with scroll-to-bottom +
  //    wheel pulls. Caps well above the expected page count.
  for (let i = 0; i < 8; i++) {
    const tailRendered = await page.evaluate(
      (mid) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
      tailMsg);
    if (tailRendered) break;
    await scrollToWindowBottom(page);
    await page.waitForTimeout(150);
    await wheelPullUp(page);
    await page.waitForTimeout(700);
  }
  const tailRendered = await page.evaluate(
    (mid) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
    tailMsg);
  assert(tailRendered, 'repeated pull-ups must walk the window to the live tail');
  await page.waitForTimeout(400);
  assert(!(await gapPillVisible(page)),
    'gap pill must hide once the window connects to the tail');
  log('window walked to the live tail; gap pill hidden ✓');
}
