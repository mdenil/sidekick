// Field bug 2026-05-25 (Jonathan, virt-default): "I played an agent
// reply mid-history, scrolled away, then back — the play bar reset to
// zero." Under virtualization, bubbles scrolled outside the visible
// window are unmounted; remounting recreates them as fresh DOM elements
// without the .tts-* classes or play-bar widths. The per-replyId state
// needs to live OUTSIDE the DOM so the next mount can repaint it.
//
// This smoke seeds a long enough chat that the played bubble can be
// scrolled out of the virt window, asserts the bubble takes .tts-playing,
// scrolls past it, scrolls back, and checks the class survives.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'replyplayer-survives-remount';
export const DESCRIPTION = 'Under virt, agent bubble play-state survives unmount/remount when scrolled out of window';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-replyplayer-remount';
const PLAY_TARGET_KEY = 'rp-msg-4';  // even idx → assistant in i%2==0 user pattern

export function MOCK_SETUP(mock) {
  // 60 messages so virt definitely windows away from the middle.
  const messages = [];
  const body = 'reply player remount text body to give bubbles real height '.repeat(8);
  for (let i = 0; i < 60; i++) {
    const idx = i + 1;
    const isUser = i % 2 === 0;
    messages.push({
      role: isUser ? 'user' : 'assistant',
      content: `${body} (${idx})`,
      message_id: `rp-msg-${idx}`,
      sidekick_id: `rp-msg-${idx}`,
      timestamp: Date.now() / 1000 - (60 - idx) * 60,
    });
  }
  mock.addChat(CHAT_ID, {
    title: 'ReplyPlayer remount',
    source: 'sidekick',
    messages,
    lastActiveAt: Date.now() - 60_000,
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForTimeout(800);

  // Scroll the target bubble into the window. With 60 specs at the
  // bottom-pinned default, msg-3 is way above the window — scrollTo
  // the top. Simulate a wheel gesture first so scheduleAtBottomRepin's
  // RO stops snapping back; without it, programmatic scrollTo is
  // ignored by the at-bottom-repin observer for the 1.5s window.
  const box = await page.locator('#transcript').boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -100);
  }
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (t) t.scrollTo({ top: 0, behavior: 'instant' });
  });
  await page.waitForTimeout(400);

  const targetVisible = await page.evaluate((key) => {
    return !!document.querySelector(`#transcript .line.agent[data-reply-id="${CSS.escape(key)}"]`);
  }, PLAY_TARGET_KEY);
  assert(targetVisible, `setup: target bubble ${PLAY_TARGET_KEY} should be in DOM after scrollTo(0)`);
  log(`target bubble in DOM after scroll-to-top ✓`);

  // Directly inject the persisted playback state. Bypasses the full
  // tts fetch + audio path (mocked /tts wouldn't drive audio events
  // anyway) and tests the state-mirror + applyBubbleState wiring
  // exactly: write to the replyPlayer's in-memory map, paint the
  // bubble, then verify it survives unmount/remount.
  await page.evaluate(async (key) => {
    const mod = await import('/build/audio/turn-based/replyPlayer.mjs');
    mod.__testSetBubbleState(key, { active: true, playing: true, loadedRatio: 1, playedRatio: 0.4 });
  }, PLAY_TARGET_KEY);
  await page.waitForTimeout(100);

  const preScroll = await page.evaluate((key) => {
    const el = document.querySelector(`#transcript .line.agent[data-reply-id="${CSS.escape(key)}"]`);
    return {
      exists: !!el,
      classes: el ? Array.from(el.classList).filter(c => c.startsWith('tts-')) : [],
    };
  }, PLAY_TARGET_KEY);
  assert(preScroll.classes.includes('tts-playing'),
    `pre-scroll: target bubble should be .tts-playing, got ${JSON.stringify(preScroll)}`);
  log(`pre-scroll: .tts-playing applied ✓`);

  // Scroll way down — should push msg-3 out of the visible window
  // (virt unmounts it). Then scroll back to top.
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (t) t.scrollTo({ top: t.scrollHeight, behavior: 'instant' });
  });
  await page.waitForTimeout(400);

  const targetGone = await page.evaluate((key) => {
    return !document.querySelector(`#transcript .line.agent[data-reply-id="${CSS.escape(key)}"]`);
  }, PLAY_TARGET_KEY);
  assert(targetGone, `mid: target bubble should be unmounted (out of virt window)`);
  log(`target bubble unmounted after scroll-to-bottom ✓`);

  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (t) t.scrollTo({ top: 0, behavior: 'instant' });
  });
  await page.waitForTimeout(400);

  const postScroll = await page.evaluate((key) => {
    const el = document.querySelector(`#transcript .line.agent[data-reply-id="${CSS.escape(key)}"]`);
    return {
      exists: !!el,
      classes: el ? Array.from(el.classList).filter(c => c.startsWith('tts-')) : [],
    };
  }, PLAY_TARGET_KEY);
  assert(postScroll.exists, `post-scroll: target bubble should be remounted, got ${JSON.stringify(postScroll)}`);
  assert(postScroll.classes.includes('tts-playing'),
    `BUG (virt remount): target bubble must retain .tts-playing after unmount→remount, got ${JSON.stringify(postScroll)}`);
  log(`post-scroll: .tts-playing survived remount ✓`);
}
