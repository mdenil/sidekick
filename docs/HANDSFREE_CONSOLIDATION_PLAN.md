# Handsfree consolidation — follow-up to the audio refactor

Both voice modes have parallel implementations of the same handsfree
mechanisms (silence-timeout commit, sendword commit, barge-in). This
plan extracts the shared policy into `src/audio/shared/` so both modes
call the same code.

Depends on: the audio refactor file moves landing first
(`src/audio/{shared,turn-based,realtime}/` exist).

## Today's duplication

### Sendword phrase matching

| | Realtime (`dictation.ts`) | Turn-based (`sendwordDetector.ts`) |
|---|---|---|
| Speech source | `is_final` text from bridge over data channel | Web Speech API on local mic |
| Phrase regex | `^(.*)\s*\b${phrase}\b[\s.,!?]*$` (captures prefix) | `\b${phrase}\b[\s.,!?]*$` (no capture) |
| Settings key | `commitPhrase` | `listenSendword || commitPhrase` |
| Action on match | strip phrase, dispatch buffered text | fire `onMatch` callback (caller commits blob) |

The regexes are virtually identical — one captures the prefix, the other doesn't. Same semantics.

### Silence timeout

| | Realtime (`dictation.ts`) | Turn-based (`listen.ts`) |
|---|---|---|
| Speech detection | discrete `is_final` events from bridge | analyser-frame peak loop @ 50ms |
| Timer mechanism | `setTimeout(silenceSec)` reset on each `is_final` | tracks `lastVoiceAt`, dispatches when `now - lastVoiceAt > silenceSec` |
| Settings key | `silenceSec` | `listenSilenceSec` |

These differ for legitimate reason: realtime gets discrete text events, turn-based gets continuous audio. Different mechanisms, same intent. **Mechanism stays per-mode; the trigger threshold + policy unifies.**

### Barge-in

| | Realtime (Python bridge) | Turn-based (`listen.ts:tickBarge`) |
|---|---|---|
| Algorithm | sliding window of N peak readings ≥ K above threshold | identical |
| Window size | 5 frames | 5 frames |
| Required hot | 4 | 4 |
| Warmup mute | 500ms | 500ms |
| Threshold | `barge_threshold` (sent in offer payload) | `settings.bargeThreshold` (live) |

PWA-side, only `listen.ts` runs this. The bridge-side is Python and won't be sharing TS code. **Consolidation here is PWA-side only**, in case future modes (e.g. a duplex frontend that gets local-mic peaks) want to reuse it.

## Target shape

### `src/audio/shared/handsfree.ts` (new)

```ts
/** Phrase matcher — returns `{ matched: false }` if the phrase is
 *  empty, not present, or not anchored at end. Otherwise returns
 *  `{ matched: true, cleaned: string }` where `cleaned` is the input
 *  with the phrase + trailing punctuation stripped. */
export function matchSendword(
  text: string,
  phrase: string,
): { matched: false } | { matched: true; cleaned: string };

/** Silence-timer state. Caller drives via `noteVoice()` on detected
 *  speech; check `expired()` periodically (or on each `is_final`).
 *  Encapsulates the lastVoiceAt clock + threshold reading.
 *
 *  Mode-specific code still owns the loop / timer mechanism — this
 *  is just the policy holder. */
export class SilenceWindow {
  constructor(silenceSec: number);
  noteVoice(now?: number): void;
  reset(): void;
  expired(now?: number): boolean;
  msSinceVoice(now?: number): number;
}

/** Resolve the canonical handsfree config from settings, applying
 *  legacy-key fallbacks (listenSilenceSec → silenceSec, listenSendword
 *  → commitPhrase). Single point of truth — call from both modes. */
export function getHandsfreeConfig(): {
  silenceSec: number;
  sendwordPhrase: string;
};
```

### `src/audio/shared/barge.ts` (new — small)

```ts
/** N-of-K hot-frame detector. Caller pushes peak readings; `hot()`
 *  returns true when ≥ requiredHot of the last windowSize readings
 *  exceeded `threshold`. Resets on `clear()`. */
export class BargeWindow {
  constructor(opts: { windowSize?: number; requiredHot?: number });
  push(peak: number, threshold: number): boolean; // true = barge fired
  clear(): void;
}
```

### Settings-key consolidation

`silenceSec` + `commitPhrase` become canonical. `listenSilenceSec` + `listenSendword` are migrated on settings load:

```ts
// In settings.ts init or migration step
const s = readFromLocalStorage();
if (typeof s.listenSilenceSec === 'number' && !('silenceSec' in s)) {
  s.silenceSec = s.listenSilenceSec;
}
if (typeof s.listenSendword === 'string' && !('commitPhrase' in s)) {
  s.commitPhrase = s.listenSendword;
}
delete s.listenSilenceSec;
delete s.listenSendword;
```

One-time write-back so the migration runs once per device.

The settings UI panel collapses two rows into one (Listen → Handsfree section).

## Commit sequence

Per the structural-vs-feature split rule:

1. **`refactor(audio): extract shared/handsfree.ts + shared/barge.ts (no callers yet)`** — pure additive, the new modules aren't wired in. Includes a small unit test suite for `matchSendword` + `SilenceWindow` + `BargeWindow`.

2. **`refactor(audio): turn-based mode adopts shared/handsfree.ts`** — `listen.ts` calls `matchSendword` + uses `SilenceWindow`; `sendwordDetector.ts` simplifies to "Web Speech API → text → caller decides", no more phrase regex inside.

3. **`refactor(audio): realtime mode adopts shared/handsfree.ts`** — `dictation.ts` calls `matchSendword` + uses `SilenceWindow`. The local regex + setTimeout vanish.

4. **`refactor(audio): turn-based barge uses shared/barge.ts`** — `listen.ts:tickBarge` becomes `bargeWindow.push(peak, threshold)`.

5. **`refactor(settings): consolidate handsfree settings keys`** — migration code + UI panel collapse + delete legacy keys.

Each commit independently passes typecheck + build + unit tests. Smoke run at the end of the sequence.

## What stays per-mode

- The **mechanism** for detecting speech: turn-based uses analyser peaks @ 50ms, realtime uses bridge `is_final` events. Different inputs.
- The **mechanism** for getting sendword text: turn-based uses Web Speech API on local mic, realtime uses bridge transcripts. Different inputs.
- The **dispatch action**: turn-based POSTs a blob to `/transcribe`; realtime calls `connection.dispatch(text)` over the data channel. Different outputs.

Only the **policy** (regex, threshold, window) is shared — same in both, today, and going forward.

## Out of scope

- Bridge-side (Python) consolidation. The bridge owns its own barge / VAD; that's a separate refactor in `audio-bridge/`.
- Any change to TTS playback paths.
- Any change to the audio mode-selection logic in `main.ts` (separate Phase-3 commit of the audio refactor).

## Verification

- Unit tests for the three exported helpers (matchSendword, SilenceWindow, BargeWindow). Covers the regex edge cases that already live in `test/commit-word.test.ts` (move/extend that file).
- After each commit: typecheck + build + unit tests green.
- After all commits: full smoke run. Specifically watch the listen-* + barge-related smokes; if they fail in new ways the consolidation broke a semantic.
- Manual test on real device: speak "hello world over" → commits with "hello world" (sendword stripped). Speak "hello world", pause 2s → commits "hello world" (silence). Both modes.
