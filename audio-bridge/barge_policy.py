"""
Bridge-side barge policy — server-side acoustic VAD that fires
{type:'speech-active'} envelopes to the PWA, consumed by the client's
BridgeVadSource (see src/audio/shared/vadSource.ts).

WHY: client-side ONNX Silero is structurally broken on Mac Chrome
(microsoft/onnxruntime#19177 — InferenceSession.create cold-start
times out >15s). Bridge-side Silero (Python torch) loads once at
process start, works regardless of the client device, and lets us
ship the toggleable VadSource that frontier labs converged on
(LiveKit, Pipecat hybrid model — see notes_aec_post_nlp_research_2026_05_06.md
section "2026-05-06 follow-up").

PIPELINE: mic → WebRTC → audio-bridge → stt_bridge._pcm_iter →
   {feed_frame() here} → silero(p_speech) → hysteresis → emit
   {type:'speech-active', active: bool} envelope on transitions.

GATING: only runs Silero when tts_track.is_active() (the agent is
speaking). Outside that window, barge isn't a concept; we save CPU
and reset the hysteresis counters so a new turn starts clean.

HYSTERESIS: per-frame Silero is jittery; consecutive-frame counters
keep us off the chatter floor. MIN_SPEECH_FRAMES at 16kHz/32ms-window
≈ 220ms sustained — close to the client's 400ms minSpeechMs but
slightly tighter since the bridge has cleaner buffering than the
browser's worklet.

SAMPLE-RATE NOTE: stt_bridge resamples the inbound track to 16kHz
mono int16 with 20ms (320-sample) frames. Silero wants 32ms (512-
sample) at 16kHz. We buffer two incoming frames and feed 512 samples
per Silero call, sliding by 512 — yields one inference per ~32ms,
matching Silero's intended cadence.

DI: the load_model factory is injected via attach() so tests pass a
stub returning prerecorded p_speech sequences and don't need torch.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Callable, Optional

import numpy as np

logger = logging.getLogger(__name__)

# Frame and Silero sizing (must match stt_bridge frame contract).
SAMPLE_RATE = 16000
SILERO_WINDOW_SAMPLES = 512  # 32 ms at 16 kHz — Silero's expected window
INT16_TO_FLOAT = 1.0 / 32768.0

# Defaults — overridable via env. Numbers picked to match the spirit of
# the client-side BargeDetector (positiveSpeechThreshold=0.5,
# minSpeechMs=400) translated into bridge cadence (32ms per inference).
DEFAULT_SPEECH_THRESHOLD = float(os.environ.get("SIDEKICK_BARGE_THRESHOLD", "0.5"))
# 7 frames * 32ms ≈ 224ms — a touch faster than the client's 400ms.
# Bridge has cleaner buffering, so we can be slightly tighter without
# false-firing on transients.
DEFAULT_MIN_SPEECH_FRAMES = int(os.environ.get("SIDEKICK_BARGE_MIN_SPEECH_FRAMES", "7"))
# 25 frames * 32ms ≈ 800ms — long enough that the user has clearly
# stopped before we re-arm.
DEFAULT_MIN_SILENCE_FRAMES = int(os.environ.get("SIDEKICK_BARGE_MIN_SILENCE_FRAMES", "25"))


SileroInfer = Callable[[np.ndarray], float]
"""Stable-shaped callable: takes a 512-sample float32 array in [-1, 1]
at 16kHz, returns p_speech in [0, 1]. Production wraps the torch model;
tests pass a stub returning prerecorded values."""


class BargePolicy:
    """Per-peer barge-policy state machine.

    Owns:
      - a rolling sample buffer (we receive 320-sample frames; Silero
        wants 512-sample windows; buffer concatenates and slides)
      - hysteresis counters (consecutive_speech / consecutive_silence)
      - the boolean is_active flag that drives envelope emissions

    Does NOT own:
      - the data-channel send (caller provides emit_envelope)
      - the model lifecycle (caller provides infer)
      - the tts_active flag (caller passes it per feed_frame)

    Pure-function in spirit: feed_frame() and current state determine
    whether an envelope fires. Easy to test on fixture sequences.
    """

    def __init__(
        self,
        infer: SileroInfer,
        emit_envelope: Callable[[dict], None],
        *,
        speech_threshold: float = DEFAULT_SPEECH_THRESHOLD,
        min_speech_frames: int = DEFAULT_MIN_SPEECH_FRAMES,
        min_silence_frames: int = DEFAULT_MIN_SILENCE_FRAMES,
    ):
        self._infer = infer
        self._emit = emit_envelope
        self._speech_threshold = speech_threshold
        self._min_speech_frames = min_speech_frames
        self._min_silence_frames = min_silence_frames
        # Sample buffer — slides as Silero consumes 512-sample windows.
        # Sized to comfortably hold ~3 incoming frames before slide.
        self._buf: list[float] = []
        # Hysteresis counters in Silero-window units (32ms each).
        self._consec_speech = 0
        self._consec_silence = 0
        self._is_active = False

    @property
    def is_active(self) -> bool:
        """Current speech-active flag (after hysteresis)."""
        return self._is_active

    def feed_frame(self, frame_bytes: bytes, tts_active: bool) -> None:
        """Feed one 320-sample int16 frame from stt_bridge._pcm_iter.

        Behavior:
          - When tts_active=False: not in barge window. Reset hysteresis
            counters; emit a final 'inactive' envelope if we were active;
            drop the buffered samples (they predate the new turn).
          - When tts_active=True: convert to float32, append to buffer,
            consume 512-sample windows by running infer() and updating
            hysteresis. Emit envelopes on state-change boundaries.
        """
        if not tts_active:
            # Reset cleanly so the next TTS-active window starts fresh.
            if self._is_active:
                self._is_active = False
                try:
                    self._emit({"type": "speech-active", "active": False})
                except Exception as e:  # pragma: no cover
                    logger.warning("[barge-policy] emit (inactive) failed: %s", e)
            self._consec_speech = 0
            self._consec_silence = 0
            self._buf.clear()
            return

        # int16 → float32 in [-1, 1]
        arr = np.frombuffer(frame_bytes, dtype=np.int16).astype(np.float32) * INT16_TO_FLOAT
        self._buf.extend(arr.tolist())

        # Consume non-overlapping 512-sample windows.
        while len(self._buf) >= SILERO_WINDOW_SAMPLES:
            window = np.asarray(self._buf[:SILERO_WINDOW_SAMPLES], dtype=np.float32)
            del self._buf[:SILERO_WINDOW_SAMPLES]
            try:
                p_speech = float(self._infer(window))
            except Exception as e:  # pragma: no cover
                logger.warning("[barge-policy] infer threw: %s", e)
                continue
            self._step(p_speech)

    def _step(self, p_speech: float) -> None:
        """Advance the hysteresis state machine one Silero window."""
        if p_speech >= self._speech_threshold:
            self._consec_speech += 1
            self._consec_silence = 0
            if not self._is_active and self._consec_speech >= self._min_speech_frames:
                self._is_active = True
                try:
                    self._emit({"type": "speech-active", "active": True})
                    logger.info(
                        "[barge-policy] speech-active (sustained %d frames, p=%.3f)",
                        self._consec_speech, p_speech,
                    )
                except Exception as e:  # pragma: no cover
                    logger.warning("[barge-policy] emit (active) failed: %s", e)
        else:
            self._consec_silence += 1
            self._consec_speech = 0
            if self._is_active and self._consec_silence >= self._min_silence_frames:
                self._is_active = False
                try:
                    self._emit({"type": "speech-active", "active": False})
                    logger.info(
                        "[barge-policy] speech-inactive (sustained silence %d frames)",
                        self._consec_silence,
                    )
                except Exception as e:  # pragma: no cover
                    logger.warning("[barge-policy] emit (inactive) failed: %s", e)


# ── Production model loading ──────────────────────────────────────────
#
# Lazy: the bridge can run without silero-vad installed (e.g. in CI
# without torch); attach() falls back to a no-op policy that never
# fires envelopes. When silero-vad IS installed and the policy is
# enabled, we load once at module level (across all peers) — Silero
# is small (~1.8MB) and the torch JIT model is fully thread-safe via
# a per-call reset_states().

_SILERO_MODEL: Any = None
_SILERO_LOAD_TRIED = False


def _load_silero() -> Optional[Any]:
    """Lazy-load the silero-vad torch model. Returns None if the package
    isn't installed (bridge degrades to no-op barge policy)."""
    global _SILERO_MODEL, _SILERO_LOAD_TRIED
    if _SILERO_LOAD_TRIED:
        return _SILERO_MODEL
    _SILERO_LOAD_TRIED = True
    try:
        import torch  # noqa: F401  # imported for side-effect
        from silero_vad import load_silero_vad
        _SILERO_MODEL = load_silero_vad()
        _SILERO_MODEL.eval()
        logger.info("[barge-policy] silero-vad model loaded")
    except Exception as e:
        logger.warning("[barge-policy] silero-vad unavailable: %s — barge disabled", e)
        _SILERO_MODEL = None
    return _SILERO_MODEL


def _make_torch_infer() -> Optional[SileroInfer]:
    """Build a SileroInfer callable bound to the loaded torch model.
    Returns None when silero-vad isn't available."""
    model = _load_silero()
    if model is None:
        return None

    import torch

    def infer(frame: np.ndarray) -> float:
        # reset_states gives each peer's policy a fresh internal state —
        # otherwise inference accumulates across all peers' frames and
        # the model "remembers" prior context that doesn't apply to
        # this peer's mic.
        # NOTE: this is a per-peer concern; the model itself is shared
        # but state-reset on every call here means we lose Silero's
        # internal LSTM context. For barge-detection that's actually
        # fine — we want per-frame discrimination, not utterance-level
        # tracking. Trade-off documented for future tuning.
        with torch.no_grad():
            t = torch.from_numpy(frame)
            return float(model(t, SAMPLE_RATE))
    return infer


def attach(peer, *, voice_config: Any = None) -> Optional[BargePolicy]:
    """Wire a per-peer BargePolicy onto peer.extra['barge_policy'].

    Production: builds an infer fn against the lazy-loaded silero-vad
    torch model and an emit fn that sends data-channel envelopes via
    stt_bridge._send_data_channel. Tests can call BargePolicy(...)
    directly with stubbed deps and skip attach().

    Returns the BargePolicy (None when silero-vad is unavailable, in
    which case the bridge degrades to client-side-only barge — same
    as today's behavior).
    """
    infer = _make_torch_infer()
    if infer is None:
        peer.extra["barge_policy"] = None
        return None

    # Late import to avoid circular dep with stt_bridge.
    import stt_bridge

    def emit(envelope: dict) -> None:
        stt_bridge._send_data_channel(peer, envelope)

    policy = BargePolicy(infer=infer, emit_envelope=emit)
    peer.extra["barge_policy"] = policy
    logger.info("[barge-policy] attached to peer %s", peer.peer_id)
    return policy


__all__ = ["BargePolicy", "attach", "SileroInfer"]
