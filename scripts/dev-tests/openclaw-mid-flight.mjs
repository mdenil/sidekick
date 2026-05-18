// Real-backend regression test for the "mid-flight session switch
// loses the user prompt" bug Jonathan reported on 2026-05-16.
//
// Symptom: user fires a turn → switches chats before the reply lands
// → switches back → their own prompt has DISAPPEARED until the agent
// finishes. Same shape on hermes + openclaw.
//
// Root cause on openclaw: jsonl writes are turn-final (verified —
// at 300ms post-POST, /v1/conversations/{id}/items returns 0 rows;
// at 2s, the full transcript). The user message lives only in
// in-process agent state during the in-flight window. The proxy's
// inflight cache used to bridge the gap, but the openclaw plugin
// didn't emit a `user_message` envelope on POST receipt, so nothing
// fed the cache.
//
// Fix (commit ???): plugin now (1) opens an in-memory TurnBuffer
// entry at POST receipt, (2) emits `user_message` envelope to
// /v1/events for cross-device sync + inflight prime, (3) merges the
// buffer onto /v1/conversations/{id}/items output for active turns.
//
// This test uses page.reload() in place of the chat-switcher (which
// has a chat-id sequencing race) — it exercises the same /items
// refetch path the PWA does on session switch, with deterministic
// timing.
//
// Run:
//   SMOKE_URL=http://127.0.0.1:3002 \
//   SMOKE_CHROMIUM=/home/jscholz/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome \
//   node --experimental-strip-types --disable-warning=ExperimentalWarning \
//     scripts/dev-tests/openclaw-mid-flight.mjs

import {
  launchSharedBrowser, launchBrowser, waitForReady, openSidebar,
  clickNewChat, send, captureNextChatId, deleteChat, attachConsoleCapture,
  assert,
} from '../smoke/lib.mjs';

const PROXY_URL = process.env.SMOKE_URL || 'http://127.0.0.1:3002';
const PROMPT = 'count slowly to five, one number per second, end with: COUNTED';

const { browser, closeShared } = await launchSharedBrowser({ headed: false });
const { ctx, page, cleanup } = await launchBrowser(browser);
const dumpConsole = attachConsoleCapture(page);

let createdChatId = null;
let exitCode = 0;
try {
  console.log(`[openclaw-mid-flight] PROXY_URL=${PROXY_URL}`);
  await waitForReady(page, PROXY_URL, { timeout: 20_000 });
  await openSidebar(page);

  // Fresh chat for this run.
  const chatIdPromise = captureNextChatId(page, { timeoutMs: 8000 });
  await clickNewChat(page);
  const chatId = await chatIdPromise;
  createdChatId = chatId;
  console.log(`[openclaw-mid-flight] chat = ${chatId}`);

  // Fire the long prompt and reload mid-flight.
  await send(page, PROMPT);
  console.log('[openclaw-mid-flight] dispatched, waiting 800ms then reloading');
  await page.waitForTimeout(800);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForReady(page, PROXY_URL, { timeout: 20_000 });
  // Wait for the same chat to be active again (PWA picks most-recent
  // by default).
  await page.waitForFunction(
    (id) => Boolean(document.querySelector(`#sessions-list li[data-chat-id="${id}"].active`)),
    chatId, { timeout: 10_000, polling: 200 },
  );
  // Give the /items refetch a moment to render.
  await page.waitForTimeout(800);
  const userBubbles = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line.user, #transcript .line.s0'))
      .map(el => (el.textContent || '').trim()),
  );
  console.log(`[openclaw-mid-flight] post-reload user bubbles: ${JSON.stringify(userBubbles)}`);
  assert(
    userBubbles.some(t => /count slowly to five/i.test(t)),
    `expected user prompt visible after mid-flight reload, got: ${JSON.stringify(userBubbles)}`,
  );
  console.log('[openclaw-mid-flight] ✓ user prompt survived mid-flight reload');

  // Wait for the in-flight reply to actually complete (cleanup
  // courtesy — leave the chat in a consistent state on success path).
  await page.waitForFunction(
    () => document.querySelectorAll('#transcript .line.agent:not(.streaming):not(.pending)').length >= 1,
    null, { timeout: 60_000, polling: 500 },
  );
} catch (err) {
  exitCode = 1;
  console.error('[openclaw-mid-flight] FAIL', err);
  console.error('--- last 50 console lines ---');
  for (const line of dumpConsole(50)) console.error(line);
} finally {
  if (createdChatId) await deleteChat(page, createdChatId);
  await cleanup();
  await closeShared();
}
process.exit(exitCode);
