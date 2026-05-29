"""B2 tests: items endpoint reads state.db as canonical body store,
joins sidekick.db.msg_links for sidekick_id / kind annotations.

This is the staged-behind-env-flag read path: when
``SIDEKICK_ITEMS_READ_FROM_STATE_DB=true`` is set, the items endpoint
calls ``list_messages_for_chat_with_state_db_source`` instead of the
v1 ``list_messages_for_chat`` (which reads sidekick.db.msg_links as
the body store).

Why v2 exists: v1's dual-body model (envelope write-through to
sidekick.db PLUS state.db backfill via reconcile) can leave the same
logical message stored twice when reconcile's content-match fails.
Surfaces as duplicate bubbles in the PWA (Jonathan field bug
2026-05-19, two "Hey — received." bubbles with mismatched timestamps).
v2 eliminates the dupe class structurally — state.db is the single
source of truth for bodies; sidekick.db's role narrows to linkage.
"""

from __future__ import annotations

import json
import sqlite3
import time

import pytest

from ..sidekick_db import SidekickDB
from .. import sidekick_state as state


CHAT_ID = "c0a01ab1-bee2-4d5e-6f70-8090a0b0c0d0"


@pytest.fixture
def db(tmp_path):
    db = SidekickDB(tmp_path / "sidekick.db")
    yield db
    db.close()


@pytest.fixture
def state_db(tmp_path):
    """Fake hermes state.db with sessions + messages tables."""
    path = tmp_path / "state.db"
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            user_id TEXT,
            system_prompt TEXT,
            parent_session_id TEXT,
            started_at REAL NOT NULL
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            tool_name TEXT,
            tool_call_id TEXT,
            tool_calls TEXT,
            timestamp REAL,
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );
        """
    )
    conn.commit()
    conn.close()
    return path


def _add_session(state_db, sid, chat_id=CHAT_ID, source="sidekick",
                 system_prompt=None, parent_session_id=None):
    conn = sqlite3.connect(str(state_db))
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, system_prompt, "
        "parent_session_id, started_at) VALUES (?, ?, ?, ?, ?, ?)",
        (sid, source, chat_id, system_prompt, parent_session_id, time.time()),
    )
    conn.commit()
    conn.close()


def _add_msg(state_db, sid, role, content, ts=None, tool_calls=None,
             tool_name=None, tool_call_id=None):
    conn = sqlite3.connect(str(state_db))
    cur = conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_name, "
        "tool_call_id, tool_calls, timestamp) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (sid, role, content, tool_name, tool_call_id, tool_calls,
         ts if ts is not None else time.time()),
    )
    msg_id = cur.lastrowid
    conn.commit()
    conn.close()
    return msg_id


# ── core wire shape ──────────────────────────────────────────────────


def test_v2_reads_state_db_messages_in_chronological_order(db, state_db):
    """state.db is the canonical body store. v2's recursive CTE + sort
    must return messages in timestamp-ascending order."""
    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "user", "first", ts=1000.0)
    _add_msg(state_db, "s1", "assistant", "second", ts=1001.0)
    _add_msg(state_db, "s1", "user", "third", ts=1002.0)

    result = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick"
    )
    contents = [i["content"] for i in result["items"]]
    assert contents == ["first", "second", "third"]
    assert result["has_more"] is False


def test_v2_surfaces_sidekick_id_when_link_exists(db, state_db):
    """sidekick.db.msg_links provides the sidekick_id annotation via
    its ``agent_row_id`` linkage to state.db.messages.id."""
    _add_session(state_db, "s1")
    state_msg_id = _add_msg(state_db, "s1", "assistant", "linked reply", ts=2000.0)
    state.upsert_msg_link(
        db, id="msg_real_xyz", chat_id=CHAT_ID, role="assistant",
        content="linked reply", agent_row_id=str(state_msg_id),
    )

    items = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick"
    )["items"]
    assert len(items) == 1
    assert items[0]["sidekick_id"] == "msg_real_xyz"
    assert items[0]["content"] == "linked reply"


def test_v2_handles_legacy_rows_with_no_link(db, state_db):
    """state.db rows without a sidekick.db.msg_links twin still surface
    — they just don't carry a sidekick_id. PWA falls back to integer-id
    keying for these (cross-channel / pre-write-through legacy rows)."""
    _add_session(state_db, "s1")
    _add_msg(state_db, "s1", "user", "legacy q", ts=1000.0)
    _add_msg(state_db, "s1", "assistant", "legacy a", ts=1001.0)

    items = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick"
    )["items"]
    assert len(items) == 2
    assert all("sidekick_id" not in i for i in items)
    assert items[0]["content"] == "legacy q"
    assert items[1]["content"] == "legacy a"


def test_v2_no_duplicate_rows_even_when_msg_links_has_extra_entries(db, state_db):
    """v2 is structurally immune to the 2026-05-19 dupe bug. Even if
    sidekick.db.msg_links has a row that doesn't correspond to a real
    state.db message (e.g. a stale row from a turn that got /retry'd
    out), v2 only returns one row per state.db.messages entry."""
    _add_session(state_db, "s1")
    state_msg_id = _add_msg(state_db, "s1", "assistant", "Hey — received.", ts=3000.0)
    # The "real" link.
    state.upsert_msg_link(
        db, id="msg_real_xyz", chat_id=CHAT_ID, role="assistant",
        content="Hey — received.", agent_row_id=str(state_msg_id),
    )
    # A stale or duplicate link with same content but no corresponding
    # state.db row (mimics what would have caused v1 to render twice).
    state.upsert_msg_link(
        db, id="legacy:999", chat_id=CHAT_ID, role="assistant",
        content="Hey — received.", agent_row_id="999",
    )

    items = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick"
    )["items"]
    assert len(items) == 1, (
        "v2 reads from state.db so it returns one row per logical "
        f"message; got {len(items)} items: {items}"
    )
    assert items[0]["sidekick_id"] == "msg_real_xyz"


# ── tool calls (must surface from state.db side) ─────────────────────


def test_v2_surfaces_tool_calls_from_state_db(db, state_db):
    """tool_calls JSON lives on state.db.messages. v2 surfaces it
    directly — PWA's parseToolCalls reads this for activity rows."""
    _add_session(state_db, "s1")
    tcalls = json.dumps(
        [{"id": "call_x", "function": {"name": "web_search", "arguments": "{}"}}]
    )
    _add_msg(state_db, "s1", "assistant", "", ts=1000.0, tool_calls=tcalls)
    _add_msg(state_db, "s1", "tool", "result data", ts=1001.0, tool_call_id="call_x")

    items = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick"
    )["items"]
    assert len(items) == 2
    assistant = [i for i in items if i["role"] == "assistant"][0]
    parsed = json.loads(assistant["tool_calls"])
    assert parsed[0]["function"]["name"] == "web_search"
    tool_row = [i for i in items if i["role"] == "tool"][0]
    assert tool_row["tool_call_id"] == "call_x"


# ── kind annotation (notifications) ──────────────────────────────────


def test_v2_surfaces_kind_from_msg_links(db, state_db):
    """msg_links.kind annotates notification-shaped rows so PWA
    renders them as notifications vs regular replies."""
    _add_session(state_db, "s1")
    state_msg_id = _add_msg(state_db, "s1", "assistant",
                            "Cronjob Response: ...", ts=4000.0)
    state.upsert_msg_link(
        db, id="notif_cron_1", chat_id=CHAT_ID, role="assistant",
        content="Cronjob Response: ...", agent_row_id=str(state_msg_id),
        kind="cron",
    )

    items = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick"
    )["items"]
    assert len(items) == 1
    assert items[0]["kind"] == "cron"
    assert items[0]["sidekick_id"] == "notif_cron_1"


# ── pagination ──────────────────────────────────────────────────────


def test_v2_pagination_limit_returns_recent_window_with_has_more(db, state_db):
    """No `before_id`, lots of rows → return the latest `limit` items
    with has_more=True. Cursor for the next page is the smallest id
    in the returned window."""
    _add_session(state_db, "s1")
    for i in range(20):
        _add_msg(state_db, "s1", "user", f"msg-{i}", ts=1000.0 + i)

    result = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick", limit=5
    )
    assert len(result["items"]) == 5
    assert result["has_more"] is True
    # Latest 5: msg-15..msg-19
    assert [i["content"] for i in result["items"]] == [f"msg-{n}" for n in range(15, 20)]


def test_v2_pagination_before_cursor_returns_older_window(db, state_db):
    """before_id is a state.db.messages.id cursor — older page."""
    _add_session(state_db, "s1")
    msg_ids = [_add_msg(state_db, "s1", "user", f"msg-{i}", ts=1000.0 + i)
               for i in range(20)]

    # Page through older history: cursor at msg-10's id.
    cursor = msg_ids[10]
    result = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick", limit=5, before_id=cursor
    )
    contents = [i["content"] for i in result["items"]]
    # Older than msg-10 → msg-5..msg-9 (5 most recent BEFORE the cursor).
    assert contents == [f"msg-{n}" for n in range(5, 10)]
    assert result["has_more"] is True


# ── compaction CTE (parent_session_id rollup) ────────────────────────


def test_v2_rolls_up_compacted_child_session_messages(db, state_db):
    """state.db compaction creates child sessions with user_id=NULL but
    parent_session_id pointing to the original. v2's recursive CTE
    walks the chain so child messages still surface under the chat_id."""
    parent_prompt = "x" * 250  # CTE requires >= 200 chars
    _add_session(state_db, "parent_s", system_prompt=parent_prompt)
    _add_session(state_db, "child_s", chat_id=None,
                 system_prompt=parent_prompt[:200] + "...",
                 parent_session_id="parent_s")
    _add_msg(state_db, "parent_s", "user", "old prompt", ts=1000.0)
    _add_msg(state_db, "parent_s", "assistant", "old reply", ts=1001.0)
    _add_msg(state_db, "child_s", "user", "new prompt in child", ts=2000.0)
    _add_msg(state_db, "child_s", "assistant", "new reply in child", ts=2001.0)

    items = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick"
    )["items"]
    contents = [i["content"] for i in items]
    assert contents == [
        "old prompt", "old reply",
        "new prompt in child", "new reply in child",
    ]


def test_v2_drops_compaction_seed_block(db, state_db):
    """The `[CONTEXT COMPACTION — REFERENCE ONLY]` marker + everything
    before it within a child session is the hermes-injected seed block.
    Must not surface to the PWA (verbatim user-prompt dupe avoidance,
    Jonathan field bug 2026-05-17)."""
    parent_prompt = "x" * 250
    _add_session(state_db, "parent_s", system_prompt=parent_prompt)
    _add_session(state_db, "child_s", chat_id=None,
                 system_prompt=parent_prompt[:200] + "...",
                 parent_session_id="parent_s")
    _add_msg(state_db, "parent_s", "user", "real prompt", ts=1000.0)
    _add_msg(state_db, "parent_s", "assistant", "real reply", ts=1001.0)
    # Child session's seed block — must be filtered.
    _add_msg(state_db, "child_s", "user", "real prompt", ts=1500.0)
    _add_msg(state_db, "child_s", "assistant", "real reply", ts=1500.0)
    _add_msg(state_db, "child_s", "user",
             "[CONTEXT COMPACTION — REFERENCE ONLY]", ts=1500.0)
    # Real continuation in child after the marker.
    _add_msg(state_db, "child_s", "user", "next real prompt", ts=2000.0)

    items = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick"
    )["items"]
    contents = [i["content"] for i in items]
    assert contents == ["real prompt", "real reply", "next real prompt"]


# ── 404-ish empty case ──────────────────────────────────────────────


def test_v2_returns_empty_for_unknown_chat(db, state_db):
    """No session exists for the chat_id → empty result, has_more=False.
    Caller (route handler) turns this into a 404 when combined with
    no inflight envelopes."""
    result = state.list_messages_for_chat_with_state_db_source(
        db, state_db, "unknown-chat-id", "sidekick"
    )
    assert result == {"items": [], "first_id": None, "has_more": False}


def test_v2_envelope_only_chat_still_surfaces_msg_links_rows(db, state_db):
    """**The 2026-05-29 field bug** Jonathan hit right after the B2 default
    flip:  brand-new chats and mid-turn streaming chats have envelope-
    written rows in msg_links but NO state.db rows yet (hermes flushes
    state.db at end of turn). v2's pure state.db read returned ZERO
    messages for these chats → activity-row drill said "no longer has a
    session," pinned messages couldn't open, all live-edge interactions
    on fresh chats broke.

    Contract: when state.db has nothing for a chat but msg_links has
    envelope-written rows, the read path must SURFACE THOSE ROWS — the
    union of state.db + unlinked envelope writes is what the user
    actually has. Otherwise the items endpoint is a strict subset of
    reality and breaks any consumer that addresses messages within the
    envelope-to-flush window."""
    # Envelope wrote three rows to sidekick.db (Phase-1 write-through).
    # State.db has nothing — agent hasn't post-turn-flushed yet.
    state.record_envelope(db, {
        "type": "user_message", "chat_id": CHAT_ID,
        "message_id": "umsg_fresh", "text": "kick off",
    })
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_fresh_1", "text": "Checking.",
    })
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_fresh_2", "text": "Done — answer is 42.",
    })
    result = state.list_messages_for_chat_with_state_db_source(
        db, state_db, CHAT_ID, "sidekick",
    )
    contents = [it["content"] for it in result["items"]]
    sks = [it.get("sidekick_id") for it in result["items"]]
    assert "kick off" in contents, \
        "envelope-only user message must surface even when state.db has nothing"
    assert "Checking." in contents
    assert "Done — answer is 42." in contents
    assert "umsg_fresh" in sks
    assert "msg_fresh_1" in sks
    assert "msg_fresh_2" in sks


def test_v2_returns_empty_when_state_db_missing(db, tmp_path):
    """state.db path doesn't exist on disk (fresh install, never used).
    Must return empty without raising."""
    missing = tmp_path / "does-not-exist.db"
    result = state.list_messages_for_chat_with_state_db_source(
        db, missing, CHAT_ID, "sidekick"
    )
    assert result == {"items": [], "first_id": None, "has_more": False}
