// Contract (Jonathan, 2026-05-29): clicking an APPROVAL row in the
// Activity tray must drill to the in-chat approval bubble (same as the
// agent_reply case in activity-row-drills-to-bubble.mjs). Suspected
// regression: the activity item stores `messageId = sidekick_id`
// (e.g. "notif_abc123"), but the in-chat approval bubble's reconciler
// key is `notif:${sidekick_id}` (projection.ts) — so the
// querySelector(`[data-key="${messageId}"]`) in sessionResume.ts:161
// misses, drillScrollTo never runs, and the user lands in the chat at
// the bottom (or wherever) instead of on the approval bubble.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'activity-approval-row-drills-to-bubble';
export const DESCRIPTION = 'clicking an approval row in the Activity tray drills to the in-chat approval bubble';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const VIEWED_CHAT = 'mock-approval-drill-viewed';
const APPROVAL_CHAT = 'mock-approval-drill-source';
const APPROVAL_NOTIF_ID = 'notif_drill_approval_001';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(VIEWED_CHAT, {
    title: 'Viewed',
    messages: [{ role: 'user', content: 'viewed seed', sidekick_id: 'umsg_apd_view_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
  // Seed the approval as a DURABLE notification row in the source chat,
  // mirroring how hermes persists approvals to state.db — so when we
  // drill into the chat, replaySessionMessages's setDurable renders the
  // approval bubble via the projection's notification path
  // (`isNotificationLikeItem` keys off `kind`).
  mock.addChat(APPROVAL_CHAT, {
    title: 'Approval source',
    messages: [
      { role: 'user', content: 'kick off the job', sidekick_id: 'umsg_apd_source_seed', timestamp: t0 },
      {
        role: 'assistant',
        kind: 'approval',
        content:
          '⚠️ Dangerous command requires approval:\n\n' +
          'printf approval-drill-target\n\n' +
          'Reason: approval drill smoke\n' +
          'Reply /approve to execute, /approve session to approve this pattern for the session, or /deny to cancel.',
        sidekick_id: APPROVAL_NOTIF_ID,
        timestamp: t0 + 1,
      },
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

  // Push an approval notification for the OFF-screen chat. This creates
  // both (a) an Activity tray row with messageId = sidekick_id, and (b)
  // an in-chat approval bubble in APPROVAL_CHAT with data-key carrying
  // whatever the reconciler keys it with.
  mock.pushEnvelope({
    type: 'notification',
    chat_id: APPROVAL_CHAT,
    kind: 'approval',
    content:
      '⚠️ Dangerous command requires approval:\n\n' +
      'printf approval-drill-target\n\n' +
      'Reason: approval drill smoke\n' +
      'Reply /approve to execute, /approve session to approve this pattern for the session, or /deny to cancel.',
    sidekick_id: APPROVAL_NOTIF_ID,
    urgent: true,
  });

  await page.waitForFunction(() => {
    const b = document.getElementById('activity-drawer-count-rail');
    return !!b && !b.hidden && (b.textContent || '').trim() === '1';
  }, null, { timeout: 4_000, polling: 80 });

  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector(
    `#activity-drawer-panel:not([hidden]) .activity-drawer-item[data-activity-id="${APPROVAL_NOTIF_ID}"]`,
    { timeout: 3_000 },
  );
  log('approval row rendered in tray ✓');

  // Click the row BODY (not the dismiss x, not Approve/Session/Deny
  // buttons). li.onclick → opts.onOpen → drillToChatMessage.
  await page.locator(
    `#activity-drawer-panel .activity-drawer-item[data-activity-id="${APPROVAL_NOTIF_ID}"] .activity-item-body`,
  ).first().click();

  // Drill must (1) switch the viewed chat, and (2) flash-highlight the
  // approval bubble in the transcript. The bubble has SOME data-key the
  // reconciler chose — under projection.ts notification rows are keyed
  // `notif:${sidekick_id}`, so the drill needs to look up that exact
  // key (not the bare sidekick_id) for scrolling/highlighting to fire.
  await page.waitForFunction(
    (cid) => {
      const active = document.querySelector('#sessions-list li.active');
      return active?.dataset?.chatId === cid;
    },
    APPROVAL_CHAT,
    { timeout: 5_000, polling: 80 },
  );

  // Look for the approval bubble in the transcript by content (since the
  // exact data-key shape is the thing the bug is about). The body text
  // is unique to this test.
  await page.waitForFunction(
    () => /approval-drill-target/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 4_000, polling: 80 },
  );

  // Now check whether the approval bubble carries the .search-target-flash
  // class — the drill's user-visible "you've been brought to THIS row"
  // signal that drillScrollTo adds (sessionResume.ts).
  await page.waitForFunction(() => {
    const lines = Array.from(document.querySelectorAll('#transcript .line'));
    return lines.some((l) => /approval-drill-target/.test(l.textContent || '')
      && l.classList.contains('search-target-flash'));
  }, null, { timeout: 4_000, polling: 60 }).catch(() => { /* surface via assert */ });

  const state = await page.evaluate(() => {
    const active = document.querySelector('#sessions-list li.active');
    const lines = Array.from(document.querySelectorAll('#transcript .line'));
    const approvalLine = lines.find((l) => /approval-drill-target/.test(l.textContent || ''));
    const t = document.getElementById('transcript');
    let inView = false;
    if (approvalLine && t) {
      const r = approvalLine.getBoundingClientRect();
      const c = t.getBoundingClientRect();
      inView = r.bottom > c.top && r.top < c.bottom;
    }
    return {
      activeChatId: active?.dataset?.chatId || null,
      bubbleKey: approvalLine?.getAttribute('data-key') || null,
      hasFlash: !!approvalLine?.classList.contains('search-target-flash'),
      inView,
    };
  });
  log(`after click: activeChat=${state.activeChatId} bubbleKey=${state.bubbleKey} flash=${state.hasFlash} inView=${state.inView}`);
  assert(state.bubbleKey, 'approval bubble missing from transcript after drill');
  assert(state.hasFlash,
    `clicking the approval row didn't flash the approval bubble. bubble data-key="${state.bubbleKey}", ` +
    `activity messageId stored as "${APPROVAL_NOTIF_ID}" — sessionResume.ts:161 looks up ` +
    `[data-key="${APPROVAL_NOTIF_ID}"] but the reconciler keys notification bubbles as ` +
    `"notif:${APPROVAL_NOTIF_ID}", so the lookup misses and drillScrollTo never runs.`);
  assert(state.inView, 'approval bubble must be scrolled into view after drill');
  log('approval row click drilled to in-chat approval bubble with flash ✓');
}
