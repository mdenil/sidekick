/**
 * @fileoverview Subtle audio feedback sounds — tiny clicks for send/receive.
 *
 * v0.447 (Jonathan, 2026-05-05): switched from live Web Audio oscillators to
 * pre-rendered WAV blobs played via HTMLAudioElement. Reason: chimes that
 * fired while the iOS AVAudioSession category was 'play-and-record' (mic
 * mode) routed to the iPhone speaker, while chimes that fired during TTS
 * playback ('playback' category) routed to BT correctly. Root cause: the
 * shared AudioContext binds to the iOS hardware route AT CREATION TIME —
 * later setSessionType() hints don't migrate existing oscillator
 * destinations. Field-confirmed split: send/commit/start/listening → phone,
 * receive/barge → BT.
 *
 * Fix: HTMLAudioElement.play() inherits whatever AVAudioSession category
 * is current at play() time, identically to TTS (which uses the same
 * mechanism — see tts.ts). Same proven pattern as the silent-keepalive
 * element in ios-specific.ts. One audio mechanism for chimes + TTS +
 * keepalive, no AudioContext-binding-time race.
 *
 * The chime designs (oscillator + gain envelopes) are preserved verbatim;
 * scheduleChime() runs them on an OfflineAudioContext to render PCM, then
 * audioBufferToWav() encodes for HTMLAudioElement consumption. First call
 * per chime pays the render cost (~few ms), subsequent calls reuse the
 * cached blob URL.
 */

import * as settings from '../../settings.ts';

export type ChimeName =
  | 'send' | 'receive' | 'error' | 'start'
  | 'commit' | 'connect' | 'listening' | 'barge';

// Pre-render at scale=4 so el.volume=userVolume reproduces the legacy
// oscillator path's amplitude curve.
const RENDER_SCALE = 4;
const SAMPLE_RATE = 44100;

/** Must cover every osc.stop() in scheduleChime so render doesn't truncate. */
function chimeDuration(name: ChimeName): number {
  switch (name) {
    case 'send':      return 0.10;
    case 'receive':   return 0.12;
    case 'start':     return 0.04;
    case 'commit':    return 0.07;
    case 'connect':   return 0.25;
    case 'listening': return 0.18;
    case 'barge':     return 0.14;
    case 'error':     return 0.36;
  }
}

/**
 * Schedule a chime program on a BaseAudioContext (real or offline) starting
 * at t0. Pure scheduling — no playback semantics. Each chime's design notes
 * live here as the source of truth.
 *
 *   - send:    short rising click, confirms outbound
 *   - receive: soft descending pop, confirms inbound
 *   - error:   two low descending tones — distinct from send/receive so
 *              bike-mode users hear a failure without watching the screen.
 *              Plays at ~1.5x the gain of send/receive because its whole
 *              job is to be noticed over wind/traffic.
 *   - start:   single very short high-pitched tick, ~half the gain of send.
 *              Fires when local audio capture begins (memo or streaming).
 *              Intended as a "seatbelt click": the brain tunes it out as
 *              background, only notices if it's absent — signalling the
 *              mic isn't actually recording.
 *   - commit:  higher rising tick than 'send' — fires the moment the
 *              commit-word ("over") is detected, BEFORE the message is
 *              sent. Pairs with 'send' which fires when the message
 *              actually ships to the backend.
 *   - connect: ascending two-tone chime (C5 → E5) over ~200ms — fires
 *              when a WebRTC peer connection establishes. The two-note
 *              arc reads unmistakably as "circuit closed, channel open".
 *   - listening: subtle two-tone fade-in (~150ms) — "system is ready
 *              for your voice". Sine wave (smoother than triangle) at
 *              low gain so it doesn't compete with the user starting to
 *              speak. Distinct from 'connect' which is louder.
 *   - barge:   single short sine ping (~80ms, ~600Hz) — "I heard you,
 *              stopping". Fires the moment the BargeWindow detector
 *              triggers, BEFORE the upstream halt round-trip.
 */
function scheduleChime(name: ChimeName, ctx: BaseAudioContext, t0: number): void {
  const scale = RENDER_SCALE;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);

  if (name === 'send') {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, t0);
    osc.frequency.linearRampToValueAtTime(1200, t0 + 0.04);
    gain.gain.setValueAtTime(0.08 * scale, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.08);
    osc.start(t0);
    osc.stop(t0 + 0.08);
  } else if (name === 'receive') {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, t0);
    osc.frequency.linearRampToValueAtTime(400, t0 + 0.06);
    gain.gain.setValueAtTime(0.06 * scale, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.10);
    osc.start(t0);
    osc.stop(t0 + 0.10);
  } else if (name === 'start') {
    // Triangle wave carries better over wind than sine; 30ms is below
    // the conscious-attention threshold but clearly audible.
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1000, t0);
    osc.frequency.linearRampToValueAtTime(1200, t0 + 0.02);
    gain.gain.setValueAtTime(0.04 * scale, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.03);
    osc.start(t0);
    osc.stop(t0 + 0.03);
  } else if (name === 'commit') {
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1600, t0);
    osc.frequency.linearRampToValueAtTime(2200, t0 + 0.03);
    gain.gain.setValueAtTime(0.05 * scale, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.05);
    osc.start(t0);
    osc.stop(t0 + 0.05);
  } else if (name === 'connect') {
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(523, t0);
    gain.gain.setValueAtTime(0.09 * scale, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.10);
    osc.start(t0);
    osc.stop(t0 + 0.10);
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.type = 'triangle';
    const t2 = t0 + 0.11;
    osc2.frequency.setValueAtTime(659, t2);
    gain2.gain.setValueAtTime(0.09 * scale, t2);
    gain2.gain.exponentialRampToValueAtTime(0.001, t2 + 0.12);
    osc2.start(t2);
    osc2.stop(t2 + 0.12);
  } else if (name === 'listening') {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, t0);
    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.exponentialRampToValueAtTime(0.05 * scale, t0 + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.07);
    osc.start(t0);
    osc.stop(t0 + 0.07);
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.type = 'sine';
    const t2 = t0 + 0.08;
    osc2.frequency.setValueAtTime(523, t2);
    gain2.gain.setValueAtTime(0.001, t2);
    gain2.gain.exponentialRampToValueAtTime(0.06 * scale, t2 + 0.03);
    gain2.gain.exponentialRampToValueAtTime(0.001, t2 + 0.08);
    osc2.start(t2);
    osc2.stop(t2 + 0.08);
  } else if (name === 'barge') {
    // v0.397 louder + longer (Jonathan field-tested 2026-05-03 — hard to
    // hear over agent TTS at the original 0.06 gain). Sine kept (vs
    // triangle) so it stays non-jangly when it cuts off TTS mid-syllable.
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, t0);
    gain.gain.setValueAtTime(0.18 * scale, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12);
    osc.start(t0);
    osc.stop(t0 + 0.12);
  } else if (name === 'error') {
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(440, t0);
    osc.frequency.linearRampToValueAtTime(330, t0 + 0.12);
    gain.gain.setValueAtTime(0.12 * scale, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.14);
    osc.start(t0);
    osc.stop(t0 + 0.14);
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.type = 'triangle';
    const t2 = t0 + 0.20;
    osc2.frequency.setValueAtTime(330, t2);
    osc2.frequency.linearRampToValueAtTime(260, t2 + 0.12);
    gain2.gain.setValueAtTime(0.12 * scale, t2);
    gain2.gain.exponentialRampToValueAtTime(0.001, t2 + 0.14);
    osc2.start(t2);
    osc2.stop(t2 + 0.14);
  }
}

/** Encode an AudioBuffer as a 16-bit PCM WAV Blob. Mono in, mono out
 *  (offline ctx is created with numberOfChannels=1). Standard RIFF header
 *  followed by interleaved samples. */
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numSamples = buffer.length;
  const bytesPerSample = 2;
  const dataSize = numSamples * numChannels * bytesPerSample;
  const arrBuf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrBuf);
  const writeStr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let c = 0; c < numChannels; c++) {
      const ch = buffer.getChannelData(c);
      let s = Math.max(-1, Math.min(1, ch[i]));
      s = s < 0 ? s * 0x8000 : s * 0x7FFF;
      view.setInt16(offset, s | 0, true);
      offset += 2;
    }
  }
  return new Blob([arrBuf], { type: 'audio/wav' });
}

const players = new Map<ChimeName, HTMLAudioElement>();
const renderPromises = new Map<ChimeName, Promise<HTMLAudioElement>>();

async function renderPlayer(name: ChimeName): Promise<HTMLAudioElement> {
  const dur = chimeDuration(name);
  const Ctx = (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
  const offline: OfflineAudioContext = new Ctx(1, Math.ceil(SAMPLE_RATE * dur), SAMPLE_RATE);
  scheduleChime(name, offline, 0);
  const buffer = await offline.startRendering();
  const blob = audioBufferToWav(buffer);
  const el = new Audio(URL.createObjectURL(blob));
  el.preload = 'auto';
  return el;
}

async function getPlayer(name: ChimeName): Promise<HTMLAudioElement> {
  const existing = players.get(name);
  if (existing) return existing;
  const inflight = renderPromises.get(name);
  if (inflight) return inflight;
  const p = renderPlayer(name);
  renderPromises.set(name, p);
  try {
    const el = await p;
    players.set(name, el);
    return el;
  } finally {
    renderPromises.delete(name);
  }
}

/**
 * Play a short feedback chime. See scheduleChime() for design notes per
 * chime. Cached per name — first call renders, subsequent calls reuse.
 *
 * Why HTMLAudioElement instead of Web Audio: the chime needs to inherit
 * the current iOS AVAudioSession category at play() time, so it routes
 * through the same speaker as TTS (BT when 'playback', phone earpiece
 * when 'play-and-record'). Web Audio binds the route at AudioContext
 * creation time and the route doesn't migrate when the category hint
 * changes — that was the v0.446-and-prior bug where some chimes routed
 * to phone and others to BT.
 */
export function playFeedback(name: ChimeName): void {
  // Test instrumentation hook — Playwright smokes use this to assert
  // chime invariants ("'send' fires exactly once per assistant turn", etc.)
  // without needing to actually decode audio. Production never sees it.
  try {
    const w = (typeof window !== 'undefined') ? window : null;
    const log = w && (w as any).__TEST_FEEDBACK_LOG__;
    if (Array.isArray(log)) log.push({ type: name, t: Date.now() });
  } catch { /* best-effort */ }

  const volume = settings.get().audioFeedbackVolume ?? 0.5;
  if (volume <= 0) return;
  const userVolume = Math.max(0, Math.min(1, volume));

  // Fire-and-forget. First-call render is async; subsequent calls resolve
  // synchronously off the cache. Errors swallowed (chime failure must
  // never throw upward into the app's hot path).
  void (async () => {
    try {
      const el = await getPlayer(name);
      el.volume = userVolume;
      try { el.currentTime = 0; } catch { /* ignore — element may still be loading */ }
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => { /* ignore play rejection */ });
    } catch { /* ignore render/play failures */ }
  })();
}
