// Field bug 2026-05-24 (Jonathan, video: scroll_save_failing2.mov):
// scroll a chat to mid-history, click the "New chat" button (NOT a
// drawer row), send a message in the fresh chat, then click the
// original chat in the drawer → it restores to scrollTop=0 (TOP) even
// though the user was mid-history before leaving.
//
// Why a separate smoke from scroll-mid-history-survives-switch:
//   - That smoke exercises resume()→resume() via drawer rows; that
//     path correctly save+flushes the leaving chat.
//   - The "New chat" button in main.ts takes a DIFFERENT code path
//     that doesn't call saveCurrentScrollPosition / flushScrollPosition
//     and doesn't null viewedSessionIdRef before clearing the prior
//     chat's transcript. The clear collapses scrollHeight; the browser
//     fires a scroll(0) event; the scroll listener writes scrollTop=0
//     to the LEAVING chat's saved position (viewedSessionIdRef still
//     points there). Restore on return reads 0 → scrollTo top.

import { waitForReady, openSidebar, clickRow, clickNewChat, send, assert } from './lib.mjs';

export const NAME = 'scroll-survives-new-chat';
export const DESCRIPTION = 'Scroll mid-history → click New chat → send → switch back. Original chat must restore to saved position, not top.';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-scroll-newchat-a';

function makeMessages(count, prefix) {
  const out = [];
  const body = `${prefix}: ${'lorem ipsum dolor sit amet consectetur '.repeat(18)}`;
  for (let i = 0; i < count; i++) {
    out.push({
      id: i + 1,
      sidekick_id: `${prefix.toLowerCase()}-nc-${i + 1}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${body} (msg ${i})`,
      timestamp: Date.now() / 1000 - (count - i) * 60,
    });
  }
  return out;
}

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_A, {
    title: 'Chat A — long',
    source: 'sidekick',
    messages: makeMessages(80, 'A'),
    lastActiveAt: Date.now() - 60_000,
  });
}

async function snapScroll(page) {
  return page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (!t) return null;
    return {
      scrollTop: Math.round(t.scrollTop),
      scrollHeight: t.scrollHeight,
      clientHeight: t.clientHeight,
      maxTop: t.scrollHeight - t.clientHeight,
    };
  });
}

async function wheelTowardMiddle(page, fromTopFraction) {
  const box = await page.locator('#transcript').boundingBox();
  if (!box) throw new Error('transcript bounding box missing');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await snapScroll(page);
  const targetTop = Math.round(before.maxTop * fromTopFraction);
  const delta = before.scrollTop - targetTop;
  const stepPx = 400;
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / stepPx));
  const sign = delta > 0 ? -1 : 1;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, sign * stepPx);
  }
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // ── Step 1: open A, scroll to mid-history (~40% from top).
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(800);
  const aLoaded = await snapScroll(page);
  log(`A loaded: scrollTop=${aLoaded.scrollTop} maxTop=${aLoaded.maxTop}`);
  assert(aLoaded.maxTop > aLoaded.clientHeight * 2,
    `chat A must be deeply scrollable: maxTop=${aLoaded.maxTop}`);

  await wheelTowardMiddle(page, 0.4);
  await page.waitForTimeout(400);
  const aMid = await snapScroll(page);
  log(`A scrolled mid: scrollTop=${aMid.scrollTop}`);
  assert(aMid.scrollTop > 200 && aMid.scrollTop < aMid.maxTop - 200,
    `chat A must be mid-history (not at top or bottom). scrollTop=${aMid.scrollTop} maxTop=${aMid.maxTop}`);

  // ── Step 2: click NEW CHAT button (the suspected poison path).
  await clickNewChat(page);
  await page.waitForTimeout(500);

  // ── Step 3: send a message in the fresh chat. Mocked backend will
  // echo back a placeholder; we just need the chat to acquire content
  // and a real chat_id rotation (mirrors the video repro).
  await send(page, 'hello agent');
  await page.waitForTimeout(800);

  // ── Step 4: click A in the drawer. Must restore to aMid ± 100.
  await clickRow(page, CHAT_A);
  await page.waitForTimeout(1500);
  const aRestored = await snapScroll(page);
  log(`A restored after new-chat round-trip: scrollTop=${aRestored.scrollTop} (expected ~${aMid.scrollTop})`);
  const drift = Math.abs(aRestored.scrollTop - aMid.scrollTop);
  assert(drift <= 100,
    `chat A must restore within 100px of saved mid-position after new-chat round-trip. ` +
    `saved=${aMid.scrollTop} restored=${aRestored.scrollTop} drift=${drift} maxTop=${aRestored.maxTop}`);
}
