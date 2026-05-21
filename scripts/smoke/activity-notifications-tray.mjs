// Activity tray v1: all OS-push-worthy Sidekick events get a recoverable row.
//
// Covers the two non-approval cases that users actually see as push
// notifications:
//   - off-screen reply_final (agent reply / weather-tool-style result)
//   - cron notification envelope
// Also pins the dismiss control: x removes the row immediately.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'activity-notifications-tray';
export const DESCRIPTION = 'off-screen agent replies and cron notifications persist in Activity and can be dismissed';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const VIEWED_CHAT = 'mock-chat-activity-notif-viewed';
const REPLY_CHAT = 'mock-chat-activity-agent-reply';
const CRON_CHAT = 'mock-chat-activity-cron';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  for (const [id, title] of [
    [VIEWED_CHAT, 'Activity Notification Viewed'],
    [REPLY_CHAT, 'Weather Tool Check'],
    [CRON_CHAT, 'Cron Timer Check'],
  ]) {
    mock.addChat(id, {
      title,
      messages: [
        { role: 'user', content: `${title} seed`, sidekick_id: `umsg_${id}_seed`, timestamp: t0 },
      ],
      lastActiveAt: Date.now() - 1000,
    });
  }
}

async function waitForActivityBadge(page, count) {
  await page.waitForFunction(
    (n) => {
      const badge = document.getElementById('activity-drawer-count-rail');
      return !!badge && !badge.hidden && (badge.textContent || '').trim() === String(n);
    },
    count,
    { timeout: 3_000, polling: 50 },
  );
}

async function activityText(page) {
  return page.evaluate(() => document.getElementById('activity-drawer-panel')?.textContent || '');
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, VIEWED_CHAT);
  await page.waitForFunction(
    () => /Activity Notification Viewed seed/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );

  mock.pushEnvelope({
    type: 'reply_final',
    chat_id: REPLY_CHAT,
    message_id: 'msg_activity_agent_reply_1',
    text: 'Weather check complete: London is overcast and mild.',
  });
  await waitForActivityBadge(page, 1);
  log('off-screen reply_final created Activity badge ✓');

  mock.pushEnvelope({
    type: 'notification',
    chat_id: CRON_CHAT,
    kind: 'cron',
    content:
      'Cronjob Response: Tea timer\n' +
      '(job_id: smoke-tea-timer)\n' +
      '--------------------------\n' +
      'Your tea timer fired.\n\n' +
      'To stop or manage this job, open Sidekick.',
    sidekick_id: 'notif_activity_cron_1',
  });
  await waitForActivityBadge(page, 2);
  log('cron notification created Activity badge ✓');

  await page.click('#btn-activity-drawer-rail');
  await page.waitForSelector('#activity-drawer-panel:not([hidden]) .activity-drawer-item', { timeout: 3_000 });
  const text = await activityText(page);
  assert(text.includes('Reply · Weather Tool Check'), 'agent reply Activity title missing');
  assert(text.includes('Weather check complete'), 'agent reply Activity body missing');
  assert(text.includes('Cron · Cron Timer Check'), 'cron Activity title missing');
  assert(text.includes('Your tea timer fired'), 'cron Activity body missing');
  log('Activity tray rendered reply + cron rows ✓');

  const beforeCount = await page.locator('#activity-drawer-panel .activity-drawer-item').count();
  await page.locator('#activity-drawer-panel .activity-drawer-item', { hasText: 'Weather check complete' })
    .locator('.pin-item-unpin-btn')
    .click();
  await page.waitForFunction(
    () => !(document.getElementById('activity-drawer-panel')?.textContent || '').includes('Weather check complete'),
    null,
    { timeout: 3_000, polling: 50 },
  );
  const afterCount = await page.locator('#activity-drawer-panel .activity-drawer-item').count();
  assert(afterCount === beforeCount - 1, `expected dismiss to remove one row (${beforeCount} -> ${afterCount})`);
  log('dismiss x removed Activity row ✓');
}
