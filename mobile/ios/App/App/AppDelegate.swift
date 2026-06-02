import UIKit
import Capacitor
import AVFoundation
import MediaPlayer

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    /// Silent-audio keepalive engine. iOS suspends apps that aren't actively
    /// producing audio buffers, even with UIBackgroundModes=[audio] — within
    /// 3-5 minutes of idle, the WebView's mic capture path gets torn down
    /// while AVAudioSession + TTS playback survive (long tool call →
    /// chimes played late, mic was dead after idle suspend).
    /// Solution: keep an AVAudioEngine running with a silent looping buffer
    /// the whole app lifetime. iOS sees continuous audio output → never
    /// suspends → mic capture stays alive. Same pattern Spotify, NRC Run
    /// Club, and most VoIP apps use.
    private var keepaliveEngine: AVAudioEngine?
    private var keepalivePlayer: AVAudioPlayerNode?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Configure the shared AVAudioSession early so dictation/listen
        // can survive the app being backgrounded:
        //   - .playAndRecord: needed because the PWA also plays back TTS
        //     replies; .record alone would block playback.
        //   - .default mode (NOT .voiceChat): tried .voiceChat earlier
        //     today but it killed TTS reply playback after the first
        //     call — voiceChat optimizes for VoIP-style call audio
        //     (HFP routing, output de-priority) and conflicts with
        //     WebKit's HTMLAudioElement playback path. Reverted.
        //     .default keeps the WebView's TTS reliable while still
        //     supporting both record + playback.
        //   - .allowBluetooth + .allowBluetoothA2DP: route through paired
        //     headsets (the bike-ride use case — AirPods, Shokz, etc.).
        //   - .defaultToSpeaker: when no headset is attached, output goes
        //     to the loudspeaker rather than the earpiece. Without this,
        //     iPhone defaults to the earpiece for .playAndRecord, which
        //     surprises users who expect speakerphone.
        //   - .mixWithOthers: don't kill other apps' audio (Spotify,
        //     podcast app, navigation). Sidekick coexists.
        // Pairs with the UIBackgroundModes=[audio] entry in Info.plist —
        // without that, iOS suspends the AVAudioSession on backgrounding
        // regardless of the category we set.
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(
                .playAndRecord,
                mode: .default,
                options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker, .mixWithOthers]
            )
            try session.setActive(true)
            NSLog("[Sidekick] AVAudioSession configured: playAndRecord/default, BT+speaker+mix")
        } catch {
            NSLog("[Sidekick] AVAudioSession setup failed: \(error.localizedDescription)")
        }

        // Subscribe to interruption + route-change notifications. iOS fires
        // these on phone calls, headphone unplug, BT (dis)connect, Siri
        // invocation, etc. On `.ended` interruption we re-activate the
        // session and restart the keepalive — without this, the mic stays
        // dead after the interruption clears.
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(handleAudioInterruption(_:)),
                       name: AVAudioSession.interruptionNotification, object: nil)
        nc.addObserver(self, selector: #selector(handleAudioRouteChange(_:)),
                       name: AVAudioSession.routeChangeNotification, object: nil)

        startSilentKeepalive()
        // Lock-screen / Control-Center "Now Playing" widget. Phase 1:
        // visibility only — buttons render but no-op. Phase 2 (next
        // sprint) wires play/pause→TTS-interrupt and stop→hangup via
        // a JS bridge with platform-neutral events from shared code.
        CallControls.shared.setActive()
        return true
    }

    /// Start the silent-audio keepalive. Builds a 1-second silent PCM
    /// buffer in memory, schedules it to loop forever on an
    /// AVAudioPlayerNode connected to the main mixer. Output is silent
    /// (zeros), but iOS sees the audio engine rendering buffers and keeps
    /// the app alive in the background indefinitely. Negligible CPU/battery
    /// cost (silent buffer = no actual sound output, just a render tick).
    private func startSilentKeepalive() {
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)
        guard let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1) else {
            NSLog("[Sidekick] keepalive: failed to create audio format")
            return
        }
        engine.connect(player, to: engine.mainMixerNode, format: format)

        let frameCount: AVAudioFrameCount = 44100  // 1 second @ 44.1kHz
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
            NSLog("[Sidekick] keepalive: failed to allocate silent buffer")
            return
        }
        buffer.frameLength = frameCount
        // PCM buffer is zero-initialized by default — that's our silence.

        do {
            try engine.start()
            player.scheduleBuffer(buffer, at: nil, options: [.loops], completionHandler: nil)
            player.play()
            self.keepaliveEngine = engine
            self.keepalivePlayer = player
            NSLog("[Sidekick] silent keepalive started (44.1kHz mono, looping)")
        } catch {
            NSLog("[Sidekick] keepalive engine start failed: \(error.localizedDescription)")
        }
    }

    @objc private func handleAudioInterruption(_ notif: Notification) {
        guard let info = notif.userInfo,
              let typeRaw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
        switch type {
        case .began:
            NSLog("[Sidekick] audio interruption began (phone call / Siri / etc.)")
        case .ended:
            NSLog("[Sidekick] audio interruption ended — reactivating session + keepalive")
            do {
                try AVAudioSession.sharedInstance().setActive(true)
            } catch {
                NSLog("[Sidekick] session reactivate failed: \(error.localizedDescription)")
            }
            // Restart keepalive playback if it stopped during the interruption.
            if let player = keepalivePlayer, !player.isPlaying {
                player.play()
            }
        @unknown default:
            break
        }
    }

    @objc private func handleAudioRouteChange(_ notif: Notification) {
        guard let info = notif.userInfo,
              let reasonRaw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonRaw) else { return }
        NSLog("[Sidekick] audio route changed (reason: \(reason.rawValue))")
        // Headphone unplug = .oldDeviceUnavailable — iOS may auto-pause us.
        // BT (dis)connect = .newDeviceAvailable / .oldDeviceUnavailable.
        // Re-activate the session + nudge keepalive so we don't end up
        // silently dead after a route flip.
        do {
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            NSLog("[Sidekick] session reactivate failed (route change): \(error.localizedDescription)")
        }
        if let player = keepalivePlayer, !player.isPlaying {
            player.play()
        }
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

// MARK: - Lock-screen Now Playing integration

/// Singleton owning the lock-screen / Control-Center Now Playing widget.
/// Widget appears with the Sidekick brand + dark icon while the audio
/// session is active. The four MPRemoteCommandCenter callbacks fire
/// JS-side `sidekick:remote-control` events via webView.evaluateJS.
/// JS subscribes (src/remoteControl.ts) and dispatches the matching
/// action — stop hangs up active call, play/pause toggles agent TTS.
/// Bluetooth headset transport buttons (BT play/pause/skip) route
/// through the same callbacks on iOS, so they get this for free.
///
/// The `webViewProvider` closure is injected by WebViewDelegate at
/// capacitorDidLoad time. Keeping the dependency direction one-way
/// (WebViewDelegate → CallControls) avoids needing CallControls to
/// import or know about Capacitor's bridge type.
final class CallControls {
    static let shared = CallControls()
    private init() {}

    private var registeredCommands = false
    /// Set by WebViewDelegate.capacitorDidLoad(). When nil the remote
    /// commands no-op gracefully (iOS still calls them; we just can't
    /// reach JS yet).
    var webViewProvider: (() -> WKWebView?)?

    func setActive(title: String = "Sidekick", subtitle: String = "Agent ready") {
        registerRemoteCommandsIfNeeded()
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: subtitle,
            // Live = true → iOS shows a "live" indicator instead of a
            // playback scrubber. Right semantics for an open mic /
            // active assistant rather than a fixed-length recording.
            MPNowPlayingInfoPropertyIsLiveStream: true,
            MPNowPlayingInfoPropertyPlaybackRate: 1.0,
        ]
        if let icon = UIImage(named: "AppIcon") {
            let artwork = MPMediaItemArtwork(boundsSize: icon.size) { _ in icon }
            info[MPMediaItemPropertyArtwork] = artwork
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        UIApplication.shared.beginReceivingRemoteControlEvents()
        NSLog("[Sidekick] Now Playing set: \(title) — \(subtitle)")
    }

    func clear() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        UIApplication.shared.endReceivingRemoteControlEvents()
        NSLog("[Sidekick] Now Playing cleared")
    }

    /// Forward a remote-control action to JS as a custom event. Best-
    /// effort: if the webView isn't yet wired or the eval fails, we
    /// log and return success to iOS (returning .commandFailed makes
    /// the lockscreen flash a "failed" indicator which is worse UX).
    private func postRemoteAction(_ action: String) {
        NSLog("[Sidekick] remote: \(action) — forwarding to JS")
        guard let webView = webViewProvider?() else {
            NSLog("[Sidekick] remote: \(action) — no webView, dropping")
            return
        }
        // Build the JS expression. Action names are hardcoded constants
        // so no escaping concerns; if that ever changes, switch to
        // JSONSerialization. CustomEvent + window.dispatchEvent matches
        // the existing sidekick:engine-changed / hotkeys-changed pattern.
        let js = """
        window.dispatchEvent(new CustomEvent('sidekick:remote-control', { detail: { action: '\(action)' } }));
        """
        DispatchQueue.main.async {
            webView.evaluateJavaScript(js) { _, err in
                if let err = err {
                    NSLog("[Sidekick] remote: \(action) — JS dispatch failed: \(err)")
                }
            }
        }
    }

    /// Register the four supported remote commands. iOS hides any
    /// command without a registered handler from the lockscreen UI,
    /// so all four are wired even though play+pause are conceptually
    /// covered by togglePlayPause — some BT controllers fire only the
    /// specific play/pause variant.
    private func registerRemoteCommandsIfNeeded() {
        guard !registeredCommands else { return }
        registeredCommands = true
        let center = MPRemoteCommandCenter.shared()
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.postRemoteAction("togglePlayPause")
            return .success
        }
        center.playCommand.addTarget { [weak self] _ in
            self?.postRemoteAction("play")
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            self?.postRemoteAction("pause")
            return .success
        }
        center.stopCommand.addTarget { [weak self] _ in
            self?.postRemoteAction("stop")
            return .success
        }
    }
}
