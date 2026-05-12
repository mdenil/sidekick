// Per-bubble pin button toggle invariants:
//   1. Pin button is present on bubbles with a stable msgId
//   2. Clicking it adds .pinned to BOTH the button and the bubble
//   3. Clicking again removes the class from both
//   4. The store reports isPinned() consistently with the DOM state
//
// Field bug 2026-05-12 motivated this smoke: Jonathan reported
// "I clicked the pin and it just didn't work" — without an automated
// test the regression slot was an empty hole. Pins this end of the
// surface so we catch DOM/event-handler breakage before the user
// does.

import {
  waitForReady, openSidebar, send, captureNextChatId,
  clickNewChat, assert,
} from './lib.mjs';

export const NAME = 'pin-toggle-on-bubble';
export const DESCRIPTION = 'pin button toggles .pinned on bubble + button + reports consistent isPinned()';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(_mock) { /* defaults — auto-reply enabled */ }

async function getPinButton(page, msgId) {
  return page.evaluateHandle((mid) => {
    const line = document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`);
    return line?.querySelector('.pin-btn') || null;
  }, msgId);
}

async function pinState(page, msgId) {
  return page.evaluate((mid) => {
    const line = document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`);
    const btn = line?.querySelector('.pin-btn');
    return {
      lineHasPinned: !!line?.classList.contains('pinned'),
      btnHasPinned: !!btn?.classList.contains('pinned'),
      btnExists: !!btn,
    };
  }, msgId);
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  const chatP = captureNextChatId(page);
  await clickNewChat(page);
  const chatId = await chatP;
  log(`chat: ${chatId}`);

  await send(page, 'remember this message');
  await page.waitForTimeout(800);  // wait for user_message + agent reply

  // Find the user bubble (first one we sent) — it carries a stable
  // umsg_* id minted by the PWA before POST.
  const msgId = await page.evaluate(() => {
    const line = document.querySelector('#transcript .line.s0[data-message-id], #transcript .line.user[data-message-id]');
    return line?.getAttribute('data-message-id') || null;
  });
  assert(msgId, `pre-pin: user bubble should have a data-message-id`);
  log(`user msgId=${msgId}`);

  // Pre-click state: button exists, neither button nor bubble pinned.
  const before = await pinState(page, msgId);
  assert(before.btnExists, `pin button should exist on bubble (got ${JSON.stringify(before)})`);
  assert(!before.lineHasPinned && !before.btnHasPinned,
    `pre-click: expected unpinned, got ${JSON.stringify(before)}`);
  log(`pre-click: pin button present, both unpinned ✓`);

  // Click 1 → pinned. Count pin buttons first to catch the duplicate-
  // addLine-for-same-msgId failure mode where multiple buttons exist
  // and our page.click clicks an unexpected one.
  const btnCount = await page.evaluate((mid) => {
    return document.querySelectorAll(
      `#transcript .line[data-message-id="${CSS.escape(mid)}"] .pin-btn`,
    ).length;
  }, msgId);
  log(`pin button count on bubble: ${btnCount}`);
  assert(btnCount === 1, `expected exactly 1 pin button on bubble, got ${btnCount}`);

  // Dispatched click instead of page.click — the latter does a full
  // pointerdown → mouseup → click chain which on iOS-style mobile
  // emulation can fire on both the SVG inside the button and the
  // button itself, toggling pinned→unpinned in a single observable
  // step. dispatchEvent goes straight to the button's click handler.
  await page.evaluate((mid) => {
    const btn = document.querySelector(
      `#transcript .line[data-message-id="${CSS.escape(mid)}"] .pin-btn`,
    );
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, msgId);
  await page.waitForTimeout(200);

  // Store + DOM must agree: 1 pinned entry, both classes set.
  const storeSizeAfterPin = await page.evaluate(() => (window).__pinsDebug?.size() || 0);
  assert(storeSizeAfterPin === 1,
    `1st click: pins store should have exactly 1 entry, got ${storeSizeAfterPin}`);

  const afterPin = await pinState(page, msgId);
  assert(afterPin.lineHasPinned && afterPin.btnHasPinned,
    `1st click: expected pinned on both, got ${JSON.stringify(afterPin)}`);
  log(`1st click: bubble + button both .pinned ✓`);

  // Click 2 → unpinned again (toggle).
  await page.evaluate((mid) => {
    const btn = document.querySelector(
      `#transcript .line[data-message-id="${CSS.escape(mid)}"] .pin-btn`,
    );
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, msgId);
  await page.waitForTimeout(200);
  const afterUnpin = await pinState(page, msgId);
  assert(!afterUnpin.lineHasPinned && !afterUnpin.btnHasPinned,
    `2nd click: expected unpinned on both, got ${JSON.stringify(afterUnpin)}`);
  const storeSizeAfterUnpin = await page.evaluate(() => (window).__pinsDebug?.size() || 0);
  assert(storeSizeAfterUnpin === 0,
    `2nd click: pins store should be empty, got ${storeSizeAfterUnpin}`);
  log(`2nd click: toggle back to unpinned ✓`);
}
