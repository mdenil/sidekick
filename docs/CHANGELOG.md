# Sidekick — Changelog

We don't cut formal versioned releases yet (the only version marker is
`CACHE_NAME` in `sw.js`, currently **v0.565**). This is a feature-level
digest of the work since the start of **May 2026**, distilled from
~600 commits on `master`. Granularity is deliberately coarse — grouped
by theme, not by commit.

> **If you're upgrading, read [Heads-up by person](#heads-up-by-person)
> at the bottom first** — it tells you what actually matters for your
> setup and what (if anything) you need to do.

---

## May 2026 — highlights

### Voice & audio (the big one)

A near-complete rebuild of the voice stack, split into two modes that
share one detector:

- **Turn-based "Listen" mode** — tap-to-dictate / hold-to-PTT mic
  button, capture-honest waveform, silence-triggered hands-free mode,
  send-word detection (say a trigger word to send), and an Esc-ends-any-
  voice-mode escape hatch.
- **Realtime "Call" mode** — WebRTC live calls via a dedicated call
  button, with lockscreen / Bluetooth-headset remote control
  (Media Session API), hardware volume buttons mapped to barge, and
  **network-drop resilience** (drop chime + soft auto-reconnect).
- **Per-bubble TTS playback** — every agent reply gets play/pause,
  per-reply replay chips, next/prev navigation, and an LRU reply cache
  for instant replay.

### Barge-in (interrupt the agent by speaking)

Built up over the month and then hardened at the end:

- Unified `BargeDetector` with a **pluggable `VadSource`** — the same
  Silero VAD model can run client-side (in the browser) or on the
  audio-bridge, behind one interface.
- **Realtime now prefers server-side VAD** with a transparent
  **client-side fallback**: at call start the client asks the bridge
  "do you have VAD?" (`barge-vad-query` → `barge-vad` handshake); if the
  bridge has no VAD installed or doesn't answer, it silently falls back
  to in-browser Silero. So barge works regardless of how the bridge is
  provisioned.
- **Server VAD is now onnxruntime-only by default** (a vendored ~2 MB
  `silero_vad.onnx`, CPU). **No torch, no CUDA.** The torch/silero-vad
  backend is still supported but optional. This fixes the "the installer
  pulled in all of CUDA / torch is huge" problem.
- Per-device tuning (iOS AEC warmup prepad, threshold floors on speaker
  routes), a barge fire chime for instant feedback, and a user
  sensitivity slider.
- `install.sh` now provisions the audio-bridge venv automatically
  (python3-gated, non-fatal — falls back to client-side VAD if absent).

See [`docs/BARGE.md`](BARGE.md) for the full model.

### Notifications & Web Push

A complete push-notification system:

- Web Push subscribe/unsubscribe, dispatch from SSE envelopes,
  per-kind category toggles, and a Settings → Notifications panel with
  auto-subscribe on permission grant.
- **Quiet hours** with urgent-flag bypass, a visibility-aware gate
  (only push when you're actually away), a 30s-idle fallback gate, and
  bundled digest banners for bursts.
- Per-chat **mute** (sidebar 3-dots), per-chat unread indicators,
  sticky mark-unread, badge counts, and reply-body previews in the
  notification.
- The decision to push is now **plugin-driven** (`should_push` flag)
  rather than a client-side type allowlist.

### Approvals & activity tray

- Agent **approval prompts** surface as notifications and live in an
  **activity tray**; once resolved they stay visible with an outcome
  pill and **auto-resolve** when stale.
- Tool-argument labels and pretty-printed JSON tool results in the
  activity rows; clicking a row drills to the originating session bubble.

### Pins & cross-chat drawers

- **Per-message pins** with a right-side drawer that **aggregates pins
  across all chats**, jump-to-context navigation, expand-in-place,
  Slack-style highlight nav, and mobile swipe-to-close.
- Ambient widget mount (e.g. weather) in the right rail.

### Transcript scroll & pagination performance

- Bidirectional pagination (load older **and** newer), cache-first
  atomic drill-to-message, and IndexedDB-backed page persistence so
  drilling into a deep message is instant.
- Per-chat **scroll-position memory** across session switches; transcript
  clears + shows a spinner immediately on chat switch (no stale flash).
- Note: a JS virtualizer was prototyped mid-month but **replaced with
  browser-native full-DOM scroll** (May 27) — simpler and fewer edge
  cases. No virtualization in the shipped build.

### Sidebar & navigation

- Edge-swipe to open / drawer-swipe to close on mobile (ChatGPT-style
  direction classification), top-8 chat prefetch on boot, and cached
  pagination.

### Settings & cross-device sync

- Settings moved to a **two-column shell** (sidebar nav on desktop,
  flat on mobile).
- **STT key-terms and UI settings now sync server-side** via a
  `user_settings` table in `sidekick.db` (migrated off per-device
  IndexedDB / YAML) — your settings follow you across devices.

### Backend / plugin

- **Slash commands**: backend-declared catalog at `GET /v1/commands`,
  surfaced in a composer popover; `/reset`, `/new`, `/clear` wired.
- **Model picker** groups by provider (`<optgroup>`) and surfaces every
  authenticated provider's models; `sidekick.exclude_models` glob filter.
- **Supplemental store** (write-through + self-heal) and a staged B2
  read path making `state.db` the canonical message-body source.
- **openclaw** backend integration + a transcript projection model and
  cross-device sync SSOT.
- Native chat-id minting with prefixes; IDB schema v1→v2.

### iOS / Capacitor

- **Native `SFSpeechRecognizer` send-word path** for the CAP/iOS build
  (offloads send-word detection from Web Speech).
- **Bootstrap-based server-URL retargeting** — point the app at a
  different backend **without a rebuild**; bootstrap timeout + fallback
  to a host form so a bad URL no longer black-screens the app.

---

## June 2026 — voice reliability

Two voice bugs surfaced on real phones this month. Both are fixed,
deployed, and locked by tests that run **without a phone**, so they
can't silently regress again:

- **Realtime barge stopped working** after May's torch→onnxruntime VAD
  swap. The onnx model needs 64 samples of prior-audio context
  prepended to each window (silero v5 infers on 576 samples, not 512);
  without it the model scored ~0 on everything and never detected
  speech, so the agent never stopped talking when you spoke. Fixed by
  carrying a rolling context — and locked by a regression test that
  asserts real speech *scores high*. The prior test only checked that
  silence scored low, which the broken model also passed: that was the
  exact gap that let the regression through.
- **Turn-mode replies were silent over Bluetooth.** The reply audio
  played while the iOS audio session was still in mic-capture mode, so
  it routed to the iPhone earpiece instead of the connected headset.
  Fixed by hinting the playback audio category before play; covered by
  a spoken-turn test that asserts the reply element actually advances
  playback (not just that synthesis was requested).
- **A dev-only force-reload was wiping the 14.7 MB VAD asset cache**, so
  the next barge waited ~60s for a cold re-download and missed its
  window. Scoped so the everyday reload keeps the VAD assets warm; the
  full wipe is still available behind a long-press.

Underneath these, the audio stack now has a **three-layer E2E suite**:
real `/transcribe` + `/tts` contract canaries (run against the live
services at install time), a mocked spoken-turn test with real
getUserMedia→record→playback assertions, and a barge test that drives
the actual Silero VAD from a real speech WAV. Pushes run through a
**three-tier gate** — 496 unit/contract tests, the mocked Playwright
smoke suite, and a read-only live smoke against the deployed stack
(proxy + backend + PWA boot) — with a cross-backend conformance harness
keeping the hermes and openclaw plugins in lockstep on the `/v1/*`
contract. The ~3900-line `main.ts` is also being decomposed into
focused modules behind that gate, behavior-preserving and verified at
each step.

---

## Heads-up by person

### Tom — you're a couple weeks behind and multisession never worked for you

Start from a clean install. The two things most relevant to you:

1. **Multi-session / cross-device** is the area with the most churn this
   month — chat-id minting, IDB v1→v2 (clear-on-migrate), in-flight
   envelope caching so a mid-turn session switch doesn't drop the reply,
   and server-side settings sync. If multisession was broken for you
   before, re-pull and re-install rather than patching your old checkout.
2. **Server-URL retargeting without a rebuild** — you can now point the
   app at a backend via bootstrap config (and there's a host-form
   fallback if the URL is wrong), so getting connected shouldn't require
   an Xcode rebuild loop anymore.

If multisession still misbehaves after a clean install, that's the
thing to report first — it's the least-exercised path across devices.

### Misha — you're current; this is mostly the barge-in fix

Your barge-in issue (worked in turn-based, not realtime; the installer
dragged in all of CUDA; torch is huge) is addressed:

1. **Realtime barge works again.** Two things: the onnxruntime server
   VAD had a bug (missing the silero-v5 context window) that made it
   score everything as silence — now fixed and regression-tested — and
   realtime also falls back to in-browser Silero automatically if the
   bridge has no VAD, so you're not dependent on the bridge being
   provisioned correctly.
2. **The bridge no longer needs torch/CUDA** — server VAD runs on a
   vendored onnxruntime model (~2 MB, CPU). A fresh `install.sh` pulls
   onnxruntime, not torch. If you already have a torch venv it still
   works, but you can slim it: `pip uninstall torch torchaudio
   silero-vad` and the onnx path takes over (frees ~800 MB).
3. Re-run `install.sh` (or just `git pull`) to pick up the slim bridge
   venv provisioning and the VAD fix.
