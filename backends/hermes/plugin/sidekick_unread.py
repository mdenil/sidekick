"""Unread compute against hermes state.db.

Mirrors openclaw plugin's ``src/unread-storage.js``: derive per-chat
unread count by walking state.db for assistant rows newer than the
``unread_state.last_read_at`` pointer. Same SSOT model: this count
drives sidebar badges, app badge (sum), and was the implicit input
to push dispatch.

Reads from hermes state.db via a read-only sqlite connection. The
plugin's ``_state_db_path`` field carries the resolved location.
"""

from __future__ import annotations

import contextlib
import sqlite3
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .sidekick_state import list_unread_state


def _read_state_unread_state(db) -> Dict[str, Tuple[Optional[float], bool]]:
    """Pull last_read_at + marked_unread keyed by chat_id."""
    rows = list_unread_state(db)
    return {
        r["chatId"]: (r["lastReadAt"], bool(r["markedUnread"]))
        for r in rows
    }


def compute_unread(
    *,
    db,
    state_db_path: Path,
    source: str = "sidekick",
) -> Dict:
    """Return the same shape openclaw's compute_unread returns:
    ``{chats: [{chat_id, unread_count, marked_unread, last_read_at}],
       total: N}``.

    ``total`` is the SUM of per-chat counts (Jonathan picked the sum
    over a chat-count aggregate for higher-fidelity feedback).

    Counts assistant rows per chat (user_id) with timestamp >
    last_read_at. The query joins via the recursive CTE pattern that
    ``_items_by_user_id`` uses (so compaction-rotated child sessions
    still get rolled up under their root user_id). For sticky
    ``marked_unread=1``, returns a count of at least 1 regardless of
    the timestamp comparison.
    """
    if not state_db_path or not state_db_path.exists():
        return {"chats": [], "total": 0}

    pointer = _read_state_unread_state(db)

    uri = f"file:{state_db_path}?mode=ro"
    with contextlib.closing(sqlite3.connect(uri, uri=True, timeout=2.0)) as conn:
        # All chats for this source, with their assistant message
        # counts and the most-recent message timestamp. We compute
        # the per-chat count using a per-chat WHERE on timestamp,
        # bound by last_read_at — done in Python over the rolled-up
        # rows because each chat may have a different pointer.
        chats_sql = "SELECT DISTINCT user_id FROM sessions WHERE source = ? AND user_id IS NOT NULL"
        chat_ids = [row[0] for row in conn.execute(chats_sql, (source,))]

        out: List[Dict] = []
        total = 0
        for chat_id in chat_ids:
            # unread_state is keyed by the PWA-facing prefixed form
            # (`{source}:{chat_id}`) since /v1/unread/seen POSTs use
            # whatever chat_id the PWA sends — matches the sidebar
            # row. Look up under both forms for backwards-compat with
            # bare ids that might have been written historically.
            prefixed = f"{source}:{chat_id}"
            last_read_at, marked = pointer.get(prefixed) or pointer.get(chat_id) or (None, False)
            if marked:
                # Sticky-unread: count at least 1. Don't bother
                # walking the messages — sticky overrides regardless.
                out.append({
                    "chat_id": f"{source}:{chat_id}",
                    "unread_count": 1,
                    "marked_unread": True,
                    "last_read_at": last_read_at,
                })
                total += 1
                continue

            # Recursive CTE: same as _items_by_user_id so compaction
            # children are folded under the root user_id. Count only
            # assistant rows (push-eligible class).
            count_sql = """
                WITH RECURSIVE session_root(id, root_system_prompt) AS (
                  SELECT id, system_prompt FROM sessions
                   WHERE user_id = ? AND source = ?
                  UNION ALL
                  SELECT s.id, sr.root_system_prompt
                    FROM sessions s
                    JOIN session_root sr ON s.parent_session_id = sr.id
                   WHERE s.user_id IS NULL
                     AND LENGTH(COALESCE(sr.root_system_prompt, '')) >= 200
                     AND SUBSTR(COALESCE(s.system_prompt, ''), 1, 200)
                         = SUBSTR(sr.root_system_prompt, 1, 200)
                )
                SELECT COUNT(*) FROM messages m
                 JOIN session_root sr ON m.session_id = sr.id
                 WHERE m.role = 'assistant'
                   AND m.timestamp > ?
            """
            threshold = last_read_at if last_read_at is not None else 0
            row = conn.execute(count_sql, (chat_id, source, threshold)).fetchone()
            count = int(row[0]) if row else 0
            if count > 0:
                out.append({
                    # Sidebar uses prefixed `{source}:{chat_id}` ids
                    # (see _format_gateway_id). Match so badge.ts can
                    # look up by the same key the drawer rows carry.
                    "chat_id": f"{source}:{chat_id}",
                    "unread_count": count,
                    "marked_unread": False,
                    "last_read_at": last_read_at,
                })
                total += count

    return {"chats": out, "total": total}
