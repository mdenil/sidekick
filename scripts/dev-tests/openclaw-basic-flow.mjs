// Real-backend dev-test for the openclaw integration (proxy :3002).
//
// Exercises the four features wired up in `backends/openclaw`:
//   1. Drawer list      (/v1/conversations)
//   2. Transcript replay (/v1/conversations/{id}/items)
//   3. Turn dispatch    (POST /v1/responses)
//   4. Continuity       — second turn lands in the same chat
//
// The continuity check is the regression we shipped a fix for:
// PWA-minted ids (`sidekick:<uuid>`) → openclaw-canonical
// (`agent:dev:sidekick:<uuid>`) → plugin stripped them back so the
// PWA's IDB row matches the server-returned id. Without the strip,
// every send to a "new chat" created a phantom duplicate row.
//
// Why dev-tests/ and not smoke/:
//   - Hits real openclaw + real gpt-5.4-mini via Codex OAuth.
//   - Variable timing (LLM latency).
//   - Persists real openclaw sessions (cleaned up at the end).
//   - Same methodology as `real-timer-flow.mjs` for hermes.
//
// Run:
//   SMOKE_URL=http://127.0.0.1:3002 \
//   SMOKE_CHROMIUM=/home/jscholz/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome \
//   node --experimental-strip-types --disable-warning=ExperimentalWarning \
//     scripts/dev-tests/openclaw-basic-flow.mjs

import {
  launchSharedBrowser, launchBrowser, waitForReady, openSidebar,
  clickNewChat, send, captureNextChatId, deleteChat, attachConsoleCapture,
  assert, clickRow,
} from '../smoke/lib.mjs';

const PROXY_URL = process.env.SMOKE_URL || 'http://127.0.0.1:3002';

function snap(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#sessions-list li[data-chat-id]'));
    const sidebar = rows.map(r => ({
      chatId: r.getAttribute('data-chat-id'),
      msgCount: (r.querySelector('.sess-meta')?.textContent || '').trim(),
      active: r.classList.contains('active'),
    }));
    const transcript = (document.getElementById('transcript')?.textContent || '').slice(0, 800);
    const bubbleCount = document.querySelectorAll('#transcript .line').length;
    const agentBubbles = Array.from(document.querySelectorAll('#transcript .line.agent'))
      .map(el => ({
        text: (el.textContent || '').trim().slice(0, 80),
        streaming: el.classList.contains('streaming'),
        pending: el.classList.contains('pending'),
        msgId: el.getAttribute('data-message-id') || '',
      }));
    return { sidebar, transcript, bubbleCount, agentBubbles };
  });
}

function logSnap(label, s) {
  console.log(`\n=== ${label} ===`);
  console.log('sidebar:', JSON.stringify(s.sidebar, null, 2));
  console.log('bubbleCount:', s.bubbleCount);
  console.log('agentBubbles:', JSON.stringify(s.agentBubbles));
}

async function countFinalAgent(page) {
  return page.evaluate(() =>
    document.querySelectorAll('#transcript .line.agent:not(.streaming):not(.pending)').length,
  );
}

async function waitForAgentReply(page, { since, timeoutMs = 60_000, pollMs = 500 } = {}) {
  const baseline = since ?? 0;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const count = await countFinalAgent(page);
    if (count > baseline) return Date.now() - t0;
    await page.waitForTimeout(pollMs);
  }
  throw new Error(`agent reply not seen in ${timeoutMs}ms (baseline=${baseline})`);
}

const { browser, closeShared } = await launchSharedBrowser({ headed: false });
const { ctx, page, cleanup } = await launchBrowser(browser);
const dumpConsole = attachConsoleCapture(page);

let createdChatId = null;
let exitCode = 0;
try {
  console.log(`[openclaw-basic-flow] PROXY_URL=${PROXY_URL}`);
  await waitForReady(page, PROXY_URL, { timeout: 20_000 });
  await openSidebar(page);

  // ── 1. New chat ─────────────────────────────────────────────────
  const chatIdPromise = captureNextChatId(page, { timeoutMs: 8000 });
  await clickNewChat(page);
  const chatId = await chatIdPromise;
  createdChatId = chatId;
  console.log(`[openclaw-basic-flow] created chat ${chatId}`);
  assert(chatId.startsWith('sidekick:'), `chat_id should be PWA-minted form: ${chatId}`);

  // ── 2. Send first message ──────────────────────────────────────
  const baseBefore1 = await countFinalAgent(page);
  await send(page, 'reply with exactly: ALPHA');
  const dur1 = await waitForAgentReply(page, { since: baseBefore1 });
  console.log(`[openclaw-basic-flow] reply #1 in ${dur1}ms`);
  const after1 = await snap(page);
  logSnap('after first turn', after1);
  assert(after1.bubbleCount >= 2, `expected ≥2 bubbles after turn 1, got ${after1.bubbleCount}`);

  // ── 3. Continuity check: send second message, verify same chat ─
  const baseBefore2 = await countFinalAgent(page);
  await send(page, 'reply with exactly: BETA');
  const dur2 = await waitForAgentReply(page, { since: baseBefore2 });
  console.log(`[openclaw-basic-flow] reply #2 in ${dur2}ms`);
  const after2 = await snap(page);
  logSnap('after second turn', after2);

  // Drawer should still have exactly one row for our chat id.
  // (Pre-fix: openclaw returned `agent:dev:sidekick:abc` which the PWA
  // showed as a SECOND row alongside the PWA's IDB `sidekick:abc`.)
  const ourRow = after2.sidebar.filter(r => r.chatId === chatId);
  assert(
    ourRow.length === 1,
    `expected exactly 1 drawer row for ${chatId}, got ${ourRow.length}: `
    + JSON.stringify(after2.sidebar),
  );
  assert(
    ourRow[0].active,
    `expected ${chatId} to still be the active chat`,
  );
  // No `agent:dev:` prefixed rows should appear — that would mean the
  // plugin's stripping regressed.
  const leakedCanonical = after2.sidebar.filter(r => r.chatId.startsWith('agent:dev:'));
  assert(
    leakedCanonical.length === 0,
    `unexpected canonical-form rows leaked into drawer: `
    + JSON.stringify(leakedCanonical),
  );

  // Transcript should have grown — at minimum one more user bubble
  // and one more agent bubble than after turn 1.
  assert(
    after2.bubbleCount > after1.bubbleCount,
    `expected bubble count to grow turn2 > turn1, got ${after1.bubbleCount} → ${after2.bubbleCount}`,
  );

  // ── 3b. Open-ended prompt (no message-tool) — bubble dup gate ──
  // Jonathan reported seeing a duplicated reply for "hey whats up?".
  // Casual prompts bypass openclaw's message-tool path and stream
  // through `stream:"assistant"`. Verify exactly one new agent
  // bubble appears (no inflight/IDB dup).
  const baseBefore3 = await countFinalAgent(page);
  await send(page, 'hey whats up? respond casually in two sentences');
  await waitForAgentReply(page, { since: baseBefore3 });
  const after3 = await snap(page);
  logSnap('after casual prompt', after3);
  const finalAgents3 = after3.agentBubbles.filter(b => !b.streaming && !b.pending);
  assert(
    finalAgents3.length === baseBefore3 + 1,
    `expected exactly 1 NEW agent bubble after casual prompt; `
    + `had ${baseBefore3} finalised before, now ${finalAgents3.length}: `
    + JSON.stringify(finalAgents3.map(b => b.text)),
  );

  // ── 4. Reload + transcript replay ──────────────────────────────
  // Reloads exercise /v1/conversations/{id}/items end-to-end. The
  // transcript should re-render with both turns from server state.
  console.log('[openclaw-basic-flow] reloading to verify transcript replay');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForReady(page, PROXY_URL, { timeout: 20_000 });
  // Wait for replaySessionMessages to render the historical bubbles.
  await page.waitForFunction(
    (id) => {
      const active = document.querySelector(`#sessions-list li[data-chat-id="${id}"].active`);
      const finalAgents = document.querySelectorAll(
        '#transcript .line.agent:not(.streaming):not(.pending)',
      );
      return Boolean(active) && finalAgents.length >= 2;
    },
    chatId,
    { timeout: 15_000, polling: 250 },
  );
  const afterReload = await snap(page);
  logSnap('after reload', afterReload);
  const reloadAgentTexts = afterReload.agentBubbles.map(b => b.text).join(' ');
  assert(
    /ALPHA/.test(reloadAgentTexts) && /BETA/.test(reloadAgentTexts),
    `expected both ALPHA + BETA replies to replay after reload, got: ${reloadAgentTexts}`,
  );
  // Dedup gate: no duplicate agent bubbles after reload (the bug
  // Jonathan caught — without sidekick_id mapping, the inflight cache
  // and history replay both render bubbles for the same message).
  // Count finalized agent bubbles. Three turns went into this chat
  // (ALPHA, BETA, casual). Expect exactly 3 finalized agent bubbles,
  // no more.
  const reloadFinalAgents = afterReload.agentBubbles.filter(
    b => !b.streaming && !b.pending,
  );
  assert(
    reloadFinalAgents.length === 3,
    `expected exactly 3 agent bubbles after reload (no dup), got `
    + `${reloadFinalAgents.length}: ${JSON.stringify(reloadFinalAgents.map(b => ({t: b.text.slice(0,30), id: b.msgId})))}`,
  );

  // Title sanity: drawer row's title should be semantic (snippet of
  // first user prompt) — not the chat_id and not a UUID.
  const ourSnap = afterReload.sidebar.find(r => r.chatId === chatId);
  assert(ourSnap, `chat ${chatId} should be in drawer after reload`);
  // The "title" we surface as first user message snippet; PWA renders
  // it as the row label. Verify it doesn't start with `sidekick:` or
  // `agent:` — those would mean we leaked the raw chat_id as title.
  const ourTitle = await page.evaluate((id) => {
    const row = document.querySelector(`#sessions-list li[data-chat-id="${id}"]`);
    // PWA drawer puts the label in .sess-snippet — falls back through
    // (title || first_user_message || chat_id). For openclaw chats the
    // plugin emits a snippet of the first user message as title.
    return (row?.querySelector('.sess-snippet')?.textContent || '').trim();
  }, chatId);
  console.log(`[openclaw-basic-flow] drawer title: ${JSON.stringify(ourTitle)}`);
  assert(
    ourTitle && !ourTitle.startsWith('sidekick:') && !ourTitle.startsWith('agent:'),
    `drawer title should be a semantic snippet, got: ${JSON.stringify(ourTitle)}`,
  );

  // ── 5. Delete cascades ─────────────────────────────────────────
  // Verify the chat actually got removed from openclaw, not just the
  // drawer's local IDB row.
  console.log('[openclaw-basic-flow] deleting chat + verifying server-side');
  await deleteChat(page, chatId);
  createdChatId = null;   // cleanup already happened; skip in finally
  // /v1/conversations should no longer list this chat.
  const stillThere = await page.evaluate(async (id) => {
    const r = await fetch('/api/sidekick/sessions');
    const j = await r.json();
    return (j?.sessions || []).some(s => s.chat_id === id);
  }, chatId);
  assert(!stillThere, `expected ${chatId} to be deleted server-side`);

  console.log('[openclaw-basic-flow] ✓ all assertions pass');
} catch (err) {
  exitCode = 1;
  console.error('[openclaw-basic-flow] FAIL', err);
  console.error('--- last 50 console lines ---');
  for (const line of dumpConsole(50)) console.error(line);
} finally {
  if (createdChatId) await deleteChat(page, createdChatId);
  await cleanup();
  await closeShared();
}
process.exit(exitCode);
