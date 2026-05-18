// Repro: Jonathan reports clicking sessions doesn't change transcript
// content after Crack A. Drive the real backend via Playwright,
// click between two known chats, dump transcript before/after.

import {
  launchSharedBrowser, launchBrowser, waitForReady, openSidebar,
  attachConsoleCapture, clickRow,
} from '../smoke/lib.mjs';

function dumpTranscript(page) {
  return page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (!t) return { tokens: [], html: '' };
    const tokens = [];
    for (const child of Array.from(t.children)) {
      const key = child.getAttribute('data-key') || '';
      const cls = child.className;
      tokens.push(`${cls.split(/\s+/).slice(0, 2).join('.')}|${key}`);
    }
    return { tokens, count: t.children.length };
  });
}

const { browser, closeShared } = await launchSharedBrowser({ headed: false });
const { page, cleanup } = await launchBrowser(browser);
const consoleTail = attachConsoleCapture(page, 2000);

try {
  await waitForReady(page);
  console.log('PWA connected');
  await openSidebar(page);

  // Simulate Jonathan's state: BEFORE first session click, inject a
  // pre-Crack-A snapshot (keyless DOM) into the transcript.
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (!t) return;
    for (let i = 0; i < 8; i++) {
      const stale = document.createElement('div');
      stale.className = i % 2 ? 'line agent' : 'line s0';
      stale.dataset.messageId = `legacy_${i}`;
      stale.innerHTML = `<span class="speaker">${i % 2 ? 'Agent' : 'You'}:</span> <span class="text">STALE SNAPSHOT BUBBLE ${i}</span>`;
      t.appendChild(stale);
    }
  });
  const staleCountBefore = await page.evaluate(() => document.querySelectorAll('#transcript .line').length);
  console.log(`injected ${staleCountBefore} stale pre-Crack-A bubbles BEFORE first click`);

  // Pick the two top chats from the drawer.
  const chats = await page.evaluate(() => {
    const rows = document.querySelectorAll('#sessions-list li[data-chat-id]');
    return Array.from(rows).slice(0, 3).map(r => r.getAttribute('data-chat-id'));
  });
  console.log('candidate chats:', chats);
  if (chats.length < 2) {
    throw new Error('need at least 2 chats to test switching');
  }

  const dumps = [];
  for (let i = 0; i < 6; i++) {
    const target = chats[i % chats.length];
    console.log(`[step ${i}] clicking ${target.slice(-12)}`);
    await clickRow(page, target);
    await page.waitForTimeout(1800);
    const d = await dumpTranscript(page);
    dumps.push({ target, ...d });
    console.log(`  → ${d.count} children, first key: ${d.tokens[0]?.split('|')[1] ?? '∅'}`);
    const stillStale = await page.evaluate(() => {
      return !!document.querySelector('#transcript [data-message-id="umsg_legacy_pre_crack_a"]');
    });
    if (stillStale) console.log(`  STALE STILL PRESENT after step ${i}`);
  }

  // Compare each pair: did the transcript actually change when target differed?
  let buggySteps = 0;
  for (let i = 1; i < dumps.length; i++) {
    const prev = dumps[i - 1];
    const curr = dumps[i];
    const sameTarget = prev.target === curr.target;
    const sameDom = JSON.stringify(prev.tokens) === JSON.stringify(curr.tokens);
    if (!sameTarget && sameDom) {
      console.log(`BUG: step ${i - 1}→${i} switched chats but DOM didn't change`);
      buggySteps++;
    }
  }
  console.log(`\n=== ${buggySteps > 0 ? `BUG REPRODUCED — ${buggySteps} step(s) failed` : 'OK — all switches updated DOM'} ===`);
  const same = buggySteps > 0;

  if (same) {
    console.log('\n--- console tail (relevant) ---');
    const tail = consoleTail(120);
    const interesting = tail.filter(l =>
      /chat-resume|setDurable|reconcile|setInflight|setViewed|getViewed|active chat/.test(l));
    for (const l of interesting.slice(-50)) console.log('  ' + l);
  }
} catch (e) {
  console.log(`ERROR: ${e.message}`);
  const tail = consoleTail(60);
  console.log('console tail:\n  ' + tail.join('\n  '));
} finally {
  await cleanup();
  await closeShared();
}
