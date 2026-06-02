from __future__ import annotations

import json
import sqlite3
import time

import pytest

from ..sidekick_db import SidekickDB
from .. import sidekick_state as state
from ..sidekick_unread import compute_unread


CHAT_ID = "c0a01ab1-bee2-4d5e-6f70-8090a0b0c0d0"


@pytest.fixture
def db(tmp_path):
    db = SidekickDB(tmp_path / "sidekick.db")
    yield db
    db.close()


@pytest.fixture
def state_db(tmp_path):
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


def _add_session(state_db, sid, chat_id=CHAT_ID, source="sidekick"):
    conn = sqlite3.connect(str(state_db))
    conn.execute(
        "INSERT INTO sessions (id, source, user_id, system_prompt, "
        "parent_session_id, started_at) VALUES (?, ?, ?, ?, ?, ?)",
        (sid, source, chat_id, None, None, time.time()),
    )
    conn.commit()
    conn.close()


def _add_msg(state_db, sid, role, content, ts, tool_calls=None,
             tool_name=None, tool_call_id=None):
    conn = sqlite3.connect(str(state_db))
    conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_name, "
        "tool_call_id, tool_calls, timestamp) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (sid, role, content, tool_name, tool_call_id, tool_calls, ts),
    )
    conn.commit()
    conn.close()


def test_unread_counts_envelope_only_reply_before_state_db_flush(db, state_db):
    """Agent emits a short "Checking." quick-ack reply on an off-screen
    chat. PWA upserts the activity row + bumps badge.incrementUnread,
    then refreshes from server via /api/sidekick/notifications/unread.
    The server-side compute_unread used to count state.db assistant rows
    ONLY — but the envelope just arrived; hermes hasn't post-turn-
    flushed yet, so state.db has nothing for this chat. compute_unread
    returned 0; badge.ts:109's auto-markAllRead fired and nuked the
    activity row as "stale." Full reply arrived later → state.db was
    flushed by then → badge bumped correctly. Hence the asymmetry:
    short reply silent, full reply badges.

    Contract: a final-status envelope assistant row (msg_links row with
    status='final', non-NULL tool_calls excluded) must count toward
    unread regardless of whether state.db has caught up yet. msg_links
    is the canonical source of truth for "what messages exist."
    """
    # No state.db session for this chat yet — agent hasn't flushed.
    # Envelope path has written the reply to msg_links.
    state.record_envelope(db, {
        "type": "reply_final", "chat_id": CHAT_ID,
        "message_id": "msg_pre_flush", "text": "Checking.",
    })
    unread = compute_unread(db=db, state_db_path=state_db, source="sidekick")
    chat_ids = [c["chat_id"] for c in unread["chats"]]
    assert f"sidekick:{CHAT_ID}" in chat_ids, \
        f"envelope-only chat must surface in unread set; got {chat_ids}"
    target = next(c for c in unread["chats"] if c["chat_id"] == f"sidekick:{CHAT_ID}")
    assert target["unread_count"] >= 1, \
        f"unread_count should be ≥1 for envelope-only reply, got {target['unread_count']}"
    assert unread["total"] >= 1


def test_unread_counts_final_replies_not_tool_call_activity(db, state_db):
    _add_session(state_db, "s1")
    tool_calls = json.dumps([
        {"id": "call_1", "function": {"name": "web_search", "arguments": "{}"}},
        {"id": "call_2", "function": {"name": "fetch", "arguments": "{}"}},
        {"id": "call_3", "function": {"name": "summarize", "arguments": "{}"}},
    ])
    _add_msg(state_db, "s1", "assistant", "", ts=1001.0, tool_calls=tool_calls)
    _add_msg(state_db, "s1", "tool", "result 1", ts=1002.0, tool_call_id="call_1")
    _add_msg(state_db, "s1", "tool", "result 2", ts=1003.0, tool_call_id="call_2")
    _add_msg(state_db, "s1", "tool", "result 3", ts=1004.0, tool_call_id="call_3")
    _add_msg(state_db, "s1", "assistant", "final answer", ts=1005.0)

    unread = compute_unread(db=db, state_db_path=state_db, source="sidekick")

    assert unread == {
        "chats": [{
            "chat_id": f"sidekick:{CHAT_ID}",
            "unread_count": 1,
            "marked_unread": False,
            "last_read_at": None,
        }],
        "total": 1,
    }
