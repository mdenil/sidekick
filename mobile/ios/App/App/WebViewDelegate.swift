//
//  WebViewDelegate.swift
//  App
//
//  Auto-grants getUserMedia (microphone/camera) prompts inside the
//  Capacitor WKWebView. Without this, calls to navigator.mediaDevices.getUserMedia
//  inside the wrapper silently fail because WKWebView's default WKUIDelegate
//  has no media-capture permission handler — even when iOS-level mic permission
//  is granted via NSMicrophoneUsageDescription.
//
//  Reference: https://blog.silverpc.hu/2025/10/23/a-guide-to-permissions-how-can-i-access-the-microphone-via-a-webview/
//

import Foundation
import Capacitor
import WebKit
import AVFoundation
import MediaPlayer

/// Subclass the Capacitor bridge view controller so we own the WKUIDelegate.
/// The default Main.storyboard already instantiates `CAPBridgeViewController`;
/// we re-point it at this subclass below in didFinishLaunching.
class SidekickBridgeViewController: CAPBridgeViewController, WKUIDelegate {

    // ── Hardware volume buttons → barge bridge ────────────────────────
    //
    // Hidden MPVolumeView in the view hierarchy suppresses iOS's volume
    // HUD popup (a system overlay that would otherwise flash on every
    // press during a call — annoying mid-conversation). Audio session
    // outputVolume KVO observation captures button presses globally;
    // every change posts a 'volume-button' action to JS via the same
    // remote-control event channel that MPRemoteCommandCenter uses.
    //
    // JS-side gates the action: only fires barge if a talk-mode call
    // is open. Outside calls (or in stream/idle) volume buttons just
    // change volume normally. iOS volume DOES change on each press —
    // we don't reset it; that's a known v1 trade-off in exchange for
    // not hacking the private MPVolumeView slider.
    private var hiddenVolumeView: MPVolumeView?
    private var lastObservedVolume: Float = 0
    private var didStartObservingVolume: Bool = false

    /// Cap-specific JS+CSS injected at document_start so the PWA core
    /// (index.html, styles/app.css) has zero Capacitor-conditional code.
    /// Architectural rule (Jonathan, 2026-05-09): Cap-specific behavior
    /// stays inside `mobile/ios/App/` so the Cap shell could be ripped
    /// out by deleting the directory without touching shared sources.
    ///
    /// Three things need Cap-only treatment:
    ///   1. `viewport-fit=cover` — required for env(safe-area-inset-*)
    ///      to return real values. CANNOT be in the PWA's static meta
    ///      because iOS Safari PWA standalone interprets it differently
    ///      (caps the layout viewport at "screen − safe-area" → composer
    ///      floats in unreachable WebView space). Cap-only.
    ///   2. `<html class="capacitor-app">` — body class for CSS scoping.
    ///      Cap's WKWebView does NOT report `display-mode: standalone`
    ///      to matchMedia despite rendering edge-to-edge, so the @media
    ///      query alone misses it.
    ///   3. Cap-only safe-area padding rules for .header and .sidebar-top
    ///      so the brand + Menu label clear the iOS Dynamic Island /
    ///      status bar.
    private static let capOverlayScript = """
    (function() {
      // documentElement exists at .atDocumentStart — class can be set
      // immediately so first paint already sees `<html class="capacitor-app">`.
      document.documentElement.classList.add('capacitor-app');

      // <head> + its children (including <meta name=viewport>) DO NOT
      // yet exist at .atDocumentStart — only <html> has been opened.
      // The meta-tag mutation + <style> injection must wait until <head>
      // is parsed, otherwise:
      //   - querySelector for the viewport meta returns null → no
      //     viewport-fit=cover ever gets added → env(safe-area-inset-*)
      //     returns 0 → `.capacitor-app .header` rule resolves to
      //     `padding: max(4px, -20px) ...` = 4px → brand draws 4px
      //     from screen top, overlapping the status bar / clock.
      //     (Field-reported by Jonathan 2026-05-09 right after the
      //     isolation refactor — pre-refactor the meta was static in
      //     index.html so CSS saw real env values.)
      // Use MutationObserver to fire as soon as <head> appears (more
      // reliable than DOMContentLoaded for Cap's WKWebView, which can
      // sometimes lay out before DCL fires).
      function applyOverlay() {
        var vp = document.querySelector('meta[name=viewport]');
        if (vp && !/viewport-fit=cover/.test(vp.getAttribute('content') || '')) {
          vp.setAttribute('content', vp.getAttribute('content') + ', viewport-fit=cover');
        }
        if (!document.getElementById('cap-overlay-style')) {
          var s = document.createElement('style');
          s.id = 'cap-overlay-style';
          s.textContent = [
            '.capacitor-app .header {',
            '  /* -8px (was -20px) — Jonathan 2026-05-09: -20 was OK',
            '   * but the brand still crowded the iOS clock. -8 shifts',
            '   * down ~12px more, about the height of the "A" in the',
            '   * "AGENT PORTAL" subtitle. Brand sits below the clock',
            '   * with a comfortable gap, no overlap. max() floor of',
            '   * 4px keeps non-notch sane (env returns 0 there). */',
            '  padding: max(4px, calc(env(safe-area-inset-top) - 8px)) 18px 4px;',
            '}',
            '.capacitor-app .sidebar-top {',
            '  /* Buttons inside (sb-toggle, sb-search) must be tappable —',
            '   * use the FULL safe-area inset (not the -20px shift the header',
            '   * brand uses). With -20 the search button on the right could',
            '   * end up under the iOS signal/wifi icons or in the swipe-zone',
            '   * iOS reserves for system gestures, making it unreachable. */',
            '  padding-top: max(10px, env(safe-area-inset-top));',
            '}'
          ].join('\\n');
          document.head.appendChild(s);
        }
      }

      if (document.head) {
        applyOverlay();
      } else {
        // Watch for <head> being added to <html>. Fires before any
        // <link rel=stylesheet> children are parsed, so our <style>
        // gets ordered after them — same-specificity tiebreak by
        // source order favors our rule.
        var obs = new MutationObserver(function() {
          if (document.head) { obs.disconnect(); applyOverlay(); }
        });
        obs.observe(document.documentElement, { childList: true });
        // Belt-and-braces fallback in case the observer never fires.
        document.addEventListener('DOMContentLoaded', applyOverlay, { once: true });
      }
    })();
    """

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let webView = self.bridge?.webView else { return }
        // Take ownership of the UI delegate slot. Capacitor itself only sets
        // the navigation delegate, so we don't conflict with the bridge.
        webView.uiDelegate = self
        // Inject the Cap-only viewport / body-class / safe-area-CSS overlay.
        // forMainFrameOnly: true — sub-frames don't need this. injectionTime:
        // .atDocumentStart so the body class + viewport meta are in place
        // before the PWA's main bundle parses + the first paint happens.
        let userScript = WKUserScript(
            source: SidekickBridgeViewController.capOverlayScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        webView.configuration.userContentController.addUserScript(userScript)
        // Wire up the lockscreen / BT-headset remote-control bridge.
        // CallControls (singleton in AppDelegate) now uses this closure
        // to reach the WebView when MPRemoteCommandCenter callbacks
        // fire. Weak-self on the bridge avoids retain cycles if Cap
        // ever recreates the controller; webView is also a weak hop.
        CallControls.shared.webViewProvider = { [weak self] in
            self?.bridge?.webView
        }

        // Hardware volume buttons → barge. Hidden MPVolumeView
        // suppresses the iOS HUD that would otherwise flash on every
        // press during a call. Frame is offscreen + isHidden=true; iOS
        // detects an MPVolumeView in the hierarchy regardless of its
        // visual state, suppressing the system HUD (well-known iOS
        // technique; e.g. used by camera apps for shutter buttons).
        let mpv = MPVolumeView(frame: CGRect(x: -1000, y: -1000, width: 1, height: 1))
        mpv.isHidden = true
        self.view.addSubview(mpv)
        hiddenVolumeView = mpv

        // KVO on AVAudioSession.outputVolume catches volume button
        // presses globally. Activate the session first so outputVolume
        // reads a valid value (otherwise reads 0 until first audio
        // routes through). The keepalive engine in AppDelegate has
        // already activated; this is defensive.
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(true)
        lastObservedVolume = session.outputVolume
        session.addObserver(self, forKeyPath: "outputVolume",
                            options: [.new, .old], context: nil)
        didStartObservingVolume = true
    }

    deinit {
        if didStartObservingVolume {
            AVAudioSession.sharedInstance().removeObserver(self, forKeyPath: "outputVolume")
        }
    }

    override func observeValue(forKeyPath keyPath: String?, of object: Any?,
                               change: [NSKeyValueChangeKey: Any]?,
                               context: UnsafeMutableRawPointer?) {
        guard keyPath == "outputVolume" else {
            super.observeValue(forKeyPath: keyPath, of: object, change: change, context: context)
            return
        }
        let newVol = AVAudioSession.sharedInstance().outputVolume
        let delta = newVol - lastObservedVolume
        lastObservedVolume = newVol
        // Filter out spurious tiny changes (route changes can emit
        // millivolt-scale wobble). Real button presses move volume
        // by ~0.0625 (1/16 of the slider).
        if abs(delta) < 0.001 { return }
        let direction = delta > 0 ? "up" : "down"
        guard let webView = self.bridge?.webView else { return }
        let js = """
        window.dispatchEvent(new CustomEvent('sidekick:remote-control', { detail: { action: 'volume-button', direction: '\(direction)' } }));
        """
        DispatchQueue.main.async {
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    // iOS 15+ — modern media-capture permission callback.
    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }
}
