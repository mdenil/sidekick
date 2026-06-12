// Tail invariant (#214, field 2026-06-12): the boot snapshot must ALWAYS
// be tail-anchored. Before the fix, chat.persist() serialized whatever
// DOM was on screen — including a floating deep-jump `around` window.
// On the next boot that windowed DOM was innerHTML-restored, then the
// boot resume UPSERTED the newest page into it, grafting the tail onto
// a mid-session slice with a silently missing middle. Symptom in the
// field: "sessions don't look the same across devices or time — the UI
// forgot the end of the session", with no gap indicator and a dead
// drag-down (pagination armed as tail-anchored).
//
// Fix under test: persist() + saveCurrentScrollPosition() skip writes
// while hasMoreNewer=true, so the snapshot keeps the last tail-anchored
// state and boot always paints the session end.
//
// Test plan (mocked):
//   1. Seed a 120-msg chat (first page 30). Open it (tail snapshot
//      persists), pin a DEEP message (idx 5, far outside the newest 30).
//   2. Drill to the pin → floating around-window renders, tail absent.
//      Wait past the 250ms snapshot-persist debounce so buggy code
//      would have written the windowed DOM to IDB.
//   3. Reload. After resume settles, assert:
//      a. the tail message IS rendered,
//      b. the deep target is NOT (a windowed snapshot would leave it),
//      c. rendered indices form a CONTIGUOUS suffix ending at the tail
//         (the graft bug yields window ∪ tail with a hole), and
//      d. the view sits at the live edge (tail bubble in viewport).

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'boot-after-deep-jump-shows-tail';
export const DESCRIPTION = 'reload after a deep jump boots at the session tail — no windowed snapshot, no grafted gap';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-tail-snapshot';
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
      sidekick_id: `tailsnap-msg-${idx}`,
      timestamp: Date.now() / 1000 - (TOTAL_MSGS - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'Tail snapshot invariant test',
    source: 'sidekick',
    messages,
    lastActiveAt: Date.now() - 1000,
  });
}

async function openChat(page, chatId) {
  await page.evaluate((cid) => {
    document.body.classList.add('sidebar-expanded');
    const row = document.querySelector(
      `#sessions-list li[data-chat-id="${cid}"] .sess-body`,
    );
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, chatId);
}

function renderedKeys(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line[data-message-id]'))
      .map((el) => el.dataset.messageId));
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openChat(page, CHAT_ID);
  await page.waitForTimeout(800);

  const deepMsg = `tailsnap-msg-${DEEP_IDX}`;
  const tailMsg = `tailsnap-msg-${TAIL_IDX}`;

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

  // Sanity: we're in a floating window — the tail must NOT be rendered,
  // otherwise the reload assertions below are vacuous.
  const inWindow = await renderedKeys(page);
  assert(inWindow.includes(deepMsg), `deep target ${deepMsg} should render after the drill`);
  assert(!inWindow.includes(tailMsg),
    `setup: tail ${tailMsg} must be outside the floating window (got it rendered)`);
  log(`floating window on screen: ${inWindow.length} bubbles, tail absent ✓`);

  // Let the 250ms snapshot-persist debounce (and any scroll-position
  // write) fire — buggy code persists the windowed DOM right here.
  await page.waitForTimeout(900);

  // Reload → boot restores the snapshot, resume reconciles.
  await page.reload();
  await waitForReady(page);
  await page.waitForFunction(
    (mid) => !!document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`),
    tailMsg,
    { timeout: 8_000, polling: 100 },
  );
  await page.waitForTimeout(400);

  const keys = await renderedKeys(page);
  const indices = keys
    .filter((k) => k && k.startsWith('tailsnap-msg-'))
    .map((k) => parseInt(k.slice('tailsnap-msg-'.length), 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  log(`post-reload: ${indices.length} bubbles, range ${indices[0]}..${indices[indices.length - 1]}`);

  // (a) tail rendered
  assert(indices.includes(TAIL_IDX), `tail message ${tailMsg} must render after reload`);
  // (b) windowed snapshot would resurrect the deep slice
  assert(!indices.includes(DEEP_IDX),
    `deep-window message ${deepMsg} rendered after reload — the windowed DOM was snapshotted`);
  // (c) contiguous suffix — the graft bug yields window ∪ tail with a hole
  for (let i = 1; i < indices.length; i++) {
    assert(indices[i] === indices[i - 1] + 1,
      `transcript has a gap after reload: ...${indices[i - 1]} → ${indices[i]}... ` +
      `(windowed snapshot grafted onto the tail page)`);
  }
  assert(indices[indices.length - 1] === TAIL_IDX,
    `transcript must END at the tail (${TAIL_IDX}), got ${indices[indices.length - 1]}`);

  // (d) view sits at the live edge: tail bubble intersects the viewport.
  const atEdge = await page.evaluate((mid) => {
    const t = document.getElementById('transcript');
    const el = document.querySelector(`#transcript .line[data-message-id="${CSS.escape(mid)}"]`);
    if (!t || !el) return false;
    const tr = t.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return er.top < tr.bottom && er.bottom > tr.top;
  }, tailMsg);
  assert(atEdge, 'after reload the view should sit at the live tail (tail bubble in viewport)');

  log('boot after deep jump lands at the tail, contiguous to the live edge ✓');
}
