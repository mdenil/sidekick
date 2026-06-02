// Scenario: a real spoken turn over the LIVE stack, on a THROTTLED
// connection — nothing stubbed.
//
// turn-prompt.wav ("Tell me a short fun fact about the ocean.") is
// injected into getUserMedia. The real mic channel records it, the
// real SilenceWindow commits, /transcribe hits live Deepgram STT, and
// the real agent replies — all under a slow link (fast3g), the field
// condition (slow link). This is the install-time companion to the
// always-green mocked spoken-turn-tts (which proves the audio CHANNEL +
// playback wiring with no key); THIS proves the cloud STT + live agent
// actually work together end to end on a recorded mic blob.
//
// What it asserts (teeth that need the real stack):
//   1. /transcribe returns 200 and the user bubble contains "ocean" —
//      live STT recognized audio the browser actually recorded.
//   2. A finalized agent reply bubble lands — the live agent answered
//      the spoken question over a throttled SSE.
//
// What it deliberately does NOT assert: in-browser /tts decode/playback.
// Production /tts returns mp3 and Playwright's OSS Chromium lacks the
// mp3 codec; and the looping fake-capture stream triggers barge which
// aborts the in-flight synth. The /tts CONTRACT (real Aura bytes, not
// the 2026-05-09 JSON-with-200 wedge) is covered cleanly + without a
// browser by audio-tts-roundtrip; the reply-auto-speak CHANNEL is
// covered by the mocked spoken-turn-tts. So this stays focused on the
// STT + agent half.
//
// NOTE on the loop: Chromium replays --use-file-for-fake-audio-capture
// gaplessly, so the fixture would commit a fresh turn every ~3.6s. We
// stop Listen the instant the first /transcribe fires, so exactly ONE
// turn lands (one bit of live-state + quota, not a runaway stream).
//
// BACKEND='real', install-only. Run with `npm run smoke -- spoken-turn-real`
// or `--include-install`.

import { waitForReady, resetServerSettings, throttleNetwork, assert, SEL } from './lib.mjs';

export const NAME = 'spoken-turn-real';
export const DESCRIPTION = 'real-mic turn → live STT → live agent reply, on a throttled (fast3g) link';
export const STATUS = 'install-only';
export const BACKEND = 'real';
export const AUDIO_FIXTURE = 'turn-prompt.wav';

export default async function run({ page, log, fail, url }) {
  await waitForReady(page);
  await resetServerSettings(page, { streamingEngine: 'server', tts: true });

  // Emulate a slow field connection. HTTP paths (transcribe / agent SSE)
  // are throttled faithfully; turn-mode uses HTTP, so this is the real
  // latency profile the field hits.
  await throttleNetwork(page, 'fast3g');
  log('network throttled to fast3g');

  let transcribeStatus = null;
  page.on('response', (res) => {
    if (transcribeStatus === null
      && res.url().includes('/transcribe')
      && res.request().method() === 'POST') {
      transcribeStatus = res.status();
    }
  });

  // Arm Listen on boot with a 1s silence window; real getUserMedia reads
  // the injected WAV (NO listen_mock_mic — we want the real record path).
  await page.goto(`${url}/?listen=1&silence_sec=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });
  log('listen armed on boot; recording injected WAV');

  // WAV plays (~2.2s speech) + ~1.5s baked silence → commit → real
  // /transcribe. Throttling stretches the round-trip; allow generously.
  const t0 = Date.now();
  while (transcribeStatus === null && Date.now() - t0 < 40_000) {
    await page.waitForTimeout(200);
  }
  if (transcribeStatus === null) {
    fail('/transcribe never fired — real-mic record/commit channel produced no turn under throttling');
  }

  // Stop Listen NOW so the looping fake-capture can't spawn more turns
  // (one turn = one bit of live state + quota). The agent reply SSE is
  // independent of the mic and keeps streaming.
  await page.click('#btn-mic').catch(() => {});
  log(`/transcribe responded ${transcribeStatus}; listen stopped after first turn`);
  assert(transcribeStatus === 200, `/transcribe HTTP ${transcribeStatus}`);

  // Live STT must recognize the recorded audio → user bubble has "ocean".
  await page.waitForFunction(
    (t) => (document.getElementById('transcript')?.textContent || '').toLowerCase().includes(t),
    'ocean', { timeout: 20_000, polling: 200 },
  ).catch(() => {});
  const transcriptText = await page.evaluate(() => document.getElementById('transcript')?.textContent || '');
  assert(transcriptText.toLowerCase().includes('ocean'),
    `live STT transcript missing "ocean" — got: "${transcriptText.slice(0, 160)}"`);
  log('live STT transcript rendered (contains "ocean" ✓)');

  // Live agent must produce a finalized reply bubble (throttled SSE).
  const baseline = await page.locator(SEL.agentFinal).count();
  await page.waitForFunction(
    ({ sel, b }) => document.querySelectorAll(sel).length > b,
    { sel: SEL.agentFinal, b: baseline },
    { timeout: 90_000, polling: 250 },
  );
  log('live agent reply finalized');

  log('PASS: real-mic turn → live STT → live agent reply, throttled');
}
