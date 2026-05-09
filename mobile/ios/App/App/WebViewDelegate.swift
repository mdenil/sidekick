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

/// Subclass the Capacitor bridge view controller so we own the WKUIDelegate.
/// The default Main.storyboard already instantiates `CAPBridgeViewController`;
/// we re-point it at this subclass below in didFinishLaunching.
class SidekickBridgeViewController: CAPBridgeViewController, WKUIDelegate {

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
      document.documentElement.classList.add('capacitor-app');
      var vp = document.querySelector('meta[name=viewport]');
      if (vp) vp.setAttribute('content', vp.getAttribute('content') + ', viewport-fit=cover');
      var s = document.createElement('style');
      s.textContent = [
        '.capacitor-app .header {',
        '  padding: max(4px, calc(env(safe-area-inset-top) - 20px)) 18px 4px;',
        '}',
        '.capacitor-app .sidebar-top {',
        '  padding-top: max(10px, calc(env(safe-area-inset-top) - 20px));',
        '}'
      ].join('\\n');
      // Append at document_start: <head> may not exist yet on the very
      // first run, so stash on documentElement and defer-attach if so.
      if (document.head) {
        document.head.appendChild(s);
      } else {
        document.addEventListener('DOMContentLoaded', function() {
          document.head.appendChild(s);
        }, { once: true });
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
