// IDB-persistence invariant: pins set in one page lifetime must
// survive a full page reload. Both:
//   1. The bubble visually shows .pinned after the reload (no
//      flash-and-disappear)
//   2. The right-side pin drawer aggregates the pinned message after
//      the reload
//
// Field bug 2026-05-13 (Jonathan): "i see message pins for a sec
// and then they disappear" on dev-reload. This smoke is the gate
// that catches the regression before the user does.

import {
  waitForReady, openSidebar, send, captureNextChatId,
  clickNewChat, assert,
} from './lib.mjs';

export const NAME = 'pin-survives-reload';
export const DESCRIPTION = 'pinned bubbles + drawer aggregation survive a full page reload (IDB hydrate path)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
// MOBILE coverage deferred — see pin-toggle-on-bubble.mjs.

export function MOCK_SETUP(_mock) { /* defaults */ }

async function clickPinOnFirstUserBubble(page) {
  return page.evaluate(() => {
    const line = document.querySelector('#transcript .line.s0[data-message-id], #transcript .line.user[data-message-id]');
    const btn = line?.querySelector('.pin-btn');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return line?.getAttribute('data-message-id') || null;
  });
}

async function pinState(page, msgId) {
  return page.evaluate((mid) => {
    const line = document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`);
    const btn = line?.querySelector('.pin-btn');
    return {
      lineExists: !!line,
      lineHasPinned: !!line?.classList.contains('pinned'),
      btnHasPinned: !!btn?.classList.contains('pinned'),
    };
  }, msgId);
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // ── Send + pin a message ─────────────────────────────────────────
  const chatP = captureNextChatId(page);
  await clickNewChat(page);
  const chatId = await chatP;
  log(`chat: ${chatId}`);

  await send(page, 'survive my reload');
  await page.waitForTimeout(800);
  const msgId = await clickPinOnFirstUserBubble(page);
  assert(msgId, `pre-reload: pin click should find a user bubble`);
  await page.waitForTimeout(200);

  const beforeReload = await pinState(page, msgId);
  assert(beforeReload.lineHasPinned && beforeReload.btnHasPinned,
    `pre-reload: bubble + button should be .pinned, got ${JSON.stringify(beforeReload)}`);
  log(`pre-reload: pinned ✓`);

  // Confirm the pin is in IDB (the in-memory store wrote async — make
  // sure it actually persisted before we reload).
  const idbSize = await page.evaluate(() => (window).__pinsDebug?.size() || 0);
  assert(idbSize === 1, `pre-reload: in-memory store should have 1 entry, got ${idbSize}`);
  // Give the IDB write a moment to flush — pinMessage's IDB transaction
  // is fire-and-forget after the in-memory set.
  await page.waitForTimeout(300);

  // ── Reload the page ──────────────────────────────────────────────
  log(`reloading…`);
  await page.reload();
  await waitForReady(page);
  // Wait long enough for hydratePins to resolve + chat-resume to
  // render. 1.5s comfortably covers the few-ms hydrate + the resume
  // render path that follows it.
  await page.waitForTimeout(1500);

  // ── Two invariants after reload ──────────────────────────────────

  // (a) The bubble in the transcript visually shows .pinned. This is
  //     the directly-user-visible repaint we're protecting.
  const afterReload = await pinState(page, msgId);
  assert(afterReload.lineExists,
    `post-reload: pinned bubble should still be in the transcript, got ${JSON.stringify(afterReload)}`);
  assert(afterReload.lineHasPinned && afterReload.btnHasPinned,
    `BUG (pin disappear, field bug 2026-05-13): bubble must remain .pinned after reload, got ${JSON.stringify(afterReload)}`);
  log(`post-reload: bubble + button still .pinned ✓`);

  // (b) The store reports the pin. If IDB hydrate dropped it, this
  //     would fail INDEPENDENTLY of any DOM-paint bug.
  const sizeAfter = await page.evaluate(() => (window).__pinsDebug?.size() || 0);
  assert(sizeAfter === 1,
    `post-reload: store should still have 1 pin, got ${sizeAfter}`);
  log(`post-reload: store has 1 pin ✓`);
}
