// Scenario: send a message, get a reply, then reload the page MULTIPLE
// times. After each reload, the transcript should contain exactly the
// original messages — no duplicates.
//
// Field bug 2026-05-10 (Jonathan, then Tom): every page reload appended
// another full copy of the conversation on top of the IDB-restored
// transcript, doubling/tripling on each refresh until the chat became
// 8+ copies of the same exchange. Sister bug to the swipe-active class
// — also a state-reconciliation gap.
//
// Root cause: chat.init() rehydrated transcriptEl.innerHTML from IDB
// (DOM gets all the previous bubbles). renderedMessages.entries lives
// in JS heap, wiped on every page load. replaySessionMessages on
// resume called renderedMessages.upsert(messageId, ...) for each
// server message — entries.get returned undefined for every id, so
// upsert created NEW DOM bubbles instead of updating the existing
// IDB-restored ones. The fix: hydrateFromDOM walks
// `.line[data-message-id]` after IDB restore and registers every
// bubble in the entries map, so the next upsert finds them and
// updates in place.
//
// Test plan (mocked):
//   1. Send "dupe-marker-{rand}".
//   2. Wait for the agent reply to finalize.
//   3. Snapshot the .line count.
//   4. Reload 3 times. After each, assert .line count is unchanged.
//      Also assert no two bubbles share the same data-message-id.

import { waitForReady, send, assert } from './lib.mjs';

export const NAME = 'reload-no-duplicates';
export const DESCRIPTION = 'Page reload does not duplicate the transcript (IDB-restored DOM stays deduped against server replay)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(_mock) {
  // No pre-populated chats — scenario creates one via the PWA flow.
}

const MARKER = `dupe-marker-${Math.random().toString(36).slice(2, 8)}`;
const MOCK_REPLY_PREFIX = '[mock] echo:';
const RELOAD_COUNT = 3;

async function lineCount(page) {
  return await page.evaluate(
    () => document.querySelectorAll('#transcript .line').length,
  );
}

async function lineMessageIds(page) {
  return await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('#transcript .line[data-message-id]'));
    return lines.map(l => l.getAttribute('data-message-id'));
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);

  // Send marker + wait for the mock's auto-reply.
  await send(page, MARKER);
  log(`sent marker: ${MARKER}`);

  await page.waitForFunction(
    ({ prefix, marker }) => {
      const t = document.getElementById('transcript')?.textContent || '';
      return t.includes(marker) && t.includes(prefix);
    },
    { prefix: MOCK_REPLY_PREFIX, marker: MARKER },
    { timeout: 5_000, polling: 100 },
  );
  log('user marker + agent reply visible in transcript');

  // Baseline count + ids. Sleep briefly to let any final IDB persist
  // settle so the next reload reads the canonical snapshot.
  await page.waitForTimeout(250);
  const baselineCount = await lineCount(page);
  const baselineIds = await lineMessageIds(page);
  log(`baseline: ${baselineCount} .line elements (${baselineIds.length} with data-message-id)`);

  // Reload N times. After each, assert (a) count hasn't grown, (b) no
  // duplicate data-message-id in the DOM. Both checks together pin
  // the regression: (a) catches "renderedMessages.upsert created a
  // bubble that didn't exist in the entries map even though it was
  // already in the DOM," (b) catches the same bug viewed from the
  // other angle in case some future variant duplicates without
  // changing total .line count (e.g. removes one and adds two).
  for (let i = 1; i <= RELOAD_COUNT; i += 1) {
    await page.reload();
    await waitForReady(page);
    // Wait for the post-reload server replay to complete. The replay
    // runs after the upstream reconnects and the session resume
    // callback fires; without this poll we'd snapshot mid-replay and
    // get a (transient) lower count than baseline.
    await page.waitForFunction(
      ({ prefix, marker }) => {
        const t = document.getElementById('transcript')?.textContent || '';
        return t.includes(marker) && t.includes(prefix);
      },
      { prefix: MOCK_REPLY_PREFIX, marker: MARKER },
      { timeout: 5_000, polling: 100 },
    );
    await page.waitForTimeout(250);
    const after = await lineCount(page);
    if (after !== baselineCount) {
      const dump = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#transcript .line')).map(l => ({
          msgId: l.getAttribute('data-message-id') || null,
          cls: l.className,
          text: (l.textContent || '').slice(0, 60).replace(/\s+/g, ' ').trim(),
        })),
      );
      log(`DOM dump on failure (${after} lines):\n` + dump.map((d, idx) => `  [${idx}] msgId=${d.msgId} cls="${d.cls}" text="${d.text}"`).join('\n'));
    }
    assert(
      after === baselineCount,
      `reload #${i}: .line count grew from ${baselineCount} to ${after} — IDB+server replay are duplicating bubbles`,
    );
    const ids = await lineMessageIds(page);
    const dupes = ids.filter((id, idx) => ids.indexOf(id) !== idx);
    assert(
      dupes.length === 0,
      `reload #${i}: duplicate data-message-id values in DOM: ${JSON.stringify(dupes)}`,
    );
    log(`reload #${i}: ${after} .line elements, no duplicate ids ✓`);
  }
}
