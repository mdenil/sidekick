// Keyed drill-window cache (#214 TFC-C): the bounded `around` window a
// deep drill fetches gets cached in IDB keyed `${chatId}::${anchorMsgId}`.
// A REPEAT drill to the same anchor paints instantly from the cache while
// the server fetch reconciles in the background — on a slow link the
// ?around= round trip was the bulk of a deep jump's wait.
//
// Test plan (mocked):
//   1. Seed 120-msg chat. Pin idx 5, drill once (server) → cache primed.
//   2. Jump to latest (target leaves the DOM).
//   3. mock.setMessageDelay(4000) → server now slow.
//   4. Drill again → target must render well within the server delay
//      (cache paint). Deterministic: only the cache can answer that fast.
//   5. After the slow server reconcile lands: target still rendered once,
//      window still floating (gap pill visible) — no yank, no dupes.
//   6. LRU leg: spam 35 windows via the module; count caps at 30 and the
//      pinned anchor's record survives eviction.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'drill-window-cache';
export const DESCRIPTION = 'repeat deep drill paints instantly from the keyed IDB window cache; LRU caps at 30 and protects pinned anchors';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-drill-window-cache';
const TOTAL_MSGS = 120;
const DEEP_IDX = 5;
const SERVER_DELAY_MS = 4000;

export function MOCK_SETUP(mock) {
  mock.setHistoryFirstPageLimit(30);
  const messages = [];
  for (let i = 0; i < TOTAL_MSGS; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user' ? `user marker ${idx}` : `agent reply ${idx}`,
      sidekick_id: `dwc-msg-${idx}`,
      timestamp: Date.now() / 1000 - (TOTAL_MSGS - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Drill window cache',
    source: 'sidekick',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
}

const targetRendered = (page, mid) => page.evaluate(
  (m) => document.querySelectorAll(`#transcript .line[data-message-id="${CSS.escape(m)}"]`).length,
  mid);

const gapPillVisible = (page) => page.evaluate(() =>
  document.getElementById('transcript-gap-newer')?.classList.contains('visible') ?? false);

async function drillViaPinDrawer(page, mid) {
  await page.evaluate(() => {
    (document.getElementById('btn-pin-drawer-rail') || document.getElementById('btn-pin-drawer'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(250);
  await page.evaluate((m) => {
    document.querySelector(`#pin-drawer-list .pin-drawer-item[data-msg-id="${m}"] .pin-item-jump-btn`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, mid);
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  await page.evaluate((cid) => {
    document.body.classList.add('sidebar-expanded');
    document.querySelector(`#sessions-list li[data-chat-id="${cid}"] .sess-body`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, CHAT_ID);
  await page.waitForTimeout(800);

  const deepMsg = `dwc-msg-${DEEP_IDX}`;

  // 1. Pin + first drill (fast server) — primes the cache.
  await page.evaluate(({ chatId, msgId, idx }) =>
    import('/build/pins/store.mjs').then((mod) => mod.pinMessage({
      chatId, msgId, role: 'user', text: `user marker ${idx}`, timestamp: Date.now(),
    })), { chatId: CHAT_ID, msgId: deepMsg, idx: DEEP_IDX });
  await page.waitForTimeout(200);
  await drillViaPinDrawer(page, deepMsg);
  await page.waitForFunction(
    (m) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(m)}"]`),
    deepMsg, { timeout: 8_000, polling: 60 });
  log('first drill rendered (server) — cache primed ✓');
  // putWindow is fire-and-forget after the fetch; give IDB a beat.
  await page.waitForTimeout(600);

  // 2. Back to the live tail — target leaves the DOM.
  await page.evaluate(() => {
    document.getElementById('transcript-gap-newer')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(
    (m) => !document.querySelector(`#transcript .line[data-message-id="${CSS.escape(m)}"]`),
    deepMsg, { timeout: 8_000, polling: 100 });
  await page.waitForTimeout(400);

  // 3-4. Slow the server, re-drill: the target must paint from cache well
  //      before the server could possibly answer.
  mock.setMessageDelay(CHAT_ID, SERVER_DELAY_MS);
  const t0 = Date.now();
  await drillViaPinDrawer(page, deepMsg);
  await page.waitForFunction(
    (m) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(m)}"]`),
    deepMsg, { timeout: SERVER_DELAY_MS - 1500, polling: 50 });
  const paintMs = Date.now() - t0;
  assert(paintMs < SERVER_DELAY_MS - 1000,
    `cache paint must beat the ${SERVER_DELAY_MS}ms server delay — took ${paintMs}ms`);
  assert(await gapPillVisible(page), 'cached window is floating — gap pill visible');
  log(`repeat drill painted from cache in ${paintMs}ms (server ${SERVER_DELAY_MS}ms away) ✓`);

  // 5. Let the slow server reconcile land — window intact, exactly one
  //    row for the target, still floating.
  await page.waitForTimeout(SERVER_DELAY_MS + 1000);
  const count = await targetRendered(page, deepMsg);
  assert(count === 1, `after server reconcile the target must render exactly once, got ${count}`);
  assert(await gapPillVisible(page), 'after reconcile the window must still be floating (gap pill visible)');
  const inView = await page.evaluate((m) => {
    const t = document.getElementById('transcript');
    const el = document.querySelector(`#transcript .line[data-message-id="${CSS.escape(m)}"]`);
    if (!t || !el) return false;
    const tr = t.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return er.top < tr.bottom && er.bottom > tr.top;
  }, deepMsg);
  assert(inView, 'target must still be in view after the server reconcile (no yank)');
  log('server reconcile landed: single row, still floating, no yank ✓');
  mock.setMessageDelay(CHAT_ID, 0);

  // 6. LRU: spam 35 windows; cap at 30; the pinned anchor survives.
  const lru = await page.evaluate(async ({ chatId, pinnedAnchor }) => {
    const wc = await import('/build/drillWindowCache.mjs');
    for (let i = 0; i < 35; i++) {
      await wc.putWindow(chatId, `lru-anchor-${i}`,
        [{ role: 'user', content: `x${i}`, sidekick_id: `lru-anchor-${i}`, id: i + 1 }],
        { firstId: i + 1, hasMore: false, lastId: i + 1, hasMoreNewer: true });
    }
    return {
      count: await wc.countWindows(),
      pinnedSurvived: !!(await wc.getWindow(chatId, pinnedAnchor)),
      earlyFakeEvicted: !(await wc.getWindow(chatId, 'lru-anchor-0')),
    };
  }, { chatId: CHAT_ID, pinnedAnchor: deepMsg });
  assert(lru.count <= 30, `LRU must cap at 30 windows, got ${lru.count}`);
  assert(lru.pinnedSurvived, 'window anchored at a PINNED message must survive eviction');
  assert(lru.earlyFakeEvicted, 'oldest unpinned window should be evicted under pressure');
  log(`LRU: count=${lru.count}, pinned anchor survived, oldest fake evicted ✓`);
}
