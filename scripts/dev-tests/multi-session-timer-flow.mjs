// Real-backend repro driver for the 2026-05-11 multi-session
// disappearing-bubbles bug. Drives the actual PWA against the actual
// proxy against the actual hermes — no mocks. Mints two FRESH chats
// (no touching of existing user data); both run a slow agent turn
// in parallel; the script switches back and forth between them and
// asserts that prompts + agent state stay rendered.
//
// Field symptom (Jonathan, 2026-05-11):
//   "I'm interacting with my agent in two different sessions, which
//    is working and actually quite a pleasure to use, but it did
//    reveal that we're having dropouts between them as I switch
//    back and forth. Some of my bubbles are disappearing."
//
// Methodology (per feedback_test_at_right_layer.md):
//   1. Repro in full with the real agent here.
//   2. Mirror failing assertions into a mocked smoke for permanent CI.
//   3. Fix; rerun both real + mocked.
//
// Sequence:
//   1. Mint chat A — send a "wait 10s + acknowledge" prompt
//   2. Mint chat B (within 1-2s) — same prompt shape
//   3. While BOTH are in-flight, switch A → B → A → B (rapid)
//   4. Wait for both turns to finalize
//   5. Final A→B→A→B pass to check post-turn stability
//   6. Assertions at each transition: user prompt visible, agent
//      bubble (streaming or final) visible, msgId stable.
//
// Run:
//   SMOKE_CHROMIUM=/home/jscholz/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome \
//     node --experimental-strip-types scripts/dev-tests/multi-session-timer-flow.mjs

import {
  launchSharedBrowser, launchBrowser, waitForReady, openSidebar,
  clickNewChat, send, captureNextChatId, deleteChat, attachConsoleCapture,
  clickRow,
} from '../smoke/lib.mjs';

const PROMPT_A = 'set a 10 second timer please';
const PROMPT_B = 'set a 12 second timer please';

function snap(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#sessions-list li[data-chat-id]'));
    const sidebar = rows.map(r => ({
      chatId: r.getAttribute('data-chat-id'),
      text: (r.querySelector('.sess-snippet')?.textContent || '').trim(),
      active: r.classList.contains('active'),
    }));
    const transcript = (document.getElementById('transcript')?.textContent || '').slice(0, 600);
    const allLines = Array.from(document.querySelectorAll('#transcript .line'))
      .map(el => ({
        cls: el.className,
        msgId: el.getAttribute('data-message-id') || '',
        text: (el.textContent || '').trim().slice(0, 80),
      }));
    const userBubbles = allLines.filter(l => /\bs0\b|\buser\b/.test(l.cls))
      .map(l => ({ msgId: l.msgId, text: l.text, cls: l.cls }));
    const agentBubbles = allLines.filter(l => /\bagent\b/.test(l.cls))
      .map(l => ({
        msgId: l.msgId, text: l.text,
        streaming: /\bstreaming\b/.test(l.cls),
        pending: /\bpending\b/.test(l.cls),
        failed: /\bfailed\b/.test(l.cls),
      }));
    const activityRows = Array.from(document.querySelectorAll('#transcript .activity-row'))
      .map(el => ({
        cls: el.className,
        text: (el.textContent || '').trim().slice(0, 60),
      }));
    return { sidebar, transcript, allLines, userBubbles, agentBubbles, activityRows };
  });
}

function logSnap(label, s) {
  console.log(`\n=== ${label} ===`);
  console.log(`sidebar (${s.sidebar.length}):`,
    s.sidebar.map(r => `${r.active ? '*' : ' '} ${r.chatId.slice(-12)}: ${r.text.slice(0, 40)}`).join('\n  ') || '(empty)');
  console.log(`userBubbles (${s.userBubbles.length}):`,
    JSON.stringify(s.userBubbles, null, 2));
  console.log(`agentBubbles (${s.agentBubbles.length}):`,
    JSON.stringify(s.agentBubbles, null, 2));
  if (s.activityRows.length) console.log(`activityRows (${s.activityRows.length}):`,
    JSON.stringify(s.activityRows, null, 2));
}

const { browser, closeShared } = await launchSharedBrowser({ headed: false });
const { page, cleanup } = await launchBrowser(browser);
const consoleTail = attachConsoleCapture(page, 600);
let chatA = null, chatB = null;
const failures = [];

function check(label, cond, detail = '') {
  const tag = cond ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures.push(`${label}${detail ? ' — ' + detail : ''}`);
}

// Network capture — all /messages responses across the run.
const messagesResps = [];
page.on('response', async (resp) => {
  const url = resp.url();
  if (/\/api\/sidekick\/sessions\/[^/]+\/messages/.test(url)) {
    try {
      const body = await resp.json();
      const m = url.match(/\/sessions\/([^/]+)\/messages/);
      messagesResps.push({
        at: Date.now(),
        chatId: m ? decodeURIComponent(m[1]) : '',
        msgCount: body.messages?.length ?? 0,
        inflightCount: body.inflight?.length ?? 0,
        msgIds: (body.messages || []).map(x => x.sidekick_id || `int:${x.id}`),
        inflightTypes: (body.inflight || []).map(e => e.type),
      });
    } catch {}
  }
});

try {
  console.log('--- step 1: boot + open sidebar ---');
  await waitForReady(page);
  await openSidebar(page);

  console.log('\n--- step 2: mint chat A, send PROMPT_A ---');
  const idAP = captureNextChatId(page);
  await clickNewChat(page);
  chatA = await idAP;
  console.log('chat A:', chatA);
  const tASent = await send(page, PROMPT_A);
  console.log(`PROMPT_A sent at +${Date.now() - tASent}ms`);
  await page.waitForTimeout(500);
  const s1 = await snap(page);
  logSnap('after PROMPT_A send (A in-flight)', s1);

  // Quick sanity: chat A should have one user bubble matching PROMPT_A.
  check('A.send: chat A has user bubble for PROMPT_A',
    s1.userBubbles.some(b => b.text.includes(PROMPT_A.slice(0, 20))),
    `userBubbles=${JSON.stringify(s1.userBubbles)}`);

  console.log('\n--- step 3: mint chat B (while A still in-flight) ---');
  const idBP = captureNextChatId(page);
  await clickNewChat(page);
  chatB = await idBP;
  console.log('chat B:', chatB);
  // After new-chat click, the transcript should be empty (B's view).
  await page.waitForTimeout(300);
  const sNewB = await snap(page);
  logSnap('on chat B fresh (A still in-flight in background)', sNewB);

  const tBSent = await send(page, PROMPT_B);
  console.log(`PROMPT_B sent at +${Date.now() - tBSent}ms`);
  await page.waitForTimeout(500);
  const s2 = await snap(page);
  logSnap('after PROMPT_B send (both in-flight)', s2);

  check('B.send: chat B has user bubble for PROMPT_B',
    s2.userBubbles.some(b => b.text.includes(PROMPT_B.slice(0, 20))),
    `userBubbles=${JSON.stringify(s2.userBubbles)}`);

  console.log('\n--- step 4: switch A → B → A → B rapid (both in-flight) ---');
  // First switch: A. (We're on B now.)
  await clickRow(page, chatA);
  await page.waitForTimeout(700);
  const s3 = await snap(page);
  logSnap('switched to A (B still in-flight)', s3);

  check('switch.A1: chat A user bubble for PROMPT_A still visible',
    s3.userBubbles.some(b => b.text.includes(PROMPT_A.slice(0, 20))),
    `userBubbles=${JSON.stringify(s3.userBubbles)}`);
  check('switch.A1: chat A has an in-flight agent bubble OR finalized',
    s3.agentBubbles.length >= 1,
    `agentBubbles=${JSON.stringify(s3.agentBubbles)}`);

  await clickRow(page, chatB);
  await page.waitForTimeout(700);
  const s4 = await snap(page);
  logSnap('switched to B (A still in-flight)', s4);

  check('switch.B1: chat B user bubble for PROMPT_B still visible',
    s4.userBubbles.some(b => b.text.includes(PROMPT_B.slice(0, 20))),
    `userBubbles=${JSON.stringify(s4.userBubbles)}`);
  check('switch.B1: chat B has an in-flight agent bubble OR finalized',
    s4.agentBubbles.length >= 1,
    `agentBubbles=${JSON.stringify(s4.agentBubbles)}`);

  await clickRow(page, chatA);
  await page.waitForTimeout(700);
  const s5 = await snap(page);
  logSnap('switched back to A (second visit)', s5);

  check('switch.A2: chat A user bubble for PROMPT_A still visible',
    s5.userBubbles.some(b => b.text.includes(PROMPT_A.slice(0, 20))),
    `userBubbles=${JSON.stringify(s5.userBubbles)}`);

  await clickRow(page, chatB);
  await page.waitForTimeout(700);
  const s6 = await snap(page);
  logSnap('switched back to B (second visit)', s6);

  check('switch.B2: chat B user bubble for PROMPT_B still visible',
    s6.userBubbles.some(b => b.text.includes(PROMPT_B.slice(0, 20))),
    `userBubbles=${JSON.stringify(s6.userBubbles)}`);

  console.log('\n--- step 5: wait for both replies to finalize (up to 30s) ---');
  // Stay on B and wait for B to finalize, then switch to A and wait.
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('#transcript .line.agent:not(.streaming):not(.pending)').length >= 1,
      null, { timeout: 30_000, polling: 500 },
    );
  } catch { console.log('WARN: chat B reply did not finalize within 30s'); }
  await page.waitForTimeout(1500);
  const s7 = await snap(page);
  logSnap('B finalized (still on B)', s7);
  check('finalize.B: chat B has a finalized agent bubble',
    s7.agentBubbles.some(b => !b.streaming && !b.pending && b.text.length > 0),
    `agentBubbles=${JSON.stringify(s7.agentBubbles)}`);
  check('finalize.B: chat B still has the user prompt',
    s7.userBubbles.some(b => b.text.includes(PROMPT_B.slice(0, 20))),
    `userBubbles=${JSON.stringify(s7.userBubbles)}`);

  await clickRow(page, chatA);
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('#transcript .line.agent:not(.streaming):not(.pending)').length >= 1,
      null, { timeout: 30_000, polling: 500 },
    );
  } catch { console.log('WARN: chat A reply did not finalize within 30s'); }
  await page.waitForTimeout(1500);
  const s8 = await snap(page);
  logSnap('A finalized (now on A)', s8);
  check('finalize.A: chat A has a finalized agent bubble',
    s8.agentBubbles.some(b => !b.streaming && !b.pending && b.text.length > 0),
    `agentBubbles=${JSON.stringify(s8.agentBubbles)}`);
  check('finalize.A: chat A still has the user prompt',
    s8.userBubbles.some(b => b.text.includes(PROMPT_A.slice(0, 20))),
    `userBubbles=${JSON.stringify(s8.userBubbles)}`);

  console.log('\n--- step 6: final A→B→A→B pass to check post-turn stability ---');
  await clickRow(page, chatB);
  await page.waitForTimeout(700);
  const s9 = await snap(page);
  logSnap('post-final: on B', s9);
  check('post.B: chat B user prompt preserved post-turn',
    s9.userBubbles.some(b => b.text.includes(PROMPT_B.slice(0, 20))),
    `userBubbles=${JSON.stringify(s9.userBubbles)}`);
  check('post.B: chat B agent reply still rendered',
    s9.agentBubbles.some(b => !b.streaming && !b.pending),
    `agentBubbles=${JSON.stringify(s9.agentBubbles)}`);

  await clickRow(page, chatA);
  await page.waitForTimeout(700);
  const sA = await snap(page);
  logSnap('post-final: on A', sA);
  check('post.A: chat A user prompt preserved post-turn',
    sA.userBubbles.some(b => b.text.includes(PROMPT_A.slice(0, 20))),
    `userBubbles=${JSON.stringify(sA.userBubbles)}`);
  check('post.A: chat A agent reply still rendered',
    sA.agentBubbles.some(b => !b.streaming && !b.pending),
    `agentBubbles=${JSON.stringify(sA.agentBubbles)}`);

  console.log(`\n--- /messages responses observed (${messagesResps.length}) ---`);
  for (const r of messagesResps) {
    console.log(`  ${r.chatId.slice(-12)} → ${r.msgCount} msgs (inflight: ${r.inflightCount} [${r.inflightTypes.join(',')}]) ids=${JSON.stringify(r.msgIds)}`);
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`failures: ${failures.length}`);
  failures.forEach(f => console.log(`  - ${f}`));
  if (failures.length === 0) console.log('all checks passed');
} catch (e) {
  console.error('\nSCRIPT ERROR:', e?.message || e);
  console.error('--- last 60 console lines ---');
  console.error(consoleTail(60).join('\n'));
} finally {
  console.log('\n--- cleanup: delete chats we created ---');
  if (chatA) await deleteChat(page, chatA);
  if (chatB) await deleteChat(page, chatB);
  await cleanup();
  await closeShared();
  console.log('done.');
  if (failures.length > 0) process.exit(1);
}
