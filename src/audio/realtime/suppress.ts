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

let suppressing = false;
let suppressEndTimer: ReturnType<typeof setTimeout> | null = null;
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
 *  transcripts flow again immediately. */
export function onBarge(): void {
  if (suppressEndTimer) {
    clearTimeout(suppressEndTimer);
    suppressEndTimer = null;
  }
  if (suppressing) stopSuppressing('barge');
  // Bridge will halt its TTS sender; the audio in the speaker is gone.
  ttsPlaying = false;
}

/** Called by main.ts when the bridge sends `{type:'listening'}` —
 *  TTS audio playback is finished and the bridge is ready for the next
 *  user turn. Authoritative "audio done" signal: the bridge knows when
 *  its own TTS sender stopped pushing frames. The transcript-suppression
 *  grace timer is independent (shorter, AEC-tail-focused). */
export function onListening(): void {
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
  ttsPlaying = false;
}

function stopSuppressing(reason: string): void {
  log('[suppress] resume user transcripts (', reason, ')');
  suppressing = false;
}
