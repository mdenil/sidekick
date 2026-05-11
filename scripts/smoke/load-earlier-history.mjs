// Phase 0 smoke (pre-refactor): pin loadEarlierHistory's invariants.
//
// loadEarlierHistory (main.ts:4350) fires when the user scrolls to the
// top of the transcript and chat.setPaginationState says hasMore. It
// fetches via backend.loadEarlier(id, beforeId) which hits
// GET /api/sidekick/sessions/<id>/messages?before=N, then prepends
// the returned messages in REVERSE iteration order (i.length-1 → 0)
// because each chat.addLine(prepend=true) inserts at firstChild —
// LAST call ends up at the top.
//
// Refactor risk: when sessionResume.ts gets extracted (Phase 2), the
// prepend-loop direction is a one-line invariant. A "simplification"
// that iterates 0 → length-1 silently inverts older-batch order so
// the OLDEST message of the batch ends up adjacent to the existing
// transcript and the NEWEST of the batch ends up at the top — bug
// is invisible unless you read the timestamps. This smoke pins the
// correct ordering by seeding 30 messages with monotonically
// increasing content markers and asserting they appear in
// monotonic order top-to-bottom across both pages.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'load-earlier-history';
export const DESCRIPTION = 'scroll-to-top loads older history above existing messages in correct chronological order';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-load-earlier';

export function MOCK_SETUP(mock) {
  // 30 messages with monotonic content markers, plus a first-page
  // limit cap of 10 so the initial render is msg-21..30 and
  // hasMore=true. Pagination support + the limit cap landed in
  // mock-backend.mjs 2026-05-11 to support this test.
  mock.setHistoryFirstPageLimit(10);
  const messages = [];
  for (let i = 0; i < 30; i++) {
    const idx = i + 1;  // 1..30 (1-indexed for readable assertions)
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user' ? `msg-${idx} user marker` : `msg-${idx} agent reply`,
      timestamp: Date.now() / 1000 - (30 - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Load-earlier pagination test',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);

  // Wait for the latest page to render. msg-30 is the newest; if the
  // first page slice worked, it's the bottom of the transcript.
  await page.waitForFunction(
    () => /msg-30 agent reply/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  log('first page rendered (msg-21..30 expected) ✓');

  // Sanity: msg-1..20 should NOT be in the DOM yet — they're on later
  // pages.
  const firstPageHasOlder = await page.evaluate(
    () => /msg-5 /.test(document.getElementById('transcript')?.textContent || ''),
  );
  assert(
    !firstPageHasOlder,
    'first page leaked msg-5 — pagination didn\'t actually restrict the slice',
  );
  log('first page is correctly limited to the latest 10 ✓');

  // Watch for the before-cursored /messages request loadEarlier fires.
  // Surfaced on assertion failure so a "smoke didn't even trigger
  // loadEarlier" failure is distinguishable from an "older messages
  // landed in the wrong order" failure.
  const beforeRequests = [];
  page.on('request', (req) => {
    if (/\/api\/sidekick\/sessions\/[^/]+\/messages\?.*before=/.test(req.url())) {
      beforeRequests.push(req.url());
    }
  });

  // Scroll to top to trigger loadEarlier. The scroll handler fires
  // maybeLoadEarlier on every scroll event regardless of who initiated
  // it. Brief settle first so any post-replay forceScrollToBottom
  // has completed before we move the cursor up.
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (t) {
      t.scrollTop = 0;
      t.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  });

  // Wait for the older page to land. msg-11 is the newest of msgs 11-20
  // (the middle slice). When that appears, loadEarlier did its work.
  try {
    await page.waitForFunction(
      () => /msg-11 user marker/.test(document.getElementById('transcript')?.textContent || ''),
      null,
      { timeout: 5_000, polling: 100 },
    );
  } catch (e) {
    log(`load-earlier never fired. Before-cursor requests seen: ${beforeRequests.length}`);
    if (beforeRequests.length > 0) {
      log(`  ${beforeRequests[0]}`);
    }
    throw e;
  }
  log('older page loaded (msg-11..20 prepended) ✓');

  // Critical assertion: top-to-bottom DOM order must be monotonic.
  // After two pages we should have msg-11..30 in order. Pull every
  // bubble's marker number and assert ascending.
  const orderInfo = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('#transcript .line.s0, #transcript .line.agent'));
    const markers = [];
    for (const l of lines) {
      const m = /msg-(\d+) /.exec(l.textContent || '');
      if (m) markers.push(parseInt(m[1], 10));
    }
    return markers;
  });
  log(`DOM marker order (first/last 4): [${orderInfo.slice(0, 4).join(', ')}, …, ${orderInfo.slice(-4).join(', ')}]`);
  assert(
    orderInfo.length >= 20,
    `expected at least 20 marker-bubbles in DOM after load-earlier; got ${orderInfo.length}`,
  );
  for (let i = 1; i < orderInfo.length; i++) {
    assert(
      orderInfo[i] > orderInfo[i - 1],
      `chronological order violated at position ${i}: ${orderInfo[i - 1]} → ${orderInfo[i]}. ` +
      `Most likely cause: loadEarlierHistory's prepend-loop was inverted (iterating 0 → length-1 ` +
      `instead of length-1 → 0). Each prepend inserts at firstChild; LAST inserted is topmost — ` +
      `so the iteration MUST go newest-first within the older batch to land them oldest-first ` +
      `in the DOM.`,
    );
  }
  log(`top-to-bottom DOM order is monotonically increasing across the page boundary ✓`);
}
