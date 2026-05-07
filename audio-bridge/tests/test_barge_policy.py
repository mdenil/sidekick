"""Unit tests for the bridge-side BargePolicy.

Tests inject a stub `infer` (callable returning prerecorded p_speech
sequences) so the suite runs without torch / silero-vad. Hysteresis,
state transitions, envelope emissions, and the tts_active gating are
all exercised against synthetic frame sequences.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Allow `import barge_policy` from audio-bridge/ when tests run from
# the package root.
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))

import numpy as np
import pytest

from barge_policy import BargePolicy, SILERO_WINDOW_SAMPLES


def _frame_int16(n_samples: int = 320) -> bytes:
    """Synth a frame of silent (zero) int16 samples — n_samples × 2 bytes."""
    return np.zeros(n_samples, dtype=np.int16).tobytes()


def _make_infer_from_sequence(seq):
    """Stub infer that returns successive p_speech values from `seq`,
    repeating the last value if frames keep coming."""
    it = iter(seq)
    last = [0.0]

    def infer(frame):
        try:
            last[0] = float(next(it))
        except StopIteration:
            pass
        return last[0]

    return infer


def _make_recorder():
    """Capture envelopes emitted by the policy for assertion."""
    captured = []

    def emit(envelope):
        captured.append(envelope)

    return captured, emit


# ── Lifecycle / boundaries ────────────────────────────────────────────


def test_no_emit_when_tts_inactive():
    """When tts_active=False, frames are dropped silently."""
    captured, emit = _make_recorder()
    p = BargePolicy(infer=_make_infer_from_sequence([0.99]), emit_envelope=emit)
    for _ in range(20):
        p.feed_frame(_frame_int16(), tts_active=False)
    assert captured == []
    assert p.is_active is False


def test_no_emit_below_min_speech_frames():
    """A short burst that doesn't sustain min_speech_frames doesn't fire."""
    captured, emit = _make_recorder()
    # min_speech_frames=4 → need ≥4 consecutive ≥-threshold windows.
    p = BargePolicy(
        infer=_make_infer_from_sequence([0.9, 0.9, 0.9, 0.0, 0.0]),
        emit_envelope=emit,
        min_speech_frames=4,
        min_silence_frames=2,
    )
    # Need to feed enough int16 frames to produce 5 Silero windows.
    # 320-sample frames; Silero window 512 → ~1.6 frames per window.
    # 9 frames of 320 samples = 2880 samples = 5 full 512 windows + 320 remainder.
    for _ in range(9):
        p.feed_frame(_frame_int16(), tts_active=True)
    assert captured == [], "3 consecutive speech windows < min_speech_frames=4 should not fire"
    assert p.is_active is False


def test_fires_active_after_sustained_speech():
    """Once min_speech_frames consecutive ≥-threshold windows arrive,
    emits {speech-active: True}."""
    captured, emit = _make_recorder()
    # 6 consecutive speech windows; min_speech_frames=4 — fires on 4th.
    p = BargePolicy(
        infer=_make_infer_from_sequence([0.9] * 10),
        emit_envelope=emit,
        min_speech_frames=4,
        min_silence_frames=10,
    )
    # 10 incoming frames → ~6 Silero windows.
    for _ in range(10):
        p.feed_frame(_frame_int16(), tts_active=True)
    assert len(captured) == 1
    assert captured[0] == {"type": "speech-active", "active": True}
    assert p.is_active is True


def test_fires_inactive_after_sustained_silence():
    """After active, a sustained silence window fires {speech-active: False}."""
    captured, emit = _make_recorder()
    # First 6 windows speech, then 6 windows silence. min_silence_frames=4.
    p = BargePolicy(
        infer=_make_infer_from_sequence([0.9] * 6 + [0.05] * 6),
        emit_envelope=emit,
        min_speech_frames=3,
        min_silence_frames=4,
    )
    # ~12 windows = ~20 frames.
    for _ in range(20):
        p.feed_frame(_frame_int16(), tts_active=True)
    assert len(captured) == 2
    assert captured[0] == {"type": "speech-active", "active": True}
    assert captured[1] == {"type": "speech-active", "active": False}
    assert p.is_active is False


def test_speech_then_silence_then_speech_chains():
    """Active → inactive → active fires three envelopes (each transition)."""
    captured, emit = _make_recorder()
    seq = [0.9] * 4 + [0.05] * 4 + [0.9] * 4
    p = BargePolicy(
        infer=_make_infer_from_sequence(seq),
        emit_envelope=emit,
        min_speech_frames=3,
        min_silence_frames=3,
    )
    # 12 windows → ~20 frames.
    for _ in range(20):
        p.feed_frame(_frame_int16(), tts_active=True)
    assert [e["active"] for e in captured] == [True, False, True], captured


def test_tts_inactive_resets_state_and_emits_inactive_when_was_active():
    """When tts_active flips False mid-active, we emit inactive once and
    reset counters so the next tts_active window starts clean."""
    captured, emit = _make_recorder()
    p = BargePolicy(
        infer=_make_infer_from_sequence([0.9] * 10),
        emit_envelope=emit,
        min_speech_frames=3,
        min_silence_frames=3,
    )
    # Drive into active.
    for _ in range(8):
        p.feed_frame(_frame_int16(), tts_active=True)
    assert p.is_active is True
    # tts ends — should emit inactive once.
    p.feed_frame(_frame_int16(), tts_active=False)
    assert captured[-1] == {"type": "speech-active", "active": False}
    assert p.is_active is False
    # Subsequent tts-inactive frames don't re-emit.
    n_before = len(captured)
    for _ in range(5):
        p.feed_frame(_frame_int16(), tts_active=False)
    assert len(captured) == n_before


def test_isolated_silence_window_does_not_break_active_below_threshold_count():
    """A single silence window shouldn't drop us out of active until
    min_silence_frames consecutive silences."""
    captured, emit = _make_recorder()
    # 4 speech, 1 silence, 4 speech (single silence is below min_silence_frames=3)
    seq = [0.9] * 4 + [0.05] + [0.9] * 4
    p = BargePolicy(
        infer=_make_infer_from_sequence(seq),
        emit_envelope=emit,
        min_speech_frames=3,
        min_silence_frames=3,
    )
    for _ in range(20):
        p.feed_frame(_frame_int16(), tts_active=True)
    # Should only see one transition: silence → active. No re-fire.
    assert [e["active"] for e in captured] == [True], captured


def test_buffer_slides_correctly_across_frames():
    """Incoming 320-sample frames buffer until 512-sample windows are
    available; verify we get the expected number of inferences for a
    given frame count."""
    counts = {"calls": 0}

    def counting_infer(frame):
        counts["calls"] += 1
        assert len(frame) == SILERO_WINDOW_SAMPLES
        return 0.0

    captured, emit = _make_recorder()
    p = BargePolicy(infer=counting_infer, emit_envelope=emit)
    # 10 frames × 320 = 3200 samples → 6 Silero windows (3072 samples).
    for _ in range(10):
        p.feed_frame(_frame_int16(), tts_active=True)
    assert counts["calls"] == 6


# ── Robustness ────────────────────────────────────────────────────────


def test_emit_exception_does_not_break_state_machine():
    """If emit_envelope throws, state still advances."""
    def emit_throws(_envelope):
        raise RuntimeError("intentional")

    p = BargePolicy(
        infer=_make_infer_from_sequence([0.9] * 10),
        emit_envelope=emit_throws,
        min_speech_frames=3,
        min_silence_frames=3,
    )
    # Should not raise.
    for _ in range(10):
        p.feed_frame(_frame_int16(), tts_active=True)
    assert p.is_active is True


def test_infer_exception_drops_window_without_failing():
    """If infer throws on a window, we skip it and continue."""
    flip = [False]

    def flaky_infer(_frame):
        if not flip[0]:
            flip[0] = True
            raise RuntimeError("intentional")
        return 0.9

    captured, emit = _make_recorder()
    p = BargePolicy(
        infer=flaky_infer,
        emit_envelope=emit,
        min_speech_frames=2,
        min_silence_frames=10,
    )
    # Need 3+ Silero windows; first throws, subsequent ones return 0.9.
    for _ in range(10):
        p.feed_frame(_frame_int16(), tts_active=True)
    assert any(e.get("active") is True for e in captured)
