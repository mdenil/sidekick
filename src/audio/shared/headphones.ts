/**
 * @fileoverview Output-routing detector — "are we playing through
 * headphones or a speaker on the same device as the mic?"
 *
 * Used to decide whether barge detection can possibly work in
 * turnbased mode. Realtime/WebRTC engages OS-level AEC against the
 * peer track regardless; turnbased plays MP3 through `<audio>` which
 * bypasses Chrome/Safari's AEC pipeline → speaker bleed defeats
 * Silero VAD → barge self-fires constantly. With headphones the
 * acoustic loop is broken and barge works fine.
 *
 * **Reliability matrix**:
 *   - iOS Safari 17+: `navigator.audioSession.type` = 'speaker' /
 *     'headphones' / 'bluetooth' / 'airplay'. **Direct OS-level
 *     routing info — the only platform where we can trust this.**
 *   - Mac/desktop browsers: no API exposes "current output device
 *     routing." `enumerateDevices()` lists what's connected, not
 *     what's currently routed. Heuristic-only.
 *   - Android: limited; Chrome partial support for audioSession.
 *
 * Policy: when iOS reports speaker → return `'speaker'`. When iOS
 * reports anything else (headphones / bluetooth / airplay) → return
 * `'isolated'`. On non-iOS or when the API is unavailable → return
 * `'unknown'`. Callers treat 'unknown' as "show the user a manual
 * control and trust them" — Jonathan's Mac demo case.
 *
 * Implementation: the audioSession API is observable via
 * `navigator.audioSession.onstatechange`. We subscribe once, cache the
 * latest value, fan it out to subscribers. No polling.
 */

import { log } from '../../util/log.ts';

export type Routing = 'speaker' | 'isolated' | 'unknown';

type Listener = (routing: Routing) => void;

let current: Routing = 'unknown';
let initialized = false;
const listeners = new Set<Listener>();

/** Read the current routing from navigator.audioSession (iOS Safari).
 *  Returns 'unknown' on platforms that don't expose the API. */
function readNow(): Routing {
  if (typeof navigator === 'undefined') return 'unknown';
  const session = (navigator as any).audioSession;
  if (!session) return 'unknown';
  // iOS exposes `type` (the active route type). Empty/undefined means
  // the OS hasn't decided yet (typically before any audio plays);
  // treat that as 'unknown' to avoid false-disable of barge UI.
  const t = String(session.type || '').toLowerCase();
  if (!t) return 'unknown';
  if (t === 'speaker' || t === 'play-and-record') {
    // iOS reports 'play-and-record' for the speakerphone path when no
    // headphones are connected. Both map to "the mic and speaker share
    // the same physical device" → AEC cannot help us in turnbased.
    return 'speaker';
  }
  // headphones, bluetooth, airplay, and any other route are all
  // "isolated" from the perspective of acoustic feedback.
  return 'isolated';
}

/** Subscribe to routing changes. Returns the current value AND fires
 *  the callback on every change. Safe to call before init() runs;
 *  the callback gets the current cached value (initially 'unknown')
 *  and any subsequent updates. */
export function onChange(cb: Listener): () => void {
  init();
  listeners.add(cb);
  try { cb(current); } catch { /* noop */ }
  return () => { listeners.delete(cb); };
}

/** Synchronous read of the most recent routing. */
export function getRouting(): Routing {
  init();
  return current;
}

/** Snapshot of audio-session state for instrumentation. Returns the
 *  full picture (routing + raw audioSession.type/outputType/mode) at
 *  one moment in time. iOS-only fields are null on other platforms.
 *  Used by the Phase-A barge investigation to correlate AEC engagement
 *  with audio-session category transitions. Remove the call sites
 *  once the bug is closed. */
export function audioStateSnapshot(): {
  routing: Routing;
  audioSessionAvailable: boolean;
  audioSessionType: string | null;
  audioSessionOutputType: string | null;
  audioSessionMode: string | null;
} {
  init();
  if (typeof navigator === 'undefined' || !(navigator as any).audioSession) {
    return {
      routing: current,
      audioSessionAvailable: false,
      audioSessionType: null,
      audioSessionOutputType: null,
      audioSessionMode: null,
    };
  }
  const s = (navigator as any).audioSession;
  return {
    routing: current,
    audioSessionAvailable: true,
    audioSessionType: s.type ?? null,
    audioSessionOutputType: s.outputType ?? null,
    audioSessionMode: s.mode ?? null,
  };
}

/** One-shot diag dump — formats the snapshot as a single log line at
 *  a named milestone. Use sparingly; prod calls these checkpoints to
 *  build the timeline of audio-state transitions during call setup.
 *  Uses log() (not console.log) so the line lands in the on-page debug
 *  panel that's reachable from iOS PWA without an inspector. */
export function logAudioState(label: string): void {
  const s = audioStateSnapshot();
  log('[audio-state]',
    `label=${label}`,
    `routing=${s.routing}`,
    `audioSessionAvailable=${s.audioSessionAvailable}`,
    `type=${s.audioSessionType}`,
    `outputType=${s.audioSessionOutputType}`,
    `mode=${s.audioSessionMode}`);
}

/** True only when we have positive confirmation we're on a same-device
 *  speaker setup (iOS reports 'speaker'). 'unknown' returns false —
 *  Mac demos / non-iOS callers default to "barge is allowed." */
export function isOnSpeaker(): boolean {
  return getRouting() === 'speaker';
}

/** Single source of truth for "is barge physically possible right now?"
 *
 *  Returns `{available: boolean, reason: string}`. `available=false`
 *  means the user-facing barge UI (slider, settings) should be hidden
 *  AND the BargeDetector should not be created. `reason` is a short
 *  string usable as a hover tooltip / debug log explaining WHY barge
 *  is unavailable.
 *
 *  Centralized here so every consumer (slider visibility, settings
 *  hint, future tap-to-interrupt fallback decision) reads from the
 *  same function — no two-source-of-truth divergence.
 *
 *  Inputs:
 *    @param mode  'realtime' or 'turnbased' — the active call mode.
 *                 Realtime + WebRTC AEC works on speakers; turnbased
 *                 + speakers does not (no AEC against <audio> output).
 *
 *  Combinations:
 *    realtime + speaker           → available (WebRTC AEC engages)
 *    realtime + headphones/iso    → available
 *    realtime + unknown           → available (assume best, e.g. Mac)
 *    turnbased + speaker          → UNAVAILABLE (acoustic loop kills VAD)
 *    turnbased + headphones/iso   → available
 *    turnbased + unknown          → available (Mac demo case — let
 *                                   the user discover via hint)
 */
export function isBargeAvailable(mode: 'realtime' | 'turnbased'): {
  available: boolean;
  reason: string;
} {
  if (mode === 'realtime') {
    return { available: true, reason: '' };
  }
  // turnbased
  if (isOnSpeaker()) {
    return {
      available: false,
      reason: 'Barge unavailable on built-in speaker (turnbased mode). Use headphones, or switch to Realtime mode.',
    };
  }
  return { available: true, reason: '' };
}

function init(): void {
  if (initialized) return;
  initialized = true;
  current = readNow();
  if (typeof navigator === 'undefined') return;
  const session = (navigator as any).audioSession;
  if (!session) {
    log('[headphones] audioSession API unavailable (non-iOS); routing=unknown');
    return;
  }
  // iOS audioSession dispatches a statechange event when the route
  // flips (e.g. user plugs headphones in mid-call). Re-read + fan out.
  try {
    session.addEventListener?.('statechange', () => {
      const next = readNow();
      if (next === current) return;
      log(`[headphones] routing change: ${current} → ${next}`);
      current = next;
      for (const cb of listeners) {
        try { cb(current); } catch { /* noop */ }
      }
    });
  } catch (e: any) {
    log('[headphones] failed to wire statechange listener:', e?.message);
  }
  log(`[headphones] initial routing=${current}`);
}
