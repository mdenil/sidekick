// Pin the de5b48f fix: cancelRemotePlayback() is a no-op and MUST
// NOT detach the remote-track <audio>'s srcObject.
//
// Pre-fix it called audio.pause() + audio.srcObject = null, which
// permanently unbound the element from the peer track (ontrack only
// fires once at session setup — nothing rebinds later). One false
// barge therefore silenced TTS for the rest of the call. Bridge
// already handles cancellation server-side via tts_track.halt(); the
// PWA-side cancel was redundant double-work.
//
// Test plan (mocked):
//   1. Construct a fake MediaStream sentinel and assign it to a real
//      <audio> element's srcObject (matching the production binding).
//   2. Import connection.mjs and call cancelRemotePlayback().
//   3. Assert audio.srcObject === sentinel (still bound) AND
//      audio.paused state was not flipped.
//
// This is a static behavioural test — exercises the function directly
// rather than going through the WebRTC negotiation. The fix is "do
// nothing"; the test pins that nothing-ness.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'webrtc-barge-keeps-srcobject';
export const DESCRIPTION = 'cancelRemotePlayback() does NOT unbind the peer-track <audio> element';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log }) {
  await waitForReady(page);

  const result = await page.evaluate(async () => {
    const conn = await import('/build/audio/realtime/realtime.mjs');

    // Build a fake remote-track <audio> element + sentinel stream,
    // mirroring the binding established inside connection.ts ontrack.
    const audio = document.createElement('audio');
    audio.autoplay = true;
    document.body.appendChild(audio);

    // A real MediaStream is the simplest sentinel — the production
    // path stores `ev.streams[0]`, a MediaStream. If audio.srcObject
    // is reassigned to null the identity check below fails.
    const sentinel = new MediaStream();
    audio.srcObject = sentinel;
    // We don't actually call play() — the test is purely about the
    // srcObject binding survival under cancelRemotePlayback().
    const wasPaused = audio.paused;

    // Fire the function under test.
    let threw = null;
    try { conn.cancelRemotePlayback(); }
    catch (e) { threw = String(e?.message || e); }

    return {
      threw,
      srcObjectStillSentinel: audio.srcObject === sentinel,
      srcObjectIsNull: audio.srcObject === null,
      pausedAfter: audio.paused,
      wasPaused,
    };
  });

  log(`cancelRemotePlayback result: ${JSON.stringify(result)}`);

  assert(result.threw === null, `cancelRemotePlayback threw: ${result.threw}`);
  assert(
    !result.srcObjectIsNull,
    'cancelRemotePlayback nulled audio.srcObject — this is the regressed pre-fix behaviour that killed TTS for the rest of the call',
  );
  assert(
    result.srcObjectStillSentinel,
    'cancelRemotePlayback replaced audio.srcObject with a different value (expected: untouched)',
  );
  // The pause-state flip was the OTHER half of the pre-fix logic.
  assert(
    result.pausedAfter === result.wasPaused,
    `cancelRemotePlayback flipped audio.paused (was ${result.wasPaused}, now ${result.pausedAfter})`,
  );
  log('cancelRemotePlayback() leaves the <audio> binding + paused state intact ✓');
}
