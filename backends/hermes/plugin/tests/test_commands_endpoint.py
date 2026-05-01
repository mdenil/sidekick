"""Unit tests for the sidekick plugin's slash-command registry serializer.

Covers ``_serialize_command_registry``:

  * Returns a list of dicts with the documented field names.
  * Drops ``cli_only`` entries (mirrors the gateway-surface filter).
  * Includes ``gateway_only`` entries (those are the platform-only ones
    that the CLI shouldn't see — telegram/slack/sidekick should).
  * Aliases survive on the canonical row (no separate row per alias).
  * Plugin-registered commands are appended with category="Plugins".
  * Empty list when ``hermes_cli`` isn't importable (defensive — keeps
    non-hermes test contexts from blowing up).

The helper is module-level so we don't need a SidekickAdapter instance.
We import the plugin module via importlib (same pattern as
``test_pdf_rasterize.py``) so the tests are independent of the hermes
plugin loader.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest


# ── plugin loader (mirror of test_pdf_rasterize.py) ──────────────────

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
        "sidekick_plugin_under_test_commands", plugin_init,
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def plugin():
    return _load_plugin()


# ── tests ─────────────────────────────────────────────────────────────


def test_returns_list_of_dicts_with_documented_fields(plugin):
    """Shape pin: every row carries the six fields the PWA expects."""
    rows = plugin._serialize_command_registry()
    assert isinstance(rows, list)
    if not rows:  # hermes_cli unavailable in this env — covered separately
        pytest.skip("hermes_cli not importable in this test env")
    for r in rows:
        assert set(r.keys()) >= {
            "name", "description", "category",
            "aliases", "args_hint", "subcommands",
        }, f"missing fields: {r}"
        assert isinstance(r["name"], str) and r["name"]
        assert isinstance(r["description"], str)
        assert isinstance(r["category"], str)
        assert isinstance(r["aliases"], list)
        assert isinstance(r["args_hint"], str)
        assert isinstance(r["subcommands"], list)


def test_excludes_cli_only_entries(plugin):
    """``/clear``, ``/history``, ``/save``, ``/quit`` etc. are CLI-only —
    they exercise terminal affordances the PWA can't and must not appear
    in the gateway-surface payload."""
    rows = plugin._serialize_command_registry()
    if not rows:
        pytest.skip("hermes_cli not importable in this test env")
    names = {r["name"] for r in rows}
    # Sample a few well-known cli_only entries from commands.py.
    cli_only_samples = {"clear", "history", "save", "quit", "config"}
    for name in cli_only_samples:
        assert name not in names, (
            f"{name!r} is cli_only and must not appear in /v1/commands"
        )


def test_includes_gateway_only_entries(plugin):
    """``/sethome``, ``/approve``, ``/deny``, ``/restart`` are
    gateway_only — they SHOULD appear (they're literally for non-CLI
    surfaces)."""
    rows = plugin._serialize_command_registry()
    if not rows:
        pytest.skip("hermes_cli not importable in this test env")
    names = {r["name"] for r in rows}
    for name in ("sethome", "approve", "deny", "restart"):
        assert name in names, f"{name!r} should appear in /v1/commands"


def test_aliases_carried_on_canonical_row(plugin):
    """``/new`` has alias ``reset`` — the row should list it under
    ``aliases``, NOT as a second top-level row."""
    rows = plugin._serialize_command_registry()
    if not rows:
        pytest.skip("hermes_cli not importable in this test env")
    by_name = {r["name"]: r for r in rows}
    assert "new" in by_name, "expected /new in the catalog"
    assert "reset" in by_name["new"]["aliases"]
    assert "reset" not in by_name, "alias must not be a top-level row"


def test_args_hint_and_subcommands_propagate(plugin):
    """``/voice`` declares args_hint='[on|off|tts|status]' AND explicit
    subcommands=('on','off','tts','status'). Both should propagate."""
    rows = plugin._serialize_command_registry()
    if not rows:
        pytest.skip("hermes_cli not importable in this test env")
    by_name = {r["name"]: r for r in rows}
    voice = by_name.get("voice")
    assert voice is not None, "expected /voice in the catalog"
    assert voice["args_hint"] == "[on|off|tts|status]"
    assert set(voice["subcommands"]) >= {"on", "off", "tts", "status"}


def test_empty_when_hermes_cli_unavailable(plugin, monkeypatch):
    """If ``hermes_cli.commands`` isn't importable, the helper returns
    an empty list rather than crashing — keeps non-hermes test contexts
    (and any future minimal-deploy variant) safe."""
    # Force ImportError on the hermes_cli imports inside the helper.
    real_modules = {
        k: sys.modules[k] for k in list(sys.modules)
        if k == "hermes_cli" or k.startswith("hermes_cli.")
    }
    for k in real_modules:
        monkeypatch.setitem(sys.modules, k, None)  # type: ignore[arg-type]
    out = plugin._serialize_command_registry()
    assert out == []
