// Pin the b00646b feature: when settings.tts ("Speak replies") is ON
// AND no WebRTC call is open, the PWA POSTs the freshly-finalized
// agent reply text to /tts so it gets spoken aloud through the
// shared #player <audio> element.
//
// Pre-feature the toggle was call-mode-only; typed-reply playback
// silently no-op'd. Post-feature handleReplyFinal fires playReplyTts,
// which fetches /tts → blob → player.play().
//
// Test plan (mocked):
//   1. Intercept POST /tts; capture the body and return a tiny fake
//      audio blob so the play() call can resolve cleanly.
//   2. Stub player.play to a resolved promise (jsdom audio paths are
//      flaky in playwright).
//   3. Enable settings.tts via the bundled settings module.
//   4. Send a message via mock backend → mock auto-replies via SSE.
//   5. Wait for the agent bubble to finalize.
//   6. Assert /tts was called and the body contains the reply text.

import { waitForReady, send, assert } from './lib.mjs';

export const NAME = 'speak-typed-replies';
export const DESCRIPTION = 'settings.tts on → finalized agent reply POSTs to /tts';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const USER_TEXT = 'good morning';
// The mock backend echoes "[mock] echo: <text>" — the cleanForTts
// regex set in text-tts.ts strips the leading "[mock]" prefix
// (matches /^\[[A-Za-z0-9_\- ]+\]\s*/), so the /tts body should be
// "echo: good morning".
const EXPECTED_TTS_TEXT = 'echo: good morning';

export default async function run({ page, log }) {
  // Intercept POST /tts, capture body, return a 1-byte fake blob.
  // Match by exact pathname '/tts' so we don't accidentally catch
  // /api/sidekick/settings/tts (the agent-settings POST for the
  // "tts" key — same suffix, different surface).
  const ttsCalls = [];
  await page.route('**/tts', async (route) => {
    if (new URL(route.request().url()).pathname !== '/tts') return route.fallback();
    if (route.request().method() !== 'POST') return route.fallback();
    let body = null;
    try { body = JSON.parse(route.request().postData() || '{}'); }
    catch {}
    ttsCalls.push(body);
    // Return a tiny mp3-ish blob so the response.blob() succeeds.
    await route.fulfill({
      status: 200,
      contentType: 'audio/mpeg',
      body: Buffer.from([0xFF, 0xFB, 0x90, 0x00]),
    });
  });

  await waitForReady(page);

  // Stub player.play so audio playback errors don't fail the test.
  // play() resolves; the route handler controls /tts response.
  await page.evaluate(() => {
    const player = document.getElementById('player');
    if (player) {
      player.play = () => Promise.resolve();
    }
  });

  // Enable settings.tts via the live settings module.
  await page.evaluate(async () => {
    const s = await import('/build/settings.mjs');
    s.set('tts', true);
  });

  // Send a typed message; mock auto-replies via SSE → handleReplyFinal
  // → playReplyTts.
  await send(page, USER_TEXT);
  log(`sent "${USER_TEXT}" — waiting for finalized agent reply + /tts POST`);

  // Wait for the agent bubble to finalize.
  await page.waitForFunction(
    () => document.querySelectorAll('.line.agent:not(.streaming):not(.pending)').length >= 1,
    null,
    { timeout: 5_000, polling: 50 },
  );

  // Wait for the /tts POST to land (handleReplyFinal fires it after
  // a brief delay for the receive chime sequencing).
  const start = Date.now();
  while (ttsCalls.length === 0 && Date.now() - start < 4_000) {
    await page.waitForTimeout(50);
  }

  log(`/tts calls: ${ttsCalls.length}, bodies: ${JSON.stringify(ttsCalls).slice(0, 300)}`);

  assert(
    ttsCalls.length >= 1,
    `expected ≥1 POST /tts after reply_final with settings.tts=true; saw ${ttsCalls.length}`,
  );

  const firstBody = ttsCalls[0];
  assert(
    firstBody && typeof firstBody.text === 'string',
    `/tts body should have a 'text' field; got ${JSON.stringify(firstBody)}`,
  );
  assert(
    firstBody.text.includes(EXPECTED_TTS_TEXT),
    `/tts body.text expected to contain "${EXPECTED_TTS_TEXT}", got ${JSON.stringify(firstBody.text)}`,
  );
  log(`/tts called with the reply text ✓`);
}
