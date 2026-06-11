/**
 * @fileoverview Optimistic call capture — a parallel MediaRecorder on
 * the live call's mic track, running for the whole call.
 *
 * Phase 1 use (cold-start splice): the bridge's STT pipe takes seconds
 * to go hot after the user taps call (mic acquire → SDP → Deepgram →
 * first `listening` envelope). Anything said in that gap is lost to
 * the bridge — but not to this recorder, which starts the moment the
 * mic stream exists. When the first `listening` lands we transcribe
 * the head of the recording (gap + a 2s overlap past `listening`) via
 * /transcribe; the first dispatch of the call splices that head onto
 * the bridge transcript with stitchTranscripts (the overlap gives the
 * seam dedup shared audio on both sides).
 *
 * Phase-0 device verdict (2026-06-11, task #194): this exact recorder
 * recipe runs cleanly alongside a live RTCPeerConnection in iOS
 * WKWebView — steady 1s chunk cadence, no track steals, real bytes,
 * sane transcripts. See ocSpike removal commit for the evidence log.
 *
 * Every failure path degrades to "no head" (un-spliced dispatch),
 * never to a blocked or broken call.
 */

import { log, diag } from '../../util/log.ts';
import { apiUrl } from '../../apiBase.ts';
import { decodeToMono16k, encodeWav, TARGET_RATE } from '../shared/chunkedTranscribe.ts';
import { postTranscribe } from '../shared/postTranscribe.ts';

/** Head audio extends this far past the `listening` moment so the head
 *  transcript and the bridge transcript share words for seam dedup. */
const HEAD_OVERLAP_MS = 2000;
/** Recorder timeslice is 1s — wait this much past the overlap point so
 *  the chunk covering it has flushed before we assemble the head blob. */
const HEAD_SLACK_MS = 1200;
/** A gap this small captured nothing the bridge could have missed —
 *  skip the head round-trip (and the false-splice risk) entirely. */
const MIN_GAP_MS = 1000;
const TRANSCRIBE_TIMEOUT_MS = 30_000;

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let startedAt = 0;
let listeningLatched = false;
let headPromise: Promise<string> | null = null;
let headResolve: ((text: string) => void) | null = null;
let headTimer: ReturnType<typeof setTimeout> | null = null;
let headConsumed = false;

/** Start the whole-call recorder on the live call's mic stream. Call
 *  right after mic acquisition, before the SDP handshake. No-op if a
 *  recorder is already running. */
export function start(micStream: MediaStream): void {
  if (recorder) return;
  chunks = [];
  startedAt = 0;
  listeningLatched = false;
  headPromise = null;
  headResolve = null;
  headConsumed = false;
  if (headTimer !== null) { clearTimeout(headTimer); headTimer = null; }

  const track = micStream.getAudioTracks()[0];
  if (!track) { diag('[call-capture] no audio track — capture off for this call'); return; }
  try {
    try {
      recorder = new MediaRecorder(micStream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 24000 });
    } catch {
      recorder = new MediaRecorder(micStream, { audioBitsPerSecond: 24000 });
    }
  } catch (e: any) {
    log('[call-capture] MediaRecorder construction failed', `name=${e?.name}`, `message=${e?.message}`);
    recorder = null;
    return;
  }
  startedAt = performance.now();
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onerror = (e: any) => {
    diag('[call-capture] recorder error', `name=${e?.error?.name}`, `message=${e?.error?.message}`);
  };
  recorder.start(1000);
  log('[call-capture] start', `mime=${recorder.mimeType || '(default)'}`);
}

/** The bridge's FIRST `listening` envelope of the call: measure the
 *  cold-start gap and schedule head extraction. Later `listening`s
 *  (after each TTS turn) are no-ops via the latch. */
export function markListening(): void {
  if (!recorder || listeningLatched) return;
  listeningLatched = true;
  const gapMs = Math.round(performance.now() - startedAt);
  if (gapMs < MIN_GAP_MS) {
    log('[call-capture] listening at +' + gapMs + 'ms — gap too small, no head');
    return;
  }
  headPromise = new Promise<string>((resolve) => { headResolve = resolve; });
  headTimer = setTimeout(() => {
    headTimer = null;
    void extractHead(gapMs).then((text) => headResolve?.(text));
  }, HEAD_OVERLAP_MS + HEAD_SLACK_MS);
  log('[call-capture] listening at +' + gapMs + 'ms — head extraction scheduled');
}

/** Consume the cold-start head transcript. Single-consume: the first
 *  caller (the call's first dispatch) gets the head — or '' after
 *  timeoutMs if transcription is still in flight; every later call
 *  resolves '' immediately. Never throws. */
export async function takeHead(timeoutMs: number): Promise<string> {
  if (headConsumed || !headPromise) return '';
  headConsumed = true;
  const p = headPromise;
  headPromise = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<string>((resolve) => { timer = setTimeout(() => resolve(''), timeoutMs); });
  const text = await Promise.race([p, timeout]);
  if (timer !== null) clearTimeout(timer);
  return text;
}

/** Stop the recorder and discard the capture. Call from close() BEFORE
 *  the mic stream is released, so the final chunk flushes. Unblocks any
 *  pending takeHead waiter with ''. */
export function stop(reason: string): void {
  if (headTimer !== null) { clearTimeout(headTimer); headTimer = null; }
  // Resolving an already-resolved promise is a no-op, so a real head
  // that landed before close still wins.
  headResolve?.('');
  if (!recorder) return;
  const rec = recorder;
  recorder = null;
  rec.onstop = () => {
    const bytes = chunks.reduce((n, c) => n + c.size, 0);
    log('[call-capture] stop', `reason=${reason}`,
      `duration=${Math.round((performance.now() - startedAt) / 1000)}s`,
      `chunks=${chunks.length}`, `bytes=${bytes}`);
    chunks = [];
  };
  try { rec.stop(); } catch (e: any) {
    diag('[call-capture] rec.stop threw', e?.message);
    chunks = [];
  }
}

/** Assemble the head window from the chunks captured so far, transcribe
 *  it, return the text ('' on any failure). The chunk list is
 *  snapshotted up front so a concurrent stop() can't clear it mid-read.
 *  Decoding a non-finalized webm assembled from in-flight chunks can
 *  throw on some platforms — that's a caught, degraded path. */
async function extractHead(gapMs: number): Promise<string> {
  try {
    const blob = new Blob(chunks.slice(), { type: recorder?.mimeType || 'audio/webm' });
    if (blob.size === 0) { log('[call-capture] head: no bytes captured'); return ''; }
    const pcm = await decodeToMono16k(blob);
    const wantSamples = Math.floor(((gapMs + HEAD_OVERLAP_MS) / 1000) * TARGET_RATE);
    const head = pcm.length > wantSamples ? pcm.subarray(0, wantSamples) : pcm;
    const wav = encodeWav(head);
    const text = await postTranscribe(apiUrl('/transcribe'), wav, 'audio/wav', TRANSCRIBE_TIMEOUT_MS);
    log('[call-capture] head transcript:',
      text ? `"${text.slice(0, 120)}${text.length > 120 ? '…' : ''}"` : '(empty)');
    return text;
  } catch (e: any) {
    log('[call-capture] head extraction failed', `name=${e?.name}`, `message=${e?.message}`);
    return '';
  }
}
