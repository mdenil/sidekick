/**
 * Scenario: agent's own voice in the mic stream — does barge fire?
 *
 * Models the speaker-bleed condition: AEC not engaged (or engaged but
 * imperfect), so the user's "mic" picks up the agent's TTS playing
 * through the speaker. On the Pi smoke this is the unfiltered worst
 * case (no AEC at all, since there's no real speaker → real mic
 * acoustic path; the WAV bytes are the input directly).
 *
 * Today, with the BargeDetector firing on Silero positive-speech
 * detection alone, this WILL fire — and it should: agent voice IS
 * speech-shaped audio. That's the bug-class we're chasing on iOS,
 * where AEC is supposed to remove agent voice before Silero sees it
 * but doesn't.
 *
 * The fix path is one of:
 *   (a) ensure AEC is engaged on the mic capture, so Silero never
 *       hears agent voice
 *   (b) BargeDetector cross-references TTS playback timing and is
 *       suspicious of "speech detected exactly during TTS"
 *   (c) some combination
 *
 * Once a fix lands, this scenario flips from EXPECTED_FAIL → asserting
 * 0 fires. For now it asserts that it DOES fire — pinning the current
 * (buggy) behaviour as a baseline. If a future change accidentally
 * fixes it without us noticing, this scenario will tell us. */

import { PROXY_URL, FIXTURES, injectMic, attachLogCapture } from './lib.mjs';

export const NAME = 'agent-voice-in-mic';
export const DESCRIPTION = 'EXPECTED FAIL today: agent voice in mic stream fires barge (no AEC).';

export default async function run({ page, log }) {
  const logs = attachLogCapture(page);
  // The MIC is the agent's own voice — the worst-case speaker-bleed
  // simulation. The TTS plays the same audio over the WebRTC peer.
  await injectMic(page, FIXTURES.agentCounts);
  await page.goto(`${PROXY_URL}/?debug=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  log('opening call (realtime mode)');
  await page.click('#btn-call');
  await logs.waitFor(/\[barge-detector\] VAD warm/, 30_000);
  log('VAD warm — dispatching typed message');

  await page.fill('#composer-input', 'count to ten');
  await page.click('#composer-send');

  log('waiting for reply_final');
  await logs.waitFor(/reply_final/, 30_000);
  log('reply_final received — letting fixture audio play');
  await page.waitForTimeout(10_000);

  const fires = logs.count(/\[barge-detector\] fire/);
  // Inverted assertion: today (no AEC, Silero sees agent voice as
  // speech) we EXPECT >= 1 fire. If this passes (no fires), either
  // (a) a fix landed — update the scenario to assert 0 — or (b) the
  // rig regressed and isn't actually playing the WAV. Either way,
  // worth a look.
  if (fires === 0) {
    log(`UNEXPECTED PASS: 0 fires when agent voice was injected as mic input.`);
    log(`Either AEC is somehow engaged in the synthetic stream (unlikely),`);
    log(`or BargeDetector got smarter at discriminating self-speech.`);
    log(`Either way: review and update this scenario's assertion.`);
    throw new Error('expected ≥1 fire, got 0 (see log: investigate before flipping the assertion)');
  }
  log(`BASELINE confirmed: ${fires} fire(s) when agent voice in mic (no AEC scenario).`);
}
