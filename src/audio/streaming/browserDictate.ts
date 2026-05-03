/**
 * @fileoverview Browser-local STT provider — Web Speech API
 * (`SpeechRecognition`) wrapped in the vendor-neutral `STTProvider`
 * interface so it drops into `dictate.ts` as an alternative to the
 * WebRTC bridge with zero state-machine duplication.
 *
 * This is the "ship without backend audio" path: when no audio bridge
 * is reachable (or the user explicitly chose `streamingEngine: 'local'`)
 * the realtime+talkonly mode (mic-tap dictation) keeps working entirely
 * in-browser. The realtime+speak mode (headset call with TTS over
 * WebRTC) DOES disappear in this configuration — UI hides btn-call.
 *
 * Why an STTProvider (not a parallel `start/stop/setStateListener`
 * module that mirrors dictate.ts internals): dictate.ts owns the
 * cursor-aware splice state machine — anchor capture, interim replace,
 * content-final bake, utterance-end trailing-space, user-edit reset.
 * That logic is non-trivial and deeply tested. Mirroring it would
 * fork the implementation and guarantee divergence the moment a
 * Deepgram-style edge-case fix lands on one side. Instead we slot in
 * here at the transcript-events layer and let dictate.ts do its thing.
 *
 * ── Web Speech mapping ────────────────────────────────────────────────
 *
 * Browser SpeechRecognition emits a different event shape than the
 * audio bridge's data-channel envelope. The mapping:
 *
 *   - `onresult` event with `results[i].isFinal === false`
 *       → TranscriptEvent { is_final: false, role: 'user', text: <transcript> }
 *
 *   - `onresult` event with `results[i].isFinal === true`
 *       → TranscriptEvent { is_final: true, role: 'user', text: <transcript> }
 *
 *   - `onend` (no UtteranceEnd analogue in Web Speech) — we DO emit a
 *     synthetic `is_final: true` empty-text event so dictate.ts's
 *     handleUtteranceEnd path closes out the utterance (trailing-space
 *     etc). Skipped if we just emitted a content-final from the same
 *     onresult batch — avoids double-end.
 *
 *   - `onerror` — emit state-listener error, then attempt restart if
 *     the error is recoverable (no-speech, network, audio-capture).
 *     Permanent errors (not-allowed, service-not-allowed) bail out.
 *
 * ── iOS Safari gotchas (documented from sendwordDetector.ts + this work) ──
 *
 *   - Web Speech is NOT available in PWAs installed to the home
 *     screen on older iOS versions; check `isSupported()` and surface
 *     a user-visible error if false.
 *   - Safari kills the SR session every ~30s. Auto-restart on `onend`
 *     unless stop() was explicitly called — same approach as
 *     sendwordDetector.ts.
 *   - `interimResults` works on iOS 14.5+; on older versions only finals
 *     arrive. Dictation still functions — the live caption just doesn't
 *     update as smoothly.
 *   - Mic permission prompt fires the FIRST time start() runs. Wrap
 *     the user gesture (mic-button pointerdown) so the prompt isn't
 *     blocked by the autoplay policy.
 *
 * ── Vendor prefix handling ────────────────────────────────────────────
 *
 * Both `SpeechRecognition` and `webkitSpeechRecognition` are checked.
 * Safari + iOS use the prefixed form; Chrome/Edge expose both; Firefox
 * exposes neither (Web Speech in Firefox requires a flag, which our
 * users won't have). isSupported() returns true if either constructor
 * is callable.
 */

import type { STTProvider, TranscriptEvent, Unsubscribe } from '../shared/stt-provider.ts';
import { log, diag } from '../../util/log.ts';

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

/** True if the runtime exposes a `SpeechRecognition` constructor. Browser
 *  matrix: Chrome/Edge yes, Safari/iOS yes (webkit prefix), Firefox no. */
export function isSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  return typeof Ctor === 'function';
}

/** Browser-local STT provider. Constructs a fresh SpeechRecognition
 *  per `start()` so a `stop()` / `start()` cycle starts cleanly (some
 *  browsers retain stale state on the same instance). */
export class BrowserSTTProvider implements STTProvider {
  private sr: SR | null = null;
  private listener: ((ev: TranscriptEvent) => void) | null = null;
  private stopRequested = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** True after the most recent onresult emitted a content-final — gates
   *  whether `onend` should also fire a synthetic utterance-end. */
  private justEmittedFinal = false;

  /** Begin recognition. Throws if Web Speech is unsupported (caller —
   *  typically dictate.ts via a provider injection — surfaces this to
   *  the user via the state listener's `error` arg). */
  async start(_opts?: { sessionId?: string | null; chatId?: string | null }): Promise<void> {
    if (this.sr) return;  // already running
    if (!isSupported()) {
      throw new Error('Browser speech recognition not supported');
    }
    this.stopRequested = false;
    this.justEmittedFinal = false;
    this.sr = this.build();
    if (!this.sr) {
      throw new Error('Failed to construct SpeechRecognition');
    }
    try {
      this.sr.start();
    } catch (e: any) {
      this.sr = null;
      throw new Error(`SpeechRecognition.start() threw: ${e?.message || e}`);
    }
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.sr) {
      try { this.sr.abort(); } catch { /* noop */ }
      this.sr = null;
    }
  }

  onTranscript(cb: (ev: TranscriptEvent) => void): Unsubscribe {
    this.listener = cb;
    return () => { if (this.listener === cb) this.listener = null; };
  }

  /** Construct + wire a fresh SR. Returns null if construction throws. */
  private build(): SR | null {
    if (typeof window === 'undefined') return null;
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (typeof Ctor !== 'function') return null;
    let inst: SR;
    try {
      inst = new Ctor() as SR;
    } catch (e: any) {
      diag('[browser-stt] construct failed', e?.message);
      return null;
    }
    // Continuous: stay listening across utterances (matches the realtime
    // path). interimResults: emit grey-text live caption — dictate.ts's
    // splice machine relies on these for the "cursor follows what I'm
    // saying" UX.
    inst.continuous = true;
    inst.interimResults = true;
    inst.lang = 'en-US';
    inst.onresult = (ev) => this.handleResult(ev);
    inst.onend = () => this.handleEnd();
    inst.onerror = (ev) => this.handleError(ev);
    return inst;
  }

  private handleResult(ev: any): void {
    if (!this.listener) return;
    try {
      const start = ev.resultIndex || 0;
      let lastWasFinal = false;
      for (let i = start; i < ev.results.length; i++) {
        const result = ev.results[i];
        const transcript = String(result?.[0]?.transcript || '').trim();
        if (!transcript) continue;
        const isFinal = !!result.isFinal;
        this.listener({
          type: 'transcript',
          text: transcript,
          is_final: isFinal,
          role: 'user',
        });
        lastWasFinal = isFinal;
      }
      this.justEmittedFinal = lastWasFinal;
    } catch (e: any) {
      diag('[browser-stt] handleResult threw', e?.message);
    }
  }

  private handleEnd(): void {
    // Web Speech doesn't have a UtteranceEnd analogue, but dictate.ts
    // expects an `is_final: true, text: ''` event to close the
    // utterance (trailing space, advance cursor). Synthesize one
    // unless the most recent onresult batch already ended on a final
    // (which dictate.ts treats as a content-final + same-utterance
    // continuation — consistent with Deepgram).
    if (this.listener && this.justEmittedFinal) {
      // The last is_final=true was a content-final; dictate.ts is
      // sitting in "more to come" mode. Send the synthetic empty-text
      // final to tell it the utterance is over.
      try {
        this.listener({ type: 'transcript', text: '', is_final: true, role: 'user' });
      } catch { /* noop */ }
    }
    this.justEmittedFinal = false;

    // Auto-restart loop: Safari kills the session ~30s. Skip if
    // stop() was explicitly invoked. Bounded delay so a permanent
    // error doesn't tight-loop us.
    if (this.stopRequested) return;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopRequested) return;
      this.sr = this.build();
      if (!this.sr) return;
      try {
        this.sr.start();
      } catch (e: any) {
        diag('[browser-stt] restart start() threw', e?.message);
      }
    }, 200);
  }

  private handleError(ev: any): void {
    const code = String(ev?.error || '');
    diag('[browser-stt] error', code, ev?.message);
    // Permanent errors — don't auto-restart.
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      this.stopRequested = true;
    }
    // Recoverable errors (no-speech, network, audio-capture, aborted)
    // ride the onend path's restart loop. Nothing else to do here.
  }
}

/** Default provider instance — keeps the constructor noise out of
 *  callers that don't need to wire test doubles. */
export const defaultBrowserSTTProvider = new BrowserSTTProvider();

// ── Engine selector ──────────────────────────────────────────────────
//
// Centralised so mode entry points (main.ts startDictate, hotkey
// handler, etc.) can resolve the active STT provider without each
// re-importing settings + both providers. Returns the WebRTC default
// when streamingEngine is 'server' (or unset), the browser default
// when 'local'.
//
// Lives here rather than in dictate.ts because dictate.ts is the
// CONSUMER of providers — it shouldn't know about the engine-selection
// policy. controls.ts is too WebRTC-specific. This module owns the
// browser leg and is a natural home for the policy.

import * as settings from '../../settings.ts';
import { defaultWebRTCSTTProvider } from '../realtime/realtime.ts';

/** Resolve the STT provider per the user's `streamingEngine` setting.
 *  Pass the result into `dictate.start({ provider: pickStreamingProvider() })`. */
export function pickStreamingProvider(): STTProvider {
  return settings.get().streamingEngine === 'local'
    ? defaultBrowserSTTProvider
    : defaultWebRTCSTTProvider;
}
