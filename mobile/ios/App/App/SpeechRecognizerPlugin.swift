import Foundation
import Capacitor
import Speech
import AVFoundation

/// Native send-word recognizer for Listen mode on iOS.
///
/// Why this exists: the web app's send-word detector (sendwordDetector.ts)
/// opens a standalone Web Speech `SpeechRecognition` session, which
/// WKWebView gates with `service-not-allowed` — so on CAP the send word
/// never matches and Listen degrades to silence-only commit. This plugin
/// runs SFSpeechRecognizer natively and streams
/// partial transcripts back to JS via `partialResult` events; the JS side
/// (src/native/speechRecognizer.ts) feeds them into the detector's
/// existing FED path.
///
/// AVAudioSession ownership: AppDelegate configures the shared session
/// (.playAndRecord/.default, active) and keeps a silent keepalive engine
/// running for the whole app lifetime. This plugin DELIBERATELY never
/// calls setCategory / setActive — doing so previously broke TTS playback
/// (see AppDelegate.swift). It only installs an input tap on its own
/// AVAudioEngine and reads the shared session's mic input. That makes it
/// a third concurrent reader of the hardware input alongside the keepalive
/// engine and WKWebView's getUserMedia capture; concurrent input taps
/// across separate AVAudioEngines normally coexist under .playAndRecord,
/// but this is the behavior to verify on-device.
@objc(SpeechRecognizerPlugin)
public class SpeechRecognizerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SpeechRecognizerPlugin"
    public let jsName = "SpeechRecognizer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var listening = false

    @objc func available(_ call: CAPPluginCall) {
        call.resolve(["available": recognizer?.isAvailable ?? false])
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { status in
            let speechOk = (status == .authorized)
            // Mic access is normally already granted (getUserMedia), but
            // request explicitly so the input tap has record permission.
            AVAudioSession.sharedInstance().requestRecordPermission { micOk in
                call.resolve(["granted": speechOk && micOk])
            }
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        guard let recognizer = recognizer, recognizer.isAvailable else {
            call.reject("recognizer unavailable")
            return
        }
        DispatchQueue.main.async {
            do {
                try self.startInternal()
                call.resolve()
            } catch {
                self.stopInternal()
                call.reject("start failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.stopInternal()
            call.resolve()
        }
    }

    // MARK: - Internals

    private func startInternal() throws {
        if listening { return }
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }
        audioEngine.prepare()
        try audioEngine.start()
        listening = true
        makeTask()
    }

    /// Build a fresh recognition request + task. The input tap stays
    /// installed across restarts and appends to whatever `request` is
    /// current, so we just swap the request/task here.
    private func makeTask() {
        guard listening, let recognizer = recognizer else { return }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        request = req
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result {
                self.notifyListeners("partialResult", data: [
                    "transcript": result.bestTranscription.formattedString,
                    "isFinal": result.isFinal,
                ])
            }
            // SFSpeechRecognizer stops on final result, ~1-minute limit,
            // and transient errors. Restart so the send word stays live
            // for the whole Listen turn — mirrors the Web Speech onend
            // auto-restart loop in sendwordDetector.ts.
            if error != nil || (result?.isFinal ?? false) {
                self.task = nil
                self.request = nil
                if self.listening {
                    DispatchQueue.main.async { self.makeTask() }
                }
            }
        }
    }

    private func stopInternal() {
        listening = false
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        if audioEngine.isRunning {
            audioEngine.inputNode.removeTap(onBus: 0)
            audioEngine.stop()
        }
    }
}
