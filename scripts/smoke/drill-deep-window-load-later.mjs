// Floating deep-window → load-newer walk. After a deep `?around=`
// drill lands a BOUNDED window
// CENTERED on the target, the window is "floating" — it does NOT reach
// the live tail (hasMoreNewer=true). Scrolling DOWN must walk the window
// forward toward the tail via the symmetric `?after=` (load-newer)
// endpoint — appending newer rows — the mirror image of scroll-up
// loadEarlier `?before=` paging.
//
// We seed a long chat, drill to a DEEP target (so the around window stops
// well short of the tail), then scroll to the bottom of that window and
// assert: a `?after=` request fired, newer rows appended, and the live
// tail message — absent from the initial window — is now rendered.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'drill-deep-window-load-later';
export const DESCRIPTION = 'scrolling down a floating deep window walks newer via ?after= to the live tail';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-deep-window';
const TOTAL_MSGS = 120;
const FIRST_PAGE = 30;
const DEEP_IDX = 5;       // far older than the newest 30 → out of initial window
const TAIL_IDX = TOTAL_MSGS;  // the very last message (deep-msg-120)

export function MOCK_SETUP(mock) {
  mock.setHistoryFirstPageLimit(FIRST_PAGE);
  const messages = [];
  for (let i = 0; i < TOTAL_MSGS; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user' ? `user marker ${idx}` : `agent reply ${idx}`,
      sidekick_id: `deep-msg-${idx}`,
      timestamp: Date.now() / 1000 - (TOTAL_MSGS - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Deep window load-later test',
    source: 'sidekick',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
}

async function seedPin(page, chatId, idx, role) {
  await page.evaluate(({ chatId, msgId, role, idx }) => {
    return import('/build/pins/store.mjs').then((mod) => mod.pinMessage({
      chatId, msgId, role,
      text: role === 'user' ? `user marker ${idx}` : `agent reply ${idx}`,
      timestamp: Date.now(),
    }));
  }, { chatId, msgId: `deep-msg-${idx}`, role, idx });
}

async function openChat(page, chatId) {
  await page.evaluate((cid) => {
    document.body.classList.add('sidebar-expanded');
    const row = document.querySelector(
      `#sessions-list li[data-chat-id="${cid}"] .sess-body`,
    );
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, chatId);
}

async function openPinDrawer(page) {
  await page.evaluate(() => {
    const btn = document.getElementById('btn-pin-drawer-rail')
            || document.getElementById('btn-pin-drawer');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(250);
}

async function clickPinForMsg(page, msgId) {
  await page.evaluate((mid) => {
    const li = document.querySelector(`#pin-drawer-list .pin-drawer-item[data-msg-id="${mid}"]`);
    const btn = li?.querySelector('.pin-item-jump-btn');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, msgId);
}

function renderedKeys(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line[data-message-id]'))
      .map((el) => el.dataset.messageId));
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openChat(page, CHAT_ID);
  await page.waitForTimeout(800);

  const deepMsg = `deep-msg-${DEEP_IDX}`;
  const tailMsg = `deep-msg-${TAIL_IDX}`;

  await seedPin(page, CHAT_ID, DEEP_IDX, 'user');
  await page.waitForTimeout(200);
  await openPinDrawer(page);

  // Drill to the deep target — lands the bounded centered window.
  await clickPinForMsg(page, deepMsg);
  await page.waitForFunction(
    (mid) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
    deepMsg,
    { timeout: 8_000, polling: 60 },
  );
  // A drill arms a ~1200ms lazy-load suppress window (chat.suppressLazyLoadFor)
  // so the drill's OWN render-scroll can't auto-walk a centered window to the
  // tail. We're testing the steady-state "user scrolls down → walk" property,
  // so wait past that drill-transient before scrolling.
  await page.waitForTimeout(1400);

  // The floating window must stop short of the tail — otherwise there's
  // nothing for load-later to walk to and the test is vacuous.
  const afterDrill = await renderedKeys(page);
  assert(afterDrill.includes(deepMsg), `deep target ${deepMsg} should be rendered after the drill`);
  assert(!afterDrill.includes(tailMsg),
    `setup: tail ${tailMsg} should be OUTSIDE the floating around window (got it rendered)`);
  log(`floating window: ${afterDrill.length} bubbles, tail ${tailMsg} not yet loaded ✓`);

  // Count load-newer requests for the scroll-down walk only.
  let afterCount = 0;
  const onReq = (req) => {
    const u = req.url();
    if (/\/sessions\/[^/]+\/messages/.test(u) && /[?&]after=/.test(u)) afterCount++;
  };
  page.on('request', onReq);

  // Scroll to the bottom of the floating window — within LOAD_LATER
  // threshold — and fire a scroll event so maybeLoadLater() runs. Repeat
  // a couple of times in case the tail needs more than one page.
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => {
      const t = document.getElementById('transcript');
      if (!t) return;
      t.scrollTop = t.scrollHeight;
      t.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const reached = await page.waitForFunction(
      (mid) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
      tailMsg,
      { timeout: 2_500, polling: 60 },
    ).then(() => true).catch(() => false);
    if (reached) break;
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(300);
  page.off('request', onReq);

  const finalKeys = await renderedKeys(page);
  log(`after load-later walk: after=${afterCount} bubbles=${finalKeys.length} tailLoaded=${finalKeys.includes(tailMsg)}`);
  assert(afterCount >= 1,
    `scrolling down a floating window must issue at least one ?after= request (got ${afterCount})`);
  assert(finalKeys.includes(tailMsg),
    `load-later walk must reach the live tail ${tailMsg}`);
  assert(finalKeys.includes(deepMsg),
    `the deep target ${deepMsg} must remain rendered after walking forward`);
  log('floating deep window walks newer via ?after= to the live tail ✓');
}
