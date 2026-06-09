/**
 * Chunked batch transcription for long recordings.
 *
 * Why: /transcribe is a single HTTP round-trip with a 60s client budget.
 * A 5-minute dictation can exceed that budget repeatedly, leaving the blob
 * in the outbox looping forever (queued → timeout → retry → timeout…).
 * Chunking bounds each round-trip: decode the stored blob to PCM, slice it
 * into ~80s segments with a small overlap, ship each as a WAV, then stitch
 * the per-chunk transcripts by deduplicating the overlapping words at each
 * seam so boundaries don't produce repeated or clipped phrases.
 *
 * Chunking happens at FLUSH time (not record time) on purpose: blobs
 * already sitting in the durable outbox — recorded before this code
 * existed — get picked up by the chunked path on their next flush.
 *
 * We can't byte-slice the stored blob (webm/mp4 containers — only the
 * first slice would carry the codec header), hence decode → PCM → WAV.
 * The decode always runs on the platform that recorded the blob, so the
 * codec is guaranteed decodable. WAV at 16kHz mono keeps chunks small
 * (~2.5MB per 80s) and is accepted by every batch STT provider.
 */

/** Clips longer than this get the chunked path. Comfortably above the
 *  3-minute memos the flat 60s budget already handles, comfortably below
 *  the 5-minute clips that wedge it. */
export const CHUNK_THRESHOLD_MS = 150_000;
/** Per-chunk slice length. 80s of 16k mono WAV ≈ 2.5MB — uploads in
 *  seconds, transcribes well inside the 60s budget. */
export const CHUNK_SEC = 80;
/** Seam overlap. Long enough that a word split by a chunk boundary is
 *  fully audible in at least one chunk; short enough that the dedup
 *  window stays a handful of words. */
export const OVERLAP_SEC = 2.5;
/** Decode/render sample rate. 16k mono is what STT wants; resampling at
 *  decode time keeps the PCM buffer ~20MB for a 5-min clip instead of
 *  ~115MB at 48k stereo. */
export const TARGET_RATE = 16_000;

/** Size fallback when durationMs is unknown: the recorder targets 24kbps,
 *  so 2.5MB ≈ 13+ min webm — but iOS can ignore the bitrate hint and emit
 *  much fatter AAC, so treat any multi-MB blob as long. */
const SIZE_THRESHOLD_BYTES = 2_500_000;

export function needsChunking(durationMs?: number, blobSize?: number): boolean {
  if (durationMs && durationMs > 0) return durationMs > CHUNK_THRESHOLD_MS;
  return (blobSize ?? 0) > SIZE_THRESHOLD_BYTES;
}

/** Decode any recorded container (webm/opus, mp4/AAC, wav) to 16kHz mono
 *  PCM. OfflineAudioContext resamples to its own rate during decode, so
 *  the full-rate buffer never materializes. Browser-only (no unit test). */
export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const buf = await blob.arrayBuffer();
  const Ctx: typeof OfflineAudioContext =
    (globalThis as any).OfflineAudioContext || (globalThis as any).webkitOfflineAudioContext;
  const ctx = new Ctx(1, 1, TARGET_RATE);
  const decoded: AudioBuffer = await ctx.decodeAudioData(buf);
  if (decoded.numberOfChannels === 1) return decoded.getChannelData(0).slice();
  // Mix down to mono: equal-weight average.
  const n = decoded.length;
  const out = new Float32Array(n);
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    const data = decoded.getChannelData(ch);
    for (let i = 0; i < n; i++) out[i] += data[i];
  }
  const scale = 1 / decoded.numberOfChannels;
  for (let i = 0; i < n; i++) out[i] *= scale;
  return out;
}

/** Slice PCM into chunks of chunkSec with overlapSec carried into the next
 *  chunk's head. Last chunk absorbs the remainder; a sub-overlap tail is
 *  never emitted alone. */
export function slicePcm(
  pcm: Float32Array,
  rate: number = TARGET_RATE,
  chunkSec: number = CHUNK_SEC,
  overlapSec: number = OVERLAP_SEC,
): Float32Array[] {
  const chunkLen = Math.floor(chunkSec * rate);
  const stride = Math.floor((chunkSec - overlapSec) * rate);
  if (pcm.length <= chunkLen || stride <= 0) return [pcm];
  const out: Float32Array[] = [];
  let start = 0;
  while (start + chunkLen < pcm.length) {
    out.push(pcm.subarray(start, start + chunkLen));
    start += stride;
  }
  out.push(pcm.subarray(start));
  return out;
}

/** Encode mono float PCM as a 16-bit PCM WAV blob. */
export function encodeWav(pcm: Float32Array, rate: number = TARGET_RATE): Blob {
  const dataLen = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);        // fmt chunk size
  v.setUint16(20, 1, true);         // PCM
  v.setUint16(22, 1, true);         // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);  // byte rate
  v.setUint16(32, 2, true);         // block align
  v.setUint16(34, 16, true);        // bits per sample
  writeStr(36, 'data');
  v.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < pcm.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

const normalizeWord = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/** Max words considered when matching a seam. ~2.5s of speech is 5-8
 *  words; 24 leaves slack for fast talkers + a misjudged boundary. */
const SEAM_WINDOW_WORDS = 24;
/** Two transcriptions of the same overlap audio can disagree slightly
 *  (punctuation, a homophone). Accept a seam match when at least 75% of
 *  the aligned words agree instead of demanding an exact run. */
const SEAM_MATCH_RATIO = 0.75;

/** Join per-chunk transcripts, removing the words duplicated by the audio
 *  overlap at each seam. For each adjacent pair, find the longest n
 *  (3..SEAM_WINDOW_WORDS) where the last n words of the left part align
 *  with the first n words of the right part at ≥ SEAM_MATCH_RATIO; drop
 *  the right part's first n words. No acceptable alignment → plain join
 *  (better a rare doubled word than a dropped one). */
export function stitchTranscripts(parts: string[]): string {
  const nonEmpty = parts.map(p => (p || '').trim()).filter(Boolean);
  if (nonEmpty.length === 0) return '';
  let acc = nonEmpty[0];
  for (let p = 1; p < nonEmpty.length; p++) {
    const right = nonEmpty[p];
    const accWords = acc.split(/\s+/);
    const rightWords = right.split(/\s+/);
    const maxN = Math.min(SEAM_WINDOW_WORDS, accWords.length, rightWords.length);
    let cut = 0;
    for (let n = maxN; n >= 3; n--) {
      const tail = accWords.slice(-n);
      let matches = 0;
      for (let i = 0; i < n; i++) {
        if (normalizeWord(tail[i]) === normalizeWord(rightWords[i])) matches++;
      }
      if (matches / n >= SEAM_MATCH_RATIO) { cut = n; break; }
    }
    const remainder = rightWords.slice(cut).join(' ');
    acc = remainder ? `${acc} ${remainder}` : acc;
  }
  return acc;
}
