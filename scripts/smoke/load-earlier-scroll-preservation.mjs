// Pin the load-earlier scroll-preservation invariant: when older
// messages prepend into the transcript, the message that was at the
// user's eye-level must STAY at the same viewport y-coordinate. The
// transcript scrollTop should be adjusted by exactly the amount of
// new content inserted above.
//
// Field repro (Jonathan, 2026-05-18, mobile): "scrolling through a
// long chat, it jumps unpredictably." Root cause was a Crack A
// regression — `loadEarlierHistory` called `transcriptStore.prependDurable`
// directly, bypassing `chat.prependHistory`'s scrollTop fixup. Without
// it, prepending N px of content leaves the user staring at a
// different message N px above the one they were reading.
//
// This smoke is small and fast. It seeds 30 messages, scrolls to a
// known anchor in the middle, drags scrollTop to the top to trigger
// load-earlier, and asserts the anchor message's y-coordinate hasn't
// drifted by more than a small slack.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'load-earlier-scroll-preservation';
export const DESCRIPTION = 'load-earlier preserves the eye-level message position (no scroll jump)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-scroll-preserve';

export function MOCK_SETUP(mock) {
  // 30 messages, 10-row first-page limit (forces load-earlier to fire
  // when we scroll up).
  mock.setHistoryFirstPageLimit(10);
  const messages = [];
  for (let i = 0; i < 30; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user'
        ? `anchor-msg-${idx} user content goes here so the bubble has real height`
        : `anchor-msg-${idx} agent reply with similar height for stable layout`,
      timestamp: Date.now() / 1000 - (30 - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Scroll-preservation test',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);

  // Wait for the first page (msg-21..30) to render.
  await page.waitForFunction(
    () => /anchor-msg-30 /.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  await page.waitForTimeout(200);  // let post-replay scroll-to-bottom settle

  // Park scrollTop a few px below 0 so load-earlier doesn't fire yet,
  // then capture the anchor message's viewport-relative y. anchor-msg-21
  // is the OLDEST visible message on the first page — most-likely to
  // be near the top of the viewport when the user starts scrolling up.
  const before = await page.evaluate(() => {
    const t = document.getElementById('transcript');
    t.scrollTop = 80;  // 80 px from the top; clear of the load-earlier trigger band
    const anchor = Array.from(t.querySelectorAll('.line'))
      .find(el => /anchor-msg-21 /.test(el.textContent || ''));
    if (!anchor) return null;
    const r = anchor.getBoundingClientRect();
    return { anchorTop: r.top, scrollTop: t.scrollTop, scrollHeight: t.scrollHeight };
  });
  assert(before, 'anchor-msg-21 should be in DOM before scroll');
  log(`before: anchor.top=${before.anchorTop.toFixed(0)}px scrollTop=${before.scrollTop} scrollHeight=${before.scrollHeight}`);

  // Scroll to 0 → triggers load-earlier. The newly-prepended msg-11..20
  // adds N px of content above the viewport; chat.prependHistory should
  // bump scrollTop by exactly N so anchor-msg-21 stays at the same y.
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    t.scrollTop = 0;
    t.dispatchEvent(new Event('scroll', { bubbles: true }));
  });

  // Wait for the older page to land (msg-11 appearing is the proof).
  await page.waitForFunction(
    () => /anchor-msg-11 /.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 5_000, polling: 100 },
  );

  // Settle for one rAF cycle so the scrollTop adjustment has applied.
  await page.waitForTimeout(50);

  const after = await page.evaluate(() => {
    const t = document.getElementById('transcript');
    const anchor = Array.from(t.querySelectorAll('.line'))
      .find(el => /anchor-msg-21 /.test(el.textContent || ''));
    if (!anchor) return null;
    const r = anchor.getBoundingClientRect();
    return { anchorTop: r.top, scrollTop: t.scrollTop, scrollHeight: t.scrollHeight };
  });
  assert(after, 'anchor-msg-21 should still be in DOM after load-earlier');
  log(`after:  anchor.top=${after.anchorTop.toFixed(0)}px scrollTop=${after.scrollTop} scrollHeight=${after.scrollHeight}`);

  // Critical assertion: anchor.top should be within ~30 px of its
  // pre-load-earlier position. A miss-by-100s-of-pixels signals the
  // scrollTop fixup didn't run. The slack accommodates trivial
  // sub-pixel rounding + at most one bubble of layout drift (some
  // browsers re-measure heights on insert).
  const drift = Math.abs(after.anchorTop - before.anchorTop);
  const heightDelta = after.scrollHeight - before.scrollHeight;
  log(`scrollHeight grew by ${heightDelta}px; anchor drifted ${drift.toFixed(0)}px`);
  assert(
    drift < 30,
    `anchor-msg-21 drifted ${drift.toFixed(0)}px after load-earlier (eye-level message ` +
    `should hold its viewport position; chat.prependHistory's scrollTop fixup missing?). ` +
    `scrollHeight grew by ${heightDelta}px; if scrollTop wasn't bumped by ~that amount, ` +
    `the user sees a JUMP.`,
  );
  log('eye-level message held its viewport y-coordinate across load-earlier ✓');
}
