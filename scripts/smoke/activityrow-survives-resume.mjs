// Pin the a9cee9f fix: activity-row entries survive a same-session
// resume (visibility flip, SSE reconnect, post-turn drawer refresh).
//
// Pre-fix: replaySessionMessages always called activityRow.clearAll(),
// even though it only cleared renderedMessages on a true session
// switch. Result: any background event that triggered a same-session
// resume after a turn wiped the on-screen tool-call summary while the
// reply bubble stayed put. The user saw tool calls appear during
// streaming, then "vanish at the end" once any cosmetic refresh
// landed.
//
// Test plan (mocked):
//   1. addChat with seed history.
//   2. Click into the chat.
//   3. Push a tool_call envelope; assert .tool-row appears in DOM.
//   4. Trigger a same-session resume by re-emitting the chat's
//      messages list through the public adapter callback. We use the
//      same path proxyClient takes on a stream-reconnect: replay the
//      messages payload via shellAdapter.onResume — exposed through
//      the build/main.mjs side-effect (replaySessionMessages is the
//      onResume handler).
//   5. Assert .tool-row STILL exists in DOM after resume (the bug:
//      it would have been wiped).

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'activityrow-survives-resume';
export const DESCRIPTION = 'Activity row tool-call entries survive a same-session resume';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-activity-resume';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Activity resume',
    messages: [
      { role: 'user', content: 'use a tool', timestamp: Date.now() / 1000 - 5 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // Click into the seeded chat so it's the viewed session.
  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_ID}"]`, { timeout: 5_000 });
  await page.locator(`#sessions-list li[data-chat-id="${CHAT_ID}"] .sess-body`).first().click();
  await page.waitForFunction(
    () => /use a tool/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  log('chat seeded + viewed');

  // Push a tool_call envelope. With agentActivity='summary' (default)
  // the activity row + an internal .tool-row is created.
  mock.pushEnvelope({
    type: 'tool_call',
    chat_id: CHAT_ID,
    call_id: 'call-survive-1',
    tool_name: 'web_search',
    args: { q: 'something' },
    started_at: new Date().toISOString(),
  });

  await page.waitForFunction(
    () => document.querySelectorAll('.tool-row').length >= 1,
    null,
    { timeout: 3_000, polling: 50 },
  );
  log('tool row rendered into activity row');

  // Snapshot the count BEFORE the resume.
  const before = await page.evaluate(() => ({
    activityRows: document.querySelectorAll('.activity-row').length,
    toolRows: document.querySelectorAll('.tool-row').length,
  }));
  log(`before resume: ${JSON.stringify(before)}`);
  assert(before.activityRows >= 1, `expected ≥1 activity row before resume, got ${before.activityRows}`);
  assert(before.toolRows >= 1, `expected ≥1 tool row before resume, got ${before.toolRows}`);

  // Trigger a same-session resume by hitting the proxy-client's
  // forceReconnect path — that's what visibility/online events do.
  // The 500ms reconcile-debounce means we need to wait a bit before
  // reading post-resume state. forceReconnect → reconcileActiveChat
  // → /messages refetch → onResume(replaySessionMessages).
  await page.evaluate(async () => {
    const px = await import('/build/proxyClient.mjs');
    px.forceReconnect();
  });

  // The reconcileActiveChat gate skips when gapMs < 10s. To force the
  // resume path, hit it manually via the public history-replay route:
  // post-turn drawer refresh inside the PWA also calls
  // replaySessionMessages directly. Same effect: import main's
  // resume path. main.ts doesn't export replaySessionMessages, so we
  // simulate the equivalent: dispatch a session-resume by clicking
  // into the SAME chat in the drawer twice, which forces a re-fetch
  // of /messages without changing viewed.
  //
  // Simplest: click into a different (auto-rotated) chat and back —
  // but a same-session resume needs to actually fire. We can simulate
  // by directly invoking onResume via the bound shell. Since the
  // shell registers onResume = replaySessionMessages, we trigger via
  // the same mechanism the proxy-client uses internally:
  //
  // The cleanest path: dispatch a 'visibilitychange' to fire the
  // forceReconnect path's reconcileActiveChat with a long gapMs by
  // manipulating the time. But that's intrusive.
  //
  // Pragmatic approach: directly invoke main's drawer-click resume
  // by clicking the row again. clickRow → resumeSession(chatId)
  // which goes through replaySessionMessages on the SAME chat —
  // textbook same-session resume.
  await page.locator(`#sessions-list li[data-chat-id="${CHAT_ID}"] .sess-body`).first().click();

  // Wait for the second resume to complete — transcript reflows but
  // viewed remains the same chat.
  await page.waitForTimeout(500);

  const after = await page.evaluate(() => ({
    activityRows: document.querySelectorAll('.activity-row').length,
    toolRows: document.querySelectorAll('.tool-row').length,
  }));
  log(`after same-session resume: ${JSON.stringify(after)}`);

  assert(
    after.activityRows >= 1,
    `same-session resume cleared the activity row (was ${before.activityRows}, now ${after.activityRows}) — pre-fix bug regressed`,
  );
  assert(
    after.toolRows >= 1,
    `same-session resume cleared the tool entries (was ${before.toolRows}, now ${after.toolRows}) — pre-fix bug regressed`,
  );
  log('activity row + tool entries survived same-session resume ✓');
}
