"""
Fixture-replay TTS provider — for smoke tests.

Reads a 16 kHz mono signed-int16 PCM WAV from disk and yields its
samples as the agent's "voice." Ignores the text_iter (we're replaying
a fixed clip regardless of what the agent claims to be saying — the
text content already matches the recorded audio by fixture design).

Deterministic, network-free, credential-free. The downstream PCMTrack
encodes to Opus and sends over the WebRTC peer like any normal reply,
so the entire client-side audio pipeline (decode → AEC → speaker) runs
exactly as in production. Only the upstream synthesis is mocked.

Usage in audio-bridge config:

    voice:
      tts:
        provider: fixture
        options:
          wav_path: /path/to/agent-counts-1-10.wav

The WAV must be 16 kHz, mono, signed-int16. ``scripts/generate-test-
fixtures.mjs`` produces clips in this format.

Provider name: ``fixture``. Registered at module import; ``__init__.py``
imports this module conditionally so it's available whenever the bridge
runs (no production cost — it just sits there until something asks for
``provider: fixture``).
"""

from __future__ import annotations

import asyncio
import logging
import wave
from typing import AsyncIterator

from config import ProviderSpec
from .tts import TTSProvider, register_tts_provider

logger = logging.getLogger(__name__)


# Yield in 50 ms chunks (1600 samples × 2 bytes = 3200 bytes per chunk).
# Matches the cadence the Opus encoder expects — smaller chunks add CPU
# overhead, larger ones add latency.
_CHUNK_MS = 50
_CHUNK_BYTES = int(16000 * _CHUNK_MS / 1000) * 2


class FixtureTTS(TTSProvider):
    def __init__(self, spec: ProviderSpec) -> None:
        wav_path = spec.options.get("wav_path")
        if not wav_path:
            raise RuntimeError(
                "fixture TTS requires options.wav_path"
            )
        self._wav_path = str(wav_path)
        self._pcm_cache: bytes | None = None

    def _load(self) -> bytes:
        """Read the WAV once; cache the raw PCM body for re-use across
        multiple replies in the same call."""
        if self._pcm_cache is not None:
            return self._pcm_cache
        with wave.open(self._wav_path, "rb") as w:
            if w.getnchannels() != 1 or w.getframerate() != 16000 or w.getsampwidth() != 2:
                raise RuntimeError(
                    f"fixture WAV must be 16 kHz mono int16; got "
                    f"channels={w.getnchannels()} rate={w.getframerate()} "
                    f"sampwidth={w.getsampwidth()}: {self._wav_path}"
                )
            self._pcm_cache = w.readframes(w.getnframes())
        logger.info(
            "FixtureTTS: loaded %d bytes (%.2fs) from %s",
            len(self._pcm_cache),
            len(self._pcm_cache) / (16000 * 2),
            self._wav_path,
        )
        return self._pcm_cache

    async def synth(self, text_iter: AsyncIterator[str]) -> AsyncIterator[bytes]:
        """Drain text_iter (we ignore content but must consume it so the
        upstream coroutine completes), then stream the cached PCM in
        chunked frames."""
        # Drain the text iterator — the bridge expects us to consume it,
        # even if we don't synthesize from the actual text.
        async for _chunk in text_iter:
            pass
        pcm = self._load()
        for offset in range(0, len(pcm), _CHUNK_BYTES):
            yield pcm[offset:offset + _CHUNK_BYTES]
            # Tiny await keeps the event loop responsive between chunks
            # without artificially pacing the output (PCMTrack handles
            # real-time pacing on the consumer side).
            await asyncio.sleep(0)

    async def aclose(self) -> None:
        self._pcm_cache = None


def _factory(spec: ProviderSpec) -> TTSProvider:
    return FixtureTTS(spec)


register_tts_provider("fixture", _factory)
