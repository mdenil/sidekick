/**
 * Scenario: silence-during-TTS asserts no self-barge.
 *
 * The regression test for the iPhone self-barge bug. Open a call, send
 * a typed message, the agent replies with "1, 2, 3, ..., 10" via the
 * fixture-replay TTS (real audio over real WebRTC), the user mic is
 * 5 s of digital silence on loop. Assert: zero `[barge-detector] fire`
 * events from call-open through reply-end.
 *
 * Pass = barge stayed silent during silent input.
 * Fail = barge fired on the agent's own voice (the bug we're chasing).
 */

import { PROXY_URL, FIXTURES, injectMic, attachLogCapture } from './lib.mjs';

export const NAME = 'silence-no-self-fire';
export const DESCRIPTION = 'No barge fires when mic input is silent during agent TTS playback.';

export default async function run({ page, log }) {
  const logs = attachLogCapture(page);
  await injectMic(page, FIXTURES.silence);
  // ?debug=1 enables in-app diag logging so barge ticks/fires emit
  // to console. The realtime + tts settings come from the smoke-mode
  // yaml the orchestrator wrote (lib.mjs:bootRig).
  await page.goto(`${PROXY_URL}/?debug=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  log('opening call (realtime mode)');
  await page.click('#btn-call');
  await logs.waitFor(/\[barge-detector\] VAD warm/, 30_000);
  log('VAD warm — dispatching typed message');

  // Send a typed message via composer. Bypasses STT (noop in this rig)
  // so the reply trigger is deterministic.
  await page.fill('#composer-input', 'count to ten');
  await page.click('#composer-send');

  // Wait for reply_final, then a grace window for TTS playback to
  // complete (fixture is 7.5 s, plus encode/transport overhead).
  log('waiting for reply_final');
  await logs.waitFor(/reply_final/, 30_000);
  log('reply_final received — letting fixture audio play out');
  await page.waitForTimeout(10_000);

  const fires = logs.count(/\[barge-detector\] fire/);
  if (fires > 0) {
    const fireLines = logs.matching(/\[barge-detector\] fire/);
    const tickLines = logs.matching(/\[barge-detector\] tick/);
    log(`SELF-BARGE: ${fires} fire(s) during silent-mic playback`);
    for (const fl of fireLines) log(`  fire: ${fl}`);
    log(`last 20 ticks:`);
    for (const tl of tickLines.slice(-20)) log(`  tick: ${tl}`);
    throw new Error(`expected 0 barge fires, got ${fires}`);
  }
  log(`PASS: 0 fires during silent-mic TTS playback (${logs.count(/\[barge-detector\] tick/)} ticks observed)`);
}
