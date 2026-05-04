"""Unit tests for the user_id-keyed read path in the sidekick plugin.

Covers ``SidekickAdapter._summaries_by_user_id`` and
``SidekickAdapter._items_by_user_id`` against an in-temp-file SQLite
state.db that mirrors hermes-agent's schema.

What we exercise:

  * Drawer aggregate produces one row per (user_id, source) pair
    even when a chat has rotated through multiple session_ids.
  * History walks across rotated sessions for the same user_id —
    this is the core regression from the auto-reset bug where the
    old recursive parent_session_id CTE missed messages that lived
    in a session_reset-rotated session.
  * Source filter discriminates: telegram chat_id "1000000001" and
    a synthetic sidekick chat_id "1000000001" do NOT cross-contaminate
    even though they share the user_id string.
  * Sources allow-list controls which platforms appear in the drawer.
  * Index migration is idempotent (runs cleanly twice).

The plugin's hermes imports are stubbed exactly the same way as
``test_pdf_rasterize.py`` so we can construct the adapter without
the hermes runtime.
"""

from __future__ import annotations

import importlib.util
import sqlite3
import sys
import types
import time
from pathlib import Path

import pytest


# ── plugin loader (mirror of test_pdf_rasterize.py setup) ────────────

def _install_hermes_stubs() -> None:
    if "gateway" not in sys.modules:
        gateway = types.ModuleType("gateway")
        sys.modules["gateway"] = gateway

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
        "sidekick_plugin_under_test_user_id", plugin_init,
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def plugin():
    return _load_plugin()


# ── state.db fixture: hand-rolled minimal schema ────────────────────

# We don't import hermes-agent's schema — instead, we replicate the
# subset the plugin reads. (The real upstream schema has many more
# columns we don't use: token counts, billing, etc.) This keeps the
# test independent of upstream version drift.
_SCHEMA_SQL = """
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    user_id TEXT,
    parent_session_id TEXT,
    started_at REAL NOT NULL,
    title TEXT
);
CREATE INDEX idx_sessions_source ON sessions(source);

CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    content TEXT,
    tool_name TEXT,
    timestamp REAL NOT NULL
);
CREATE INDEX idx_messages_session ON messages(session_id, timestamp);
"""


@pytest.fixture
def state_db(tmp_path):
    """Build a fresh state.db for each test."""
    db = tmp_path / "state.db"
    conn = sqlite3.connect(db)
    conn.executescript(_SCHEMA_SQL)
    conn.commit()
    conn.close()
    return db


def _insert_session(
    db: Path, sid: str, source: str, user_id: str, started_at: float,
    title: str | None = None, parent: str | None = None,
) -> None:
    conn = sqlite3.connect(db)
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, parent_session_id, "
        "started_at, title) VALUES (?, ?, ?, ?, ?, ?)",
        (sid, source, user_id, parent, started_at, title),
    )
    conn.commit()
    conn.close()


def _insert_message(
    db: Path, session_id: str, role: str, content: str, ts: float,
    tool_name: str | None = None,
) -> int:
    conn = sqlite3.connect(db)
    cur = conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_name, timestamp) "
        "VALUES (?, ?, ?, ?, ?)",
        (session_id, role, content, tool_name, ts),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return new_id


def _make_adapter(plugin, state_db_path: Path):
    """Construct an adapter without going through __init__ (which
    needs PlatformConfig). We only exercise pure read methods, so
    bypassing the constructor is fine."""
    adapter = plugin.SidekickAdapter.__new__(plugin.SidekickAdapter)
    adapter._state_db_path = state_db_path
    return adapter


# ── tests ────────────────────────────────────────────────────────────


def test_drawer_aggregate_one_row_per_user_id(plugin, state_db):
    """Two sessions for the same user_id+source aggregate into one
    drawer row with summed message_count, latest title, oldest
    created_at, latest last_active_at, and first user message."""
    chat = "709fdd42-7d8c-4105-a1ce-977f3b56e77e"
    # Older session (Series A)
    _insert_session(state_db, "20260430_old", "sidekick", chat, 1000.0,
                    title="Series A Pitch Deck")
    _insert_message(state_db, "20260430_old", "user", "draft me a pitch deck for series A", 1001.0)
    for i in range(36):
        _insert_message(state_db, "20260430_old", "assistant", f"reply {i}", 1002.0 + i)
    # Newer session (Collaborative scratchpad) — auto-reset, no parent
    _insert_session(state_db, "20260501_new", "sidekick", chat, 2000.0,
                    title="Collaborative Pitch Deck")
    for i in range(28):
        _insert_message(state_db, "20260501_new", "user" if i == 0 else "assistant",
                        f"new {i}", 2001.0 + i)

    adapter = _make_adapter(plugin, state_db)
    rows = adapter._summaries_by_user_id(("sidekick",), 50)

    assert len(rows) == 1
    chat_id, source, chat_type, title, mcount, last_active, created, first = rows[0]
    assert chat_id == chat
    assert source == "sidekick"
    assert chat_type == "dm"
    # Title comes from the LATEST session
    assert title == "Collaborative Pitch Deck"
    # Total message_count across BOTH sessions
    assert mcount == 37 + 28
    # created_at is the OLDEST started_at
    assert created == 1000.0
    # last_active is the latest message timestamp
    assert last_active == 2001.0 + 27
    # first_user_message is the earliest user message in the chat
    assert first == "draft me a pitch deck for series A"


def test_history_walks_rotated_sessions(plugin, state_db):
    """The history fetch sees messages from BOTH rotated sessions
    even though the older one has no parent_session_id (session_reset
    case, not compression). This is the core regression fix."""
    chat = "709fdd42-7d8c-4105-a1ce-977f3b56e77e"
    _insert_session(state_db, "old", "sidekick", chat, 1000.0, title="Old")
    _insert_message(state_db, "old", "user", "first message", 1001.0)
    _insert_message(state_db, "old", "assistant", "first reply", 1002.0)
    # Auto-reset rotates: brand new session, parent=NULL
    _insert_session(state_db, "new", "sidekick", chat, 2000.0, title="New")
    _insert_message(state_db, "new", "user", "second message", 2001.0)
    _insert_message(state_db, "new", "assistant", "second reply", 2002.0)

    adapter = _make_adapter(plugin, state_db)
    result = adapter._items_by_user_id(chat, "sidekick", 200, None)
    assert result is not None
    items, _first_id, has_more = result
    assert has_more is False
    contents = [m["content"] for m in items]
    assert contents == ["first message", "first reply", "second message", "second reply"]


def test_source_filter_discriminates_collisions(plugin, state_db):
    """A telegram numeric chat_id and a (synthetic) sidekick chat_id
    that happen to share the same string don't cross-contaminate."""
    same_id = "1000000001"
    _insert_session(state_db, "tg", "telegram", same_id, 1000.0, title="TG")
    _insert_message(state_db, "tg", "user", "telegram-only", 1001.0)
    _insert_session(state_db, "sk", "sidekick", same_id, 2000.0, title="SK")
    _insert_message(state_db, "sk", "user", "sidekick-only", 2001.0)

    adapter = _make_adapter(plugin, state_db)

    # History side: each (user_id, source) returns its own messages.
    tg = adapter._items_by_user_id(same_id, "telegram", 200, None)
    sk = adapter._items_by_user_id(same_id, "sidekick", 200, None)
    assert tg is not None and sk is not None
    assert [m["content"] for m in tg[0]] == ["telegram-only"]
    assert [m["content"] for m in sk[0]] == ["sidekick-only"]

    # Drawer side: with a single source filter, only that source row appears.
    rows_sk_only = adapter._summaries_by_user_id(("sidekick",), 50)
    assert len(rows_sk_only) == 1
    assert rows_sk_only[0][0] == same_id
    assert rows_sk_only[0][1] == "sidekick"

    # With both sources, BOTH rows appear (one per source).
    rows_both = adapter._summaries_by_user_id(("sidekick", "telegram"), 50)
    sources_returned = sorted(r[1] for r in rows_both if r[0] == same_id)
    assert sources_returned == ["sidekick", "telegram"]


def test_drawer_sources_allowlist(plugin, state_db):
    """Sources NOT in the allow-list are filtered out."""
    _insert_session(state_db, "tg", "telegram", "tg_chat", 1000.0, title="TG")
    _insert_message(state_db, "tg", "user", "hi", 1001.0)
    _insert_session(state_db, "sk", "sidekick", "sk_chat", 2000.0, title="SK")
    _insert_message(state_db, "sk", "user", "hi", 2001.0)

    adapter = _make_adapter(plugin, state_db)
    rows_sk_only = adapter._summaries_by_user_id(("sidekick",), 50)
    assert [r[0] for r in rows_sk_only] == ["sk_chat"]

    rows_both = adapter._summaries_by_user_id(("sidekick", "telegram"), 50)
    assert sorted(r[0] for r in rows_both) == ["sk_chat", "tg_chat"]


def test_history_before_id_pagination(plugin, state_db):
    """before_id cursor returns only older messages."""
    _insert_session(state_db, "s1", "sidekick", "u", 1000.0, title="t")
    ids = []
    for i in range(10):
        ids.append(_insert_message(state_db, "s1", "user", f"m{i}", 1001.0 + i))

    adapter = _make_adapter(plugin, state_db)
    # Fetch latest 5 (no cursor)
    result = adapter._items_by_user_id("u", "sidekick", 5, None)
    assert result is not None
    items, first_id, has_more = result
    assert [m["content"] for m in items] == ["m5", "m6", "m7", "m8", "m9"]
    assert has_more is True
    # Page back from first_id
    result2 = adapter._items_by_user_id("u", "sidekick", 5, first_id)
    assert result2 is not None
    items2, _, has_more2 = result2
    assert [m["content"] for m in items2] == ["m0", "m1", "m2", "m3", "m4"]
    assert has_more2 is True  # exactly `limit` returned


def test_history_no_match_returns_none(plugin, state_db):
    adapter = _make_adapter(plugin, state_db)
    assert adapter._items_by_user_id("nonexistent", "sidekick", 50, None) is None


def test_history_skips_context_compaction_rows(plugin, state_db):
    _insert_session(state_db, "s1", "sidekick", "u", 1000.0)
    _insert_message(state_db, "s1", "user", "real", 1001.0)
    _insert_message(state_db, "s1", "system", "[CONTEXT COMPACTION] internal", 1002.0)
    _insert_message(state_db, "s1", "assistant", "real reply", 1003.0)
    adapter = _make_adapter(plugin, state_db)
    result = adapter._items_by_user_id("u", "sidekick", 50, None)
    assert result is not None
    items, _, _ = result
    assert [m["content"] for m in items] == ["real", "real reply"]


def test_drawer_orders_by_last_active_desc(plugin, state_db):
    _insert_session(state_db, "old", "sidekick", "old_chat", 1000.0, title="O")
    _insert_message(state_db, "old", "user", "old", 1001.0)
    _insert_session(state_db, "new", "sidekick", "new_chat", 2000.0, title="N")
    _insert_message(state_db, "new", "user", "new", 2001.0)
    adapter = _make_adapter(plugin, state_db)
    rows = adapter._summaries_by_user_id(("sidekick",), 50)
    assert [r[0] for r in rows] == ["new_chat", "old_chat"]


def test_drawer_includes_compression_forks_via_user_id(plugin, state_db):
    """parent_session_id chains (compression case) ALSO inherit user_id,
    so they're already covered by the (user_id, source) GROUP BY.
    Counts include both the root and the fork."""
    _insert_session(state_db, "root", "sidekick", "u", 1000.0, title="root")
    _insert_message(state_db, "root", "user", "rooted", 1001.0)
    _insert_session(state_db, "fork", "sidekick", "u", 2000.0, title="fork",
                    parent="root")
    _insert_message(state_db, "fork", "user", "forked", 2001.0)

    adapter = _make_adapter(plugin, state_db)
    rows = adapter._summaries_by_user_id(("sidekick",), 50)
    assert len(rows) == 1
    chat_id, _src, _ctype, title, mcount, last_active, created, _first = rows[0]
    assert chat_id == "u"
    assert title == "fork"  # latest started_at
    assert mcount == 2
    assert created == 1000.0
    assert last_active == 2001.0


def test_index_migration_idempotent(plugin, state_db):
    """Running the index migration twice is a no-op."""
    adapter = _make_adapter(plugin, state_db)
    adapter._ensure_state_db_indexes()
    adapter._ensure_state_db_indexes()
    # Verify the index actually exists
    conn = sqlite3.connect(state_db)
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name=?",
        ("idx_sessions_user_id_source",),
    )
    assert cur.fetchone() is not None
    conn.close()


def test_drawer_first_user_message_truncated_to_80_chars(plugin, state_db):
    long_msg = "x" * 200
    _insert_session(state_db, "s1", "sidekick", "u", 1000.0)
    _insert_message(state_db, "s1", "user", long_msg, 1001.0)
    adapter = _make_adapter(plugin, state_db)
    rows = adapter._summaries_by_user_id(("sidekick",), 50)
    assert len(rows) == 1
    first_user = rows[0][7]
    assert first_user is not None
    assert len(first_user) == 80


def test_drawer_excludes_null_user_id_sessions(plugin, state_db):
    """Sessions with NULL user_id (legacy / non-platform sessions)
    should not appear in the drawer."""
    _insert_session(state_db, "s1", "sidekick", None, 1000.0, title="orphan")
    _insert_message(state_db, "s1", "user", "hi", 1001.0)
    _insert_session(state_db, "s2", "sidekick", "u", 2000.0, title="real")
    _insert_message(state_db, "s2", "user", "hi", 2001.0)
    adapter = _make_adapter(plugin, state_db)
    rows = adapter._summaries_by_user_id(("sidekick",), 50)
    assert [r[0] for r in rows] == ["u"]


# ── Gateway id encoding (contract uniqueness across sources) ─────────


def test_format_gateway_id_round_trip(plugin):
    """Encode/decode round-trip preserves source and chat_id, including
    chat_ids with `@` and other platform-shaped characters."""
    cases = [
        ("sidekick", "709fdd42-7d8c-4105-a1ce-977f3b56e77e"),
        ("whatsapp", "199999999999999@lid"),
        ("whatsapp", "15551234567@s.whatsapp.net"),
        ("telegram", "1000000001"),
    ]
    for source, chat_id in cases:
        encoded = plugin._format_gateway_id(source, chat_id)
        parsed_source, parsed_chat = plugin._parse_gateway_id(encoded)
        assert parsed_source == source
        assert parsed_chat == chat_id


def test_parse_gateway_id_rejects_unknown_prefix(plugin):
    """A bare chat_id (no prefix) returns (None, id_str). A string with
    a colon whose prefix is NOT a known source is also treated as bare —
    defensive against future chat_id formats containing colons."""
    assert plugin._parse_gateway_id("199999999999999@lid") == (None, "199999999999999@lid")
    assert plugin._parse_gateway_id("notasource:something") == (None, "notasource:something")


def test_gateway_id_unique_for_cross_source_chat_id_collision(plugin, state_db):
    """The smoking-gun regression: two sessions sharing user_id but
    differing in source must produce DISTINCT gateway ids when the
    drawer aggregate is encoded for the on-the-wire response. Before
    this fix, both rows emitted `id = chat_id` and the frontend
    rendered two LIs with the same `data-chat-id` (click activated
    both, history fetched the wrong one)."""
    same_id = "199999999999999@lid"
    _insert_session(state_db, "wa", "whatsapp", same_id, 1000.0, title="WhatsApp thread")
    _insert_message(state_db, "wa", "user", "voice memo", 1001.0)
    _insert_session(state_db, "sk", "sidekick", same_id, 2000.0, title="Barge in test")
    _insert_message(state_db, "sk", "user", "cookies?", 2001.0)

    adapter = _make_adapter(plugin, state_db)
    rows = adapter._summaries_by_user_id(("sidekick", "whatsapp"), 50)
    assert len(rows) == 2
    encoded_ids = [plugin._format_gateway_id(src, cid) for cid, src, *_ in rows]
    assert len(set(encoded_ids)) == 2
    assert "sidekick:199999999999999@lid" in encoded_ids
    assert "whatsapp:199999999999999@lid" in encoded_ids


def test_delete_conversation_sync_source_aware(plugin, state_db):
    """Deleting `(whatsapp, chat_id)` must scrub the whatsapp session
    rows ONLY — not the sidekick rows that share the same user_id.
    Previously _delete_conversation_sync hardcoded source=sidekick
    and would silently delete the wrong rows for cross-source
    collisions."""
    same_id = "199999999999999@lid"
    _insert_session(state_db, "wa", "whatsapp", same_id, 1000.0, title="WA")
    _insert_message(state_db, "wa", "user", "wa-msg", 1001.0)
    _insert_session(state_db, "sk", "sidekick", same_id, 2000.0, title="SK")
    _insert_message(state_db, "sk", "user", "sk-msg", 2001.0)

    adapter = _make_adapter(plugin, state_db)
    result = adapter._delete_conversation_sync(same_id, "whatsapp")
    assert result == "ok"

    # Whatsapp session gone, sidekick session intact.
    conn = sqlite3.connect(state_db)
    rows = conn.execute(
        "SELECT id, source FROM sessions WHERE user_id = ?", (same_id,),
    ).fetchall()
    conn.close()
    assert sorted(rows) == [("sk", "sidekick")]


def test_delete_conversation_sync_default_source_back_compat(plugin, state_db):
    """Calling _delete_conversation_sync without a source still defaults
    to SIDEKICK_SOURCE — preserves behavior for any legacy un-prefixed
    delete callers."""
    _insert_session(state_db, "sk", "sidekick", "u", 1000.0, title="SK")
    _insert_message(state_db, "sk", "user", "hi", 1001.0)
    adapter = _make_adapter(plugin, state_db)
    result = adapter._delete_conversation_sync("u")
    assert result == "ok"


# ── Rename (PATCH /v1/conversations/{id}) ────────────────────────────


def test_rename_conversation_sync_updates_title(plugin, state_db):
    """Happy path: PATCH-driven rename rewrites sessions.title for the
    `(source, user_id)` pair and is visible via the drawer aggregate."""
    chat = "709fdd42-7d8c-4105-a1ce-977f3b56e77e"
    _insert_session(state_db, "s1", "sidekick", chat, 1000.0, title="auto-title")
    _insert_message(state_db, "s1", "user", "hi", 1001.0)

    adapter = _make_adapter(plugin, state_db)
    result = adapter._rename_conversation_sync(chat, "sidekick", "Bug bash")
    assert result == "ok"

    # Verify state.db was actually written.
    conn = sqlite3.connect(state_db)
    rows = conn.execute(
        "SELECT title FROM sessions WHERE user_id = ? AND source = ?",
        (chat, "sidekick"),
    ).fetchall()
    conn.close()
    assert rows == [("Bug bash",)]

    # And the drawer surfaces the new title via _summaries_by_user_id.
    drawer = adapter._summaries_by_user_id(("sidekick",), 50)
    assert len(drawer) == 1
    assert drawer[0][3] == "Bug bash"


def test_rename_conversation_sync_updates_only_latest_session(plugin, state_db):
    """A chat with rotated sessions (compression / auto-reset) only
    has the LATEST row's title updated. We can't rewrite all rotated
    rows to the same title because hermes-agent's real schema has a
    partial UNIQUE INDEX on ``sessions(title) WHERE title IS NOT
    NULL``; the drawer's ``_summaries_by_user_id`` picks the latest
    title via ``ORDER BY started_at DESC LIMIT 1`` so this is the
    row that surfaces in the UI."""
    chat = "u"
    _insert_session(state_db, "old", "sidekick", chat, 1000.0, title="old-auto")
    _insert_message(state_db, "old", "user", "msg1", 1001.0)
    _insert_session(state_db, "new", "sidekick", chat, 2000.0, title="new-auto")
    _insert_message(state_db, "new", "user", "msg2", 2001.0)

    adapter = _make_adapter(plugin, state_db)
    result = adapter._rename_conversation_sync(chat, "sidekick", "Renamed")
    assert result == "ok"

    conn = sqlite3.connect(state_db)
    rows = conn.execute(
        "SELECT id, title FROM sessions WHERE user_id = ? AND source = ?"
        " ORDER BY id",
        (chat, "sidekick"),
    ).fetchall()
    conn.close()
    # Only the latest (started_at=2000) row is updated.
    assert rows == [("new", "Renamed"), ("old", "old-auto")]

    # Drawer surfaces the updated title regardless.
    drawer = adapter._summaries_by_user_id(("sidekick",), 50)
    assert len(drawer) == 1
    assert drawer[0][3] == "Renamed"


def test_rename_conversation_sync_title_conflict(plugin, state_db):
    """If another session already holds this title, return
    'title_conflict' (route surfaces 409). Models the partial UNIQUE
    INDEX in hermes-agent's real schema."""
    # Build a state.db with the same partial UNIQUE INDEX hermes-agent
    # ships. The base fixture omits it because most tests don't need
    # it; we add it here so the rename helper's pre-check actually
    # has a competitor to find.
    conn = sqlite3.connect(state_db)
    conn.execute(
        "CREATE UNIQUE INDEX idx_sessions_title_unique "
        "ON sessions(title) WHERE title IS NOT NULL"
    )
    conn.commit()
    conn.close()

    _insert_session(state_db, "a", "sidekick", "chat-a", 1000.0, title="Series A")
    _insert_message(state_db, "a", "user", "hi", 1001.0)
    _insert_session(state_db, "b", "sidekick", "chat-b", 2000.0, title="Series B")
    _insert_message(state_db, "b", "user", "hi", 2001.0)

    adapter = _make_adapter(plugin, state_db)
    result = adapter._rename_conversation_sync("chat-b", "sidekick", "Series A")
    assert result == "title_conflict"

    # Original row untouched.
    conn = sqlite3.connect(state_db)
    rows = conn.execute(
        "SELECT id, title FROM sessions ORDER BY id",
    ).fetchall()
    conn.close()
    assert rows == [("a", "Series A"), ("b", "Series B")]


def test_rename_conversation_sync_idempotent_same_title(plugin, state_db):
    """Renaming to the title the row already has is a no-op success,
    NOT a conflict — the latest row matches its own title."""
    chat = "u"
    _insert_session(state_db, "s1", "sidekick", chat, 1000.0, title="Existing")
    _insert_message(state_db, "s1", "user", "hi", 1001.0)

    adapter = _make_adapter(plugin, state_db)
    result = adapter._rename_conversation_sync(chat, "sidekick", "Existing")
    assert result == "ok"


def test_rename_conversation_sync_not_found(plugin, state_db):
    """No session for `(source, user_id)` → 'not_found' (route
    surfaces 404)."""
    adapter = _make_adapter(plugin, state_db)
    result = adapter._rename_conversation_sync(
        "nonexistent", "sidekick", "Whatever",
    )
    assert result == "not_found"


def test_rename_conversation_sync_source_isolation(plugin, state_db):
    """Renaming `(sidekick, chat_id)` doesn't touch a `(whatsapp,
    chat_id)` row that happens to share the same user_id string."""
    same_id = "199999999999999@lid"
    _insert_session(state_db, "wa", "whatsapp", same_id, 1000.0, title="WA-orig")
    _insert_message(state_db, "wa", "user", "wa", 1001.0)
    _insert_session(state_db, "sk", "sidekick", same_id, 2000.0, title="SK-orig")
    _insert_message(state_db, "sk", "user", "sk", 2001.0)

    adapter = _make_adapter(plugin, state_db)
    result = adapter._rename_conversation_sync(same_id, "sidekick", "SK-new")
    assert result == "ok"

    conn = sqlite3.connect(state_db)
    rows = conn.execute(
        "SELECT id, source, title FROM sessions WHERE user_id = ?"
        " ORDER BY id",
        (same_id,),
    ).fetchall()
    conn.close()
    assert rows == [
        ("sk", "sidekick", "SK-new"),
        ("wa", "whatsapp", "WA-orig"),
    ]


def test_session_title_max_len_constant(plugin):
    """Document the cap so a future bump doesn't silently lose data."""
    assert plugin.SESSION_TITLE_MAX_LEN == 200
