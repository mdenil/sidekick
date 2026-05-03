/**
 * @fileoverview Sendword detector — fires onMatch when the user's mic
 * stream contains the configured commit phrase.
 *
 * Two source modes:
 *
 *   1. EXTERNAL (preferred when caller already runs an STTProvider).
 *      The caller passes `source: STTProvider` — typically the same
 *      `BrowserSttProvider` instance Listen mode uses for body
 *      transcription when `streamingEngine: 'local'`. We subscribe to
 *      its transcript events and run the phrase regex on each interim/
 *      final segment. Single SR session per Listen run, no mic
 *      contention, no second Web Speech instance racing for the same
 *      audio.
 *
 *   2. STANDALONE (back-compat — when no source is given). We construct
 *      our own `webkitSpeechRecognition` / `SpeechRecognition` instance
 *      in continuous + interim mode. This is the original v0.397 path
 *      and is still used when Listen runs against a server-side body
 *      transcription pipeline (`streamingEngine: 'server'`) — the
 *      MediaRecorder blob → /transcribe path doesn't expose realtime
 *      transcript events to subscribe to.
 *
 * Auto-restart loop (standalone path): Safari kills the SR session every
 * ~30s + on every server round trip. The `onend` handler restarts unless
 * stop() was explicitly invoked, so the detector survives long Listen
 * sessions. External path inherits whatever auto-restart logic the
 * source provider implements (BrowserSttProvider has its own).
 *
 * Fail-soft: if `SpeechRecognition` is undefined OR `start()` throws
 * (Firefox without WebSpeech, browser quotas exceeded), the detector
 * silently no-ops in standalone mode. Listen falls back to silence-only
 * via its own timer; this module never throws past start().
 *
 * Phrase matching: caller resolves the phrase via getHandsfreeConfig().
 * Match on word boundary, case-insensitive, end-of-segment. The canonical
 * matcher lives in src/audio/shared/handsfree.ts (matchSendword) — this
 * module just plumbs the audio source.
 */

import { log, diag } from '../../util/log.ts';
import type { STTProvider, TranscriptEvent, Unsubscribe } from '../shared/stt-provider.ts';

export type SendwordOpts = {
  /** Phrase to match on. Empty string disables matching. Caller resolves
   *  the canonical phrase via getHandsfreeConfig(); this module just
   *  looks for whatever string it's given. */
  phrase: string;
  /** Fired when the phrase is detected in an interim or final result.
   *  Caller (listen.ts) should commit the buffered audio blob. */
  onMatch: () => void;
  /** Optional external transcript source. When provided, we subscribe
   *  to its events instead of opening our own SR session — single
   *  source of truth when the caller already runs Web Speech for body
   *  transcription (Listen mode + streamingEngine=local). When omitted,
   *  falls back to the standalone Web Speech path. */
  source?: STTProvider;
};

type SR = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: any) => void) | null;
  onend: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onstart: ((ev: any) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

let sr: SR | null = null;
let opts: SendwordOpts | null = null;
let stopRequested = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
/** Unsubscribe handle when running in EXTERNAL source mode. Calling it
 *  detaches our transcript listener from the caller's STTProvider. The
 *  provider itself is owned by the caller — we don't start/stop it. */
let externalUnsub: Unsubscribe | null = null;

export function isSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  return typeof Ctor === 'function';
}

/** Build a fresh SR instance + wire handlers. Returns null if SR is
 *  unsupported OR construction throws. */
function build(): SR | null {
  if (typeof window === 'undefined') return null;
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (typeof Ctor !== 'function') return null;
  let inst: SR;
  try {
    inst = new Ctor() as SR;
  } catch (e: any) {
    diag('sendword: construct failed', e?.message);
    return null;
  }
  inst.continuous = true;
  inst.interimResults = true;
  inst.lang = 'en-US';
  inst.onresult = handleResult;
  inst.onend = handleEnd;
  inst.onerror = handleError;
  return inst;
}

/** Run the phrase regex against a single transcript string. Shared
 *  between the standalone-SR onresult walker and the external-source
 *  TranscriptEvent listener. Returns true when a match fired (so the
 *  external listener can short-circuit). */
function checkTranscript(transcript: string): boolean {
  if (!opts || !opts.phrase) return false;
  const phrase = opts.phrase.trim().toLowerCase();
  if (!phrase) return false;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Same regex shape as test/commit-word.test.ts — match on word
  // boundary, optional trailing punctuation, anywhere in the segment.
  const re = new RegExp(`\\b${escaped}\\b[\\s.,!?]*$`, 'i');
  if (!transcript) return false;
  if (re.test(transcript)) {
    log(`sendword: matched "${phrase}" in "${transcript}"`);
    try { opts.onMatch(); } catch { /* noop */ }
    return true;
  }
  return false;
}

function handleResult(ev: any): void {
  if (!opts || !opts.phrase) return;
  // Walk the new results in this event (resultIndex .. results.length-1)
  // and check each segment for the phrase.
  try {
    const start = ev.resultIndex || 0;
    for (let i = start; i < ev.results.length; i++) {
      const result = ev.results[i];
      const transcript = String(result?.[0]?.transcript || '');
      if (checkTranscript(transcript)) return;
    }
  } catch (e: any) {
    diag('sendword: handleResult threw', e?.message);
  }
}

function handleEnd(_ev: any): void {
  // Auto-restart loop — Safari kills the session ~30s. Skip if stop()
  // was explicitly requested.
  if (stopRequested) return;
  if (restartTimer) clearTimeout(restartTimer);
  // Tiny delay so we don't tight-loop if the engine itself is in a
  // permanent error state.
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (stopRequested) return;
    sr = build();
    if (!sr) return;
    try { sr.start(); } catch (e: any) { diag('sendword: restart start() threw', e?.message); }
  }, 200);
}

function handleError(ev: any): void {
  diag('sendword: error', ev?.error || ev?.message || ev);
}

/** Begin listening. Two paths:
 *
 *   - EXTERNAL: `o.source` set → subscribe to its onTranscript events.
 *     We don't start the source (caller owns its lifecycle); we just
 *     wire a listener. Returns true unconditionally (the contract is
 *     "events flow when the source is hot" — that's the caller's job).
 *
 *   - STANDALONE: no `o.source` → construct our own SR. Fails soft on
 *     unsupported / construction errors and returns false so the
 *     caller knows to expect no matches.
 */
export function start(o: SendwordOpts): boolean {
  if (sr || externalUnsub) return true;  // already running
  opts = o;
  stopRequested = false;
  if (o.source) {
    // External-source mode: subscribe to the caller's STTProvider.
    // We watch BOTH interim and final segments — same as the standalone
    // path's continuous + interimResults config — so the user doesn't
    // have to wait for an utterance-final to commit on their sendword.
    try {
      externalUnsub = o.source.onTranscript((ev: TranscriptEvent) => {
        // role:'user' only — assistant captions (TTS) shouldn't trigger
        // a sendword match. Empty-text synthetic finals (utterance-end
        // sentinels) carry no transcript content; skip them too.
        if (ev.role !== 'user') return;
        if (!ev.text) return;
        checkTranscript(ev.text);
      });
    } catch (e: any) {
      diag('sendword: source.onTranscript threw', e?.message);
      externalUnsub = null;
      opts = null;
      return false;
    }
    return true;
  }
  // Standalone mode: open our own SR session.
  sr = build();
  if (!sr) return false;
  try {
    sr.start();
  } catch (e: any) {
    diag('sendword: start() threw', e?.message);
    sr = null;
    return false;
  }
  return true;
}

/** Stop + release. Idempotent. Detaches from external source if running
 *  in that mode (does NOT call source.stop() — caller owns its
 *  provider's lifecycle). */
export function stop(): void {
  stopRequested = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (externalUnsub) {
    try { externalUnsub(); } catch { /* noop */ }
    externalUnsub = null;
  }
  if (sr) {
    try { sr.abort(); } catch { /* noop */ }
    sr = null;
  }
  opts = null;
}

/** Update the phrase on the fly without restarting the SR session.
 *  Used when the user changes commitPhrase in settings mid-session. */
export function setPhrase(phrase: string): void {
  if (opts) opts.phrase = phrase;
}
