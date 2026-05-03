/**
 * @fileoverview Minimal user-transcript suppression during agent reply.
 *
 * Background: while the agent is speaking, the iOS speakerphone (and to
 * a lesser degree desktop speakers) re-captures the agent's TTS output
 * as mic input, which Deepgram transcribes. Without suppression, those
 * fake transcripts pollute the chat log. We can't tell from the
 * transcript text alone whether a "user" line came from the user or the
 * speakerphone echo — so while a reply is in progress, we drop user
 * transcripts entirely.
 *
 * Barge-in is server-side now (audio-bridge runs an RMS VAD on raw
 * pre-AEC PCM). When the bridge detects user voice during TTS, it
 * sends a `{type:'barge'}` envelope and the PWA both cancels remote
 * playback and clears suppression — see main.ts. Suppression also
 * clears on assistant `is_final: true` plus a small grace period
 * (TTS playback continues briefly after text-final).
 *
 * This module replaces the client-side analyser/HUD-driven
 * `pipelines/webrtc/duplex.ts` that lived here previously. The
 * analyser path was structurally broken on browsers that apply AEC
 * inside the WebRTC capture pipeline (every modern Chrome/Safari);
 * the bridge-side VAD is the canonical detector now.
 */

import { log } from '../../util/log.ts';

/** Tail extension after `is_final` — TTS audio playback continues a
 *  bit after text-final on most TTS providers (sentence-end pause,
 *  buffered audio). Re-enabling user transcripts immediately would let
 *  the tail leak back as fake user transcripts. 1.2 s covers Aura's
 *  typical buffer plus a small margin. */
const SUPPRESS_GRACE_MS = 1200;

// Speaker-buffer drain time after a barge halt. The bridge stops
// sending TTS frames when it receives the upstream barge envelope,
// but the client's audio output queue (Web Audio + OS speaker buffer)
// has ~300-500ms of TTS already in flight. During that drain window,
// the mic captures the residual TTS audio — without this grace, the
// drained tail gets STT-transcribed into a fake user turn (the
// "1 2 3 ... zero" feedback loop, 2026-05-03 09:34). Set 2026-05-03.
const TTS_DRAIN_GRACE_MS = 600;

let suppressing = false;
let suppressEndTimer: ReturnType<typeof setTimeout> | null = null;
let ttsPlayingClearTimer: ReturnType<typeof setTimeout> | null = null;
// TTS audio playback flag — distinct from `suppressing` because the
// transcript-suppression window is short (final + 1.2s grace, just long
// enough to drop the AEC-leaked speakerphone tail) but the TTS audio
// keeps playing through the speaker for SECONDS after `final`. The
// realtime barge detector needs the audio-playback window, not the
// transcript-suppression window — gating barge on `suppressing` makes
// it impossible to interrupt anything past the first ~1.2s of a reply
// (regression caught in 2026-05-03 v0.381 field-test). Set on first
// assistant delta; cleared on `listening` envelope from the bridge
// (the authoritative "TTS audio is done, your turn now" signal).
let ttsPlaying = false;

export function isSuppressing(): boolean {
  return suppressing;
}

export function isTtsPlaying(): boolean {
  return ttsPlaying;
}

/** Called by main.ts on every assistant transcript delta. First call
 *  of a reply turn flips suppression on; subsequent calls within the
 *  same reply cancel any pending end-timer (each delta extends the
 *  tail). */
export function onAssistantDelta(): void {
  if (suppressEndTimer) {
    clearTimeout(suppressEndTimer);
    suppressEndTimer = null;
  }
  if (!suppressing) {
    suppressing = true;
    log('[suppress] agent speaking — dropping user transcripts');
  }
  // Audio playback starts when the bridge starts pushing TTS frames,
  // which lags the first delta by a few hundred ms. Treating delta as
  // the start is a slight over-approximation — barge in this small
  // pre-audio window is a no-op (BargeWindow has its own warmup mute).
  ttsPlaying = true;
}

/** Called by main.ts on assistant `is_final: true`. Schedules
 *  suppression-clear after the grace period, unless a delta arrives
 *  in the meantime (which would extend the tail). */
export function onAssistantFinal(): void {
  if (!suppressing) return;
  if (suppressEndTimer) clearTimeout(suppressEndTimer);
  suppressEndTimer = setTimeout(() => {
    suppressEndTimer = null;
    stopSuppressing('final+grace');
  }, SUPPRESS_GRACE_MS);
}

/** Called by main.ts when the bridge sends `{type:'barge'}` — the
 *  user interrupted, so cancel any pending tail-grace and let user
 *  transcripts flow again immediately for the user's intentional
 *  speech. BUT: keep `ttsPlaying` true for TTS_DRAIN_GRACE_MS so the
 *  speaker-buffer tail draining over the next ~500ms doesn't get
 *  STT-transcribed as a fake user turn. */
export function onBarge(): void {
  if (suppressEndTimer) {
    clearTimeout(suppressEndTimer);
    suppressEndTimer = null;
  }
  if (suppressing) stopSuppressing('barge');
  // Schedule ttsPlaying clear AFTER the speaker tail drains — was
  // immediate, but the drained tail leaked to STT and created fake
  // user turns ("1 2 3 ... zero" feedback loop, 2026-05-03 09:34).
  if (ttsPlayingClearTimer) clearTimeout(ttsPlayingClearTimer);
  ttsPlayingClearTimer = setTimeout(() => {
    ttsPlayingClearTimer = null;
    ttsPlaying = false;
  }, TTS_DRAIN_GRACE_MS);
}

/** Called by main.ts when the bridge sends `{type:'listening'}` —
 *  TTS audio playback is finished and the bridge is ready for the next
 *  user turn. Authoritative "audio done" signal: the bridge knows when
 *  its own TTS sender stopped pushing frames. The transcript-suppression
 *  grace timer is independent (shorter, AEC-tail-focused). */
export function onListening(): void {
  if (ttsPlayingClearTimer) {
    clearTimeout(ttsPlayingClearTimer);
    ttsPlayingClearTimer = null;
  }
  ttsPlaying = false;
}

/** Called by controls.ts on call open/close so a stale state from a
 *  previous call doesn't leak in. Idempotent. */
export function reset(): void {
  if (suppressEndTimer) {
    clearTimeout(suppressEndTimer);
    suppressEndTimer = null;
  }
  if (suppressing) {
    suppressing = false;
    log('[suppress] reset (call lifecycle)');
  }
  if (ttsPlayingClearTimer) {
    clearTimeout(ttsPlayingClearTimer);
    ttsPlayingClearTimer = null;
  }
  ttsPlaying = false;
}

function stopSuppressing(reason: string): void {
  log('[suppress] resume user transcripts (', reason, ')');
  suppressing = false;
}
