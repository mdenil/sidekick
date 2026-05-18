// Real-backend Playwright driver — no mocks, no DOM tricks.
//
// Driving the actual PWA at http://127.0.0.1:3001 against the actual
// sidekick.service against the actual hermes-gateway against Jonathan's
// actual state.db. This is what iOS hits over the tailnet HTTPS proxy;
// localhost just bypasses the TLS layer (same code, same bundle, same
// data).
//
// Two repros:
//
// Bug B — "fresh load dumps glob of tool calls"
//   Open a fresh browser context (no IDB, no SW cache), navigate to
//   the PWA, click into chat sidekick:cb5dc920-2b15-45d6-8e04-d5d7dec475a0
//   (40+ tool-using turns), capture the rendered transcript DOM order.
//   FAIL if any activity row sits past the last text bubble's turn.
//
// Bug A — "mid-turn switch loses prompt + tool history"
//   Mint a fresh chat, send a prompt that fires multiple tool calls,
//   wait until at least one tool_call envelope has rendered (mid-turn
//   window). Click an OTHER chat. Click back into chat A. Capture
//   the transcript: prompt bubble + tool rows + streaming assistant
//   bubble should all be present.
//
// Run:
//   SMOKE_CHROMIUM=/home/jscholz/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome \
//     node --experimental-strip-types scripts/dev-tests/jonathan-repro-real-backend.mjs

import {
  launchSharedBrowser, launchBrowser, waitForReady, openSidebar,
  attachConsoleCapture, clickRow,
} from '../smoke/lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const TARGET_CHAT_B = 'sidekick:cb5dc920-2b15-45d6-8e04-d5d7dec475a0';
const BUG_A_PROMPT = 'please use 3 tool calls to introspect this chat and then reply';

const OUT_DIR = '/tmp/jscholz-repro';
fs.mkdirSync(OUT_DIR, { recursive: true });

/** Build a structural fingerprint of the transcript: ordered list of
 *  tokens marking text bubbles + activity rows + streaming state.
 *  Mirrors the smoke helper but on REAL backend data. */
function dumpTranscript(page) {
  return page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (!t) return { tokens: [], rows: 0 };
    const tokens = [];
    for (const child of Array.from(t.children)) {
      if (child.classList.contains('activity-row')) {
        const n = child.querySelectorAll('[data-call-id]').length;
        tokens.push(`ar[${n}]`);
        continue;
      }
      if (child.classList.contains('line')) {
        const cls = child.className;
        const id = child.dataset.messageId || '';
        let kind = '?';
        if (/\bs0\b|\buser\b/.test(cls)) kind = 'u';
        else if (/\bagent\b/.test(cls)) kind = 'a';
        const flags = [];
        if (/\bstreaming\b/.test(cls)) flags.push('S');
        if (/\bpending\b/.test(cls)) flags.push('P');
        if (/\bfailed\b/.test(cls)) flags.push('F');
        tokens.push(`${kind}${flags.length ? '[' + flags.join('') + ']' : ''}:${id}`);
      }
    }
    return {
      tokens,
      rows: tokens.filter(t => t.startsWith('ar[')).length,
      lines: tokens.filter(t => t.startsWith('u:') || t.startsWith('a:')).length,
    };
  });
}

/** Audit: for every activity row, find its position relative to user
 *  bubbles. Returns a list of issues — empty = correctly interleaved.
 *
 *  Crack A note: an activity row at the top of the transcript WITHOUT
 *  a preceding user is a TRUNCATION artifact (the user message that
 *  triggered the turn is older than the fetch window). Not a bug. We
 *  only flag truly clumped rows — adjacent activity rows OR rows far
 *  past their turn's user. */
function auditClump(tokens) {
  const issues = [];
  const uIdxs = [];
  const arIdxs = [];
  tokens.forEach((tok, i) => {
    if (tok.startsWith('u:')) uIdxs.push(i);
    if (tok.startsWith('ar[')) arIdxs.push(i);
  });
  // First user bubble in the transcript. Rows BEFORE it are
  // truncation orphans (user prompt fell off the fetch window) — ok.
  const firstUserIdx = uIdxs[0];
  for (const arIdx of arIdxs) {
    if (firstUserIdx === undefined || arIdx < firstUserIdx) {
      // Pre-first-user orphan — accept as truncation artifact.
      continue;
    }
    const prevUser = uIdxs.filter(i => i < arIdx).pop();
    if (prevUser === undefined) {
      issues.push(`row at idx ${arIdx} has NO user bubble before it`);
      continue;
    }
    const distance = arIdx - prevUser;
    if (distance > 2) {
      issues.push(`row at idx ${arIdx} is ${distance} tokens past its turn's user bubble at ${prevUser}`);
    }
  }
  // Detect adjacent rows: indicates turns collapsed
  for (let i = 1; i < arIdxs.length; i++) {
    if (arIdxs[i] === arIdxs[i - 1] + 1) {
      issues.push(`adjacent activity rows at ${arIdxs[i - 1]}, ${arIdxs[i]} — turns merged`);
    }
  }
  return issues;
}

const { browser, closeShared } = await launchSharedBrowser({ headed: false });

// ──────────────────────────────────────────────────────────────────
// Bug B: fresh-load clump in cb5dc920
// ──────────────────────────────────────────────────────────────────
console.log('\n========== BUG B: fresh-load clump ==========');
console.log(`target chat: ${TARGET_CHAT_B}`);

async function runBugB(iteration) {
  const { page, cleanup } = await launchBrowser(browser);
  const consoleTail = attachConsoleCapture(page, 800);
  try {
    await waitForReady(page);
    console.log(`  [iter ${iteration}] PWA connected`);
    await openSidebar(page);

    // Tap the chat. clickRow waits for the row to be present + clickable.
    await clickRow(page, TARGET_CHAT_B);
    console.log(`  [iter ${iteration}] tapped chat`);

    // Wait for the transcript to settle — either activity rows render
    // or text bubbles render. Give it generous time since it's a long chat.
    await page.waitForFunction(
      () => {
        const t = document.getElementById('transcript');
        if (!t) return false;
        return t.querySelectorAll('.line').length >= 10;
      },
      null,
      { timeout: 10_000 },
    );
    // Extra settle for any deferred renders.
    await page.waitForTimeout(1500);

    const dump = await dumpTranscript(page);
    console.log(`  [iter ${iteration}] tokens=${dump.tokens.length} lines=${dump.lines} rows=${dump.rows}`);
    const issues = auditClump(dump.tokens);
    if (issues.length) {
      console.log(`  [iter ${iteration}] FAIL — ${issues.length} ordering issues:`);
      for (const i of issues.slice(0, 6)) console.log(`      • ${i}`);
      // Dump full structure + screenshot
      const outBase = path.join(OUT_DIR, `bug-b-iter${iteration}`);
      fs.writeFileSync(`${outBase}.tokens.json`, JSON.stringify(dump.tokens, null, 2));
      await page.screenshot({ path: `${outBase}.png`, fullPage: true });
      console.log(`  [iter ${iteration}] artifacts: ${outBase}.tokens.json, ${outBase}.png`);
      return { ok: false, dump, issues };
    } else {
      console.log(`  [iter ${iteration}] OK — all activity rows inline with their turns`);
      return { ok: true, dump };
    }
  } finally {
    await cleanup();
  }
}

// Run multiple iterations — Jonathan said Bug B "happened in this chat
// but isn't reproducing right now". Try a few fresh contexts to catch
// any state-dependent intermittency.
const ITERATIONS = 3;
const bugBResults = [];
for (let i = 1; i <= ITERATIONS; i++) {
  bugBResults.push(await runBugB(i));
}
const bugBFailures = bugBResults.filter(r => !r.ok);
console.log(`\nBug B: ${bugBFailures.length}/${ITERATIONS} iterations failed`);

// ──────────────────────────────────────────────────────────────────
// Bug A: mid-turn switch loses prompt + tool history
// ──────────────────────────────────────────────────────────────────
console.log('\n========== BUG A: mid-turn session switch ==========');

async function runBugA() {
  const { page, cleanup } = await launchBrowser(browser);
  const consoleTail = attachConsoleCapture(page, 1200);
  let bugAChatId = null;
  try {
    await waitForReady(page);
    console.log('  PWA connected');
    await openSidebar(page);

    // Pick an existing chat as "the other chat" to switch to. Use the
    // 2nd row in the drawer (1st might be the active default).
    const otherChatId = await page.evaluate(() => {
      const rows = document.querySelectorAll('#sessions-list li[data-chat-id]');
      // Skip the one we just used in Bug B; pick whatever's next.
      for (const r of rows) {
        const id = r.getAttribute('data-chat-id');
        if (id && id !== 'sidekick:cb5dc920-2b15-45d6-8e04-d5d7dec475a0') return id;
      }
      return null;
    });
    if (!otherChatId) {
      console.log('  FAIL — no other chat available to switch to');
      return { ok: false, reason: 'no-other-chat' };
    }
    console.log(`  will switch away to: ${otherChatId}`);

    // Mint a fresh chat and send the trigger prompt.
    const newChatBtn = await page.waitForSelector('button#btn-new-chat, button:has-text("New chat")', { timeout: 4_000 });
    await newChatBtn.click();
    await page.waitForTimeout(400);
    console.log('  minted fresh chat');

    // Type prompt + send.
    const composer = await page.waitForSelector('#composer-input', { timeout: 3_000 });
    await composer.fill(BUG_A_PROMPT);
    // Capture chat_id from URL or proxyClient when send fires.
    const idCapture = page.waitForFunction(() => {
      const t = document.getElementById('transcript');
      const userBubble = t?.querySelector('.line.s0[data-message-id], .line.user[data-message-id]');
      return userBubble ? userBubble.dataset.messageId : null;
    }, null, { timeout: 4_000 });
    await page.keyboard.press('Enter');
    await idCapture;
    console.log(`  sent prompt: "${BUG_A_PROMPT}"`);

    // Wait for the FIRST tool_call envelope to land (means we're now
    // mid-turn). Look for an activity-row in DOM.
    await page.waitForFunction(
      () => document.querySelectorAll('#transcript .activity-row').length >= 1,
      null,
      { timeout: 30_000 },
    );
    console.log('  first tool_call rendered — we are now mid-turn');
    await page.waitForTimeout(500);  // let a 2nd or 3rd tool envelope land too

    const beforeSwitch = await dumpTranscript(page);
    console.log(`  before-switch: tokens=${beforeSwitch.tokens.length} lines=${beforeSwitch.lines} rows=${beforeSwitch.rows}`);
    console.log(`    tokens: ${JSON.stringify(beforeSwitch.tokens)}`);
    fs.writeFileSync(path.join(OUT_DIR, 'bug-a-before-switch.tokens.json'),
      JSON.stringify(beforeSwitch.tokens, null, 2));
    await page.screenshot({ path: path.join(OUT_DIR, 'bug-a-before-switch.png'), fullPage: true });

    // Grab our own chat_id BEFORE we switch — so we can switch back.
    bugAChatId = await page.evaluate(() => {
      const active = document.querySelector('#sessions-list li.active[data-chat-id]');
      return active ? active.getAttribute('data-chat-id') : null;
    });
    console.log(`  our chat_id: ${bugAChatId}`);

    // Switch AWAY mid-turn.
    await clickRow(page, otherChatId);
    console.log(`  switched away to ${otherChatId}`);
    await page.waitForTimeout(800);  // let the other chat render

    // Switch BACK.
    if (!bugAChatId) {
      console.log('  FAIL — could not capture our chat_id');
      return { ok: false, reason: 'no-chat-id-captured' };
    }
    await clickRow(page, bugAChatId);
    console.log('  switched back');
    await page.waitForTimeout(1500);  // let the resume settle

    const afterSwitchBack = await dumpTranscript(page);
    console.log(`  after-switch-back: tokens=${afterSwitchBack.tokens.length} lines=${afterSwitchBack.lines} rows=${afterSwitchBack.rows}`);
    console.log(`    tokens: ${JSON.stringify(afterSwitchBack.tokens)}`);
    fs.writeFileSync(path.join(OUT_DIR, 'bug-a-after-switchback.tokens.json'),
      JSON.stringify(afterSwitchBack.tokens, null, 2));
    await page.screenshot({ path: path.join(OUT_DIR, 'bug-a-after-switchback.png'), fullPage: true });

    // Assertions:
    //   1. User prompt bubble is present after switch-back
    //   2. At least one activity row is present
    const beforeUserCount = beforeSwitch.tokens.filter(t => t.startsWith('u:')).length;
    const afterUserCount = afterSwitchBack.tokens.filter(t => t.startsWith('u:')).length;
    const beforeRowCount = beforeSwitch.rows;
    const afterRowCount = afterSwitchBack.rows;
    const userLost = afterUserCount < beforeUserCount;
    const rowsLost = afterRowCount < beforeRowCount;

    if (userLost || rowsLost) {
      console.log(`  FAIL — Bug A reproduces:`);
      console.log(`    user bubbles before=${beforeUserCount} after=${afterUserCount} ${userLost ? '(LOST)' : ''}`);
      console.log(`    activity rows  before=${beforeRowCount} after=${afterRowCount} ${rowsLost ? '(LOST)' : ''}`);
      // Dump reorder-relevant console lines from the page so we can see
      // what the slice did at runtime.
      const tail = consoleTail(400);
      const interesting = tail.filter(l => /chat-resume|reorder|inflight envelope|render-dupe.*decision=create-new|render-dupe.*role=user/.test(l));
      if (interesting.length) {
        console.log(`  --- relevant console lines (${interesting.length}) ---`);
        for (const l of interesting.slice(-40)) console.log(`    ${l}`);
      }
      return { ok: false, beforeSwitch, afterSwitchBack };
    }
    console.log(`  OK — prompt + tool rows survived the round-trip`);
    return { ok: true, beforeSwitch, afterSwitchBack };
  } catch (e) {
    console.log(`  ERROR running Bug A: ${e.message}`);
    const tail = consoleTail(50);
    if (tail.length) console.log('  console tail:\n    ' + tail.join('\n    '));
    return { ok: false, error: e.message };
  } finally {
    // Clean up the fresh chat we minted, if any. Skip on error to keep
    // repro artifacts.
    if (bugAChatId) {
      try {
        await page.evaluate(async (id) => {
          await fetch(`/api/sidekick/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
        }, bugAChatId);
        console.log(`  cleaned up test chat ${bugAChatId}`);
      } catch (e) { /* ignore */ }
    }
    await cleanup();
  }
}

const bugAResult = await runBugA();

// ──────────────────────────────────────────────────────────────────
// Final summary
// ──────────────────────────────────────────────────────────────────
console.log('\n========== SUMMARY ==========');
console.log(`Bug B (fresh-load clump): ${bugBFailures.length}/${ITERATIONS} iterations FAILED`);
console.log(`Bug A (mid-turn switch):  ${bugAResult.ok ? 'OK' : 'FAILED'}`);
if (bugBFailures.length || !bugAResult.ok) {
  console.log(`\nArtifacts in ${OUT_DIR}/`);
  for (const f of fs.readdirSync(OUT_DIR)) console.log(`  ${f}`);
}

await closeShared();
process.exit((bugBFailures.length || !bugAResult.ok) ? 1 : 0);
