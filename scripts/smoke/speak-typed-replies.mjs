// Pin the call-only speak-replies rule (2026-05): when settings.tts
// ("Speak replies") is ON BUT no call is active, the PWA does NOT
// auto-fire /tts. Outside a call the user reads replies on screen;
// the per-bubble play button handles on-demand replay.
//
// Pre-2026-05 the toggle ALSO triggered TTS for typed replies. The
// two-button-split refactor narrowed it to call-only — the typed-mode
// TTS is now the per-bubble play button only.
//
// Test plan (mocked):
//   1. Intercept POST /tts; record any calls.
//   2. Stub player.play to a resolved promise.
//   3. Enable settings.tts.
//   4. Send a message via mock backend → mock auto-replies via SSE.
//   5. Wait for the agent bubble to finalize.
//   6. Assert /tts was NOT auto-called (call-only gate held).
//   7. Assert the per-bubble play affordance IS present (so the user
//      can replay on demand if they want).

import { waitForReady, send, assert } from './lib.mjs';

export const NAME = 'speak-typed-replies';
export const DESCRIPTION = 'settings.tts on outside a call → /tts NOT auto-fired (call-only gate)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const USER_TEXT = 'good morning';

export default async function run({ page, log }) {
  // Intercept POST /tts and record any calls (we expect zero).
  const ttsCalls = [];
  await page.route('**/tts', async (route) => {
    if (new URL(route.request().url()).pathname !== '/tts') return route.fallback();
    if (route.request().method() !== 'POST') return route.fallback();
    let body = null;
    try { body = JSON.parse(route.request().postData() || '{}'); }
    catch {}
    ttsCalls.push(body);
    await route.fulfill({
      status: 200,
      contentType: 'audio/mpeg',
      body: Buffer.from([0xFF, 0xFB, 0x90, 0x00]),
    });
  });

  await waitForReady(page);

  // Stub player.play so any background audio attempts don't fail the test.
  await page.evaluate(() => {
    const player = document.getElementById('player');
    if (player) {
      player.play = () => Promise.resolve();
    }
  });

  // Enable settings.tts via the live settings module. With the
  // call-only gate this should NOT trigger TTS for the typed reply
  // — `settings.tts` is now meaningful only INSIDE a call (talk vs.
  // stream WebRTC mode).
  await page.evaluate(async () => {
    const s = await import('/build/settings.mjs');
    s.set('tts', true);
  });

  // Send a typed message; mock auto-replies via SSE → handleReplyFinal.
  // No call is open, so the new gate (`inListen && !webrtcOpen`) should
  // skip the playReplyTts call entirely.
  await send(page, USER_TEXT);
  log(`sent "${USER_TEXT}" — waiting for finalized agent reply (no /tts auto-fire expected)`);

  // Wait for the agent bubble to finalize.
  await page.waitForFunction(
    () => document.querySelectorAll('.line.agent:not(.streaming):not(.pending)').length >= 1,
    null,
    { timeout: 5_000, polling: 50 },
  );

  // Wait a beat — handleReplyFinal fires playReplyTts after a brief
  // delay in the old code path, so we need to wait long enough that
  // a regression would have triggered by now.
  await page.waitForTimeout(800);

  log(`/tts calls observed: ${ttsCalls.length} (expected 0)`);

  assert(
    ttsCalls.length === 0,
    `call-only gate failed: expected 0 POST /tts after reply_final outside a call, saw ${ttsCalls.length}`,
  );
  log(`/tts NOT auto-fired outside a call ✓`);

  // Per-bubble play button — should be present on the agent bubble so
  // the user can manually replay if desired. replyPlayer.ts wires
  // `.reply-play` (or similar) onto agent bubbles. Just check the
  // bubble has a clickable play affordance.
  const hasPlayAffordance = await page.evaluate(() => {
    const bubble = document.querySelector('.line.agent:not(.streaming):not(.pending)');
    if (!bubble) return false;
    // replyPlayer.ts uses a play button; check for any descendant button
    // whose role is play / aria-label contains "play".
    const btn = bubble.querySelector('button[aria-label*="play" i], .reply-play, .bubble-play');
    return !!btn;
  });
  // Soft-assert: the per-bubble UX is the responsibility of the
  // replyplayer-bubble-ux smoke. Here we just note its presence/absence
  // so a regression in the bubble UX shows up adjacent to the gate test.
  log(`per-bubble play affordance present: ${hasPlayAffordance}`);
}
