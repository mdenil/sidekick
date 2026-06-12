// Missing-suffix indicator (#214 TFC-D): while a floating deep-jump
// window is open (hasMoreNewer=true), the transcript on screen does NOT
// reach the session's end — but before this feature nothing said so.
// Field complaint: "there's no indicator that there's a missing suffix
// (there should be an ellipsis or something indicating we're not at end)".
//
// Feature under test: chat.setPaginationState toggles a
// `#transcript-gap-newer` overlay pill ("⋯ newer messages"). Visible only
// while hasMoreNewer; click re-resumes to the live tail (jumpToLatestCb).
//
// Test plan (mocked):
//   1. Seed a 120-msg chat (first page 30). Open it tail-anchored →
//      indicator absent/hidden.
//   2. Pin a DEEP message (idx 5), drill via the pin drawer → floating
//      around-window renders → indicator VISIBLE.
//   3. Click the indicator → tail message renders, view sits at the live
//      edge, indicator hides again.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'gap-indicator-on-floating-window';
export const DESCRIPTION = 'deep-jump window shows a "newer messages" pill; click jumps to the live tail and hides it';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-gap-indicator';
const TOTAL_MSGS = 120;
const FIRST_PAGE = 30;
const DEEP_IDX = 5;
const TAIL_IDX = TOTAL_MSGS;

export function MOCK_SETUP(mock) {
  mock.setHistoryFirstPageLimit(FIRST_PAGE);
  const messages = [];
  for (let i = 0; i < TOTAL_MSGS; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user' ? `user marker ${idx}` : `agent reply ${idx}`,
      sidekick_id: `gapind-msg-${idx}`,
      timestamp: Date.now() / 1000 - (TOTAL_MSGS - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Gap indicator test',
    source: 'sidekick',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
}

function gapIndicatorVisible(page) {
  return page.evaluate(() => {
    const el = document.getElementById('transcript-gap-newer');
    if (!el) return false;
    return el.classList.contains('visible');
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);

  // Open the chat tail-anchored.
  await page.evaluate((cid) => {
    document.body.classList.add('sidebar-expanded');
    const row = document.querySelector(
      `#sessions-list li[data-chat-id="${cid}"] .sess-body`,
    );
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, CHAT_ID);
  await page.waitForTimeout(800);

  const deepMsg = `gapind-msg-${DEEP_IDX}`;
  const tailMsg = `gapind-msg-${TAIL_IDX}`;

  assert(!(await gapIndicatorVisible(page)),
    'tail-anchored open: gap indicator must be hidden');
  log('tail-anchored: indicator hidden ✓');

  // Pin the deep message, open the pin drawer, drill.
  await page.evaluate(({ chatId, msgId, idx }) => {
    return import('/build/pins/store.mjs').then((mod) => mod.pinMessage({
      chatId, msgId, role: 'user',
      text: `user marker ${idx}`,
      timestamp: Date.now(),
    }));
  }, { chatId: CHAT_ID, msgId: deepMsg, idx: DEEP_IDX });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const btn = document.getElementById('btn-pin-drawer-rail')
            || document.getElementById('btn-pin-drawer');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(250);
  await page.evaluate((mid) => {
    const li = document.querySelector(`#pin-drawer-list .pin-drawer-item[data-msg-id="${mid}"]`);
    const btn = li?.querySelector('.pin-item-jump-btn');
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, deepMsg);
  await page.waitForFunction(
    (mid) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
    deepMsg,
    { timeout: 8_000, polling: 60 },
  );
  await page.waitForTimeout(200);

  // Sanity: floating window — tail not rendered, indicator visible.
  const tailInWindow = await page.evaluate(
    (mid) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
    tailMsg,
  );
  assert(!tailInWindow, `setup: tail ${tailMsg} must be outside the floating window`);
  assert(await gapIndicatorVisible(page),
    'floating deep window: gap indicator must be visible');
  log('floating window: indicator visible ✓');

  // Click the indicator → jump to the live tail.
  await page.evaluate(() => {
    document.getElementById('transcript-gap-newer')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(
    (mid) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
    tailMsg,
    { timeout: 8_000, polling: 100 },
  );
  await page.waitForTimeout(400);

  assert(!(await gapIndicatorVisible(page)),
    'after jump-to-latest the gap indicator must hide');

  // View sits at the live edge: tail bubble intersects the viewport.
  const atEdge = await page.evaluate((mid) => {
    const t = document.getElementById('transcript');
    const el = document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`);
    if (!t || !el) return false;
    const tr = t.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return er.top < tr.bottom && er.bottom > tr.top;
  }, tailMsg);
  assert(atEdge, 'after the indicator click the view should sit at the live tail');

  log('indicator click jumps to the tail and hides ✓');
}
