// Contract (Jonathan, 2026-05-29): clicking a row in the Activity tray
// must navigate me to the originating chat AND scroll to the specific
// message bubble that produced the notification, highlighting it
// (`search-target-flash`) for visual confirmation. Field bug: the click
// no longer drills — it either does nothing or just switches the chat
// without scrolling to the bubble.
//
// Wiring: activity row li.onclick → opts.onOpen → onActivityOpen
// (main.ts) → drillToChatMessage(chatId, msgId, {validateExists:true})
// → backend.fetchSessionMessages probe → resumeSession →
// replaySessionMessages(id, msgs, pagination, targetMessageId=msgId).
// The targetMessageId branch in sessionResume.ts (line 158) looks up
// `[data-key="${msgId}"]` and runs drillScrollTo + adds the flash class.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'activity-row-drills-to-bubble';
export const DESCRIPTION = 'clicking an Activity tray row drills to the originating session bubble (flash highlight)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const VIEWED_CHAT = 'mock-drill-viewed';
const SOURCE_CHAT = 'mock-drill-source';
// The reply that fires the activity row. Its sidekick_id is what the
// activity row stores as `messageId`, and what the assistant bubble in
// the source chat carries as `data-key`. The smoke asserts those line up
// so the targetMessageId path in replaySessionMessages can find it.
const REPLY_MSG_ID = 'msg_drill_reply_0001';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(VIEWED_CHAT, {
    title: 'Viewed chat',
    messages: [{ role: 'user', content: 'viewed seed', sidekick_id: 'umsg_drill_viewed_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
  // Source chat: durable user message + the assistant reply (matching
  // REPLY_MSG_ID) — so when we drill into this chat, replaySessionMessages
  // renders the assistant bubble with data-key=REPLY_MSG_ID.
  mock.addChat(SOURCE_CHAT, {
    title: 'Source chat',
    messages: [
      { role: 'user', content: 'kick off the job', sidekick_id: 'umsg_drill_source_seed', timestamp: t0 },
      { role: 'assistant', content: 'On it — I\'ll triangulate Phil\'s emails…', sidekick_id: REPLY_MSG_ID, timestamp: t0 + 1 },
    ],
    lastActiveAt: Date.now() - 5000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, VIEWED_CHAT);
  await page.waitForFunction(
    () => /viewed seed/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 4_000, polling: 50 },
  );

  // Drive the OFF-SCREEN reply path. reply_final for SOURCE_CHAT while
  // VIEWED_CHAT is on screen → handleReplyFinal's off-screen branch
  // upserts an agent_reply activity item with messageId = REPLY_MSG_ID.
  mock.pushEnvelope({
    type: 'reply_delta',
    chat_id: SOURCE_CHAT,
    message_id: REPLY_MSG_ID,
    text: 'On it — I\'ll triangulate Phil\'s emails…',
  });
  mock.pushEnvelope({
    type: 'reply_final',
    chat_id: SOURCE_CHAT,
    message_id: REPLY_MSG_ID,
  });

  // The activity tray should now have a row for this reply, with
  // data-activity-id = REPLY_MSG_ID (sidekick_id flows through to the
  // activity-store id).
  await page.waitForFunction(() => {
    const b = document.getElementById('activity-drawer-count-rail');
    return !!b && !b.hidden;
  }, null, { timeout: 4_000, polling: 80 });

  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector(
    `#activity-drawer-panel:not([hidden]) .activity-drawer-item[data-activity-id="${REPLY_MSG_ID}"]`,
    { timeout: 3_000 },
  );
  log('activity row for the off-screen reply rendered ✓');

  // Click the row BODY — not the dismiss x, not action buttons. The
  // li.onclick handler is what drills.
  await page.locator(
    `#activity-drawer-panel .activity-drawer-item[data-activity-id="${REPLY_MSG_ID}"] .activity-item-body`,
  ).first().click();

  // Wait for (a) the viewed chat to switch to SOURCE_CHAT and
  // (b) the originating bubble to flash. The flash class is added by
  // drillScrollTo / its caller in sessionResume.ts:158-167.
  await page.waitForFunction(
    (cid) => {
      const active = document.querySelector('#sessions-list li.active');
      return active?.dataset?.chatId === cid;
    },
    SOURCE_CHAT,
    { timeout: 5_000, polling: 80 },
  ).catch(() => { /* surface via assert below */ });

  await page.waitForFunction(
    (key) => !!document.querySelector(`#transcript [data-key="${CSS.escape(key)}"]`),
    REPLY_MSG_ID,
    { timeout: 5_000, polling: 80 },
  ).catch(() => { /* surface via assert below */ });

  await page.waitForFunction(
    (key) => {
      const el = document.querySelector(`#transcript [data-key="${CSS.escape(key)}"]`);
      return !!el && el.classList.contains('search-target-flash');
    },
    REPLY_MSG_ID,
    { timeout: 4_000, polling: 60 },
  ).catch(() => { /* surface via assert below */ });

  const state = await page.evaluate((key) => {
    const active = document.querySelector('#sessions-list li.active');
    const bubble = document.querySelector(`#transcript [data-key="${CSS.escape(key)}"]`);
    const t = document.getElementById('transcript');
    const inView = bubble && t
      ? (() => {
          const r = bubble.getBoundingClientRect();
          const c = t.getBoundingClientRect();
          // Visible iff at least part of the bubble is inside the scroller.
          return r.bottom > c.top && r.top < c.bottom;
        })()
      : false;
    return {
      activeChatId: active?.dataset?.chatId || null,
      bubblePresent: !!bubble,
      hasFlash: !!bubble?.classList.contains('search-target-flash'),
      inView,
    };
  }, REPLY_MSG_ID);

  log(`after click: activeChat=${state.activeChatId} bubblePresent=${state.bubblePresent} flash=${state.hasFlash} inView=${state.inView}`);
  assert(state.activeChatId === SOURCE_CHAT,
    `clicking the activity row must switch to the source chat (${SOURCE_CHAT}); got "${state.activeChatId}"`);
  assert(state.bubblePresent,
    `the originating bubble (data-key="${REPLY_MSG_ID}") must be rendered in the transcript after the drill`);
  assert(state.hasFlash,
    `the originating bubble must carry the .search-target-flash class to highlight it (added by drillScrollTo in sessionResume.ts) — the click drilled into the chat but the target-message scroll/flash never ran`);
  assert(state.inView,
    `the originating bubble must be scrolled INTO the viewport after the drill — drillScrollTo did not bring it into view`);
  log('activity row click drilled to the originating session bubble with highlight ✓');
}
