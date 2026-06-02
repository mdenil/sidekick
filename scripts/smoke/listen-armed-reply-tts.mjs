// Scenario: a Listen-turn reply that lands AFTER the turn machine has
// re-armed must still auto-speak.
//
// Regression guard: turn/memo mode stopped speaking replies when the
// reply arrived after the turn machine had already re-armed. Root
// cause was commit 2e82220 ("fix audio capture and desktop stream
// regressions", 2026-05-23), which added shouldAutoPlayForListen()
// and over-narrowed the autoplay gate to
// `turnbased.getState() === 'committing' || 'cooldown'`. On a SLOW
// connection the agent reply arrives several seconds after the turn
// committed — by which point the turn machine has cycled
// committing → cooldown → 'armed' (re-armed for the next utterance).
// The narrow gate then silently dropped the reply's TTS and the agent
// went mute. Observable via a `[reply-route] turnbased-tts ...
// turnbased=armed` line with NO following `[reply-tts] enter` in the
// relay log — playReplyTts was never called.
//
// Why the existing spoken-turn-tts / listen-silence-commit smokes miss
// it: their mocked reply comes back instantly, while the machine is
// still in committing/cooldown — so the broken gate happens to pass.
// The bug only bites when the reply lands in 'armed'.
//
// This test reproduces THAT state deterministically (mock mic, no real
// getUserMedia, no commit so the machine parks in 'armed'):
//   1. ?listen=1&listen_mock_mic=1&silence_sec=60 → Listen arms and
//      STAYS 'armed' (we never inject silence, so it never commits) —
//      the exact state a slow reply lands in after a re-arm.
//   2. markAwaitingReply(chatId) — simulates "we committed a turn and
//      are awaiting its reply" (set on every real commit). This is the
//      window/chat-id/consume-once guard that legitimately scopes
//      autoplay to the awaited reply.
//   3. Drive the real reply-route (handleReplyFinal) directly with a
//      finalized reply on that chat, in the 'armed' state.
//   4. Assert /tts fires — i.e. shouldAutoPlay returned true and
//      playReplyTts ran. PRE-FIX this never fires (armed excluded);
//      POST-FIX it does.
//
// /tts is stubbed so this runs in the default suite with no Deepgram
// key. We assert the POST fired, not in-browser playback — decode/
// playback is covered by spoken-turn-tts; THIS pins the autoplay-gate
// logic the field bug lived in.

import { waitForReady, resetServerSettings, assert } from './lib.mjs';

export const NAME = 'listen-armed-reply-tts';
export const DESCRIPTION = 'Listen reply arriving in the re-armed state still auto-speaks (the slow-link turn-mode-silent regression)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, url }) {
  await waitForReady(page);
  await resetServerSettings(page, { streamingEngine: 'server', tts: true });

  const ttsPosts = [];
  await page.route('**/tts', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    ttsPosts.push({ ts: Date.now() });
    // Tiny zero-sample WAV — enough to satisfy the fetch; we assert the
    // POST fired (the gate), not playback.
    const wav = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
      0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
      0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00,
      0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
    ]);
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
  });

  // Arm Listen on boot with a long silence window (mock mic, no real
  // getUserMedia). We never inject silence, so the machine arms and
  // PARKS in 'armed' — the state a slow reply lands in after re-arm.
  await page.goto(`${url}/?listen=1&listen_mock_mic=1&silence_sec=60`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });
  await page.waitForFunction(() => window.__listen?.state === 'armed', null, {
    timeout: 10_000, polling: 100,
  });
  log('listen armed (parked) — the slow-reply condition');

  // Simulate "turn committed, awaiting reply" + deliver the reply over
  // the real reply-route while armed. handleReplyFinal + listenReplyState
  // + turnbased resolve to the SAME singletons the running app uses.
  const stateAtReply = await page.evaluate(async () => {
    const listenReply = await import('/build/listenReplyState.mjs');
    const beh = await import('/build/backendEventHandlers.mjs');
    const sd = await import('/build/sessionDrawer.mjs');
    const settings = await import('/build/settings.mjs');
    settings.set('tts', true);

    const st = window.__listen?.state;
    const chatId = sd.getFocused() || `test-chat-${Date.now()}`;
    listenReply.markAwaitingReply(chatId);
    beh.handleReplyFinal({
      replyId: 'sk-test-reply',
      text: 'Here is a short spoken reply.',
      conversation: chatId,
      messageId: 'sk-test-msg',
      isReplay: false,
    });
    return st;
  });
  assert(stateAtReply === 'armed',
    `expected turn machine 'armed' at reply time, got '${stateAtReply}'`);

  // Post-fix: shouldAutoPlay returns true in 'armed' → playReplyTts →
  // POST /tts. Pre-fix: gate returns false → no /tts ever.
  const t0 = Date.now();
  while (ttsPosts.length === 0 && Date.now() - t0 < 8_000) {
    await page.waitForTimeout(150);
  }
  assert(ttsPosts.length > 0,
    'reply arrived while the turn machine was re-armed (\'armed\') and /tts never fired — '
    + 'the autoplay gate dropped TTS for a reply that landed after re-arm '
    + '(the slow-link "turn mode doesn\'t speak" regression from 2e82220).');

  log('PASS: reply in the re-armed state auto-spoke (/tts fired) — gate no longer drops slow replies');
}
