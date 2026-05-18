"""Supplemental sqlite for sidekick-shaped state — push subs, mutes,
prefs, VAPID keys, pins, unread state, in-flight message link map.

Mirrors the openclaw plugin's ``src/schema.sql`` so the two backends
expose an identical /v1/* contract. Per-backend isolation: openclaw
stores at ``~/.openclaw-sk-integ/sidekick.db``; hermes stores at
``$HERMES_STATE_DIR/sidekick.db`` (default ``~/.hermes/sidekick.db``).

The proxy used to keep this state as JSON files under
``~/.sidekick/notifications/``; that was the legacy path because the
proxy was originally hermes-only. With the per-backend supplemental
DB pattern, all sidekick state moves into each backend's plugin.
"""

import os
import sqlite3
import threading
from pathlib import Path


SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS msg_links (
  id            TEXT PRIMARY KEY,
  chat_id       TEXT NOT NULL,
  role          TEXT NOT NULL,
  content       TEXT NOT NULL,
  kind          TEXT,
  tool_name     TEXT,
  tool_call_id  TEXT,
  created_at    REAL NOT NULL,
  updated_at    REAL NOT NULL,
  status        TEXT NOT NULL DEFAULT 'final',
  agent_row_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_links_chat ON msg_links(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_links_agent ON msg_links(agent_row_id);

CREATE TABLE IF NOT EXISTS pins (
  chat_id    TEXT NOT NULL,
  msg_id     TEXT NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  timestamp  REAL NOT NULL,
  pinned_at  REAL NOT NULL,
  PRIMARY KEY (chat_id, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_pins_pinned_at ON pins(pinned_at DESC);

CREATE TABLE IF NOT EXISTS unread_state (
  chat_id        TEXT PRIMARY KEY,
  last_read_at   REAL,
  marked_unread  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint      TEXT PRIMARY KEY,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  user_agent    TEXT,
  created_at    REAL NOT NULL,
  last_used_at  REAL
);

CREATE TABLE IF NOT EXISTS push_mutes (
  chat_id   TEXT PRIMARY KEY,
  muted_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS push_prefs (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vapid_keys (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  public_key   TEXT NOT NULL,
  private_key  TEXT NOT NULL,
  subject      TEXT NOT NULL,
  created_at   REAL NOT NULL
);
"""


# Thread-safe shared connection. sqlite3 in Python is locked across
# threads by default unless `check_same_thread=False` is passed; we
# add an explicit lock so concurrent route handlers (aiohttp worker
# pool) don't trip on the GIL race. Write throughput is low (handful
# of ops per turn) so a single lock is fine.
class SidekickDB:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)

    def exec(self, sql: str, params=()) -> sqlite3.Cursor:
        """Run a write/query under the lock. Use `fetch*` on the cursor."""
        with self._lock:
            return self._conn.execute(sql, params)

    def fetchone(self, sql: str, params=()):
        with self._lock:
            return self._conn.execute(sql, params).fetchone()

    def fetchall(self, sql: str, params=()):
        with self._lock:
            return self._conn.execute(sql, params).fetchall()

    def close(self):
        with self._lock:
            self._conn.close()


def open_sidekick_db(state_dir: str | None = None) -> SidekickDB:
    """Open (or create) the sidekick supplemental DB.

    `state_dir` defaults to ``$HERMES_STATE_DIR`` or ``~/.hermes``.
    """
    if not state_dir:
        state_dir = os.environ.get("HERMES_STATE_DIR") or os.path.expanduser("~/.hermes")
    path = Path(state_dir) / "sidekick.db"
    return SidekickDB(path)
