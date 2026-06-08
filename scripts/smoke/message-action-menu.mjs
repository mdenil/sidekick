// Per-message action caret menu (#154):
//   1. Every bubble carries exactly ONE caret button (.msg-caret).
//   2. Clicking the caret opens a .msg-menu anchored to that bubble.
//   3. The agent menu offers Play, Pin, Copy, Mark unread.
//   4. The user menu offers Pin, Copy — NO Play, NO Mark unread.
//   5. Clicking outside the menu closes it; clicking the caret again toggles.
//
// The copy/pin/play buttons stay in the DOM (hidden) so their handlers and
// the replyPlayer delegation keep working — the menu just synthesizes clicks
// on them. This smoke pins the menu surface itself; the mark-unread side
// effect has its own coverage in message-mark-unread.mjs.

import {
  waitForReady, openSidebar, send, captureNextChatId,
  clickNewChat, assert,
} from './lib.mjs';

export const NAME = 'message-action-menu';
export const DESCRIPTION = 'per-message caret opens an action menu (agent: play/pin/copy/mark-unread; user: pin/copy); outside-click + re-click close it';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(_mock) { /* defaults — auto-reply enabled */ }

const caretCount = (page, sel) =>
  page.evaluate((s) => document.querySelectorAll(`${s} .msg-caret`).length, sel);

async function openMenu(page, sel) {
  await page.evaluate((s) => {
    document.querySelector(`${s} .msg-caret`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, sel);
}

const menuLabels = (page, sel) =>
  page.evaluate((s) => {
    const menu = document.querySelector(`${s} .msg-menu`);
    if (!menu) return null;
    return Array.from(menu.querySelectorAll('button')).map((b) => b.textContent || '');
  }, sel);

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  const chatP = captureNextChatId(page);
  await clickNewChat(page);
  const chatId = await chatP;
  log(`chat: ${chatId}`);

  await send(page, 'open the action menu please');
  // Wait for the agent reply bubble (auto-reply) to land with a msg id.
  await page.waitForFunction(
    () => !!document.querySelector('#transcript .line.agent[data-message-id]'),
    null, { timeout: 5_000, polling: 100 },
  );

  // Resolve concrete, unambiguous per-bubble selectors by message id — a
  // comma-OR selector would mis-bind the trailing ` .msg-menu` descendant.
  const ids = await page.evaluate(() => {
    const u = document.querySelector('#transcript .line.s0[data-message-id], #transcript .line.user[data-message-id]');
    const a = document.querySelector('#transcript .line.agent[data-message-id]');
    return {
      user: u?.getAttribute('data-message-id') || null,
      agent: a?.getAttribute('data-message-id') || null,
    };
  });
  assert(ids.user && ids.agent, `expected both a user and agent bubble id (got ${JSON.stringify(ids)})`);
  const userSel = `#transcript .line[data-message-id="${ids.user}"]`;
  const agentSel = `#transcript .line[data-message-id="${ids.agent}"]`;

  // ── 1. Exactly one caret per bubble ──────────────────────────────
  assert((await caretCount(page, userSel)) === 1, 'user bubble must have exactly one caret');
  assert((await caretCount(page, agentSel)) === 1, 'agent bubble must have exactly one caret');
  log('1 ✓ one caret per bubble (user + agent)');

  // ── 2/3. Agent menu opens with the full action set ───────────────
  await openMenu(page, agentSel);
  await page.waitForSelector(`${agentSel} .msg-menu`, { timeout: 2_000 });
  const agentItems = await menuLabels(page, agentSel);
  log(`agent menu: ${JSON.stringify(agentItems)}`);
  for (const want of ['Play', 'Pin', 'Copy', 'Mark unread']) {
    assert(agentItems.includes(want), `agent menu missing "${want}" (got ${JSON.stringify(agentItems)})`);
  }
  log('2 ✓ agent menu offers Play / Pin / Copy / Mark unread');

  // ── 4. Outside click closes the menu ─────────────────────────────
  await page.evaluate(() => document.body.click());
  await page.waitForFunction(
    (s) => !document.querySelector(`${s} .msg-menu`),
    agentSel, { timeout: 2_000, polling: 50 },
  );
  log('3 ✓ outside click closes the menu');

  // ── 5. Caret re-click toggles closed ─────────────────────────────
  await openMenu(page, agentSel);
  await page.waitForSelector(`${agentSel} .msg-menu`, { timeout: 2_000 });
  await openMenu(page, agentSel);  // second click toggles off
  await page.waitForFunction(
    (s) => !document.querySelector(`${s} .msg-menu`),
    agentSel, { timeout: 2_000, polling: 50 },
  );
  log('4 ✓ caret re-click toggles the menu closed');

  // ── 6. User menu omits Play + Mark unread ────────────────────────
  await openMenu(page, userSel);
  await page.waitForSelector(`${userSel} .msg-menu`, { timeout: 2_000 });
  const userItems = await menuLabels(page, userSel);
  log(`user menu: ${JSON.stringify(userItems)}`);
  assert(userItems.includes('Pin'), `user menu should offer Pin (got ${JSON.stringify(userItems)})`);
  assert(userItems.includes('Copy'), `user menu should offer Copy (got ${JSON.stringify(userItems)})`);
  assert(!userItems.includes('Play'), `user menu must NOT offer Play (got ${JSON.stringify(userItems)})`);
  assert(!userItems.includes('Mark unread'), `user menu must NOT offer Mark unread (got ${JSON.stringify(userItems)})`);
  log('5 ✓ user menu is Pin + Copy only (no Play, no Mark unread)');

  log('PASS: per-message caret menu opens with the right actions and dismisses correctly');
}
