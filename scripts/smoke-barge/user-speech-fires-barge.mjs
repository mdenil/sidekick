/**
 * Scenario: real user speech in the mic during TTS fires barge.
 *
 * The positive test — barge should actually work when a user speaks
 * during agent TTS playback. Otherwise we could accidentally ship a
 * fix for self-barge that's too deaf (silence is fine, but real
 * speech doesn't fire either).
 *
 * Mic injection: looped "stop" recording (Aura Zeus voice — different
 * timbre than the agent's Aura Thalia, models a different speaker).
 * Asserts ≥1 fire during the window. */

import { PROXY_URL, FIXTURES, injectMic, attachLogCapture } from './lib.mjs';

export const NAME = 'user-speech-fires-barge';
export const DESCRIPTION = 'User saying "stop" during TTS fires barge (positive test).';

export default async function run({ page, log }) {
  const logs = attachLogCapture(page);
  await injectMic(page, FIXTURES.userStop);
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
  if (fires === 0) {
    const tickLines = logs.matching(/\[barge-detector\] tick/);
    log(`FAIL: real user speech in mic did not fire barge`);
    log(`last 20 ticks:`);
    for (const tl of tickLines.slice(-20)) log(`  tick: ${tl}`);
    throw new Error(`expected ≥1 fire (user speech), got 0`);
  }
  log(`PASS: ${fires} fire(s) — barge correctly triggered on user speech.`);
}
