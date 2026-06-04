// Scenario: a multi-chunk reply plays back as ONE continuous track — the
// regression teeth for the virtual-timeline rewrite (src/audio/turn-based/
// tts.ts). Pre-fix, #player only ever held a single chunk, so:
//   - the green playhead bar RESET to 0 at every chunk boundary (progress
//     reported per-chunk position/duration), and
//   - scrubbing could only land WITHIN the current chunk, and
//   - the grey loading bar jumped straight to full on chunk 0 instead of
//     filling as each chunk synthesized.
//
// This smoke subscribes to the tts event surface and asserts the fix:
//   1. INCREMENTAL GREY BAR: load-progress climbs through >=2 intermediate
//      ratios in (0,1) before reaching 1 (fills per chunk, no early jump).
//   2. CONTINUOUS PLAYHEAD: progress reports a stable WHOLE-reply duration
//      (≈ N× one chunk) and position is monotonic ACROSS chunk boundaries —
//      it climbs past a single chunk's duration with no sawtooth reset.
//   3. CROSS-CHUNK SCRUB: seekTo(0.85) lands the playhead near 0.85× the
//      whole-reply duration (a LATER chunk), not capped inside chunk 0.
//
// All /tts responses are a REAL 16-bit PCM WAV fixture (decodable in
// Playwright's Chromium), so #player genuinely decodes + advances.

import { waitForReady, assert } from './lib.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPLY_TTS_WAV } from './fixtures/manifest.mjs';

export const NAME = 'tts-virtual-timeline';
export const DESCRIPTION = 'multi-chunk reply plays as one continuous track: incremental grey bar, continuous playhead, cross-chunk scrub';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPLY = [
  'The ocean covers more than seventy percent of the planet surface and holds most of its water.',
  'Beneath the waves lie mountain ranges taller than any on land, and trenches deeper than Everest is high.',
  'Bioluminescent creatures light the dark midwater zone with their own cold blue glow.',
  'Coral reefs, though a tiny fraction of the seafloor, shelter a quarter of all marine species.',
  'Vast currents carry warmth around the globe and quietly shape the weather we feel on shore.',
  'We have mapped the far side of the moon in more detail than we have charted our own deep sea.',
].join(' ');

export default async function run({ page, log }) {
  const replyWav = await readFile(path.join(__dirname, 'fixtures', REPLY_TTS_WAV));

  // Stagger chunk synthesis so the grey bar has a genuine "filling" window:
  // chunk 0 returns fast, each later chunk +400ms. (We don't gate the asserts
  // on this — it just makes the incremental fill observable, not instant.)
  let reqIdx = 0;
  await page.route('**/tts', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const idx = reqIdx++;
    await new Promise((r) => setTimeout(r, 150 + idx * 400));
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: replyWav });
  });

  await waitForReady(page);

  // Wire the event subscribers + expose the API in page context. The
  // dynamic import resolves to the SAME module singleton that #player's
  // listeners use, so on(...) receives the real emissions.
  await page.evaluate(async () => {
    const mod = await import('/build/audio/turn-based/tts.mjs');
    const w = window;
    w.__tts = mod;
    w.__loadProgress = [];   // ratios from load-progress
    w.__progress = [];       // { position, duration } from progress
    w.__seeks = [];          // { position, duration } from seek
    mod.on('load-progress', (p) => w.__loadProgress.push(p.ratio));
    mod.on('progress', (p) => w.__progress.push({ position: p.position, duration: p.duration }));
    mod.on('seek', (p) => w.__seeks.push({ position: p.position, duration: p.duration }));
  });

  const clientChunks = await page.evaluate((t) => window.__tts.chunkForTts(t).length, REPLY);
  log(`client split reply into ${clientChunks} chunks`);
  assert(clientChunks >= 3, `need a >=3-chunk reply to exercise cross-chunk scrub, got ${clientChunks}`);

  await page.evaluate((t) => window.__tts.playReplyTts(t, 'aura-2-thalia-en', 'vt-reply-1'), REPLY);

  // Let playback get underway and chunks chain through a couple boundaries.
  await page.waitForFunction(() => {
    const p = document.getElementById('player');
    return p && p.currentTime > 0.02;
  }, null, { timeout: 12_000, polling: 50 });

  // Wait for every chunk to finish synthesizing (grey bar reaches full) so
  // the load-progress sequence is complete and the scrub target chunk has a
  // blob to bind.
  await page.waitForFunction(
    () => window.__loadProgress.some((r) => r >= 0.999),
    null,
    { timeout: 15_000, polling: 100 },
  );

  // ── 1. INCREMENTAL GREY BAR ──────────────────────────────────────────
  const ratios = await page.evaluate(() => window.__loadProgress);
  const intermediate = ratios.filter((r) => r > 0 && r < 0.999);
  const distinctIntermediate = [...new Set(intermediate.map((r) => r.toFixed(3)))];
  log(`load-progress ratios: [${ratios.map((r) => r.toFixed(2)).join(', ')}]`);
  assert(ratios.some((r) => r >= 0.999), 'grey bar never reached full (ratio 1)');
  assert(distinctIntermediate.length >= 2,
    `grey bar did not fill incrementally — expected >=2 intermediate ratios in (0,1), `
    + `saw ${distinctIntermediate.length} (${distinctIntermediate.join(', ')}). `
    + `A single jump to 1 means it's not driven per-chunk.`);
  // Monotonic non-decreasing (a chunk settling never shrinks the bar).
  for (let i = 1; i < ratios.length; i++) {
    assert(ratios[i] >= ratios[i - 1] - 1e-6,
      `grey bar went backwards: ${ratios[i - 1]} → ${ratios[i]}`);
  }
  log(`grey bar filled incrementally through ${distinctIntermediate.length} intermediate steps ✓`);

  // ── 2. CONTINUOUS PLAYHEAD ───────────────────────────────────────────
  // #player holds ONE chunk, so its duration is a single chunk's real length.
  const chunkDur = await page.evaluate(() => document.getElementById('player').duration);
  assert(Number.isFinite(chunkDur) && chunkDur > 0, `player never decoded a chunk (dur=${chunkDur})`);

  // Let playback advance until the playhead has genuinely crossed the first
  // chunk boundary on the continuous timeline (position > one chunk). With a
  // per-chunk timeline this would never happen — it'd reset to 0 at the swap.
  await page.waitForFunction(
    (cd) => window.__progress.some((p) => p.position > cd * 1.3),
    chunkDur,
    { timeout: Math.ceil(chunkDur * 1000 * 2) + 6_000, polling: 100 },
  );

  const progress = await page.evaluate(() => window.__progress);
  assert(progress.length >= 2, `too few progress samples (${progress.length})`);
  const positions = progress.map((p) => p.position);
  const durations = progress.map((p) => p.duration);
  const maxPos = Math.max(...positions);
  const repDur = Math.max(...durations);
  log(`per-chunk dur≈${chunkDur.toFixed(2)}s; reported whole-reply dur≈${repDur.toFixed(2)}s; max playhead=${maxPos.toFixed(2)}s`);

  // Reported duration is the WHOLE reply, not one chunk: clearly larger than
  // a single chunk's real duration.
  assert(repDur > chunkDur * 1.8,
    `progress duration (${repDur.toFixed(2)}s) is not a whole-reply timeline — `
    + `expected >> one chunk (${chunkDur.toFixed(2)}s). Playhead is still per-chunk.`);

  // Playhead climbs PAST one chunk's duration (it crossed a boundary on a
  // continuous scale instead of resetting to 0).
  assert(maxPos > chunkDur * 1.2,
    `playhead never advanced past a single chunk (max ${maxPos.toFixed(2)}s vs chunk ${chunkDur.toFixed(2)}s) — `
    + `it likely reset to 0 at the boundary`);

  // No sawtooth: position is monotonic across boundaries (small tolerance for
  // timeupdate jitter at the swap instant).
  for (let i = 1; i < positions.length; i++) {
    assert(positions[i] >= positions[i - 1] - 0.35,
      `playhead jumped backwards across a chunk boundary: `
      + `${positions[i - 1].toFixed(2)}s → ${positions[i].toFixed(2)}s (per-chunk reset?)`);
  }
  log('playhead is continuous across chunk boundaries (no per-chunk reset) ✓');

  // ── 3. CROSS-CHUNK SCRUB ─────────────────────────────────────────────
  await page.evaluate(() => { window.__progress.length = 0; });
  await page.evaluate(() => window.__tts.seekTo(0.85));

  const seek = await page.evaluate(() => window.__seeks[window.__seeks.length - 1]);
  assert(seek, 'seekTo emitted no seek event');
  const targetRatio = seek.position / seek.duration;
  log(`seek to 0.85 → position ${seek.position.toFixed(2)}s of ${seek.duration.toFixed(2)}s (ratio ${targetRatio.toFixed(2)})`);
  assert(Math.abs(targetRatio - 0.85) < 0.08,
    `seek did not map to the whole-reply timeline: landed at ratio ${targetRatio.toFixed(2)}, expected ~0.85`);
  // 0.85 of the reply is well past chunk 0 — proving the scrub crossed chunks.
  assert(seek.position > chunkDur * 1.5,
    `seek target (${seek.position.toFixed(2)}s) is within the first chunk — scrub did not cross chunks`);

  // The playhead actually jumped there: the next progress samples report a
  // position near the seek target (not back near 0 in chunk 0).
  await page.waitForFunction(
    (target) => window.__progress.some((p) => Math.abs(p.position - target) < 3.0),
    seek.position,
    { timeout: 6_000, polling: 100 },
  );
  const postSeek = await page.evaluate(() => window.__progress.map((p) => p.position));
  const nearest = postSeek.reduce((a, p) => Math.min(a, Math.abs(p - seek.position)), Infinity);
  log(`post-seek playhead reached within ${nearest.toFixed(2)}s of the ${seek.position.toFixed(2)}s target`);
  assert(postSeek.some((p) => p > chunkDur * 1.5),
    `playhead did not move to the seeked later chunk after scrub (samples: `
    + `${postSeek.map((p) => p.toFixed(1)).join(', ')})`);
  log('cross-chunk scrub landed the playhead in the seeked later chunk ✓');

  log('PASS: virtual timeline — incremental grey bar, continuous playhead, cross-chunk scrub');
}
