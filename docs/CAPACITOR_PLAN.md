# Capacitor app — execution plan (2026-05-05)

Goal: get the existing Capacitor scaffold from "checked in" to "Sidekick app installed on Jonathan's iPhone, sideloadable to others, working over Tailscale to blueberry." Each phase has explicit stop conditions and a "what blocks this" note so a subagent or Jonathan can resume from any point.

---

## Status check (what already exists)

Scaffolded on `wip/voice-stack-2026-05-04` branch:
- `capacitor.config.ts` — appId `com.reimaginerobotics.sidekick`, server.url pointing at `https://blueberry.REDACTED-TAILNET.ts.net:3001`
- `mobile/ios/App/App.xcodeproj` + `App.xcworkspace`
- `mobile/ios/App/App/Info.plist` — `NSMicrophoneUsageDescription` + ATS exception for `REDACTED-TAILNET.ts.net` (with `NSExceptionRequiresForwardSecrecy=false`)
- `mobile/ios/App/App/WebViewDelegate.swift` — handles `requestMediaCapturePermissionFor` to grant mic without re-prompts
- `mobile/ios/App/App/SidekickBridgeViewController` (custom subclass) wired via `Main.storyboard`
- `mobile/android/` — Gradle project (deferred; iOS first)
- `docs/MAC_BOOTSTRAP.md` — step-by-step from `git pull` to first build
- `package.json` — `@capacitor/{core,cli,ios,android}@^8.3.1`

What's UNTESTED (this plan validates each):
1. Whether `npm install` + `pod install` complete cleanly on a fresh Mac
2. Whether the Xcode project builds without modification
3. Whether the WKWebView reaches `https://blueberry.REDACTED-TAILNET.ts.net:3001` (Tailscale routing in WKWebView)
4. Whether `getUserMedia` actually works (mic permission grant via `WebViewDelegate.swift`)
5. Whether `RTCPeerConnection` can establish a call (WebRTC support in WKWebView)
6. Whether the audio bridge audio actually flows (ICE through WKWebView's NAT)
7. Whether SideStore can install/distribute the resulting `.ipa`

---

## Phase 0 — Pre-flight audit (agent, autonomous, no Mac needed)

**Goal**: catch obvious-on-the-page issues before Jonathan opens Xcode.

Steps (in order):
1. Read `docs/MAC_BOOTSTRAP.md` end-to-end. Cross-check every command against the actual files in `mobile/ios/`.
2. Verify `Info.plist` has all required keys:
   - `NSMicrophoneUsageDescription` (non-empty string)
   - `NSAppTransportSecurity` → `NSExceptionDomains` → `REDACTED-TAILNET.ts.net`
   - `CFBundleDisplayName` set to "Sidekick"
   - `CFBundleVersion` and `CFBundleShortVersionString` present
3. Verify `WebViewDelegate.swift` actually overrides `webView(_:requestMediaCapturePermissionFor:initiatedByFrame:type:decisionHandler:)` and grants the request unconditionally for the REDACTED-TAILNET origin.
4. Verify `Main.storyboard` references the custom `SidekickBridgeViewController` (not stock `CAPBridgeViewController`) — this is the storyboard plumbing the bootstrap doc warns about.
5. Verify `capacitor.config.ts` `server.url` points to the production Tailscale URL and `allowNavigation` whitelists it.
6. Run `npx cap doctor --config capacitor.config.ts` from the repo root if installable on Pi (likely fails — capacitor CLI wants Xcode/Android SDK locally — but capture the output anyway).
7. Audit `package-lock.json` — confirm `@capacitor/*` versions match `package.json` and that no `xcode` peer-dep mismatches lurk.
8. Verify `mobile/ios/App/Podfile` exists (or note that `pod install` will fail without one). If missing, regenerate via `npx cap add ios` is destructive — instead confirm Capacitor 8.3.1's expected Podfile shape.

**Output**: a one-page audit report. List anything missing or suspicious. No fixes — just the report.

**Stop condition**: report clean, OR list of issues to address before Jonathan boots Xcode.

---

## Phase 1 — Mac local build (Jonathan, ~30 min, requires Xcode + iPhone)

**Goal**: confirm the iOS app compiles, links, and launches in the Simulator.

Steps:
1. `cd ~/code/sidekick && git checkout master` (after the wip branch has merged) and `git pull`.
2. `npm install` — should be a no-op if `package-lock.json` is consistent.
3. `cd mobile/ios/App && pod install`. Watch for:
   - Cocoapods version warning (acceptable up to a point)
   - `error: ` lines (stop)
4. `open mobile/ios/App/App.xcworkspace` (NOT `.xcodeproj`).
5. In Xcode:
   - Select the **App** target → **Signing & Capabilities** → set **Team** to "Jonathan Scholz (Personal Team)" (free Apple ID).
   - Bundle ID: leave as `com.reimaginerobotics.sidekick`. If Xcode complains "already in use," try suffix `.jscholz`.
   - Select an **iPhone 15 Simulator** (or similar) as the run target.
   - **Product → Build** (`⌘B`).
6. **Stop condition for Phase 1**: build succeeds (gray checkmark in Xcode toolbar). If errors:
   - Take the FIRST error, copy to ~/CAPACITOR_BLOCKERS.md with its file:line + the `Issue navigator` description.
   - Common issues + fixes (catalogued for the agent to attempt before bothering Jonathan):
     - "No such module 'Capacitor'" → run `pod install` again, ensure `.xcworkspace` is open
     - "ATS error" → `Info.plist` exception domains entry malformed
     - "Bundle ID conflict" → suffix the bundle ID with Apple-ID short name

**Output**: green build OR a specific error in `CAPACITOR_BLOCKERS.md`.

---

## Phase 2 — Simulator launch (Jonathan, ~15 min)

**Goal**: app opens to Sidekick UI in the iOS Simulator.

Steps:
1. **Product → Run** (`⌘R`) on iPhone 15 Simulator.
2. Wait for Simulator to boot + app to launch.
3. **Expected**: app opens, displays the Sidekick UI loaded from `https://blueberry.REDACTED-TAILNET.ts.net:3001`.
4. **Note**: Simulator does NOT have Tailscale routing by default. The simulator inherits the Mac's network — so if Mac's Tailscale is up and routing REDACTED-TAILNET.ts.net, the simulator should reach blueberry. If not, the WebView shows a connection error.
5. Try sending a typed message; verify reply appears.

**Stop condition**: UI loads + typed message round-trips. If WebView is blank or shows error:
- Open Safari Web Inspector (Mac Safari → Develop → Simulator → Sidekick) and capture the network/console log
- Save to `CAPACITOR_BLOCKERS.md`
- Likely root cause: ATS rejection (cert chain), or Tailscale Mac daemon not routing, or `server.url` typo

---

## Phase 3 — Physical iPhone launch (Jonathan, ~30 min)

**Goal**: Sidekick app installed and running on Jonathan's actual iPhone.

Steps:
1. Plug iPhone into Mac via USB. Trust the Mac when prompted on the phone.
2. In Xcode toolbar, change run target from Simulator → physical iPhone.
3. **Product → Run**.
4. First launch: iOS will refuse the developer signature. On phone:
   - **Settings → General → VPN & Device Management → Developer App** → trust the Apple ID.
5. Re-launch Sidekick from the home screen.
6. Verify Tailscale on the iPhone is logged in to the same tailnet as blueberry. If not, install Tailscale from the App Store + log in.
7. App should load `https://blueberry.REDACTED-TAILNET.ts.net:3001`.
8. **Mic permission**: send a typed message first to verify the app is alive. Then tap the call button. iOS should show the system mic-permission prompt (driven by `NSMicrophoneUsageDescription`). Tap Allow.
9. **Functional checklist** (in order, stop on first fail):
   - [ ] Typed message → agent reply round-trips
   - [ ] Realtime call connects within 5s (no 8s ICE hang the way Mac Chrome had)
   - [ ] Mic captures audio (look for `[bubble-diag] listening envelope received from bridge` in the on-page debug panel)
   - [ ] Dictate works: speak → text appears in transcript → agent replies
   - [ ] Barge: agent talking → user speaks → TTS halts
   - [ ] Hangup → call ends cleanly within 2s
   - [ ] Background the app → bring back → still connected (or auto-reconnects within 5s)
   - [ ] Lock the phone with a call active → audio continues (or warns clearly that it doesn't)

**Stop condition**: all checked, OR the first failed item logged with the on-page debug panel output.

---

## Phase 4 — Diagnose + fix iteration (agent + Jonathan, time-boxed at 2 hours)

**Goal**: every "broken" item from Phase 3 either fixed or backlogged with a clear repro.

Loop:
1. Take the topmost broken item.
2. Reproduce it. Capture the debug panel output + Xcode console output (`View → Debug Area → Show Debug Area`).
3. Agent analyzes the logs. Possible categories:
   - **Web layer bug** (PWA code) — agent edits `src/`, builds, Jonathan pulls-to-refresh
   - **Native shell bug** (Swift code) — agent edits `mobile/ios/App/`, Jonathan rebuilds in Xcode
   - **Configuration bug** (Info.plist, capacitor.config.ts) — same as native shell
   - **WKWebView limitation** — back-burner with a clear note ("cannot do X without WebRTC polyfill")
4. Apply fix, verify, commit.

**Stop condition**: 2-hour budget elapsed OR all items in Phase 3 pass.

**Risks (catalogued so Jonathan can decide before Phase 4 begins)**:
- **WebRTC in WKWebView**: works on iOS 14.3+ but the connection establishment differs from Mobile Safari. Anecdotally there are quirks with ICE candidate gathering in WKWebView. If realtime calls fail to connect, that's the suspect.
- **AudioWorklet in WKWebView**: should work iOS 16+. If barge VAD fails to warm, the fallback path (RMS-only, smaller scope) should still trigger.
- **Web Speech API**: NOT available in WKWebView. The PWA's local-STT fallback will silently break — code path needs a feature-detect. Acceptable for the bridge-driven path which the app uses by default.
- **Service Worker**: WKWebView fully supports SW. The IDB cache + VAD_CACHE strategies should work identically.

---

## Phase 5 — Distribution prep (Jonathan, ~30 min)

**Goal**: produce a sideloadable `.ipa` and verify SideStore install on a second device (Jonathan's old iPhone or Tom's).

Steps:
1. In Xcode toolbar: change run target to **"Any iOS Device (arm64)"**.
2. **Product → Archive**.
3. Organizer opens. **Distribute App** → **Custom** → **Release Testing** (label varies by Xcode version) → Personal Team → skip provisioning profile upload → Export `.ipa` to `~/Documents/sidekick-<version>.ipa`.
4. Install **SideStore** on the recipient device via AltStore-style sideload (one-time setup with a Mac helper).
5. From the recipient device: SideStore → "+" → select `.ipa` from a shared cloud folder (or AirDrop the `.ipa`). SideStore signs with the recipient's free Apple ID.
6. App installs. First launch: the Apple ID developer trust dance from Phase 3.
7. Verify: typed message → realtime call → barge — same checklist as Phase 3.

**Output**: working installation on a second device.

**Stop condition**: install succeeds AND functional checklist passes on the second device.

**Known limitations** (call out in `MAC_BOOTSTRAP.md` after this phase):
- Free Apple ID: 7-day re-sign required (SideStore handles this via Mac helper)
- 3 sideloaded apps per Apple ID limit
- SideStore Mac helper needs to be running on the network for re-signs

---

## Phase 6 — Documentation + cleanup (agent, autonomous)

**Goal**: any deltas from Phase 0 → Phase 5 captured in repo so the next person can repeat without surprises.

Steps:
1. Update `docs/MAC_BOOTSTRAP.md`:
   - Any new commands required
   - Any error/fix notes from Phase 4
   - The exact Xcode version that worked (record from Jonathan's machine)
   - The exact iOS version on the target phone
2. If any Swift / Info.plist / capacitor.config changes were made in Phase 4, ensure they're committed with descriptive messages.
3. Update `~/your-agent-private/backlog.md`:
   - Mark Capacitor as **SHIPPED** in the recently-shipped section
   - Move the iOS-PWA-mic-permission Path B item to the same shipped section (Capacitor IS Path B in practice)
   - File any new backlog items discovered during Phase 4 (e.g. WebRTC quirks, SW edge cases on WKWebView)
4. Tag the repo at the post-Phase-5 commit: `git tag capacitor-v1`. Push tags.
5. Note in the morning briefing format what was achieved + any open items.

**Output**: clean docs, clean backlog, tagged release point.

---

## What this plan does NOT do (out of scope, deferred)

- **Android build** — `mobile/android/` exists but Phase 1-5 are iOS only. Add Android phase post-iOS (different Gradle pain, no SideStore equivalent).
- **Push notifications** — needs hermes platform-adapter refactor (separate backlog item).
- **App Store submission** — out of scope. SideStore distribution is the goal.
- **Native plugins** (Camera, Filesystem, etc.) — none added. PWA uses Web APIs.
- **Background audio** — investigate if the current setup keeps audio alive when phone locks. Not strictly required for v1.
- **Web Speech fallback rewrite** — acceptable to lose local-STT in WKWebView; bridge-driven STT works.

---

## Greenlight gates

For the agent to proceed phase-by-phase without Jonathan's input, this is the gating model:

- **Phase 0** (pre-flight audit): ALWAYS safe to run. No code changes, just reading. Agent runs autonomously.
- **Phase 1-3** (Mac/Xcode/iPhone): REQUIRES Jonathan at his Mac. Agent cannot do these. Agent's role is preparing the issue tracker (`CAPACITOR_BLOCKERS.md`) and being on standby for Phase 4.
- **Phase 4** (fix iteration): mixed. Agent can edit code, build PWA, restart services. Jonathan rebuilds in Xcode + tests on phone. Time-box 2 hours; if not converged, queue remaining items and ship what works.
- **Phase 5** (distribution): Jonathan only. Agent waits.
- **Phase 6** (documentation): agent autonomous after Phase 5 succeeds.

---

## Subagent instructions (for firing this off)

If Jonathan delegates this to a subagent:

```
Read ~/code/sidekick/docs/CAPACITOR_PLAN.md.
Execute Phase 0 (pre-flight audit) autonomously.
Output the audit report as ~/CAPACITOR_AUDIT.md.
DO NOT proceed to Phase 1 — Jonathan does that on his Mac.
After the audit, stop and report. The Phase 1-5 work happens
when Jonathan is at his Mac and pings you with results.
```
