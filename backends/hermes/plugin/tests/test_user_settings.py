"""Synced user settings (sidekick.db ``user_settings``).

Covers the storage helpers (``get_user_setting`` / ``set_user_setting`` /
``list_user_settings``) and the ``/v1/user-settings`` route handler that
the PWA's cross-device settings (STT key-terms today) ride on.

Pins down:
  - get returns the fallback for an absent key, the stored JSON otherwise
  - set upserts (insert then update same key) and stamps updated_at
  - list returns the whole {key: value} map with JSON decoded
  - values can be scalars, objects, AND lists (key-terms = a JSON array)
  - the route handler: GET → {settings: {...}}, POST → upsert + echo
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from ..sidekick_db import SidekickDB
from .. import sidekick_state as state
from ..sidekick_routes import handle_user_settings


@pytest.fixture
def db(tmp_path):
    db = SidekickDB(tmp_path / "sidekick.db")
    yield db
    db.close()


class FakeRequest:
    def __init__(self, method, body=None):
        self.method = method
        self._body = body or {}

    async def json(self):
        return self._body


def _body(resp):
    return json.loads(resp.text)


def test_get_missing_returns_fallback(db):
    assert state.get_user_setting(db, "nope") is None
    assert state.get_user_setting(db, "nope", fallback=[]) == []


def test_set_then_get_roundtrips_list(db):
    state.set_user_setting(db, "stt_keyterms", ["Deepgram", "Sidekick"])
    assert state.get_user_setting(db, "stt_keyterms") == ["Deepgram", "Sidekick"]


def test_set_upserts_and_stamps_updated_at(db):
    state.set_user_setting(db, "theme", "dark")
    row1 = db.fetchone("SELECT value, updated_at FROM user_settings WHERE key = ?", ("theme",))
    assert json.loads(row1["value"]) == "dark"
    assert row1["updated_at"] > 0

    state.set_user_setting(db, "theme", "light")
    rows = db.fetchall("SELECT key FROM user_settings WHERE key = ?", ("theme",))
    assert len(rows) == 1  # upsert, not a second row
    assert state.get_user_setting(db, "theme") == "light"


def test_value_can_be_object(db):
    state.set_user_setting(db, "vad", {"silence_ms": 800, "barge": True})
    assert state.get_user_setting(db, "vad") == {"silence_ms": 800, "barge": True}


def test_list_returns_decoded_map(db):
    state.set_user_setting(db, "stt_keyterms", ["a", "b"])
    state.set_user_setting(db, "theme", "dark")
    assert state.list_user_settings(db) == {
        "stt_keyterms": ["a", "b"],
        "theme": "dark",
    }


def test_route_get_returns_settings_map(db):
    state.set_user_setting(db, "stt_keyterms", ["Hermes"])
    ctx = SimpleNamespace(db=db)
    resp = asyncio.run(handle_user_settings(ctx, FakeRequest("GET")))
    assert resp.status == 200
    assert _body(resp) == {"settings": {"stt_keyterms": ["Hermes"]}}


def test_route_post_upserts_and_echoes(db):
    ctx = SimpleNamespace(db=db)
    resp = asyncio.run(handle_user_settings(
        ctx, FakeRequest("POST", {"key": "stt_keyterms", "value": ["x", "y"]})
    ))
    assert resp.status == 200
    assert _body(resp) == {"ok": True, "key": "stt_keyterms", "value": ["x", "y"]}
    assert state.get_user_setting(db, "stt_keyterms") == ["x", "y"]


def test_route_post_missing_key_is_400(db):
    ctx = SimpleNamespace(db=db)
    resp = asyncio.run(handle_user_settings(ctx, FakeRequest("POST", {"value": 1})))
    assert resp.status == 400


def test_route_post_empty_list_clears_not_seeds(db):
    """An explicit [] is a distinct, persisted state — NOT 'never saved'.
    The frontend relies on this to respect a cleared key-terms list."""
    ctx = SimpleNamespace(db=db)
    asyncio.run(handle_user_settings(
        ctx, FakeRequest("POST", {"key": "stt_keyterms", "value": []})
    ))
    assert state.get_user_setting(db, "stt_keyterms", fallback="sentinel") == []
