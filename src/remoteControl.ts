/**
 * @fileoverview Lockscreen / BT-headset remote-control receiver.
 *
 * Two surfaces feed the same dispatcher:
 *
 *   1. Cap (iOS native): AppDelegate.swift's CallControls
 *      MPRemoteCommandCenter callbacks fire
 *      `window.dispatchEvent(new CustomEvent('sidekick:remote-control', ...))`
 *      via webView.evaluateJavaScript. Bluetooth headset transport
 *      buttons (play/pause/skip on AirPods, etc.) route through
 *      MPRemoteCommandCenter on iOS, so they hit this path too.
 *
 *   2. PWA (Safari standalone): the Media Session API
 *      (`navigator.mediaSession.setActionHandler`) surfaces the same
 *      kind of controls on iOS lockscreen + Control Center for any
 *      page that is actively playing audio. Less powerful than the
 *      Cap surface but covers the major use case.
 *
 * Both surfaces feed `dispatch()` which interprets the action against
 * current app state (call open? TTS playing?).
 *
 * Action semantics:
 *   - 'stop'              → end the active call if any, else cancel
 *                           any in-flight TTS reply playback.
 *   - 'pause'             → pause active TTS reply.
 *   - 'play'              → resume paused TTS reply.
 *   - 'togglePlayPause'   → if TTS playing, pause; if paused, resume;
 *                           if idle, no-op (lockscreen affordances
 *                           need a "current track" to act on, and a
 *                           silent fallback is less surprising than
 *                           accidentally starting playback).
 */

import { log } from './util/log.ts';
import * as ttsModule from './audio/turn-based/tts.ts';
import * as webrtcControls from './audio/realtime/controls.ts';
import * as conn from './audio/realtime/realtime.ts';
import * as suppress from './audio/realtime/suppress.ts';

type RemoteAction = 'play' | 'pause' | 'togglePlayPause' | 'stop' | 'volume-button';

function dispatch(action: RemoteAction | string): void {
  log(`[remote-control] action=${action}`);
  if (action === 'stop') {
    if (webrtcControls.isOpen()) {
      void webrtcControls.closeIfOpen();
      return;
    }
    try { ttsModule.cancelReplyTts('user-stop'); } catch { /* noop */ }
    return;
  }
  if (action === 'volume-button') {
    // Cap-only path: hardware volume buttons fire this when pressed.
    // Use as barge in talk-mode calls (interrupt agent TTS); ignore
    // outside calls or in stream mode (volume just changes normally).
    // Note: we don't suppress the volume change itself in v1 — that's
    // a known trade-off documented in WebViewDelegate.swift.
    if (!webrtcControls.isOpen() || webrtcControls.currentMode() !== 'talk') {
      log('[remote-control] volume-button ignored — no talk-mode call open');
      return;
    }
    log('[remote-control] volume-button → manual barge');
    try { conn.sendBarge(); } catch { /* noop */ }
    try { conn.cancelRemotePlayback(); } catch { /* noop */ }
    try { suppress.onBarge(); } catch { /* noop */ }
    return;
  }
  const ttsState = ttsModule.getState();
  if (action === 'pause' || (action === 'togglePlayPause' && ttsState === 'playing')) {
    try { ttsModule.pauseReplyTts(); } catch { /* noop */ }
    return;
  }
  if (action === 'play' || (action === 'togglePlayPause' && ttsState === 'paused')) {
    void ttsModule.resumeReplyTts();
    return;
  }
  // togglePlayPause when nothing's playing: no-op. iOS still shows the
  // play button on lockscreen because we register the handler, but
  // tapping it from a quiet state shouldn't surprise-auto-start audio.
  log(`[remote-control] action=${action} ignored — ttsState=${ttsState} callOpen=${webrtcControls.isOpen()}`);
}

let installed = false;

export function init(): void {
  if (installed) return;
  installed = true;

  // Cap surface — AppDelegate posts these.
  window.addEventListener('sidekick:remote-control', (e: Event) => {
    const ce = e as CustomEvent<{ action?: string }>;
    const action = ce.detail?.action;
    if (action) dispatch(action);
  });

  // PWA surface — Media Session API. Available in modern Safari /
  // Chrome / Edge. Wrapped in try/catch because the API throws if a
  // particular action isn't supported (rare but defensive).
  if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
    const ms: MediaSession = (navigator as any).mediaSession;
    const safeSet = (a: MediaSessionAction, fn: () => void): void => {
      try { ms.setActionHandler(a, fn); }
      catch (e: any) { log(`[remote-control] mediaSession.setActionHandler('${a}') failed: ${e?.message || e}`); }
    };
    safeSet('play', () => dispatch('play'));
    safeSet('pause', () => dispatch('pause'));
    safeSet('stop', () => dispatch('stop'));
    // 'play' + 'pause' together cover togglePlayPause for Media Session;
    // there's no separate 'togglePlayPause' action in the web spec.
  }

  log('[remote-control] installed');
}
