// Real-backend regression test for "mid-flight bounce between chats"
// — the harder version of openclaw-mid-flight.mjs.
//
// Flow:
//   1. Create chat A, send "ALPHA-PING", wait for reply.
//   2. Create chat B, send "BETA-PING", wait for reply.
//   3. Switch to chat A (resume → "ALPHA-PING" visible).
//   4. Fire a long prompt in chat A ("count slowly...").
//   5. Mid-flight: switch to B (resume → "BETA-PING" visible).
//   6. Switch back to A (resume).
//   7. Assert "count slowly" user bubble visible in chat A — NOT
//      vanished by the in-flight gap.
//   8. Bounce A → B → A again to stress the resume + items merge.
//   9. Wait for reply, verify it lands in chat A (not bled to B).
//
// Real session switches via the drawer (not page.reload), so this
// exercises the actual user flow. Uses content-match waits to dodge
// the clickRow → activeChatId timing race (waiting for "active class"
// is unreliable because activeChatId is set synchronously inside the
// resume promise, not at click-time).

import {
  launchSharedBrowser, launchBrowser, waitForReady, openSidebar,
  clickNewChat, send, captureNextChatId, deleteChat, attachConsoleCapture,
  assert, clickRow,
} from '../smoke/lib.mjs';

const PROXY_URL = process.env.SMOKE_URL || 'http://127.0.0.1:3002';

async function waitTranscriptContains(page, snippet, { timeoutMs = 10_000, pollMs = 200 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const found = await page.evaluate((s) =>
      (document.getElementById('transcript')?.textContent || '').includes(s),
      snippet);
    if (found) return Date.now() - t0;
    await page.waitForTimeout(pollMs);
  }
  const have = await page.evaluate(() =>
    (document.getElementById('transcript')?.textContent || '').slice(0, 200),
  );
  throw new Error(`transcript did not contain ${JSON.stringify(snippet)} within ${timeoutMs}ms; have: ${JSON.stringify(have)}`);
}

async function userBubbles(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line.user, #transcript .line.s0'))
      .map(el => (el.textContent || '').trim()),
  );
}

const { browser, closeShared } = await launchSharedBrowser({ headed: false });
const { ctx, page, cleanup } = await launchBrowser(browser);
const dumpConsole = attachConsoleCapture(page);

let chatA = null, chatB = null;
let exitCode = 0;
try {
  console.log(`[openclaw-multi-switch] PROXY_URL=${PROXY_URL}`);
  await waitForReady(page, PROXY_URL, { timeout: 20_000 });
  await openSidebar(page);

  // ── Chat A setup ────────────────────────────────────────────────
  let p = captureNextChatId(page, { timeoutMs: 8000 });
  await clickNewChat(page);
  chatA = await p;
  console.log(`[openclaw-multi-switch] chat A = ${chatA}`);
  await send(page, 'reply with: ALPHA-PING');
  await waitTranscriptContains(page, 'ALPHA-PING', { timeoutMs: 60_000 });

  // ── Chat B setup ────────────────────────────────────────────────
  p = captureNextChatId(page, { timeoutMs: 8000 });
  await clickNewChat(page);
  chatB = await p;
  console.log(`[openclaw-multi-switch] chat B = ${chatB}`);
  await send(page, 'reply with: BETA-PING');
  await waitTranscriptContains(page, 'BETA-PING', { timeoutMs: 60_000 });

  // ── Switch to chat A, fire long prompt ─────────────────────────
  await clickRow(page, chatA);
  await waitTranscriptContains(page, 'ALPHA-PING', { timeoutMs: 10_000 });
  console.log('[openclaw-multi-switch] chat A active, firing long prompt');
  const LONG = 'count slowly to five, one per second, end with: COUNTED-MULTI';
  await send(page, LONG);
  // Brief pause so dispatch is genuinely in-flight (reply not done).
  await page.waitForTimeout(500);

  // ── Mid-flight: switch to chat B ────────────────────────────────
  console.log('[openclaw-multi-switch] switch → chat B mid-flight');
  await clickRow(page, chatB);
  await waitTranscriptContains(page, 'BETA-PING', { timeoutMs: 10_000 });

  // ── Back to A: prompt should still be there ─────────────────────
  console.log('[openclaw-multi-switch] switch ← chat A mid-flight');
  await clickRow(page, chatA);
  await waitTranscriptContains(page, 'count slowly', { timeoutMs: 10_000 });
  let ub = await userBubbles(page);
  console.log(`[openclaw-multi-switch]   user bubbles after first bounce: ${JSON.stringify(ub)}`);
  assert(
    ub.some(t => /count slowly/i.test(t)),
    `user prompt missing after A→B→A bounce, got: ${JSON.stringify(ub)}`,
  );
  // Also assert no dupe of the count-slowly prompt (timestamped + bare).
  const countSlowlyCount = ub.filter(t => /count slowly/i.test(t)).length;
  assert(
    countSlowlyCount === 1,
    `expected exactly 1 count-slowly user bubble, got ${countSlowlyCount}: ${JSON.stringify(ub)}`,
  );

  // ── Bounce again: A → B → A ─────────────────────────────────────
  console.log('[openclaw-multi-switch] second bounce A → B → A');
  await clickRow(page, chatB);
  await waitTranscriptContains(page, 'BETA-PING', { timeoutMs: 10_000 });
  await clickRow(page, chatA);
  await waitTranscriptContains(page, 'count slowly', { timeoutMs: 10_000 });
  ub = await userBubbles(page);
  assert(
    ub.some(t => /count slowly/i.test(t)),
    `user prompt missing after second bounce, got: ${JSON.stringify(ub)}`,
  );

  // ── Wait for reply, verify it landed in A (not B) ───────────────
  console.log('[openclaw-multi-switch] waiting for reply to complete');
  await waitTranscriptContains(page, 'COUNTED-MULTI', { timeoutMs: 60_000 });
  // Switch to B → should not see COUNTED-MULTI there.
  await clickRow(page, chatB);
  await waitTranscriptContains(page, 'BETA-PING', { timeoutMs: 10_000 });
  const bText = await page.evaluate(() => (document.getElementById('transcript')?.textContent || ''));
  assert(
    !bText.includes('COUNTED-MULTI'),
    `reply bled to chat B (should be A-only). chat B transcript: ${bText.slice(0, 300)}`,
  );

  console.log('[openclaw-multi-switch] ✓ all assertions pass');
} catch (err) {
  exitCode = 1;
  console.error('[openclaw-multi-switch] FAIL', err);
  console.error('--- last 50 console lines ---');
  for (const line of dumpConsole(50)) console.error(line);
} finally {
  for (const id of [chatA, chatB].filter(Boolean)) {
    try { await deleteChat(page, id); } catch {}
  }
  await cleanup();
  await closeShared();
}
process.exit(exitCode);
