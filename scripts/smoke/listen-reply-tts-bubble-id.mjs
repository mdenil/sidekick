// Scenario: a Listen-turn autoplay must drive TTS under the SAME reply
// id the rendered bubble carries (the bare message_id), not the adapter's
// sk-${message_id} label.
//
// Regression guard — the playReplyTts "double-fire + ~11s latency" bug:
// the adapter derives a streaming reply id of `sk-${message_id}`
// (replyIdFor in proxyClient), but the rendered assistant bubble's
// data-reply-id is the BARE message_id (reconciler stamps spec.key, and
// the projection keys assistant specs on env.message_id). Autoplay used
// to play TTS under the sk-${id} label, putting it in a different
// namespace from the bubble:
//   • replyPlayer.findBubble(sk-…) missed → the play bar never painted
//     during autoplay; and
//   • a later tap on the play button read the bubble's bare id, saw
//     getActiveReplyId() === sk-… ≠ bare → "different reply" → it
//     cancelled the in-flight /tts and re-synthesized from scratch (the
//     second `[reply-tts] enter replyId=msg…` + a full extra /tts round
//     trip on a slow link ≈ 11s).
//
// The fix aligns the autoplay TTS id to the bubble id (bare message_id).
// This test pins that contract deterministically: drive the real reply
// route with a realistic { messageId: bare, replyId: sk-bare } pair and
// assert tts.getActiveReplyId() === the bare message_id (what the bubble
// carries) — NOT the sk-prefixed adapter label.
//
// /tts is stubbed so this runs in the default suite with no Deepgram key.

import { waitForReady, resetServerSettings, assert } from './lib.mjs';

export const NAME = 'listen-reply-tts-bubble-id';
export const DESCRIPTION = 'Listen autoplay plays TTS under the bubble id (bare message_id), not the sk- adapter label (double-fire/latency guard)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, url }) {
  await waitForReady(page);
  await resetServerSettings(page, { streamingEngine: 'server', tts: true });

  await page.route('**/tts', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const wav = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
      0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
      0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00,
      0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
    ]);
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
  });

  // Arm Listen and PARK in 'armed' (mock mic, never inject silence).
  await page.goto(`${url}/?listen=1&listen_mock_mic=1&silence_sec=60`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });
  await page.waitForFunction(() => window.__listen?.state === 'armed', null, {
    timeout: 10_000, polling: 100,
  });
  log('listen armed (parked)');

  const BARE_MSG_ID = 'reply-msg-1';
  const SK_REPLY_ID = `sk-${BARE_MSG_ID}`;

  await page.evaluate(async ({ bareId, skId }) => {
    const listenReply = await import('/build/listenReplyState.mjs');
    const beh = await import('/build/backendEventHandlers.mjs');
    const switchCtl = await import('/build/switchController.mjs');
    const settings = await import('/build/settings.mjs');
    settings.set('tts', true);
    const chatId = switchCtl.focusedId() || `test-chat-${Date.now()}`;
    listenReply.markAwaitingReply(chatId);
    // Realistic adapter shape: BARE messageId + sk-prefixed replyId.
    beh.handleReplyFinal({
      replyId: skId,
      text: 'Here is a short spoken reply.',
      conversation: chatId,
      messageId: bareId,
      isReplay: false,
    });
  }, { bareId: BARE_MSG_ID, skId: SK_REPLY_ID });

  // playReplyTts sets activeReplyId synchronously (before the /tts fetch
  // awaits), so a short poll suffices.
  const activeReplyId = await page.evaluate(async ({ timeoutMs }) => {
    const tts = await import('/build/audio/turn-based/tts.mjs');
    const t0 = Date.now();
    while (!tts.getActiveReplyId() && Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return tts.getActiveReplyId();
  }, { timeoutMs: 8_000 });

  assert(activeReplyId,
    'autoplay never started (getActiveReplyId stayed null) — the reply-route gate dropped TTS.');
  assert(activeReplyId === BARE_MSG_ID,
    `autoplay played TTS under '${activeReplyId}', expected the bubble id '${BARE_MSG_ID}'. `
    + `Playing under the sk- adapter label ('${SK_REPLY_ID}') desyncs the play bar from the bubble `
    + `and makes a later play-button tap cancel + re-synthesize (the double-fire + ~11s latency).`);

  log(`PASS: autoplay TTS id '${activeReplyId}' matches the bubble id (bare message_id) — single namespace`);
}
