// Real-backend repro driver for the 2026-05-11 mid-turn session-switch
// bug. Drives the actual PWA against the actual proxy against the
// actual hermes — no mocks. Captures the SIX assertions the field
// report described:
//
//   1. New chat → "set a 10 second timer"
//   2. Switch to ANOTHER (existing) session
//      → original sidebar title should show the snippet, not "New chat"
//      → critical: the EXISTING-chat target triggers the heavier
//        resumeSession path. A fresh empty target hides the bug.
//   3. Switch back → user message still visible in transcript
//   4. Wait for agent reply → exactly 1 user + 1 finalized agent bubble
//   5. Switch away + back → same state preserved post-roundtrip
//
// Why this lives in dev-tests/ and not scripts/smoke/:
//   - Hits the live hermes stack; persists real state.db rows
//     (cleanup deletes chat A after).
//   - Variable timing (depends on real LLM latency).
//   - Not gated; meant as a methodology fixture for future debug
//     sessions to copy + tweak, not a CI-suite check.
//
// The 4 PASS assertions in `switch-during-inflight-existing-target.mjs`
// (mocked smoke) are the regression-gate version of this script. When
// a similar field bug surfaces:
//   1. Write the real-backend repro here first — proves the bug exists
//      and pins exact failing assertions.
//   2. Mirror the timing semantics into mock-backend.mjs (e.g. the
//      setPostTurnPersistence flag added 2026-05-11).
//   3. Port assertions into a mocked smoke for permanent CI gating.
// See ~/code/hermes-agent-private/DEVELOPMENT.md "Test at the right
// layer" for the broader methodology.
//
// Run: SMOKE_CHROMIUM=/home/jscholz/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome \
//      node --experimental-strip-types scripts/dev-tests/real-timer-flow.mjs

import {
  launchSharedBrowser, launchBrowser, waitForReady, openSidebar,
  clickNewChat, send, captureNextChatId, deleteChat, attachConsoleCapture,
} from '../smoke/lib.mjs';

const PROMPT = 'set a 10 second timer';

function snap(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#sessions-list li[data-chat-id]'));
    const sidebar = rows.map(r => ({
      chatId: r.getAttribute('data-chat-id'),
      text: (r.querySelector('.sess-snippet')?.textContent || '').trim(),
      active: r.classList.contains('active'),
    }));
    const transcript = (document.getElementById('transcript')?.textContent || '').slice(0, 800);
    const bubbleCount = document.querySelectorAll('#transcript .line').length;
    const userBubbles = Array.from(document.querySelectorAll('#transcript .line.s0, #transcript .line.user'))
      .map(el => (el.textContent || '').trim().slice(0, 80));
    const agentBubbles = Array.from(document.querySelectorAll('#transcript .line.agent'))
      .map(el => ({
        text: (el.textContent || '').trim().slice(0, 80),
        streaming: el.classList.contains('streaming'),
        pending: el.classList.contains('pending'),
        msgId: el.getAttribute('data-message-id') || '',
      }));
    const allLines = Array.from(document.querySelectorAll('#transcript .line'))
      .map(el => ({
        cls: el.className,
        msgId: el.getAttribute('data-message-id') || '',
        text: (el.textContent || '').trim().slice(0, 60),
      }));
    return { sidebar, transcript, bubbleCount, userBubbles, agentBubbles, allLines };
  });
}

function logSnap(label, snap) {
  console.log(`\n=== ${label} ===`);
  console.log('sidebar:', JSON.stringify(snap.sidebar, null, 2));
  console.log(`userBubbles (${snap.userBubbles.length}):`, JSON.stringify(snap.userBubbles));
  console.log(`agentBubbles (${snap.agentBubbles.length}):`, JSON.stringify(snap.agentBubbles));
  console.log(`allLines (${snap.allLines.length}):`, JSON.stringify(snap.allLines));
}

const { browser, closeShared } = await launchSharedBrowser({ headed: false });
const { page, cleanup } = await launchBrowser(browser);
const consoleTail = attachConsoleCapture(page, 400);
let chatA = null, chatB = null;

try {
  console.log('--- step 1: waitForReady, open sidebar ---');
  await waitForReady(page);
  await openSidebar(page);

  console.log('--- step 2: new chat A, send the timer prompt ---');
  const idAP = captureNextChatId(page);
  await clickNewChat(page);
  chatA = await idAP;
  console.log('chat A id:', chatA);
  await send(page, PROMPT);
  // Let optimistic state settle (handleSessionAnnounced + pending bubble).
  await page.waitForTimeout(500);
  const sAfterSend = await snap(page);
  logSnap('after send (chat A active, still in-flight)', sAfterSend);

  // Diagnostic: what's in IDB for chat A right now? Tells us if my
  // proxyClient.sendMessage hydrate(chatId, seedTitle) completed.
  const idbA = await page.evaluate(async (id) => {
    return new Promise((resolve) => {
      const req = indexedDB.open('sidekick-conversations');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('conversations', 'readonly');
        const r = tx.objectStore('conversations').get(id);
        r.onsuccess = () => { resolve(r.result || null); db.close(); };
        r.onerror = () => { resolve('err'); db.close(); };
      };
      req.onerror = () => resolve('open-err');
    });
  }, chatA);
  console.log(`IDB chat A row immediately after send: ${JSON.stringify(idbA)}`);

  // Capture all /api/sidekick/sessions responses during the round-trip.
  const sessionsListResps = [];
  page.on('response', async (resp) => {
    if (resp.url().endsWith('/api/sidekick/sessions?limit=200') || /\/api\/sidekick\/sessions\?/.test(resp.url())) {
      try {
        const body = await resp.json();
        const a = (body.sessions || []).find((s) => s.chat_id === chatA);
        sessionsListResps.push({ at: Date.now(), chatA_entry: a || null });
      } catch {}
    }
  });

  console.log('--- step 3: switch to an EXISTING chat (heavier resumeSession path) ---');
  // Pick the second-most-recent existing chat from the sidebar (chat A
  // is most-recent now since it was just sent). This exercises the full
  // resumeSession path — fetch transcript, render, then track viewed.
  // Jonathan's real-world repro switches BETWEEN existing chats; a
  // brand-new empty chat takes a lighter path.
  const existing = sAfterSend.sidebar
    .filter(r => r.chatId !== chatA && !r.chatId.startsWith('__sidekick:hint'))
    .map(r => r.chatId);
  if (existing.length === 0) {
    throw new Error('no existing chats in sidebar to switch to — need at least one prior chat');
  }
  chatB = existing[0];
  console.log('chat B (existing):', chatB);
  await page.locator(`#sessions-list li[data-chat-id="${chatB}"] .sess-body`).first().click();
  // Give the drawer a moment to settle after the switch.
  await page.waitForTimeout(800);
  const sSwitchedAway = await snap(page);
  logSnap('switched to chat B (chat A in background, still in-flight)', sSwitchedAway);

  console.log(`\n[server enrich snapshots for chat A]:\n${JSON.stringify(sessionsListResps, null, 2)}`);

  // Re-check IDB chat A row right before TEST #1 — has anything overwritten it?
  const idbA2 = await page.evaluate(async (id) => {
    return new Promise((resolve) => {
      const req = indexedDB.open('sidekick-conversations');
      req.onsuccess = () => {
        const db = req.result;
        const r = db.transaction('conversations', 'readonly').objectStore('conversations').get(id);
        r.onsuccess = () => { resolve(r.result || null); db.close(); };
        r.onerror = () => { resolve('err'); db.close(); };
      };
      req.onerror = () => resolve('open-err');
    });
  }, chatA);
  console.log(`IDB chat A row right before TEST #1: ${JSON.stringify(idbA2)}`);
  // Also: what's in sessionCache?
  const cacheState = await page.evaluate(async () => {
    return new Promise((resolve) => {
      const req = indexedDB.open('sidekick-keyterms');
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('cache')) { resolve('no-store'); db.close(); return; }
        const r = db.transaction('cache', 'readonly').objectStore('cache').get('sessions-list');
        r.onsuccess = () => { resolve(r.result || null); db.close(); };
        r.onerror = () => { resolve('err'); db.close(); };
      };
      req.onerror = () => resolve('open-err');
    });
  });
  console.log(`sessionCache (keyterms IDB): ${typeof cacheState === 'string' ? cacheState : JSON.stringify(cacheState).slice(0, 200)}`);

  // Test #1: chat A's sidebar text — should be PROMPT, not "New chat".
  const aRow = sSwitchedAway.sidebar.find(r => r.chatId === chatA);
  console.log(`\n[TEST #1] chat A sidebar text: ${JSON.stringify(aRow?.text)}`);
  if (!aRow) {
    console.log('FAIL: chat A row missing from sidebar entirely');
  } else if (aRow.text.toLowerCase().includes('new chat')) {
    console.log('FAIL: chat A sidebar shows "New chat" instead of the prompt snippet');
  } else if (aRow.text.includes(PROMPT) || aRow.text.includes(PROMPT.slice(0, 20))) {
    console.log('PASS: chat A sidebar shows the snippet');
  } else {
    console.log(`UNCLEAR: chat A sidebar shows "${aRow.text}" — neither "New chat" nor the prompt`);
  }

  console.log('\n--- step 4: switch back to chat A ---');
  await page.locator(`#sessions-list li[data-chat-id="${chatA}"] .sess-body`).first().click();
  await page.waitForTimeout(1200);
  const sSwitchedBack = await snap(page);
  logSnap('switched back to chat A', sSwitchedBack);

  // Test #2: user prompt should still be visible in transcript.
  const aHasPromptBubble = sSwitchedBack.userBubbles.some(b => b.includes(PROMPT) || b.includes(PROMPT.slice(0, 15)));
  console.log(`\n[TEST #2] user prompt visible in transcript after switch-back: ${aHasPromptBubble ? 'PASS' : 'FAIL'}`);

  console.log('\n--- step 5: wait for agent reply (up to 30s) ---');
  // Wait until at least one finalized agent bubble exists OR timeout.
  try {
    await page.waitForFunction(
      () => {
        const finals = document.querySelectorAll('#transcript .line.agent:not(.streaming):not(.pending)');
        return finals.length >= 1;
      },
      null,
      { timeout: 30_000, polling: 500 },
    );
  } catch { console.log('WARN: agent reply did not finalize within 30s'); }
  await page.waitForTimeout(1500);
  const sAfterReply = await snap(page);
  logSnap('after agent reply', sAfterReply);

  // Test #3: no duplicate user bubbles, no duplicate agent bubbles.
  const dupUser = sAfterReply.userBubbles.filter(b => b.includes(PROMPT) || b.includes(PROMPT.slice(0, 15))).length;
  console.log(`\n[TEST #3a] user prompt bubble count (expect 1): ${dupUser} — ${dupUser === 1 ? 'PASS' : 'FAIL'}`);
  // Dedup agents by message_id for the "true dupe" count.
  const agentIds = sAfterReply.agentBubbles.filter(b => !b.streaming && !b.pending).map(b => b.msgId).filter(Boolean);
  const uniqueAgentIds = new Set(agentIds);
  console.log(`[TEST #3b] finalized agent bubble count: ${agentIds.length} (unique msgIds: ${uniqueAgentIds.size}) — ${agentIds.length === uniqueAgentIds.size && agentIds.length >= 1 ? 'PASS' : 'FAIL'}`);

  console.log('\n--- step 6: switch away to B, then back to A ---');
  // Capture the /messages response payload during the round-trip so
  // we can see what resumeSession is getting back for chat A.
  const messageReqs = [];
  const captureResp = async (resp) => {
    const url = resp.url();
    if (/\/api\/sidekick\/sessions\/[^/]+\/messages/.test(url)) {
      try {
        const body = await resp.json();
        const m = url.match(/\/sessions\/([^/]+)\/messages/);
        messageReqs.push({
          chatId: m ? decodeURIComponent(m[1]) : '',
          messages: body.messages?.length ?? 0,
          inflight: body.inflight?.length ?? 0,
          firstId: body.firstId,
          messagesSample: (body.messages || []).map((x) => ({
            id: x.id, role: x.role, sidekick_id: x.sidekick_id,
            content: (x.content || '').slice(0, 40),
          })),
        });
      } catch {}
    }
  };
  page.on('response', captureResp);
  await page.locator(`#sessions-list li[data-chat-id="${chatB}"] .sess-body`).first().click();
  await page.waitForTimeout(800);
  await page.locator(`#sessions-list li[data-chat-id="${chatA}"] .sess-body`).first().click();
  await page.waitForTimeout(1500);
  page.off('response', captureResp);
  console.log('\n[/messages responses observed during round-trip]:', JSON.stringify(messageReqs, null, 2));
  const sFinal = await snap(page);
  logSnap('after switch-away-and-back post-reply', sFinal);

  // Test #4: same counts as Test #3, no extras.
  const dupUser2 = sFinal.userBubbles.filter(b => b.includes(PROMPT) || b.includes(PROMPT.slice(0, 15))).length;
  const agentIds2 = sFinal.agentBubbles.filter(b => !b.streaming && !b.pending).map(b => b.msgId).filter(Boolean);
  const uniqueAgentIds2 = new Set(agentIds2);
  console.log(`\n[TEST #4a] user prompt bubble count post-roundtrip (expect 1): ${dupUser2} — ${dupUser2 === 1 ? 'PASS' : 'FAIL'}`);
  console.log(`[TEST #4b] finalized agent bubble count post-roundtrip: ${agentIds2.length} (unique: ${uniqueAgentIds2.size}) — ${agentIds2.length === uniqueAgentIds2.size && agentIds2.length >= 1 ? 'PASS' : 'FAIL'}`);
} catch (e) {
  console.error('SCRIPT ERROR:', e?.message || e);
  console.error('--- last 50 console lines ---');
  console.error(consoleTail(50).join('\n'));
} finally {
  console.log('\n--- cleanup: delete only chat A from state.db (chat B is a real existing chat) ---');
  if (chatA) await deleteChat(page, chatA);
  await cleanup();
  await closeShared();
  console.log('done.');
}
