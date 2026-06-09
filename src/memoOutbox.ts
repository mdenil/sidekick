/**
 * Memo transcription outbox — the offline-tolerant pipeline that turns a
 * recorded audio blob into a chat message.
 *
 * One processing path: every memo blob is rendered as a placeholder card +
 * persisted to IndexedDB + enqueued (renderMemoCard), then drained by a
 * single serialized flush (flushOutbox) that POSTs to /transcribe and routes
 * the transcript to the composer. handleMemoResult is the entry point used
 * by the recorder modes; the two background pollers cover the cases where a
 * blob gets stuck queued without a user action or reconnect to trigger a
 * flush.
 *
 * Leaf module: depends only on other modules (no boot-local DOM refs), which
 * is why it extracts cleanly out of main.ts's boot(). uploadInFlightBytes is
 * private state owned here; the status narrative for it lives in the network
 * poller below.
 */

import { log, diag } from './util/log.ts';
import { fetchWithTimeout, TimeoutError } from './util/fetchWithTimeout.ts';
import * as status from './status.ts';
import * as backend from './backend.ts';
import * as chat from './chat.ts';
import * as composer from './composer.ts';
import * as queue from './queue.ts';
import * as voiceMemos from './voiceMemos.ts';
import * as memoCard from './memoCard.ts';
import * as webrtcControls from './audio/realtime/controls.ts';
import { playFeedback } from './audio/shared/feedback.ts';
import {
  needsChunking, decodeToMono16k, slicePcm, encodeWav, stitchTranscripts,
} from './audio/shared/chunkedTranscribe.ts';

// Tracks the in-flight /transcribe upload size (bytes) so the periodic
// status refresher can surface "Uploading audio (NKB)…" while the
// request is on the wire. Field bug 2026-05-02: 14-22s queue→flush
// window was completely silent, leaving the user wondering if anything
// was happening between "queued" and the eventual transcript landing
// in the composer. null = no upload in flight; the refresher falls
// back to its normal connected/stalled narrative.
let uploadInFlightBytes: number | null = null;

// Per-chunk progress line for the chunked path ("Transcribing audio
// (2/4)…"). The 2s status refresher prefers this over the generic
// "Uploading audio (NKB)…" while an upload is in flight, so the chunk
// counter survives the refresher's ticks. Cleared alongside
// uploadInFlightBytes.
let uploadStatusLabel: string | null = null;

/** Marker for unprocessable-blob failures (Deepgram 400 / corrupt /
 *  unsupported) — caught at the item level to run the drop-from-queue
 *  narration instead of retrying forever. */
class PermanentTranscribeError extends Error {}

const isPermanentErr = (err: string) => /\b4\d\d\b|corrupt|unsupported|empty body/i.test(err);

/** POST one body to /transcribe and return the transcript string.
 *  Throws PermanentTranscribeError for unprocessable blobs, plain
 *  Error (or TimeoutError) for transient failures. */
async function postTranscribe(url: string, body: Blob, mimeType: string, timeoutMs: number): Promise<string> {
  const res = await fetchWithTimeout(url, {
    method: 'POST', headers: { 'Content-Type': mimeType }, body,
    timeoutMs,
  });
  const data = await res.json();
  if (!data.ok) {
    // Distinguish PERMANENT failures (corrupt blob, unsupported
    // format, Deepgram 400) from TRANSIENT (network, 5xx, timeout).
    // Permanent: drop from queue so we don't retry forever.
    // Transient: throw, queue.flush keeps the item for next round.
    //
    // Symptom: queued audio memos all fail with "deepgram 400
    // corrupt or unsupported data" on each retry — typically
    // blobs recorded while the iOS mic-perm dialog was up
    // (silent / partial). Without this guard the outbox grows
    // unbounded.
    const err = String(data.error || 'transcription failed');
    if (isPermanentErr(err)) throw new PermanentTranscribeError(err);
    throw new Error(err);
  }
  return (data.transcript || '').trim();
}

/** Chunked path for long clips: decode the stored blob to 16k mono PCM,
 *  slice with overlap, transcribe each slice as a WAV, stitch with seam
 *  dedup. Returns null when the blob can't be decoded (caller falls back
 *  to single-shot). Chunk-level transient failures throw — the whole
 *  item stays queued and is redone from chunk 0 next flush (chunks are
 *  fast, partial-progress persistence isn't worth the state). */
async function chunkedTranscribe(blob: Blob, url: string, toComposer: boolean): Promise<string | null> {
  let pcm: Float32Array;
  try {
    pcm = await decodeToMono16k(blob);
  } catch (e) {
    log('chunked transcribe: decode failed, falling back to single-shot:', (e as Error)?.message);
    return null;
  }
  const slices = slicePcm(pcm);
  const parts: string[] = [];
  for (let i = 0; i < slices.length; i++) {
    const label = `Transcribing audio (${i + 1}/${slices.length})…`;
    uploadStatusLabel = label;
    status.setStatus(label, 'live');
    if (toComposer) composer.setInterim(`Transcribing… (${i + 1}/${slices.length})`);
    parts.push(await postTranscribe(url, encodeWav(slices[i]), 'audio/wav', 60_000));
  }
  return stitchTranscripts(parts);
}

/** Flush queued audio items — update the corresponding memo cards with transcripts. */
export async function flushOutbox() {
  const result = await queue.flush(
    async (text) => { backend.sendMessage(text); },
    async (blob, mimeType, id, autoSend, toComposer, durationMs) => {
      // Per-user keyterm biasing for batch transcribe. Same IDB list the
      // WebRTC offer ships; bridge accepts repeated `?keyterms=…&keyterms=…`
      // and merges into the Deepgram spec like the streaming path does.
      // Without this, memo-mode transcription runs un-biased even if the
      // user has chips configured (was the case for "clawdian" miss).
      let kt: string[] = [];
      try {
        const { readList } = await import('./keyterms.ts');
        kt = (await readList()) || [];
      } catch {}
      const url = kt.length
        ? `/transcribe?${kt.map(t => 'keyterms=' + encodeURIComponent(t)).join('&')}`
        : '/transcribe';
      let text = '';
      // Surface "Uploading audio (NKB)…" immediately + via the
      // periodic refresher (which prefers uploadInFlightBytes when
      // set). Cleared in finally so success/timeout/error all reset
      // the indicator. fetchWithTimeout doesn't expose progress
      // events, so this is indeterminate by design — just enough
      // to tell the user "stop tapping, it's working."
      uploadInFlightBytes = blob.size;
      const kb = Math.round(blob.size / 1024);
      status.setStatus(`Uploading audio (${kb} KB)…`, 'live');
      try {
        try {
          // Long clips (> ~2.5 min) go through the chunked path: each
          // ~80s slice is its own bounded round-trip, so a 5-minute
          // dictation can't blow a single timeout budget and wedge in
          // permanent-retry (the 2026-06-09 "Transcribing… forever"
          // incident). Chunking happens HERE at flush time, so blobs
          // already sitting in the outbox get the new path on their
          // next flush. Decode failure → single-shot fallback below.
          let chunked: string | null = null;
          if (needsChunking(durationMs, blob.size)) {
            chunked = await chunkedTranscribe(blob, url, toComposer);
          }
          if (chunked != null) {
            text = chunked;
          } else {
            // Timeout scales with blob size: small memos under 1MB ≈
            // minute or less of audio (Deepgram batch returns in 1-3s)
            // get the snappy 15s budget. Larger blobs get 60s — the
            // upload alone for a 5MB webm over Tailscale can take
            // 5-10s, plus Deepgram batch latency grows roughly with
            // audio length. Earlier 15s flat ceiling wedged 3-minute
            // memos in permanent-retry: each attempt timed out before
            // Deepgram could respond, queue never drained. Long clips
            // that couldn't decode for chunking get 120s — better one
            // slow attempt than a guaranteed-too-short loop.
            const timeoutMs = blob.size > 1_000_000
              ? (needsChunking(durationMs, blob.size) ? 120_000 : 60_000)
              : 15_000;
            text = await postTranscribe(url, blob, mimeType, timeoutMs);
          }
        } catch (e) {
          if (e instanceof TimeoutError) {
            // Surface + chime; blob stays in queue for retry on next
            // reconnect. The card moves to queued(⏳) so the user sees
            // something is pending. Dictation (toComposer) has no card —
            // the durable queue is what saves the bad-connection upload
            // from evaporating, so we just narrate "will retry" and keep
            // the blob; a poller drains it when signal returns.
            log('transcribe timeout — blob stays queued for retry');
            if (toComposer) {
              composer.setInterim('Dictation queued — will retry when connected');
            } else {
              const transcriptEl = document.getElementById('transcript');
              const card = id && transcriptEl ? memoCard.find(transcriptEl, id) : null;
              if (card) memoCard.update(card, { status: 'queued' });
            }
            playFeedback('error');
          }
          throw e;  // re-throw so queue.flush keeps the item
        }
      } catch (e) {
        if (e instanceof PermanentTranscribeError) {
          const err = e.message;
          log('transcribe: permanent failure, dropping blob:', err);
          if (toComposer) {
            // Dictation has no card — just clear the progress line and
            // narrate softly. The blob drops from the queue (return, no
            // throw) since retrying a corrupt clip is futile.
            composer.clearInterim();
            status.setStatus('Dictation unprocessable — tap mic to retry', 'err');
          } else {
            const transcriptEl = document.getElementById('transcript');
            const card = id && transcriptEl ? memoCard.find(transcriptEl, id) : null;
            const note = '(audio unprocessable)';
            if (card) memoCard.update(card, { transcript: note, status: 'failed' });
            try { await voiceMemos.update(id, { transcript: note, status: 'failed' }); } catch {}
          }
          playFeedback('error');
          return;  // don't throw — queue.flush will drop the item
        }
        throw e;  // transient → keep in queue
      } finally {
        uploadInFlightBytes = null;
        uploadStatusLabel = null;
      }
      const transcriptEl = document.getElementById('transcript');
      const card = id && transcriptEl ? memoCard.find(transcriptEl, id) : null;

      // Empty transcript — /transcribe succeeded but heard nothing
      // (silent clip / inaudible). Surface that on the card so the user
      // isn't left staring at an orphan row. Persist the status so a
      // reload doesn't restore it as pending again.
      if (!text) {
        if (toComposer) {
          // Dictation: no card to annotate — clear the ghost line and
          // tell the user softly. Item drops from queue (return, no throw).
          composer.clearInterim();
          status.setStatus('No speech detected', null);
          return;
        }
        const note = '(no speech detected)';
        if (card) memoCard.update(card, { transcript: note, status: 'failed' });
        await voiceMemos.update(id, { transcript: note, status: 'failed' });
        return;
      }

      // Routing depends on the per-memo autoSend flag captured at
      // record time (settings.micAutoSend at the moment startMemo()
      // was called). autoSend=true → append to composer (so any
      // already-typed text is preserved) and immediately submit;
      // autoSend=false → just append, leaving the user to review +
      // send manually. Both paths converge through composer.appendText
      // → composer.submit, which is the same codepath as clicking Send.
      if (toComposer) {
        // Batch dictation: transcript is INPUT, not a message. appendText
        // lands it at the cursor (preserving anything already typed) and
        // clears the ghost interim line. No card, no voice-memo record, no
        // submit, no chat bubble — exactly the ephemeral-input UX, but the
        // blob rode the durable queue so a bad-connection upload retried
        // here instead of evaporating.
        composer.appendText(text);
        status.setStatus('', null);
        return;
      }
      if (card) card.remove();
      await voiceMemos.remove(id);
      composer.appendText(text);
      if (autoSend) {
        composer.submit();
      }
    }
  );
  if (result.skipped) diag('outbox: flush skipped (already flushing)');
  else if (result.sent > 0) log('outbox: flushed', result.sent, 'queued messages');
  return result;
}

/** Start the two background pollers (periodic retry + network-status
 *  refresh). Called once from boot. */
export function startBackgroundPollers(): void {
  // Periodic background retry. Covers the scenario where /transcribe
  // fails mid-memo (blob queued) but the gateway WS stays connected —
  // no reconnect event fires, no user send happens. Without this, a
  // queued blob sits until the next reload or user action. Poll is
  // cheap (IDB read + early-out if empty); only flushes when there's
  // pending work AND the gateway is reachable.
  setInterval(async () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    try {
      const pending = await queue.pending();
      if (pending > 0 && backend.isConnected()) {
        diag(`outbox: periodic retry (${pending} pending)`);
        flushOutbox().catch(() => {});
      }
    } catch {}
  }, 30_000);

  // Periodic network-status refresh. Surfaces queued count + weak-signal
  // detection in the header. Only writes when there's no active WebRTC
  // call (controls.ts owns the call-status narrative).
  const WEAK_SIGNAL_MS = 8_000;
  setInterval(async () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (webrtcControls.isOpen()) return;
    try {
      const gwConnected = backend.isConnected();
      const summary = await queue.summary();
      // Idle cursor — wall-clock ms since /api/sidekick/stream last
      // delivered ANY envelope. EventSource can stay "connected" while
      // the underlying TCP connection is dead (cellular handoff,
      // suspended radio). Combined with queued outbound, a long idle
      // window is the signal that we're stalled. msSinceLastEnvelope()
      // returns 0 on fresh connect → treated as "no signal yet."
      //
      // The pre-refactor openclaw path also surfaced a `weakSignal`
      // state (idle stream, no queue, ambiguously-iffy network). We
      // intentionally don't recreate that here: the SSE channel is
      // sparse by design — an idle drawer browse can go minutes
      // without an envelope and that's normal — so a `weakSignal`
      // fire on idle would be a constant false positive. Stalled
      // (idle + queued outbound) IS unambiguous and stays.
      const msIdle = backend.msSinceLastEnvelope();
      // Upload-in-flight wins over the connectivity narrative — the
      // user wants to see "uploading" until the request lands, even
      // if the gateway briefly looks idle. Without this the 2s
      // refresher would clobber the "Uploading…" pill back to
      // "Connected" within a tick.
      if (uploadInFlightBytes != null) {
        if (uploadStatusLabel) {
          // Chunked path — keep the "Transcribing audio (2/4)…" counter
          // instead of clobbering it back to the generic upload line.
          status.setStatus(uploadStatusLabel, 'live');
        } else {
          const kb = Math.round(uploadInFlightBytes / 1024);
          status.setStatus(`Uploading audio (${kb} KB)…`, 'live');
        }
      } else if (!gwConnected) {
        status.setState('reconnecting', { queuedCount: summary.count, queuedAudioMs: summary.totalAudioMs });
      } else if (msIdle > WEAK_SIGNAL_MS && summary.count > 0) {
        status.setState('stalled', { queuedCount: summary.count, queuedAudioMs: summary.totalAudioMs });
      } else {
        status.setState('connected', {
          queuedCount: summary.count,
          queuedAudioMs: summary.totalAudioMs,
        });
      }
    } catch {}
  }, 2_000);
}

/** Save blob to IDB + enqueue for retry + render a placeholder memo card
 *  in chat. Always runs on record stop, regardless of online/offline —
 *  gives the user immediate visual feedback during the quiet
 *  transcription window. Returns {id, card, rec}. autoSend is stored
 *  on the queue item so flushOutbox can route correctly even when the
 *  flush happens minutes later (periodic retry / reconnect). */
async function renderMemoCard(audioBlob, durationMs, autoSend = false) {
  // Hard ceiling: the bridge accepts up to 25MB at /v1/transcribe and
  // the proxy mirrors that. webm voice is ~30KB/s so 25MB ≈ 14 min.
  // Anything larger gets DROPPED here with a status warning rather
  // than queued — a too-big blob in the outbox just retries forever
  // and blocks the channel for smaller subsequent memos. User can
  // re-record in shorter chunks. Threshold is intentionally a few
  // hundred KB below the 25MB limit so an upload-time encoding bump
  // doesn't push a borderline blob over.
  const MEMO_MAX_BYTES = 24 * 1024 * 1024;
  if (audioBlob.size > MEMO_MAX_BYTES) {
    const mb = (audioBlob.size / (1024 * 1024)).toFixed(1);
    const mins = Math.round((durationMs ?? 0) / 60000);
    log(`memo: too big (${mb}MB ≈ ${mins}min) — dropped, would block the queue`);
    status.setStatus(
      `Memo too long (${mins}m) — dropped. Try shorter chunks.`,
      'err',
    );
    try { playFeedback('error'); } catch {}
    return { id: null, card: null, rec: null };
  }

  const id = crypto.randomUUID();
  const transcriptEl = document.getElementById('transcript');

  const rec = {
    id, blob: audioBlob, mimeType: audioBlob.type, durationMs,
    waveform: new Float32Array(40),
    transcript: null, status: 'pending', timestamp: Date.now(),
  };

  let card = null;
  if (transcriptEl) {
    card = memoCard.render(transcriptEl, rec);
    chat.autoScroll();
  }

  await voiceMemos.save(rec);
  await queue.enqueue({ id, type: 'audio', blob: audioBlob, mimeType: audioBlob.type, durationMs, autoSend });
  log('memo: queued audio blob (' + Math.round(audioBlob.size / 1024) + 'KB) autoSend=' + autoSend);

  // Background waveform extraction
  voiceMemos.extractWaveform(audioBlob).then(bars => {
    if (card) {
      const anyCard = card as any;
      if (anyCard._setWaveform) anyCard._setWaveform(bars);
    }
    voiceMemos.update(id, { waveform: Array.from(bars) }).catch(() => {});
  }).catch(e => log('memo: waveform extract failed:', e.message));

  return { id, card };
}

/** Batch dictation (dictateRealtime=OFF, #112): persist the recorded
 *  utterance to the durable outbox, then transcribe ONCE and drop the clean
 *  transcript into the composer.
 *
 *  Distinct from handleMemoResult: dictation is ephemeral INPUT, not a
 *  message. So there is NO voice-memo card and NO send — a silent / failed
 *  transcribe leaves nothing in the chat (the bug that prompted this path:
 *  the memo pipeline rendered a "(no speech detected)" bubble). But it DOES
 *  ride the same IndexedDB queue as memos (toComposer:true), because the
 *  fire-and-forget version evaporated long dictations on a bad connection:
 *  a 4-minute clip timed out on upload and the whole transcript was lost.
 *  Now the blob is persisted BEFORE any network attempt, so a timeout /
 *  offline just leaves it queued; the background pollers (or the next
 *  flushOutbox) retry it and the transcript lands in the composer whenever
 *  signal returns. The toComposer flag keeps every flush branch
 *  composer-bound (no card, no bubble, no submit). Progress shows as a ghost
 *  line under the composer plus the header pill. */
export async function transcribeToComposer(audioBlob: Blob | null, durationMs?: number): Promise<void> {
  if (!audioBlob) return;
  // Same hard ceiling as memos: a too-big blob just retries forever and
  // blocks the queue for everything behind it. Drop it up front rather
  // than persisting it.
  const MEMO_MAX_BYTES = 24 * 1024 * 1024;
  if (audioBlob.size > MEMO_MAX_BYTES) {
    const mb = (audioBlob.size / (1024 * 1024)).toFixed(1);
    status.setStatus(`Recording too long (${mb}MB) — try shorter chunks.`, 'err');
    try { playFeedback('error'); } catch {}
    return;
  }

  // Durable-first: persist the blob to the outbox BEFORE touching the
  // network. This is the whole point of the fix — if the upload times out
  // or we're offline, the blob survives in IndexedDB and a poller retries
  // it. toComposer:true routes every flush branch back to the composer.
  await queue.enqueue({
    type: 'audio', blob: audioBlob, mimeType: audioBlob.type, durationMs, toComposer: true,
  });
  log('dictate: queued audio blob (' + Math.round(audioBlob.size / 1024) + 'KB) toComposer');

  composer.setInterim('Transcribing…');

  const offline = navigator.onLine === false || !backend.isConnected();
  if (offline) {
    // Leave it queued; the periodic poller drains it on reconnect. Keep
    // the ghost line so the user knows the dictation wasn't lost.
    composer.setInterim('Dictation queued — will transcribe when connected');
    status.setStatus('Dictation queued — will transcribe when connected');
    return;
  }

  // Online: drain now. flushOutbox handles success (appendText), timeout
  // (keeps queued + "will retry" ghost line), permanent failure (drops +
  // narrates), and empty transcript — all via the toComposer branches.
  flushOutbox().catch(() => {});
}

export async function handleMemoResult(audioBlob: Blob, durationMs?: number, autoSend = false, path = 'unknown') {
  // Diagnostic for the iOS PTT auto-send bug — echoes the captured
  // autoSend flag + which release path triggered this finish, so
  // future regressions are debuggable from the JS console without
  // having to instrument startMemo from scratch.
  log(`memo finish: path=${path} autoSend=${autoSend} blob=${audioBlob ? Math.round(audioBlob.size/1024)+'KB' : 'null'}`);
  if (!audioBlob) return;
  // Always render the placeholder card + enqueue the blob, regardless
  // of connectivity. Matches the "user gets immediate visual feedback"
  // UX spec and keeps ONE processing path (flushOutbox) whether we're
  // online or offline.
  const { card } = await renderMemoCard(audioBlob, durationMs, autoSend);

  const offline = navigator.onLine === false || !backend.isConnected();
  if (offline) {
    if (card) memoCard.update(card, { status: 'queued' });
    status.setStatus('Audio queued — will transcribe when connected');
    return;
  }

  // Single transcribe path: flushOutbox iterates the queue serially
  // (for/await loop + isFlushing mutex), calls /transcribe per item,
  // routes to composer / chat based on autoSend setting, updates the
  // card. Rapid-fire memos all land here — mutex serializes them so
  // composer-append order matches record order, no duplicates.
  //
  // Earlier architecture had a second "live" transcribeChain that
  // raced with this: both paths fetched /transcribe for the same
  // blob, both appended, producing duplicates ("1 1 2 3 2 3" pattern
  // the user reported). Now there's only one path.
  flushOutbox().catch(() => {});
}
