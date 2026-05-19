"""HTTP route handler for ``GET /v1/conversations/{id}/items``.

Extracted from ``__init__.py`` 2026-05-17 — the items endpoint plus
its two private helpers (``_resolve_source_for_chat_id``,
``_items_by_user_id``) are large enough (~260 LOC) to warrant their
own module. The endpoint is read-only, hits only hermes ``state.db``
+ the plugin's in-memory turn buffer, so the extraction is
mechanically safe.

Wiring contract: ``handle_get_items(adapter, request)`` takes the
calling ``SidekickAdapter`` instance and the aiohttp request. The
handler reads ``adapter._state_db_path``, ``adapter._turn_buffer``,
``adapter._check_http_auth`` — same fields the original method
referenced via ``self``.
"""

from __future__ import annotations

import asyncio
import contextlib
import secrets
import sqlite3
import sys as _sys
import time as _time
from typing import Any, Dict, Optional, Tuple

# aiohttp guard mirrors sidekick_route_conversations — keeps unit
# tests loading without the aiohttp runtime. Production loads it
# before any route handler runs.
try:
    from aiohttp import web  # type: ignore[assignment]
except ImportError:  # pragma: no cover
    web = None  # type: ignore[assignment]

from .sidekick_ids import SIDEKICK_SOURCE, _parse_gateway_id


def _resolve_source_for_chat_id(adapter, chat_id: str) -> Optional[str]:
    """Pick a ``sessions.source`` for this chat_id.

    Used by the per-chat history handler, which doesn't carry a
    source on the URL. Prefers ``sidekick`` on a collision so the
    composer-editable behavior in the PWA stays consistent for
    sidekick-native chats; falls back to whatever source state.db
    has for the user_id otherwise (telegram, slack, etc.).

    Returns ``None`` when no session exists for the chat_id (treated
    as 404 by the caller).
    """
    if adapter._state_db_path is None or not adapter._state_db_path.exists():
        return None
    uri = f"file:{adapter._state_db_path}?mode=ro"
    with contextlib.closing(
        sqlite3.connect(uri, uri=True, timeout=2.0)
    ) as conn:
        rows = conn.execute(
            "SELECT DISTINCT source FROM sessions WHERE user_id = ?",
            (chat_id,),
        ).fetchall()
    sources = [r[0] for r in rows if r and r[0]]
    if not sources:
        return None
    if SIDEKICK_SOURCE in sources:
        return SIDEKICK_SOURCE
    return sources[0]


def _items_by_user_id(
    adapter,
    chat_id: str,
    source: str,
    limit: int,
    before_id: Optional[int],
) -> Optional[Tuple[list, Optional[int], bool]]:
    """Transcript replay across every session that ever belonged
    to ``(user_id=chat_id, source)``.

    Returns ``(items, first_id, has_more)`` or ``None`` when no
    sessions exist for the pair (treated as 404 by the route handler).

    Honors ``before_id`` for lazy paging: when set, only messages
    with ``id < before_id`` are returned.
    """
    if adapter._state_db_path is None or not adapter._state_db_path.exists():
        return None
    # Recursive CTE: walk parent_session_id chains so compacted
    # child sessions (user_id=NULL) get rolled up under the
    # requested chat_id. Without this, the transcript returns
    # only the root session's messages — any messages persisted
    # to a compaction-rotated child are invisible (Jonathan
    # field bug 2026-05-12).
    sql = """
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
        SELECT m.id, m.session_id, m.role, m.content, m.tool_name,
               m.tool_call_id, m.tool_calls, m.timestamp,
               sml.sidekick_id, sml.kind
        FROM messages m
        JOIN session_root sr ON m.session_id = sr.id
        LEFT JOIN sidekick_msg_links sml ON sml.state_db_id = m.id
    """
    params: list = [chat_id, source]
    if before_id is not None:
        sql += " WHERE m.id < ?"
        params.append(before_id)
    sql += " ORDER BY m.timestamp ASC, m.id ASC"
    uri = f"file:{adapter._state_db_path}?mode=ro"
    with contextlib.closing(
        sqlite3.connect(uri, uri=True, timeout=2.0)
    ) as conn:
        # Existence check first so we can return 404 vs. an empty
        # but valid transcript. A user_id with no messages yet
        # (e.g. just-created chat that hasn't sent its first turn)
        # still exists; the items list will be empty. We check the
        # root sessions table directly — if the chat_id has at
        # least one session with that user_id, it exists.
        exists_row = conn.execute(
            "SELECT 1 FROM sessions WHERE user_id = ? AND source = ? LIMIT 1",
            (chat_id, source),
        ).fetchone()
        if exists_row is None:
            return None
        rows = list(conn.execute(sql, params).fetchall())
    # Hermes context-compaction injects a synthesized history block at
    # the head of every child session: a verbatim copy of the original
    # user prompt + replay of recent assistant/tool rows + a
    # `[CONTEXT COMPACTION — REFERENCE ONLY]` marker. All rows are
    # inserted at the same millisecond timestamp (the moment the child
    # session was minted). Used by hermes' context-window seed; should
    # never reach the user-facing transcript.
    #
    # Field bug 2026-05-17 (Jonathan, chat 56b3d788…): the original
    # prompt appeared at the top (real, in parent session) AND again
    # near the end (the compaction-injected dupe in the child session).
    # The user saw their own prompt twice plus 4 dupe assistant/tool
    # rows in between — incoherent transcript.
    #
    # Fix: per child session, find the LAST row whose content starts
    # with `[CONTEXT COMPACTION`, drop that marker AND every row in
    # the same session with `id <= marker_id` (the synthesized seed
    # block always sits at the head of the child session, before any
    # real new content). Parent-session rows are never touched.
    #
    # `compaction_head_end_per_session[session_id] = max row id to
    # drop`. Built in a single pre-scan; lookup is O(1) per row.
    compaction_head_end_per_session: Dict[str, int] = {}
    for row_id, session_id, role, content, *_rest in rows:
        if (content or "").startswith("[CONTEXT COMPACTION"):
            # Latest marker wins. A single child session can only have
            # one compaction event per minting; the LAST id in
            # ascending-id order is the most permissive drop bound.
            cur = compaction_head_end_per_session.get(session_id, 0)
            if row_id > cur:
                compaction_head_end_per_session[session_id] = row_id

    items = []
    for row_id, session_id, role, content, tool_name, tool_call_id, tool_calls, ts, sidekick_id, kind in rows:
        text = (content or "")
        # Drop the synthesized-history seed block of any compaction
        # child session. Catches both the marker row itself AND every
        # row before it within that session (the verbatim user-prompt
        # dupe + replayed assistant/tool rows hermes inserts to seed
        # the new context window).
        drop_through = compaction_head_end_per_session.get(session_id)
        if drop_through is not None and row_id <= drop_through:
            continue
        item: Dict[str, Any] = {
            "id": int(row_id),
            "object": "message",
            "role": role,
            "content": text,
            "created_at": int(ts) if ts else 0,
        }
        if tool_name:
            item["tool_name"] = tool_name
        # Tool-call linkage. Surfaced so the PWA can reconstruct
        # activity rows from history on reload (the SSOT-rebuild
        # path Jonathan endorsed 2026-05-17). Hermes' core schema
        # already persists these columns; we just propagate them
        # in the wire response. No new storage, no schema change.
        #
        #   - role='tool' rows carry `tool_call_id` referencing
        #     back to the assistant message that issued the call.
        #     PWA routes these to activityRow.appendToolResult.
        #   - role='assistant' rows that orchestrated tool calls
        #     carry `tool_calls` (JSON array of OpenAI-shape
        #     function-call entries). PWA parses and feeds each
        #     entry to activityRow.appendToolCall.
        if tool_call_id:
            item["tool_call_id"] = tool_call_id
        if tool_calls:
            # Already a JSON string on disk; pass through verbatim.
            # PWA parses with try/catch so a malformed payload
            # degrades to "tool-call row drops out of activity row"
            # rather than crashing renderHistoryMessage.
            item["tool_calls"] = tool_calls
        # SSE-shape id (umsg_*/msg_*/notif_*) when this row was
        # persisted by a sidekick turn (or cron delivery — see
        # _persist_notification) that recorded its link. Absent
        # for legacy messages, messages from other channels, and
        # tool/system rows.
        if sidekick_id:
            item["sidekick_id"] = sidekick_id
        # Notification kind (cron / reminder / approval / etc.).
        # Plumbed through from sidekick_msg_links.kind — only set
        # on rows _persist_notification wrote. The PWA reads this
        # to discriminate notification rows from regular assistant
        # replies for rendering purposes.
        if kind:
            item["kind"] = kind
        items.append(item)
    # Same pagination semantics as the legacy path:
    #  * before_id=None → most-recent `limit` items, has_more=True
    #    when we truncated.
    #  * before_id set → user is paging backward; return up to
    #    `limit` items older than the cursor, has_more=True if a
    #    full page came back.
    first_id = items[0]["id"] if items else None
    if before_id is None and len(items) > limit:
        items = items[-limit:]
        first_id = items[0]["id"] if items else None
        has_more = True
    elif before_id is not None and len(items) >= limit:
        items = items[:limit]
        has_more = True
    else:
        has_more = False
    return (items, first_id, has_more)


async def handle_get_items(adapter, request: "web.Request") -> "web.Response":
    """GET /v1/conversations/{id}/items — transcript replay.

    Phase 2 (2026-05-19): read source is sidekick.db.msg_links, not
    state.db. Before each read, an opportunistic reconciliation pulls
    any state.db rows that don't have a sidekick.db twin into the
    message store with `legacy:<state_id>` keys. The aggregation
    across compaction-rotated sessions is done INSIDE the reconciler
    via the same recursive CTE the legacy path used.

    Pagination cursor: sidekick.db.msg_links's implicit rowid. PWA
    treats it as an integer (same wire shape as before); the cursor's
    monotonicity is sqlite-guaranteed.

    Returns 404 only when the chat has zero rows in sidekick.db AND
    state.db has no session for the chat AND no in-flight turn buffer
    exists — i.e. genuinely unknown chat. A chat with sidekick.db rows
    (envelope-time writes from Phase 1) always responds with a list.
    """
    _trace_id = secrets.token_hex(3)
    _t0 = _time.monotonic()
    def _trace(event: str, extra: str = "") -> None:
        ms = int((_time.monotonic() - _t0) * 1000)
        print(f"[items-trace {_trace_id}] +{ms}ms {event}{' ' + extra if extra else ''}", flush=True, file=_sys.stderr)
    _trace("enter")
    if not adapter._check_http_auth(request):
        return web.Response(status=401, text="invalid token")
    raw_id = request.match_info["id"]
    try:
        limit = max(1, min(int(request.query.get("limit", "200")), 500))
    except ValueError:
        return web.Response(status=400, text="invalid limit")
    before = request.query.get("before")
    before_id: Optional[int]
    if before is None:
        before_id = None
    else:
        try:
            before_id = int(before)
        except ValueError:
            return web.Response(status=400, text="invalid before cursor")

    # Source resolution still hits state.db — it's the canonical
    # mapping of chat_id → source (sidekick / telegram / slack /…).
    # Track whether state.db has ANY session for this chat so the
    # final 404-vs-empty decision can incorporate it.
    parsed_source, chat_id = _parse_gateway_id(raw_id)
    state_db_knows_chat = parsed_source is not None
    if parsed_source is not None:
        source = parsed_source
        _trace("source-from-prefix", f"source={source} chat={chat_id[:24]}")
    else:
        _trace("source-resolve-start", f"chat={chat_id[:24]}")
        source = await asyncio.to_thread(_resolve_source_for_chat_id, adapter, chat_id)
        _trace("source-resolve-end", f"source={source}")
        state_db_knows_chat = source is not None
        if source is None:
            source = "sidekick"  # assume sidekick for the reconcile/query below

    from . import sidekick_state as _sstate

    # Opportunistic reconciliation: pull any state.db rows missing
    # from sidekick.db. No-op when state.db has no rows for this
    # chat. Cheap on second + subsequent reads (linked_ids set
    # covers everything).
    inserted = await asyncio.to_thread(
        _sstate.reconcile_from_state_db,
        adapter._sidekick_db, adapter._state_db_path, chat_id, source,
    )
    if inserted:
        _trace("reconcile", f"inserted={inserted}")

    _trace("query-start", f"limit={limit} before={before_id}")
    result = await asyncio.to_thread(
        _sstate.list_messages_for_chat,
        adapter._sidekick_db, chat_id,
        limit=limit, before_rowid=before_id,
    )
    items = result["items"]
    first_id = result["first_id"]
    has_more = result["has_more"]
    _trace("query-end", f"rows={len(items)}")

    inflight_entry = None
    inflight_envelopes: list = []
    if adapter._turn_buffer is not None:
        inflight_entry = adapter._turn_buffer.active_for_chat(chat_id)
        if inflight_entry is not None:
            inflight_envelopes = adapter._turn_buffer.render_envelopes(inflight_entry)

    # 404 only when truly unknown chat: no sidekick.db rows + no
    # state.db session + no in-flight turn. Preserves the original
    # cmdk drill-to-message fall-through behavior.
    if not items and not inflight_envelopes and not state_db_knows_chat:
        return web.Response(status=404, text="conversation not found")

    body: Dict[str, Any] = {
        "object": "list",
        "data": items,
        "first_id": first_id,
        "has_more": has_more,
    }
    if inflight_envelopes:
        body["inflight"] = inflight_envelopes
    response = web.json_response(body)
    _trace("response-built")
    return response
