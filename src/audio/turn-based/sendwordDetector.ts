/**
 * @fileoverview Sendword detector — wraps Web Speech API
 * (`webkitSpeechRecognition` / `SpeechRecognition`) in continuous +
 * interim mode and fires onMatch when an utterance contains the
 * configured commit phrase.
 *
 * Auto-restart loop: Safari kills the SR session every ~30s + on every
 * server round trip. The `onend` handler restarts unless stop() was
 * explicitly invoked, so the detector survives long Listen sessions.
 *
 * Fail-soft: if `SpeechRecognition` is undefined OR `start()` throws
 * (Firefox without WebSpeech, browser quotas exceeded), the detector
 * silently no-ops. Listen falls back to silence-only via its own
 * timer; this module never throws past start().
 *
 * Phrase matching: caller resolves the phrase via getHandsfreeConfig().
 * Match on word boundary, case-insensitive, end-of-segment. The canonical
 * matcher lives in src/audio/shared/handsfree.ts (matchSendword) — this
 * module just plumbs the audio source.
 */

import { log, diag } from '../../util/log.ts';

export type SendwordOpts = {
  /** Phrase to match on. Empty string disables matching. Caller resolves
   *  the canonical phrase via getHandsfreeConfig(); this module just
   *  looks for whatever string it's given. */
  phrase: string;
  /** Fired when the phrase is detected in an interim or final result.
   *  Caller (listen.ts) should commit the buffered audio blob. */
  onMatch: () => void;
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

function handleResult(ev: any): void {
  if (!opts || !opts.phrase) return;
  // Walk the new results in this event (resultIndex .. results.length-1)
  // and check each segment for the phrase.
  try {
    const phrase = opts.phrase.trim().toLowerCase();
    if (!phrase) return;
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Same regex shape as test/commit-word.test.ts — match on word
    // boundary, optional trailing punctuation, anywhere in the segment.
    const re = new RegExp(`\\b${escaped}\\b[\\s.,!?]*$`, 'i');
    const start = ev.resultIndex || 0;
    for (let i = start; i < ev.results.length; i++) {
      const result = ev.results[i];
      const transcript = String(result?.[0]?.transcript || '');
      if (!transcript) continue;
      if (re.test(transcript)) {
        log(`sendword: matched "${phrase}" in "${transcript}"`);
        try { opts.onMatch(); } catch { /* noop */ }
        return;
      }
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

/** Begin listening. Fails soft on unsupported / construction errors —
 *  returns false so the caller knows to expect no matches. */
export function start(o: SendwordOpts): boolean {
  if (sr) return true;  // already running
  opts = o;
  stopRequested = false;
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

/** Stop + release. Idempotent. */
export function stop(): void {
  stopRequested = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
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
