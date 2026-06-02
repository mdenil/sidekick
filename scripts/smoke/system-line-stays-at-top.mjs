// Regression guard: a keyless `.line.system` timeline marker (e.g.
// "New chat started") must HOLD its position as messages reconcile
// around it. Bug: starting a new chat, "New chat started" began at the
// top, but each subsequent message pushed it down one row until it sat
// at the bottom of the conversation.
//
// Root cause: the reconciler positioned spec[i] at `children[i]`, counting
// the keyless marker as occupying a slot — so each appended message did
// insertBefore(msg, marker) and the marker sank one row per message. Fix:
// position specs relative to the spec subsequence, skipping keyless system
// rows (reconciler.ts).
//
// Why the existing `model-switch-system-line` smoke missed it: that test
// asserts markers APPEAR with the right text + count, but never sends chat
// messages afterward — so the reconcile-pushes-it-down path (which needs
// message specs flowing past the marker) was never exercised.
//
// Test plan (mocked):
//   1. New chat → "New chat started" marker is added (and should be first).
//   2. Send a user message; mock auto-replies.
//   3. Assert the marker is STILL the first `.line` (above user + agent).
//   4. Send a second message; assert the marker is STILL first.

import {
  waitForReady, openSidebar, send, captureNextChatId, clickNewChat, assert,
} from './lib.mjs';

export const NAME = 'system-line-stays-at-top';
export const DESCRIPTION = '"New chat started" system marker holds its top position as messages reconcile (not pushed down)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const MARKER = 'New chat started';

/** Ordered snapshot of `.line` rows for assertions + diagnostics. */
async function lineOrder(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line')).map((el) => ({
      system: el.classList.contains('system'),
      keyed: !!el.getAttribute('data-key'),
      text: (el.textContent || '').trim().slice(0, 40),
    })),
  );
}

/** Index of the "New chat started" marker among `.line` rows (-1 if gone). */
async function markerIndex(page) {
  return page.evaluate((m) => {
    const lines = Array.from(document.querySelectorAll('#transcript .line'));
    return lines.findIndex((el) =>
      el.classList.contains('system') && (el.textContent || '').includes(m));
  }, MARKER);
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  const idP = captureNextChatId(page);
  await clickNewChat(page);
  await idP;

  // Marker should be present and first.
  await page.waitForFunction(
    (m) => Array.from(document.querySelectorAll('#transcript .line.system'))
      .some((el) => (el.textContent || '').includes(m)),
    MARKER,
    { timeout: 4_000, polling: 50 },
  );
  assert(await markerIndex(page) === 0, `marker not at top right after new chat: ${JSON.stringify(await lineOrder(page))}`);
  log('marker present + at top after new chat ✓');

  // Send a message; wait for both the user bubble and the auto-reply.
  const MSG1 = `q1-${Math.random().toString(36).slice(2, 7)}`;
  await send(page, MSG1);
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    MSG1,
    { timeout: 5_000, polling: 100 },
  );
  // Wait for an agent bubble to land too (auto-reply), so a full reconcile
  // cycle with multiple specs has run past the marker.
  await page.waitForFunction(
    () => document.querySelectorAll('#transcript .line.agent').length >= 1,
    null,
    { timeout: 5_000, polling: 100 },
  );

  let idx = await markerIndex(page);
  assert(idx === 0, `after 1 message + reply, marker drifted to index ${idx} (BUG: should stay 0). order=${JSON.stringify(await lineOrder(page))}`);
  log('marker still at top after first message + reply ✓');

  // Second message — the original bug pushed it down one row per message,
  // so a second turn makes the regression unmistakable.
  const MSG2 = `q2-${Math.random().toString(36).slice(2, 7)}`;
  await send(page, MSG2);
  await page.waitForFunction(
    (m) => (document.getElementById('transcript')?.textContent || '').includes(m),
    MSG2,
    { timeout: 5_000, polling: 100 },
  );
  await page.waitForFunction(
    () => document.querySelectorAll('#transcript .line.agent').length >= 2,
    null,
    { timeout: 5_000, polling: 100 },
  );

  idx = await markerIndex(page);
  const order = await lineOrder(page);
  log(`final line order: ${JSON.stringify(order)}`);
  assert(idx === 0, `after 2 messages, marker drifted to index ${idx} (BUG). order=${JSON.stringify(order)}`);
  log('marker held top position across 2 turns ✓');
}
