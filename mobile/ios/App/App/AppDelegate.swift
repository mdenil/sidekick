import UIKit
import Capacitor
import AVFoundation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    /// Silent-audio keepalive engine. iOS suspends apps that aren't actively
    /// producing audio buffers, even with UIBackgroundModes=[audio] — within
    /// 3-5 minutes of idle, the WebView's mic capture path gets torn down
    /// while AVAudioSession + TTS playback survive (Jonathan's 2026-05-09
    /// field test: long tool call → chimes played late, mic was dead).
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
        //   - .voiceChat mode: optimizes for voice (echo cancellation +
        //     noise suppression beyond the .default baseline). The "what
        //     iOS expects from a voice app" hint also encourages iOS to
        //     keep the audio path alive longer when backgrounded.
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
                mode: .voiceChat,
                options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker, .mixWithOthers]
            )
            try session.setActive(true)
            NSLog("[Sidekick] AVAudioSession configured: playAndRecord/voiceChat, BT+speaker+mix")
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
