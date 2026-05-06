# Barge-in

Sidekick lets you interrupt the agent mid-sentence by speaking — same way you'd interrupt a person on a call. This doc covers the user-facing model, the detection algorithm, the tunable knobs, and the file layout for engineers debugging false-fires or missed-fires.

> **Status convention**: the *Current behaviour* table at the bottom is updated as we ship fixes. Defaults change over time; the table is the source of truth. Anything in the body that contradicts the table is stale.

---

## What "barge" does

When the agent is speaking (TTS playback in progress) and you start speaking, sidekick:

1. **Halts the agent's reply** — playback stops, no completion of the current sentence.
2. **Plays a short chime** — audible feedback that the interrupt was registered.
3. **Re-arms for your turn** — your speech is captured as the next user input.

Barge fires once per detected speech onset, then mutes itself for a cooldown window so a single utterance can't trigger 12 fires.

## Two modes

Sidekick has two voice modes; barge works the same way conceptually but routes through different transports:

| Mode | When active | TTS playback | Barge halts via |
|---|---|---|---|
| **Turn-based** | Call button with Realtime toggle OFF | Local `<audio>` element after each agent reply | `cancelReplyTts()` + caller's `onBarge` re-arms the listener |
| **Realtime** | Call button with Realtime toggle ON | Remote audio track over the WebRTC peer | Client sends `{type:'barge'}` over the data channel; bridge calls `tts_track.halt()` |

Both modes use the **same** detector (`src/audio/shared/bargeDetector.ts`) — that's the point of the unified module.

## When barge is NOT available

The detector only arms when these conditions all hold:

- **Headphones (or some isolation)** in turn-based mode. With phone speaker + open mic, speaker-bleed of the agent's own voice would self-trigger barge with no useful signal. Speaker-mode in turn-based **disables** barge entirely. See `src/audio/shared/headphones.ts`.
- **TTS is actually playing** (`isPlayingCb()` returns true). Outside playback there's nothing to interrupt.
- **User toggle is on** (`isEnabledCb()` returns true). Settings → call-mode menu → Barge sensitivity slider; leftmost position = OFF.
- **Past the warmup window** (default 500 ms after TTS starts). Absorbs the worst transient as the platform's AEC locks on.
- **Past the cooldown** (default 2 s after the last fire). Stops "12 fires in 9 seconds" cascades during sustained speech.

Realtime mode bypasses the headphones gate — WebRTC's AEC handles speaker-bleed well enough that barge works on the phone speaker.

## How detection works

The detector reads from the live mic stream every 50 ms and asks one question:

> Is the user speaking *right now*?

Answered by **Silero VAD** (a small ONNX neural net wrapped via [@ricky0123/vad-web](https://github.com/ricky0123/vad-web)). Silero outputs per-frame "speech probability" and emits an `onSpeechStart` callback when probability exceeds a threshold for a minimum duration. The detector fires when Silero says "speech started" AND every gate above passes.

Detection runs **client-side** in both modes. Bridge-side VAD is bypassed via the `client_owns_barge: true` flag in the WebRTC offer.

## Knobs

The user-facing slider in the call-mode chevron menu maps to **Silero `positiveSpeechThreshold`** (0..1). Lower threshold = more sensitive = fires earlier on quieter speech. The slider's leftmost position turns barge OFF entirely (no detector starts).

Per-device floors live in `src/voiceTuning.ts` — different platforms have different baseline noise floors and AEC quality, so the slider's "50%" maps to slightly different absolute thresholds on iOS vs Mac vs Android.

Other knobs (set in `bargeDetector.ts` defaults, override per-call via `BargeDetectorOpts`):

| Knob | Default | Effect |
|---|---|---|
| `warmupMs` | 500 ms | Grace period after TTS starts before the detector arms. Absorbs the start-of-playback transient. |
| `cooldownMs` | 2000 ms | Mute the detector for this long after firing. Prevents repeat-fires from one sustained utterance. |
| `frameMs` | 50 ms | How often the detector polls Silero. Lower = snappier but more CPU. |
| `positiveSpeechThreshold` | 0.5 | Silero confidence above which the frame counts as speech-active. |
| `minSpeechMs` | 400 ms | How long speech must sustain before `onSpeechStart` fires. **Bumped from 150→400 ms (2026-05-05)** to suppress wind/breathing/road-rumble on bike rides. Trade: ~250 ms slower perceived response, false-fires gone. |

The detector itself is initialised via `BargeDetector.start({ micStream, isPlayingCb, isEnabledCb, onFire, ... })`; cleanup is `await det.stop()`. Multiple detectors can coexist (e.g. a realtime call + a Listen session both armed); each holds one ref on the shared `speechVad` module.

## File layout

| File | Owns |
|---|---|
| [`src/audio/shared/bargeDetector.ts`](../src/audio/shared/bargeDetector.ts) | Unified detector — fire condition, warmup/cooldown, lifecycle, fire chime. |
| [`src/audio/shared/speechVad/index.ts`](../src/audio/shared/speechVad/index.ts) | Silero VAD wrapper — MicVAD lifecycle, `isSpeechActive()` readout, refcount. |
| [`src/audio/shared/headphones.ts`](../src/audio/shared/headphones.ts) | SSOT for "is barge physically possible" — checks audio routing on iOS via `navigator.audioSession.type`. |
| [`src/audio/realtime/realtime.ts`](../src/audio/realtime/realtime.ts) | WebRTC offer body, `client_owns_barge` flag, upstream `{type:'barge'}` envelope. |
| [`src/audio/realtime/realtimeBarge.ts`](../src/audio/realtime/realtimeBarge.ts) | Realtime-mode wiring of `BargeDetector` — `isPlayingCb` reads `suppress.isTtsPlaying()`. |
| [`src/audio/realtime/suppress.ts`](../src/audio/realtime/suppress.ts) | Tracks whether agent audio is currently playing (driven by `assistant_delta` events + `listening` envelope from bridge). |
| [`src/audio/turn-based/turnbased.ts`](../src/audio/turn-based/turnbased.ts) | Turn-based wiring of `BargeDetector` — `isPlayingCb` reads Listen state machine. |
| [`src/voiceTuning.ts`](../src/voiceTuning.ts) | Per-device threshold floors. |
| [`src/audio/shared/feedback.ts`](../src/audio/shared/feedback.ts) | The barge fire chime (and other system chimes). |

## Tests

| Test | What it pins |
|---|---|
| [`test/barge-detector.test.ts`](../test/barge-detector.test.ts) | Warmup mute, cooldown enforcement, re-arm on TTS end, multi-detector refcount, exception isolation in `onFire()`. Drives synthetic speech via `setSpeechActiveOverrideForTests`. |
| [`test/speech-vad.test.ts`](../test/speech-vad.test.ts) | MicVAD lifecycle, tuning-knob plumbing, `isSpeechActive` state machine, stream-identity check (one bug-fix anchor per release). |
| [`test/realtime-suppress-tts-playback.test.ts`](../test/realtime-suppress-tts-playback.test.ts) | The `suppress.isTtsPlaying()` state machine that gates realtime barge. |
| `scripts/smoke/realtime-barge-client-side.mjs` | End-to-end: client fires, upstream sends, bridge halts, no bridge-side VAD. |
| `scripts/smoke/turnbased-barge.mjs` | Turn-based fire path. |
| `scripts/smoke/realtime-barge-multi-connect.mjs` | Detector re-arms cleanly across connect/disconnect cycles. |
| `scripts/smoke/realtime-barge-hangup-before-reply.mjs` | Hangup during MicVAD warmup doesn't leak refs. |
| `scripts/smoke/vad-warm-after-prefetch.mjs` + `vad-init-real.mjs` | Silero asset prefetch + first-call latency budgets. |

---

## Current behaviour

This table is updated as we ship fixes. The dates are when each value last changed.

| | Value | Set in | Since |
|---|---|---|---|
| Detection model | Silero VAD only (RMS retired) | `bargeDetector.ts` | 2026-05-04 |
| Warmup window | 500 ms after TTS start | `DEFAULT_WARMUP_MS` | original |
| Post-fire cooldown | 2000 ms | `DEFAULT_COOLDOWN_MS` | original |
| Loop cadence | 50 ms | `DEFAULT_FRAME_MS` | original |
| Silero `positiveSpeechThreshold` | 0.5 (mapped from user slider) | `bargeDetector.ts` | original |
| Silero `minSpeechMs` | 400 ms | `DEFAULT_MIN_SPEECH_MS` | 2026-05-05 (was 150) |
| Silero MicVAD warmup watchdog | 15 s | `speechVad/index.ts` | 2026-05-04 (was 10) |
| Realtime barge ownership | client (offer carries `client_owns_barge: true`) | `realtime.ts` | 2026-05-03 |
| Turn-based + speaker | Barge **disabled** entirely | `headphones.ts` | original |
| Turn-based + headphones | Barge enabled | `headphones.ts` | original |
| Realtime + speaker | Barge enabled (relies on WebRTC AEC) | `realtime.ts` | original |

## Known issues being investigated

- **Self-barge mid-call on mobile, regardless of slider position.** Reproduced on iPhone PWA standalone with the slider at both 90% and 15% — barge fires ~9 s into TTS playback, with VAD flipping from silent to speech as the agent speaks. Indicates the mic stream feeding Silero is hearing the agent's own voice (speaker-bleed not removed by AEC, or AEC not engaged for the path Silero reads from). Slider's lack of effect suggests either the threshold isn't reaching Silero, or the agent's voice exceeds even the highest threshold. Investigation in progress.
- **Silero `MicVAD.new` 15 s timeout on Mac Chrome cold start.** Model fetch hangs; no VAD warm; barge silently disabled for the call. Likely network/cache flakiness on first-call asset load. Separate from the self-barge issue.

(Add new entries here as they surface; remove when fixed and verified.)
