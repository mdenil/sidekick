# Overnight report — 2026-05-02

## tl;dr

- **Per-bubble play UX rewrite (A)** — ported classic's event-emitter pattern to `tts.ts` + new `replyPlayer.ts` subscriber. Loading bar, played-ratio bar, glyph swap, scrub-by-tap-or-drag all work now. The "no pause icon, no green bar, no toggle" report from this morning is fixed — root cause was the shared-global activeReplyId race I described.
- **Mic + Call button split (B)** — subagent landed the design pass cleanly. 9 commits. New `btn-call` (headset icon) on the left of the composer; `btn-mic` keeps its spot. Each has its own chevron menu. Mic owns `streaming` + `autoSend`. Call owns `realtime` + `tts` (speak-replies). Speak-replies is now call-only per your refined answer.
- **All 53 smokes green.** Unit tests still 182/182.
- **SW cache v0.368.** Background-foreground iPhone PWA to pull.

## Commit list (newest first)

```
cb3ace8 fix(smoke): settings-agent-schema — poll the mock for POST landing
5206ec2 fix(smoke): tool-turn-web-search — query state.db directly, not via proxy
9a28241 chore(sw): bump cache to v0.368 + drop micCall from smoke defaults
0881d2f docs(audio/README): update mode matrix to reflect two-button split
0142543 test(smoke): pin call-button-toggle (replaces listen-mode-toggle)
2a38a01 test(smoke): pin dictate cursor-injection round-trip
7159fdd feat(main): gate handleReplyFinal TTS on call-active (speak-replies call-only)
1edf29c refactor(settings): retire micCall, add streaming, migrate hotkeyCallMode
41121e2 feat(main): wire btn-call.onclick + btn-mic dispatch to new handlers
8cc974a test(smoke): add resetServerSettings helper for cross-scenario isolation
8825b81 fix(smoke): tool-turn-web-search — poll state.db for the tool_calls write
b9ca2b9 refactor(main): extract startMicMode + startCallMode handlers
bcbdeb9 feat(composer): add btn-call alongside btn-mic; menus + headset icon
e84497e test(smoke): pin replyPlayer per-bubble UX (post-classic-port)
cd62552 refactor(audio): thin replyNavigator + delegate per-bubble click to replyPlayer
1905e80 feat(audio): port classic replyPlayer.ts as the per-bubble UX subscriber
394c297 refactor(audio): tts.ts gains event emitter + state machine + seekTo/replay
```

## A — per-bubble play UX rewrite

### What I diagnosed
Audio events (`play`, `pause`, `timeupdate`) on the `<audio>` element were being mapped back to the bubble via a shared module-global `activeReplyId`. Required activeReplyId to be set BEFORE every event fired. When `handleReplyFinal` called `playReplyTts()` without passing replyId, every auto-played reply silently broke the entire UX — the audio played, the bubble class never flipped.

The classic pipeline at `08f50ac:src/pipelines/classic/replyPlayer.ts` handled this differently: `tts.ts` emitted typed events with replyId in the payload, and `replyPlayer.ts` subscribed and looked up the bubble by replyId. No shared global, no race.

### What I shipped (4 commits)

1. **`394c297` `tts.ts` event emitter + state machine** — additive. New `on(name, handler)` / `off(name, handler)` / `getState()` / `seekTo(ratio)` / `replay()`. Internal HTMLAudioElement listeners re-emit as typed events: `synth-start`, `load-progress`, `duration-known`, `play-start`, `progress`, `seek`, `paused`, `resumed`, `ended`, `stopped`. State machine is real (`'idle' | 'loading' | 'playing' | 'paused' | 'ended'`) instead of derived from `audio.paused + audio.ended` (which races on natural end).

2. **`1905e80` `replyPlayer.ts` ports classic** — new module, ~315 LOC mirroring the classic shape. Subscribes to the 10 events, owns ALL DOM updates for the per-bubble UX. Click + pointerdown handlers DELEGATED at the transcript element so new bubbles work without per-bubble listener attachment. Scrub-by-tap-or-drag actually works now. Initialized once from `main.ts` at boot.

3. **`cd62552` thin `replyNavigator`** — drops 218 lines (HTMLAudioElement listeners + setBubbleState + clearAllStateClasses + togglePlayback + syncCachedBadges all moved to replyPlayer). Keeps just BT skip-fwd/back navigation (its original purpose). The `currentBubble` pointer now follows playback by subscribing to `tts.play-start`.

4. **`cd62552` (same commit) chat.ts drops per-bubble onclick** — replyPlayer's delegated handler owns clicks. New bubbles inherit the behavior automatically.

5. **`e84497e` smoke pins it** — `replyplayer-bubble-ux.mjs`: asserts /tts POST on click, `.tts-playing` class flip, glyph swap (the icon toggle you reported missing), second-click pause. Closes the smoke gap that let the previous regression in.

### What you should see
- Tap any agent bubble's play button → loading shimmer → green playhead bar → pause glyph swaps in
- Click play again → pauses, play glyph swaps back in
- Click play → resumes
- Click while audio is past the end → restarts from 0
- Tap or drag the bar → scrubs to that position
- BT skip-fwd/back → moves through agent replies in the active chat (per your earlier ask, no skip in realtime call)

## B — mic + call button split

Subagent followed the design pass exactly. 9 commits, each independently green at typecheck + build + tests. Headset icon for btn-call, on the left of the composer per your call. Mic streaming default OFF. Speak-replies call-only.

### Notable from the subagent's report

1. **Cursor-injection wasn't broken**: they wrote the smoke (`dictate-cursor-injection.mjs`) and it passed. The splice + anchor logic in `dictate.ts` is sound when exercised end-to-end. Their hypothesis: any real-world breakage would be in the gesture-site capture path (focus shifts, async race) the smoke doesn't cover. The smoke is the regression catcher going forward — if you see it break in real use, paste a console log and we'll trace it.

2. **`listen-mode-toggle.mjs` deleted** — its functional contract (turn-based Listen via mic button) is obsolete now. `call-button-toggle.mjs` is the new equivalent through the new entry point.

3. **`speak-typed-replies.mjs` rewritten** — previously pinned the now-removed "fire /tts on typed replies if settings.tts=true" behavior. The new test pins the inverse (no auto-fire outside a call). Behavior change per your refined answer.

4. **`migrateMicCallToButtonSplit`** in `settings.ts` — drops `micCall` and `hotkeyCallMode` from the in-memory snapshot; carries `hotkeyCallMode` value into `hotkeyToggleCall`. Idempotent. Server-side yaml cleanup is a follow-up (proxy still ships the legacy keys until then).

## Backlog cleanup

- **`tool-turn-web-search`** (5206ec2) — was failing for a stale reason. The test mapped chat_id → session_id via `/api/sidekick/sessions`, but that endpoint stopped exposing `session_id` (only `chat_id`). State.db has no chat_id column at all. Switched to a direct state.db query (sessions where `started_at >= t0Sec`, source=sidekick). Smokes are sequential, so the most-recent-after-t0 session is ours.
- **`settings-agent-schema`** (cb3ace8) — flake. The test waited on the DOM-value change after `selectOption`, but selectOption sets the DOM synchronously and the POST is async. Now polls the mock for the recorded POST (up to 3s). Stops the full-suite intermittent.
- **`resetServerSettings` helper** (8cc974a) — added to `lib.mjs`. Smokes share the proxy's yaml-backed settings across scenarios; tests can opt into a clean baseline via `resetServerSettings(page, overrides?)`. Additive — no callers yet, available for future tests that depend on specific starting values.
- **Hermes re-emit dupe** — sidekick-side mitigation declined. Content-based dedup is too risky (suppresses legitimate repeats). Memory note already directs investigation upstream.

## Pre-existing notes (still valid, not touched)

- `unused export` in `replyPlayer.ts:syncCachedBadges` — kept for future "mark cached on history-restore" wiring (the classic version had a caller).

## What to test on real device first

1. **Per-bubble play** — tap play on any past reply. You should see:
   - Loading shimmer on the bar
   - Green bar fills as audio plays
   - Glyph swaps from play to pause
   - Click again to pause; click again to resume
   - Drag the bar to scrub
2. **Two-button composer** — headset icon on the left should open a turn-based call (or WebRTC if Realtime is on); mic on the right does memo (or live-cursor dictation if Streaming is on)
3. **Speak-replies call-only** — type a message, observe NO TTS playback. Tap the per-bubble play button to hear the reply. Inside a call, replies still get spoken.
4. **Esc** — ends any active voice mode
5. **BT controls in turn-based call** — pause / skip-fwd / skip-back per replies

## Smoke status

All 53 passing. Run with `npm run smoke`. Per-test ETA in the summary; full suite ~6 minutes.
