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

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // Take ownership of the UI delegate slot. Capacitor itself only sets
        // the navigation delegate, so we don't conflict with the bridge.
        if let webView = self.bridge?.webView {
            webView.uiDelegate = self
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
