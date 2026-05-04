"""Unit tests for the cross-device user-message broadcast.

When a user dispatches a message via ``POST /v1/responses``, the plugin
emits a ``user_message`` envelope BEFORE the agent dispatch so other
connected PWA tabs render the user bubble immediately. Without this,
only the agent's reply propagated to other devices and the user's own
message was invisible until manual refresh.

Covers ``SidekickAdapter._handle_responses``:

  * Envelope is emitted with the documented shape
    (type, chat_id, message_id, text).
  * Envelope fires BEFORE ``_dispatch_message`` is invoked.
  * PWA-supplied ``user_message_id`` from the request body is
    propagated into the envelope (originating-device dedup hinges on
    this).
  * Server mints a fallback id when the field is absent (back-compat
    for raw OAI third-parties / legacy clients).

The plugin's hermes imports are stubbed exactly the same way as
``test_pdf_rasterize.py`` so the tests run without a hermes-agent
install on PYTHONPATH.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import types
from pathlib import Path
from unittest import mock

import pytest


# ── plugin loader (mirror of test_pdf_rasterize.py setup) ────────────

def _install_hermes_stubs() -> None:
    if "gateway" not in sys.modules:
        sys.modules["gateway"] = types.ModuleType("gateway")
    if "gateway.config" not in sys.modules:
        cfg = types.ModuleType("gateway.config")

        class _Platform:
            SIDEKICK = "sidekick"

        class _PlatformConfig:
            pass

        cfg.Platform = _Platform
        cfg.PlatformConfig = _PlatformConfig
        sys.modules["gateway.config"] = cfg
    if "gateway.platforms" not in sys.modules:
        sys.modules["gateway.platforms"] = types.ModuleType("gateway.platforms")
    if "gateway.platforms.base" not in sys.modules:
        base = types.ModuleType("gateway.platforms.base")

        class _BasePlatformAdapter:
            pass

        class _MessageEvent:
            pass

        class _MessageType:
            TEXT = "text"

        class _SendResult:
            pass

        base.BasePlatformAdapter = _BasePlatformAdapter
        base.MessageEvent = _MessageEvent
        base.MessageType = _MessageType
        base.SendResult = _SendResult
        sys.modules["gateway.platforms.base"] = base


def _load_plugin():
    _install_hermes_stubs()
    plugin_init = Path(__file__).resolve().parents[1] / "__init__.py"
    spec = importlib.util.spec_from_file_location(
        "sidekick_plugin_under_test_user_message", plugin_init,
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def plugin():
    return _load_plugin()


# ── adapter + request stubs ──────────────────────────────────────────


def _make_adapter(plugin):
    """Bypass __init__ so we don't need PlatformConfig / aiohttp wiring.
    We patch _safe_send_envelope and _check_http_auth + _dispatch_message
    on the instance to capture the call sequence."""
    adapter = plugin.SidekickAdapter.__new__(plugin.SidekickAdapter)
    # Minimum state _handle_responses touches before our patches kick in.
    adapter._turn_queues = {}
    return adapter


class _FakeRequest:
    """Minimal aiohttp.web.Request stand-in — _handle_responses only
    calls .json() and indirectly _check_http_auth (which we patch)."""

    def __init__(self, body: dict):
        self._body = body

    async def json(self):
        return self._body


async def _drive_handle_responses(plugin, body: dict):
    """Call _handle_responses with the auth + dispatch + streaming-write
    paths neutered. Returns the captured envelopes (in order) and the
    list of dispatch calls."""
    adapter = _make_adapter(plugin)
    sent: list[dict] = []
    dispatched: list[dict] = []

    async def fake_send_envelope(env):
        # Capture a snapshot — caller may mutate after.
        sent.append(dict(env))
        return True

    async def fake_dispatch_message(*, chat_id, text, attachments=None):
        dispatched.append({
            "chat_id": chat_id, "text": text, "attachments": attachments,
        })

    adapter._safe_send_envelope = fake_send_envelope
    adapter._dispatch_message = fake_dispatch_message
    adapter._check_http_auth = lambda req: True

    # Force the streaming path to terminate immediately by patching
    # _handle_responses_streaming. We want to assert what happened
    # BEFORE the dispatch, not exercise the full SSE stream.
    async def fake_streaming(*args, **kwargs):
        return mock.MagicMock(name="StreamResponse")

    async def fake_blocking(*args, **kwargs):
        return mock.MagicMock(name="Response")

    adapter._handle_responses_streaming = fake_streaming
    adapter._handle_responses_blocking = fake_blocking

    req = _FakeRequest(body)
    await adapter._handle_responses(req)
    return sent, dispatched


# ── tests ────────────────────────────────────────────────────────────


def test_user_message_envelope_emitted_with_documented_shape(plugin):
    """The envelope carries type, chat_id, message_id, and text."""
    sent, _ = asyncio.run(_drive_handle_responses(plugin, {
        "conversation": "abc-123",
        "input": "hello world",
        "stream": True,
        "user_message_id": "umsg_pwa_supplied_xyz",
    }))
    user_envs = [e for e in sent if e.get("type") == "user_message"]
    assert len(user_envs) == 1, f"expected exactly one user_message envelope, got {sent}"
    env = user_envs[0]
    assert env["type"] == "user_message"
    assert env["chat_id"] == "abc-123"
    assert env["message_id"] == "umsg_pwa_supplied_xyz"
    assert env["text"] == "hello world"


def test_user_message_envelope_fires_before_dispatch(plugin):
    """Order matters: emission must happen BEFORE _dispatch_message
    so other PWA tabs paint the bubble before any reply_delta lands."""
    # We instrument both _safe_send_envelope and _dispatch_message to
    # share a single ordering log.
    plugin_mod = plugin
    adapter = _make_adapter(plugin_mod)
    order: list[str] = []

    async def tracking_send(env):
        if env.get("type") == "user_message":
            order.append("user_message")
        return True

    async def tracking_dispatch(*, chat_id, text, attachments=None):
        order.append("dispatch")

    adapter._safe_send_envelope = tracking_send
    adapter._dispatch_message = tracking_dispatch
    adapter._check_http_auth = lambda req: True

    async def fake_streaming(*args, **kwargs):
        # Simulate the dispatch the streaming path would normally
        # schedule — _handle_responses_streaming kicks off
        # _dispatch_message via asyncio.create_task internally.
        await tracking_dispatch(chat_id=args[1], text=args[2])
        return mock.MagicMock()

    adapter._handle_responses_streaming = fake_streaming
    adapter._handle_responses_blocking = mock.AsyncMock()

    req = _FakeRequest({
        "conversation": "ord-1", "input": "hi", "stream": True,
    })
    asyncio.run(adapter._handle_responses(req))

    # Envelope MUST come first.
    assert order[:2] == ["user_message", "dispatch"], (
        f"expected user_message before dispatch, got {order}"
    )


def test_user_message_id_minted_when_absent(plugin):
    """Back-compat: clients that don't pre-mint a user_message_id still
    get a server-allocated one. They just won't dedup against the
    broadcast (single-device by definition)."""
    sent, _ = asyncio.run(_drive_handle_responses(plugin, {
        "conversation": "noid-chat",
        "input": "hey",
        "stream": True,
    }))
    user_envs = [e for e in sent if e.get("type") == "user_message"]
    assert len(user_envs) == 1
    mid = user_envs[0]["message_id"]
    assert isinstance(mid, str) and mid, "expected non-empty server-minted message_id"
    assert mid.startswith("umsg_"), f"expected umsg_ prefix, got {mid!r}"


def test_user_message_envelope_uses_voice_prefixed_text(plugin):
    """`voice: true` causes the plugin to prepend `[voice] ` to text
    before dispatch. The user_message envelope should reflect what we
    actually fed the agent so other-device bubbles match what got sent."""
    sent, _ = asyncio.run(_drive_handle_responses(plugin, {
        "conversation": "voice-1",
        "input": "remind me later",
        "voice": True,
        "stream": True,
    }))
    user_envs = [e for e in sent if e.get("type") == "user_message"]
    assert len(user_envs) == 1
    assert user_envs[0]["text"].startswith("[voice]"), (
        f"expected [voice] prefix in broadcast text, got {user_envs[0]['text']!r}"
    )
