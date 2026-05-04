# Mac bootstrap — Sidekick native (Capacitor) shell

The Pi-side scaffolding (Capacitor 8 + iOS + Android projects) is checked in.
This doc is everything you need to do **once** on `jons-macbook-air` to get
from `git pull` to a Sidekick app running on your iPhone, signed with your
free Apple ID, and ready to share via SideStore.

The native shell is just a thin WKWebView pointed at the live Tailscale PWA
(`server.url` in `capacitor.config.ts`). Refreshing the wrapper is identical
to refreshing the PWA — bump the SW version on the Pi, pull-to-refresh in
the app.

---

## One-time machine setup

```bash
# 1. Xcode (large download — kick this off first)
#    Install from Mac App Store: "Xcode" by Apple
#    After install, launch it once to accept the license + install components.

# 2. Command-line tools
xcode-select --install

# 3. CocoaPods (used by Capacitor to vendor Swift packages it can't deliver via SPM)
sudo gem install cocoapods

# 4. Tailscale on the Mac, logged into the same tailnet as blueberry
#    (so the wrapper's WKWebView can reach https://blueberry.REDACTED-TAILNET.ts.net:3001)
```

## Per-clone setup

```bash
cd ~/code/sidekick   # or wherever you cloned it on the Mac
npm install          # picks up @capacitor/* from package.json
cd mobile/ios/App
pod install          # creates App.xcworkspace
```

## Open and build

```bash
open mobile/ios/App/App.xcworkspace   # NOT App.xcodeproj — workspace is required by CocoaPods
```

In Xcode:

1. Select the **App** target in the project navigator (top of left sidebar).
2. **Signing & Capabilities** tab.
3. **Team** → click the dropdown, pick "Add an Account…" if needed and sign in
   with your free Apple ID. Once added, select **"Jonathan Scholz (Personal Team)"**.
4. **Bundle Identifier** is `com.reimaginerobotics.sidekick`. Free-tier Apple IDs
   may complain that the identifier is taken (it's not, but the system pre-registers
   when you sign). If so, append your Apple ID short-name, e.g.
   `com.reimaginerobotics.sidekick.jscholz`, to make it unique to your account.
5. Plug in your iPhone via USB. Trust the Mac when prompted on the phone.
6. In the Xcode toolbar, change the run target from "Any iOS Device" / a simulator
   to **your physical iPhone**.
7. Hit **▶ Run**.

First launch on the phone: iOS will block the developer signature. Go to
**Settings → General → VPN & Device Management → Developer App** and trust
your Apple ID. Re-launch Sidekick.

When Sidekick opens it should immediately load
`https://blueberry.REDACTED-TAILNET.ts.net:3001`. The first time the page asks for
the microphone, iOS shows the system permission prompt (driven by
`NSMicrophoneUsageDescription` in `Info.plist`). Tap Allow.

## Updating the app

Two layers update independently:

- **Web layer (the PWA)** — edit code on the Pi, run `npm run build`, bump the
  SW version, pull-to-refresh inside Sidekick. No Xcode needed.
- **Native shell (this Capacitor project)** — only when changing
  `capacitor.config.ts`, `Info.plist`, `AppDelegate.swift`,
  `WebViewDelegate.swift`, or adding native plugins. After editing any of those,
  on the Mac:
  ```bash
  cd ~/code/sidekick
  npx cap sync ios
  cd mobile/ios/App && pod install
  # Re-build in Xcode
  ```

## Distributing to friends via SideStore

Free Apple IDs can install up to 3 apps that re-sign every 7 days. SideStore
extends this to ~10 with a Mac-side helper.

1. In Xcode: **Product → Archive**. (You may need to switch the run target to
   "Any iOS Device (arm64)" first.)
2. When the archive completes, the Organizer opens. Click **Distribute App**.
3. Choose **Custom** → **Release Testing** (or "Ad Hoc" depending on Xcode
   version). Select your Personal Team. Skip provisioning profile upload.
4. Export the resulting `.ipa` to disk.
5. Hand the `.ipa` (and a SideStore install link) to whoever you want to give
   the app to. They side-load it via SideStore on their iPhone with their
   own Apple ID.

## Things that may go wrong on first launch

- **WebView shows a blank page or "Cannot connect to server"** — most likely
  the Mac/iPhone is not on the tailnet. Confirm `tailscale status` shows
  blueberry; confirm Safari on the iPhone can hit
  `https://blueberry.REDACTED-TAILNET.ts.net:3001`.
- **Mic prompt fires but `getUserMedia` still rejects with NotAllowedError** —
  `WebViewDelegate.swift` should be granting `requestMediaCapturePermissionFor`.
  If it isn't being hit, check that `Main.storyboard` references
  `SidekickBridgeViewController` (custom class, customModule=`App`) instead of
  the stock `CAPBridgeViewController`. This is set in the storyboard already
  but a stale Xcode build may need a clean build folder
  (**Product → Clean Build Folder**).
- **ATS / TLS reject** — `Info.plist` has an `NSExceptionDomains` entry for
  `REDACTED-TAILNET.ts.net` with `NSExceptionRequiresForwardSecrecy=false`. If you
  see a TLS error in the Xcode console, check whether the Tailscale cert
  recently rotated and the chain changed.
- **WebRTC to the audio bridge silently fails** — WKWebView supports WebRTC
  (since iOS 14.3) but it does not run the same getUserMedia stack as Mobile
  Safari. If the audio bridge connects but no audio flows, look at the
  bridge's Python logs for ICE failures; it's almost always a NAT path issue
  not a wrapper issue.

## What's deliberately left alone

- **Service worker** — the SW lives at the PWA URL, so the WKWebView picks it
  up automatically. No Capacitor-side caching configured.
- **Web Speech API** — known to be missing in WKWebView. The realtime audio
  bridge already handles STT server-side, so this is acceptable.
- **Push notifications** — not wired. The platform-adapter refactor needs to
  land on the hermes side first (see `project_sidekick_platform_adapter_plan`).
- **Plugins (Camera, Filesystem, etc.)** — none added. The PWA uses standard
  Web APIs for everything; if you later need native APIs, `npm install
  @capacitor/<plugin>` and `npx cap sync` on the Mac.
