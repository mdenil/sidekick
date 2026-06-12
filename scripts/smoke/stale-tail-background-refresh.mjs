// TFC-B (#214/#220): background tail refresh. When the drawer's server
// list shows a session with newer activity than its cached transcript's
// tail (it advanced on another device / while SSE was down), the drawer
// sweep refreshes that session's cache in the background — so the next
// switch paints the CURRENT tail instantly instead of the stale one.
// Field symptom this kills: "session transcripts stale until refresh".
//
// Test plan (mocked):
//   1. Seed chats A (to view) and B (20 msgs, last activity ~10 min ago).
//   2. Open B → resume primes its sessionCache. Switch to A.
//   3. Silently append msg 21 to B server-side (addChat re-seed, NO SSE)
//      with lastActiveAt = now. Assert B's cache does NOT have it yet.
//   4. Kick a drawer refresh() → TFC-B sweep must merge msg 21 into B's
//      cache in the background (no switch, no click).
//   5. Payoff: mock.setMessageDelay(B, 4000), click B → msg 21 renders
//      well within the server delay. Deterministic: only the refreshed
//      cache can paint it that fast.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'stale-tail-background-refresh';
export const DESCRIPTION = 'drawer sweep refreshes a cached tail when the server list shows newer activity; next switch paints the new message from cache';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-tfcb-viewed';
const CHAT_B = 'mock-tfcb-stale';
const B_MSGS = 20;
const NEW_MSG_ID = `tfcb-msg-${B_MSGS + 1}`;
const SERVER_DELAY_MS = 4000;

function bMessages(count) {
  const base = Date.now() - 10 * 60_000;
  const messages = [];
  for (let i = 0; i < count; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user' ? `user b ${idx}` : `agent b ${idx}`,
      sidekick_id: `tfcb-msg-${idx}`,
      timestamp: (base - (count - idx) * 60_000) / 1000,
    });
  }
  return messages;
}

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    title: 'TFC-B viewed chat',
    source: 'sidekick',
    messages: [
      { role: 'user', content: 'hello from A', sidekick_id: 'tfcb-a-1', timestamp: Date.now() / 1000 },
    ],
    lastActiveAt: Date.now(),
  });
  mock.addChat(CHAT_B, {
    title: 'TFC-B stale chat',
    source: 'sidekick',
    messages: bMessages(B_MSGS),
    lastActiveAt: Date.now() - 10 * 60_000,
  });
}

const clickChat = (page, cid) => page.evaluate((c) => {
  document.body.classList.add('sidebar-expanded');
  document.querySelector(`#sessions-list li[data-chat-id="${c}"] .sess-body`)
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}, cid);

const cacheHasMsg = (page, chatId, sid) => page.evaluate(async ({ c, s }) => {
  const sc = await import('/build/sessionCache.mjs');
  const rec = await sc.getMessagesCache(c);
  return !!rec?.messages?.some((m) => m?.sidekick_id === s);
}, { c: chatId, s: sid });

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  // 1-2. Prime B's cache via a real resume, then move to A.
  await clickChat(page, CHAT_B);
  await page.waitForFunction(
    () => !!document.querySelector('#transcript .line[data-message-id="tfcb-msg-20"]'),
    { timeout: 8_000, polling: 100 });
  await page.waitForTimeout(600); // resume reconcile + cache write settle
  await clickChat(page, CHAT_A);
  await page.waitForFunction(
    () => !!document.querySelector('#transcript .line[data-message-id="tfcb-a-1"]'),
    { timeout: 8_000, polling: 100 });
  assert(await cacheHasMsg(page, CHAT_B, 'tfcb-msg-20'), 'B cache primed with its tail');
  log('B cache primed; now viewing A ✓');

  // 3. B advances server-side, silently (no SSE envelope).
  mock.addChat(CHAT_B, {
    title: 'TFC-B stale chat',
    source: 'sidekick',
    messages: [...bMessages(B_MSGS), {
      role: 'assistant',
      content: 'new reply from another device',
      sidekick_id: NEW_MSG_ID,
      timestamp: Date.now() / 1000,
    }],
    lastActiveAt: Date.now(),
  });
  assert(!(await cacheHasMsg(page, CHAT_B, NEW_MSG_ID)),
    'before the sweep, B cache must NOT contain the new message');
  log('server-side message landed silently; cache still stale ✓');

  // 4. Drawer refresh → background sweep refreshes B's cache.
  await page.evaluate(async () => {
    const sd = await import('/build/sessionDrawer.mjs');
    await sd.refresh();
  });
  await page.waitForFunction(async ({ c, s }) => {
    const sc = await import('/build/sessionCache.mjs');
    const rec = await sc.getMessagesCache(c);
    return !!rec?.messages?.some((m) => m?.sidekick_id === s);
  }, { c: CHAT_B, s: NEW_MSG_ID }, { timeout: 8_000, polling: 200 });
  assert(await cacheHasMsg(page, CHAT_B, 'tfcb-msg-1'),
    'sweep must MERGE the newest page — older cached history preserved');
  log('TFC-B sweep merged the new message into B cache (still viewing A) ✓');

  // 5. Payoff: slow server, switch to B — the new message paints from
  //    the refreshed cache long before the server could answer.
  mock.setMessageDelay(CHAT_B, SERVER_DELAY_MS);
  const t0 = Date.now();
  await clickChat(page, CHAT_B);
  await page.waitForFunction(
    (m) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(m)}"]`),
    NEW_MSG_ID, { timeout: SERVER_DELAY_MS - 1500, polling: 50 });
  const paintMs = Date.now() - t0;
  assert(paintMs < SERVER_DELAY_MS - 1000,
    `cached paint must beat the ${SERVER_DELAY_MS}ms server delay — took ${paintMs}ms`);
  mock.setMessageDelay(CHAT_B, 0);
  log(`switch to B painted the cross-device message in ${paintMs}ms (server ${SERVER_DELAY_MS}ms away) ✓`);
}
