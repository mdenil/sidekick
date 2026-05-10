// Scenario: when the on-screen transcript ends up with more bubbles
// than the server's canonical message set, replaySessionMessages
// detects the divergence and self-heals by clearing + re-rendering.
//
// Why this matters: the dedup-by-sidekick_id fix relies on every
// path emitting a stable id. If a future code path leaks a stale-
// keyed bubble (regression), divergence-detection is the safety net
// that recovers automatically rather than letting the duplicate
// linger across reloads.
//
// Test plan (mocked):
//   1. Seed a chat with N=2 messages.
//   2. Click in. DOM has 2 .line elements.
//   3. Inject K=3 stale bubbles into the DOM directly (simulating a
//      hypothetical regression that bypassed dedup). DOM now has 5.
//   4. Trigger replaySessionMessages by clicking the same chat row
//      again (drawer-click → resume → onResume → replay).
//   5. Assert: divergence-detect log line appears in the page console
//      AND DOM ends up with N=2 .line elements.

import { waitForReady, openSidebar, assert } from './lib.mjs';

export const NAME = 'divergence-self-heal';
export const DESCRIPTION = 'replaySessionMessages detects DOM/server count divergence and re-renders from server';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-divergence';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Divergence repro',
    messages: [
      { role: 'user', content: 'first', sidekick_id: 'umsg_div_test_1', timestamp: Date.now() / 1000 - 10 },
      { role: 'assistant', content: 'second', sidekick_id: 'msg_div_test_2', timestamp: Date.now() / 1000 - 9 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
}

async function lineCount(page) {
  return await page.evaluate(
    () => document.querySelectorAll('#transcript .line').length,
  );
}

export default async function run({ page, log }) {
  // Capture page console so we can verify the divergence log fired.
  const consoleLog = [];
  page.on('console', (msg) => consoleLog.push(msg.text()));

  await waitForReady(page);
  await openSidebar(page);

  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_ID}"]`, { timeout: 5_000 });
  await page.locator(`#sessions-list li[data-chat-id="${CHAT_ID}"] .sess-body`).first().click();
  await page.waitForFunction(
    () => /first/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  const baseline = await lineCount(page);
  assert(baseline === 2, `baseline expected 2 .line, got ${baseline}`);
  log(`baseline: ${baseline} .line elements`);

  // Inject 3 stale bubbles directly into the DOM with fake data-message-ids
  // — simulates a regression where some code path created bubbles outside
  // the renderedMessages.upsert dedup machinery.
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (!t) throw new Error('no #transcript');
    for (let i = 0; i < 3; i += 1) {
      const div = document.createElement('div');
      div.className = 'line s0';
      div.dataset.messageId = `stale-leaked-${i}`;
      div.innerHTML = `<span class="speaker">You</span><span class="text">leaked stale bubble ${i}</span>`;
      t.appendChild(div);
    }
  });
  const polluted = await lineCount(page);
  assert(polluted === 5, `after injection expected 5 .line, got ${polluted}`);
  log(`injected 3 stale bubbles: ${polluted} .line elements (5 = 2 real + 3 stale)`);

  // Trigger a same-session resume by re-clicking the chat row. That
  // fires drawer.clickRow → resumeSession → replaySessionMessages
  // with sameSession=true. Without the divergence-detect, the stale
  // bubbles would survive (sameSession path doesn't clear). With
  // it, the count check fires + the heal path clears + re-renders.
  await page.locator(`#sessions-list li[data-chat-id="${CHAT_ID}"] .sess-body`).first().click();
  await page.waitForTimeout(500);

  // Assert divergence log fired. The exact wording is in main.ts —
  // we match the substring the implementation emits.
  const sawDivergence = consoleLog.some(l => /divergence detected/.test(l));
  assert(
    sawDivergence,
    `expected a "divergence detected" log line in page console, got: ${JSON.stringify(consoleLog.slice(-10))}`,
  );
  log('divergence-detect log fired ✓');

  // After heal: DOM back to N=2 (the server's canonical set).
  const healed = await lineCount(page);
  assert(
    healed === 2,
    `after self-heal expected 2 .line, got ${healed} — heal failed to clear stale bubbles`,
  );
  log(`self-heal complete: ${healed} .line elements (matches server canonical set) ✓`);
}
