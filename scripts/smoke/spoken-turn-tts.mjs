// Scenario: a full hands-free turn over the REAL audio channel, with
// only the two cloud providers (STT + TTS) stubbed — no Deepgram key.
//
// This is the always-green guard for the regression the mocked suite
// missed: TTS not working in turn mode.
//
// What it exercises that listen-silence-commit does NOT:
//   1. Real mic channel: AUDIO_FIXTURE feeds turn-prompt.wav into
//      getUserMedia (--use-file-for-fake-audio-capture). The real
//      MediaRecorder records actual audio and the real SilenceWindow
//      commits a real blob to /transcribe — catching getUserMedia →
//      MediaRecorder → POST channel breakage. (listen-silence-commit
//      injects SYNTHETIC analyser frames and never records a real blob.)
//   2. Real reply playback: /tts is stubbed with reply-tts.wav — a real
//      multi-second 16-bit PCM blob — and we assert #player reports
//      duration>0 AND currentTime actually advances. listen-silence-
//      commit stubs /tts with a ZERO-sample WAV that "plays" instantly,
//      so it can't catch a decode/playback failure. THIS is the teeth.
//
// The fixture has ~1.5s of trailing silence baked in so the silence
// detector commits reliably even though Chromium loops the fake-capture
// file (a gapless loop would read as one unbroken utterance and never
// commit). STT + TTS are stubbed from the versioned manifest, so this
// runs in the default suite with no key/quota.

import { waitForReady, resetServerSettings, assert } from './lib.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES, REPLY_TTS_WAV } from './fixtures/manifest.mjs';

export const NAME = 'spoken-turn-tts';
export const DESCRIPTION = 'real-mic turn → /transcribe (stubbed) → agent reply → /tts (real WAV) genuinely decodes + plays';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const AUDIO_FIXTURE = 'turn-prompt.wav';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPT = FIXTURES['turn-prompt.wav'].transcript;

export default async function run({ page, log, fail, url }) {
  await waitForReady(page);
  await resetServerSettings(page, { streamingEngine: 'server', tts: true });

  const replyWav = await readFile(path.join(__dirname, 'fixtures', REPLY_TTS_WAV));

  const transcribePosts = [];
  const ttsPosts = [];

  // Stub STT → fixture's known transcript. Capture the POST body size:
  // proves the real mic channel recorded actual audio (an empty-blob
  // regression would post ~0 bytes and never reach here).
  await page.route('**/transcribe*', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataBuffer?.() ?? null;
    transcribePosts.push({ bytes: body ? body.length : 0 });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, transcript: TRANSCRIPT }),
    });
  });

  // The teeth: a REAL PCM WAV (decodable in Playwright's Chromium),
  // not a zero-sample blob.
  await page.route('**/tts', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    ttsPosts.push({ ts: Date.now() });
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: replyWav });
  });

  // Arm Listen on boot with a 1s silence window. NO listen_mock_mic —
  // we want the real getUserMedia path reading the injected WAV.
  await page.goto(`${url}/?listen=1&silence_sec=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });
  log('listen armed on boot; recording injected WAV');

  // WAV plays (~2.2s speech) then ~1.5s silence → SilenceWindow commits
  // the recorded blob → POST /transcribe. The route runs in Node, poll
  // the captured array.
  const t0 = Date.now();
  while (transcribePosts.length === 0 && Date.now() - t0 < 20_000) {
    await page.waitForTimeout(150);
  }
  if (transcribePosts.length === 0) {
    fail('/transcribe never fired — the real-mic record/commit channel did not produce a turn');
  }
  assert(transcribePosts[0].bytes > 1000,
    `/transcribe body too small (${transcribePosts[0].bytes} bytes) — mic channel recorded no real audio`);
  log(`/transcribe fired (${transcribePosts[0].bytes} bytes of recorded audio)`);

  // Transcribed user text renders as a bubble.
  await page.waitForFunction(
    (t) => (document.getElementById('transcript')?.textContent || '').includes(t),
    'ocean', { timeout: 8_000, polling: 150 },
  );
  log('user transcript rendered');

  // Reply auto-speaks → /tts fires.
  const t1 = Date.now();
  while (ttsPosts.length === 0 && Date.now() - t1 < 12_000) {
    await page.waitForTimeout(150);
  }
  if (ttsPosts.length === 0) fail('/tts never fired — reply did not trigger TTS playback');
  log('/tts fired');

  // THE TEETH: the reply audio must genuinely decode + play.
  await page.waitForFunction(() => {
    const p = document.getElementById('player');
    return p && Number.isFinite(p.duration) && p.duration > 0;
  }, null, { timeout: 10_000, polling: 100 });
  const dur = await page.evaluate(() => document.getElementById('player').duration);
  log(`reply audio decoded: duration=${dur.toFixed(2)}s`);

  await page.waitForFunction(() => {
    const p = document.getElementById('player');
    return p && p.currentTime > 0.05;
  }, null, { timeout: 10_000, polling: 100 }).catch(() => {});
  const ct = await page.evaluate(() => document.getElementById('player').currentTime);
  assert(ct > 0.05,
    `reply audio loaded (duration=${dur.toFixed(2)}s) but never PLAYED (currentTime=${ct.toFixed(3)}s) — `
    + 'the turn-mode-TTS-silent regression');
  log(`reply audio playing: currentTime=${ct.toFixed(2)}s ✓`);

  log('PASS: full real-mic turn → stubbed STT → reply → real TTS decoded + actually played');
}
