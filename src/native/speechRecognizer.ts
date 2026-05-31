/**
 * @fileoverview Native iOS speech-recognition bridge for the send word.
 *
 * On Capacitor/iOS the standalone Web Speech `SpeechRecognition` session
 * that sendwordDetector opens is gated by WKWebView — it errors with
 * `service-not-allowed`, never matches, and Listen falls back to silence-
 * only commit (field bug 2026-05-10). This module talks to the native
 * `SpeechRecognizer` Capacitor plugin (SFSpeechRecognizer) instead, re-
 * emitting its partial results as STTProvider TranscriptEvents so the
 * detector's existing FED path (feedTranscript) consumes them unchanged.
 *
 * Runtime access is via the injected `window.Capacitor.Plugins` global
 * rather than an `@capacitor/core` import: the build (scripts/build.mjs)
 * does NOT bundle, so a bare module specifier wouldn't resolve in the
 * WebView. Capacitor auto-exposes registered native plugins under
 * `window.Capacitor.Plugins.<jsName>`.
 *
 * Web / PWA: no native plugin → `isAvailable()` is false and callers keep
 * using the Web Speech path.
 */
import { diag } from '../util/log.ts';
import type { TranscriptEvent } from '../audio/shared/stt-provider.ts';

type PluginListenerHandle = { remove: () => void | Promise<void> };

type NativePlugin = {
  available(): Promise<{ available: boolean }>;
  requestPermission(): Promise<{ granted: boolean }>;
  start(opts: { partialResults: boolean; lang: string }): Promise<void>;
  stop(): Promise<void>;
  addListener(event: string, cb: (data: any) => void): Promise<PluginListenerHandle>;
};

function plugin(): NativePlugin | null {
  const cap = (typeof window !== 'undefined') ? (window as any).Capacitor : undefined;
  if (!cap) return null;
  // Only the native iOS build ships the SpeechRecognizer plugin.
  const isNative = typeof cap.isNativePlatform === 'function' ? cap.isNativePlatform() : false;
  if (!isNative) return null;
  return (cap.Plugins?.SpeechRecognizer as NativePlugin) ?? null;
}

/** True when the native SpeechRecognizer plugin is present (CAP/iOS). */
export function isAvailable(): boolean {
  return plugin() !== null;
}

/**
 * Start native recognition and forward each result to `onTranscript` as a
 * user TranscriptEvent. Resolves with a stop handle. Rejects if the plugin
 * is unavailable, reports no recognizer, or permission is denied — the
 * caller should then degrade to silence-only (the current CAP fallback).
 */
export async function start(onTranscript: (ev: TranscriptEvent) => void): Promise<() => void> {
  const p = plugin();
  if (!p) throw new Error('native SpeechRecognizer unavailable');

  const avail = await p.available();
  if (!avail?.available) throw new Error('native speech recognition not available on this device');

  const perm = await p.requestPermission();
  if (!perm?.granted) throw new Error('speech recognition permission denied');

  const handle = await p.addListener('partialResult', (data: any) => {
    const text = String(data?.transcript ?? '');
    if (!text) return;
    onTranscript({
      type: 'transcript',
      role: 'user',
      text,
      is_final: !!data?.isFinal,
    });
  });

  await p.start({ partialResults: true, lang: 'en-US' });
  diag('[native-speech] started');

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    try { void handle?.remove(); } catch { /* noop */ }
    void p.stop().catch(() => { /* noop */ });
    diag('[native-speech] stopped');
  };
}
