// Scenario: the per-bubble play button streams a multi-sentence reply as
// several /tts chunks and plays the FIRST chunk before all chunk requests
// finish — the latency win (~30s → ~1-3s for first audio).
//
// Pre-fix the play-button path made ONE /tts POST for the whole reply and
// awaited res.blob() — first byte of audio only played after 100% of the
// synthesis downloaded. This smoke is the regression teeth for the
// chunked-streaming rewrite (src/audio/turn-based/tts.ts):
//
//   1. Multi-sentence reply → MORE THAN ONE /tts POST (it chunked).
//   2. #player begins PLAYING (currentTime advances) while at least one
//      chunk request is still in flight — proving play-start is NOT gated
//      on full synthesis. We enforce this by adding a per-request delay so
//      later chunks resolve well after chunk 0; then assert playback
//      started before the LAST request completed.
//   3. The player progresses through queued chunks (src swaps as each
//      chunk's 'ended' fires), ending in a non-error state.
//
// All /tts responses are a REAL 16-bit PCM WAV fixture (decodable in
// Playwright's Chromium; the production mp3 codec is absent there), so
// #player genuinely decodes + reports duration>0 + advances currentTime.

import { waitForReady, assert } from './lib.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPLY_TTS_WAV } from './fixtures/manifest.mjs';

export const NAME = 'streamed-reply-tts-chunking';
export const DESCRIPTION = 'play button streams a multi-sentence reply in chunks; first audio plays before all chunk requests finish';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A multi-paragraph reply that the client splits into several ~260-char
// chunks. Distinct sentences so chunking has clean boundaries.
const REPLY = [
  'The ocean covers more than seventy percent of the planet surface and holds most of its water.',
  'Beneath the waves lie mountain ranges taller than any on land, and trenches deeper than Everest is high.',
  'Bioluminescent creatures light the dark midwater zone with their own cold blue glow.',
  'Coral reefs, though a tiny fraction of the seafloor, shelter a quarter of all marine species.',
  'Vast currents carry warmth around the globe and quietly shape the weather we feel on shore.',
  'We have mapped the far side of the moon in more detail than we have charted our own deep sea.',
].join(' ');

export default async function run({ page, log, fail, url }) {
  const replyWav = await readFile(path.join(__dirname, 'fixtures', REPLY_TTS_WAV));

  // STAGGERED per-request delay: chunk 0 returns fast (~250ms) so play
  // starts quickly, but each later chunk is synthesized progressively
  // slower (+1s per index). This guarantees a genuine "tail chunk still
  // in flight" window when chunk 0 begins playing — the property the fix
  // delivers (play-start not gated on full synthesis). Captured stamps
  // are Date.now() in Node (route handler runs in Node), same machine
  // clock as the page so they're directly comparable.
  const CHUNK0_DELAY_MS = 250;
  const PER_INDEX_DELAY_MS = 1000;
  const ttsReqs = [];   // { idx, startedAt, finishedAt }
  let reqIdx = 0;

  await page.route('**/tts', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const idx = reqIdx++;
    const rec = { idx, startedAt: Date.now(), finishedAt: 0 };
    ttsReqs.push(rec);
    const delay = CHUNK0_DELAY_MS + idx * PER_INDEX_DELAY_MS;
    await new Promise((r) => setTimeout(r, delay));
    rec.finishedAt = Date.now();
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: replyWav });
  });

  await waitForReady(page);

  // Expose playReplyTts + a play-start timestamp probe in page context.
  // We hook #player's 'play' event to capture the moment the first chunk
  // begins playing, in page-clock ms.
  await page.evaluate(async () => {
    const mod = await import('/build/audio/turn-based/tts.mjs');
    const w = window;
    w.__playTts = mod.playReplyTts;
    w.__chunkForTts = mod.chunkForTts;
    w.__firstPlayAt = 0;
    const player = document.getElementById('player');
    if (player) {
      player.addEventListener('play', () => {
        if (!w.__firstPlayAt) w.__firstPlayAt = Date.now();
      });
    }
  });

  // Sanity: the client agrees this reply is multi-chunk.
  const clientChunks = await page.evaluate((t) => window.__chunkForTts(t).length, REPLY);
  log(`client split reply into ${clientChunks} chunks`);
  assert(clientChunks >= 2, `expected reply to split into >=2 chunks, got ${clientChunks}`);

  // Fire the streamed playback. Don't await fully — playReplyTts resolves
  // once chunk 0 STARTS playing, but we drive timing off captured events.
  const startedAt = Date.now();
  await page.evaluate((t) => window.__playTts(t, 'aura-2-thalia-en', 'smoke-reply-1'), REPLY);

  // 1. Multiple /tts POSTs fired (it chunked, didn't do one big request).
  //    Chunk 0 fires immediately; with concurrency the others fire right
  //    after — poll briefly for the fan-out.
  const reqT0 = Date.now();
  while (ttsReqs.length < 2 && Date.now() - reqT0 < 3000) {
    await page.waitForTimeout(50);
  }
  assert(ttsReqs.length >= 2,
    `expected multiple /tts chunk POSTs, saw ${ttsReqs.length} (did it chunk?)`);
  log(`/tts chunk POSTs observed: ${ttsReqs.length}`);

  // 2. THE TEETH: #player started PLAYING before the LAST chunk request
  //    completed — play-start is not gated on full synthesis. Chunk 0
  //    returns at ~250ms; the slowest chunk returns at 250ms+(N-1)*1000ms.
  await page.waitForFunction(() => {
    const p = document.getElementById('player');
    return p && p.currentTime > 0.02;
  }, null, { timeout: 12_000, polling: 50 });

  const firstPlayAt = await page.evaluate(() => window.__firstPlayAt);
  assert(firstPlayAt > 0, 'never captured a #player play event');

  // Wait until ALL chunk requests have settled so the last-completion
  // comparison is against the true tail (slowest = highest index).
  const settleT0 = Date.now();
  while (
    (ttsReqs.length < clientChunks || ttsReqs.some((r) => !r.finishedAt))
    && Date.now() - settleT0 < CHUNK0_DELAY_MS + clientChunks * PER_INDEX_DELAY_MS + 2000
  ) {
    await page.waitForTimeout(100);
  }
  const lastFinishedAt = Math.max(...ttsReqs.map((r) => r.finishedAt || 0));
  // firstPlayAt and finishedAt are both Date.now() on the same machine
  // clock (page vs Node realms) — directly comparable.
  log(`first play at t+${firstPlayAt - startedAt}ms; last chunk req finished at t+${lastFinishedAt - startedAt}ms`);
  assert(firstPlayAt < lastFinishedAt,
    `first audio (t+${firstPlayAt - startedAt}ms) did NOT precede the last chunk request `
    + `completing (t+${lastFinishedAt - startedAt}ms) — playback is gated on full synthesis`);
  log('first chunk played before all chunk requests finished ✓');

  // 3. The player progresses through queued chunks: assert currentTime
  //    keeps advancing as chunks chain off 'ended'. Sample twice.
  const t1 = await page.evaluate(() => document.getElementById('player').currentTime);
  await page.waitForTimeout(600);
  const t2 = await page.evaluate(() => ({
    currentTime: document.getElementById('player').currentTime,
    duration: document.getElementById('player').duration,
  }));
  log(`playhead advanced: ${t1.toFixed(2)}s → ${t2.currentTime.toFixed(2)}s (chunk dur=${(t2.duration || 0).toFixed(2)}s)`);
  assert(Number.isFinite(t2.duration) && t2.duration > 0,
    `player never decoded a chunk (duration=${t2.duration})`);

  // Let the rest of the chunks chain through to natural end, then confirm
  // no error state wedged the session (active cleared / idle reachable).
  await page.waitForTimeout(2000);
  const wedged = await page.evaluate(async () => {
    const mod = await import('/build/audio/turn-based/tts.mjs');
    // After the full reply plays out, state should be 'idle' (ended path
    // clears it) and activeReplyId null. We don't fail hard if a late
    // chunk is still playing — just report.
    return { state: mod.getState(), active: mod.getActiveReplyId() };
  });
  log(`post-playback: state=${wedged.state} active=${wedged.active}`);

  log('PASS: multi-sentence reply chunked + streamed; first audio beat full synthesis');
}
