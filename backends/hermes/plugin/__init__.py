"""Sidekick platform adapter for hermes-agent.

Runs an aiohttp HTTP server bound to localhost that speaks the abstract
agent contract (OpenAI-Responses-shaped). The sidekick proxy (Node.js)
talks to it via /v1/* endpoints; the agent contract is documented at
``docs/ABSTRACT_AGENT_PROTOCOL.md`` in the sidekick repo.

Sidekick is a peer of telegram / slack / signal — the hermes gateway
owns the chat_id → session_id mapping natively.

HTTP surface
------------
All routes auth-gate on ``Authorization: Bearer <token>`` where
``<token>`` is read from env var ``SIDEKICK_PLATFORM_TOKEN`` at adapter
startup.

Channel contract (the OAI-compat surface)::

    GET    /health
    GET    /v1/conversations              # drawer list (sidekick rows)
    GET    /v1/conversations/{id}/items   # transcript replay
    DELETE /v1/conversations/{id}         # cascade delete
    PATCH  /v1/conversations/{id}         # rename (sets sessions.title)
    POST   /v1/responses                  # turn dispatch (SSE on stream:true)
    GET    /v1/events                     # out-of-turn SSE

Gateway extension (sidekick-defined, optional)::

    GET    /v1/gateway/conversations      # cross-platform drawer list

The proxy probes ``/v1/gateway/conversations`` first; on 404 it falls
back to the channel surface and stamps source='sidekick'. Hermes
implements the gateway endpoint because hermes IS a gateway —
telegram, slack, whatsapp etc. live behind the same state.db.

Inbound dispatch goes through ``/v1/responses`` which calls
``self.handle_message(MessageEvent(...))``. The gateway resolves the
session via the standard
``build_session_key(SessionSource(platform=Platform.SIDEKICK, chat_id=...))``
DM path — ``agent:main:sidekick:dm:<chat_id>``.

Outbound envelope shapes (see SidekickEnvelope in
``server-lib/backends/hermes-gateway/upstream.ts``)::

    {"type": "reply_delta",     "chat_id": "...", "text": "<accumulated>",
     "message_id": "..."}
    {"type": "reply_final",     "chat_id": "...", "message_id": "..."}
    {"type": "image",           "chat_id": "...", "url": "...", "caption": "..."}
    {"type": "typing",          "chat_id": "..."}
    {"type": "notification",    "chat_id": "...", "kind": "cron", "content": "..."}
    {"type": "session_changed", "chat_id": "...", "session_id": "...",
     "title": "..."}
    {"type": "tool_call" / "tool_result" / "error", ...}

In-turn envelopes ride the ``/v1/responses`` SSE stream as OAI events
(translated by the proxy back to the sidekick envelope shape). All
others ride ``/v1/events`` with a Last-Event-ID replay ring.

``session_changed`` is detected via state.db polling
(``_session_poll_loop``) — no hermes core patches required for it.
Trade-off: ~1.5s lag between compression and the PWA seeing the new
title.

PDF rasterization
-----------------
Sidekick PWA uploads of ``application/pdf`` are rasterized to per-page
PNGs in ``_materialize_attachments`` via ``_rasterize_pdf`` (which
shells out to ``pdftoppm`` from poppler-utils). The PDF tempfile is
unlinked after rasterization; the agent only sees images via the
existing ``media_urls`` → vision-tool pipeline. This is sidekick-only
scope — telegram / slack / whatsapp / signal each have separate
attachment flows in ``gateway/platforms/*.py`` and don't share this
materializer (yet).

System dep: ``apt install poppler-utils`` on Debian/Ubuntu, or
``brew install poppler`` on macOS. Without it PDFs are dropped and a
clear error is logged at the first PDF upload attempt.

Knobs (env, with defaults sized for a Pi 5 host):
``SIDEKICK_PDF_DPI`` (150), ``SIDEKICK_PDF_MAX_PAGES`` (50),
``SIDEKICK_PDF_RASTERIZE_TIMEOUT_S`` (30),
``SIDEKICK_PDF_MAX_BYTES`` (20 MiB).

See ``docs/archive/PDF_RASTERIZATION_PROPOSAL.md`` in the sidekick
repo for design notes.

Install
-------
This adapter requires a hermes patch that registers
``Platform.SIDEKICK`` and the adapter-factory branch. See
``0001-add-sidekick-platform.patch`` and ``README.md`` next to this file.

Plugin shape note
-----------------
This file is *also* importable as a hermes plugin module via a tiny
``register(ctx)`` function. The hermes plugin system does NOT have a
``register_platform_adapter`` extension point (yet), so the plugin
``register()`` here is a no-op — the adapter is wired in via the
``_create_adapter()`` factory branch added by the patch. The plugin
manifest exists so ``hermes plugins list`` shows it.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import secrets
import socket as _socket
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

try:
    from aiohttp import web
    AIOHTTP_AVAILABLE = True
except ImportError:
    AIOHTTP_AVAILABLE = False
    web = None  # type: ignore[assignment]

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)

logger = logging.getLogger(__name__)

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8645
PROTOCOL_VERSION = 1

# ── PDF rasterization knobs ───────────────────────────────────────────
# When the PWA uploads a PDF via /api/sidekick/messages, we shell out to
# `pdftoppm` (poppler-utils) and replace the PDF tempfile with one PNG
# per page so vision-capable models (gemma-3, claude, gpt-4o, gemini)
# see it as N images via the existing media_urls path. The PDF tempfile
# itself is never handed to the agent — vision tools don't consume PDFs.
#
# Tunable via env at adapter startup. Defaults chosen for a Pi 5 host:
#  * 150 DPI keeps PNGs readable for body text without ballooning bytes.
#  * 50-page cap avoids 100-page-deck wedge times (50 pages ≈ 10s).
#  * 30s timeout is the hard ceiling per upload.
#  * 20 MB file-size cap rejects abusive uploads before we shell out.
SIDEKICK_PDF_DPI = int(os.environ.get("SIDEKICK_PDF_DPI", "150"))
SIDEKICK_PDF_MAX_PAGES = int(os.environ.get("SIDEKICK_PDF_MAX_PAGES", "50"))
SIDEKICK_PDF_RASTERIZE_TIMEOUT_S = int(
    os.environ.get("SIDEKICK_PDF_RASTERIZE_TIMEOUT_S", "30")
)
SIDEKICK_PDF_MAX_BYTES = int(
    os.environ.get("SIDEKICK_PDF_MAX_BYTES", str(20 * 1024 * 1024))
)

# ── tool-event hook plumbing ──────────────────────────────────────────
# pre_tool_call / post_tool_call hooks fire from worker threads (the
# agent dispatches tools via run_in_executor — see model_tools.py).
# We need a module-level reference to the live adapter so the sync
# hook callbacks can schedule envelope sends onto the adapter's
# event loop via asyncio.run_coroutine_threadsafe. The adapter sets
# this in connect() (after capturing its loop) and clears it in
# disconnect(). When None, hook handlers drop silently — non-sidekick
# deployments still load the plugin but never fire envelopes.
_active_adapter: Optional["SidekickAdapter"] = None

# Cap on the result string we put into a tool_result envelope. Tools
# can return arbitrarily large blobs (web_extract / browse). The PWA
# does its own per-tool truncation for display, but we cap here too
# so a runaway result can't blow up the WS frame budget.
TOOL_RESULT_MAX_BYTES = 50 * 1024

# /v1/responses streaming + /v1/events out-of-turn channel sizing.
# These bound worst-case memory if a consumer hangs.
TURN_QUEUE_MAX = 1000          # per-chat envelope queue depth
TURN_TIMEOUT_S = 120           # hold a /v1/responses turn open this long
EVENT_REPLAY_CAP = 256         # bounded ring for /v1/events replay

# Session title cap on the PATCH /v1/conversations/{id} rename path.
# 200 chars is comfortably more than the drawer renders (~40 visible
# before ellipsis) but small enough that an abusive client can't bloat
# the sessions row. The PWA's UI already truncates at 80 in the bubble.
SESSION_TITLE_MAX_LEN = 200


def _iso_from_epoch(t: float) -> str:
    """Render an epoch-seconds timestamp as ISO-8601 UTC."""
    import datetime as _dt
    return _dt.datetime.fromtimestamp(t, tz=_dt.timezone.utc).isoformat()

# ── session_changed polling ───────────────────────────────────────────
# We watch state.db for compression-induced session_id rotations on the
# chat_ids we know about, and emit a `session_changed` envelope to the
# proxy when (session_id, title) changes for a known chat_id. This is
# strictly less invasive than (a) patching hermes to add a callback hook
# or (c) polling from the PWA on tab-focus — the adapter already runs
# in-process with the gateway, so it has direct read access to state.db
# and zero additional moving parts.
#
# Trade-off accepted: ~1s lag between compression and the PWA seeing a
# title refresh. Polling cost is one indexed SELECT per cadence tick;
# negligible at sidekick's single-user scale.
#
# Cadence: every 1.5s while a proxy client is connected. Skipped when
# disconnected (no listener — would be wasted I/O). The first time we
# see a chat_id we record its initial state without emitting; the emit
# only fires on subsequent (session_id, title) changes.
SESSION_POLL_INTERVAL_S = 1.5

# state.db lookup pattern. Matches the session_key shape that
# build_session_key generates for SessionSource(platform=SIDEKICK,
# chat_id=X, chat_type='dm') — `agent:main:sidekick:dm:<chat_id>`.
SESSION_KEY_PREFIX = "agent:main:sidekick:dm:"

# Source allow-list for the cross-platform gateway drawer. Any
# `sessions.source` value not in this set is dropped at query time.
# This is the canonical hermes-agent platform set as of the platform-
# adapter migration; if hermes adds a new platform, drop it in here.
GATEWAY_DRAWER_SOURCES: Tuple[str, ...] = (
    "sidekick",
    "telegram",
    "whatsapp",
    "slack",
    "signal",
    "discord",
    "webhook",
    "openclaw",
)

# Sidekick's own source — used by the channel-only `/v1/conversations`
# endpoint and by tool-event hook resolution (which only cares about
# sidekick sessions; non-sidekick tool calls never make it past the
# adapter's filter).
SIDEKICK_SOURCE: str = "sidekick"


# ── Gateway id encoding ─────────────────────────────────────────────
# The agent contract guarantees `ConversationSummary.id` is globally
# unique. Hermes natively keys sessions by `(source, user_id)` —
# `user_id` IS the platform chat_id, and the same chat_id can recur
# across sources (e.g. a sidekick test session that happens to use a
# WhatsApp `@lid` as its chat_id, or a telegram numeric id that
# coincides with a sidekick UUID). Exposing user_id alone as `id`
# violates uniqueness; the drawer then renders two LIs with the same
# `data-chat-id`, click activates both, and history fetches go
# through `_resolve_source_for_chat_id` which picks one source
# arbitrarily — wrong session content appears in the right row.
#
# Encode `(source, chat_id)` into a single contract-unique id:
#   `${source}:${chat_id}`  e.g. `whatsapp:199999999999999@lid`
#
# Sources are internal constants (no colons); chat_ids in the wild
# don't contain colons in any platform we support. We split on FIRST
# `:` — chat_ids containing colons would still round-trip correctly.
# Frontend treats `id` as opaque. Per-chat URLs (`/v1/conversations/
# {id}/items`, DELETE) decode the prefix server-side to disambiguate.
#
# Backward compat: if an `id` arrives at the per-chat handler WITHOUT
# a prefix, fall through to `_resolve_source_for_chat_id` so legacy
# callers (channel-only `/v1/conversations` consumers, ad-hoc curls)
# keep working. New callers should always use prefixed ids.
_GATEWAY_ID_SEP = ":"


def _format_gateway_id(source: str, chat_id: str) -> str:
    """Encode (source, chat_id) into a contract-unique identifier."""
    return f"{source}{_GATEWAY_ID_SEP}{chat_id}"


def _parse_gateway_id(id_str: str) -> Tuple[Optional[str], str]:
    """Split a gateway id back into (source, chat_id). Returns
    `(None, id_str)` for legacy un-prefixed ids — callers fall back to
    source-resolution-by-chat_id in that case."""
    if _GATEWAY_ID_SEP not in id_str:
        return (None, id_str)
    src, _, chat = id_str.partition(_GATEWAY_ID_SEP)
    if src not in GATEWAY_DRAWER_SOURCES:
        # Unrecognized prefix — treat as a chat_id that happens to
        # contain a colon. Defensive against future chat_id formats.
        return (None, id_str)
    return (src, chat)


class _SettingsValidationError(ValueError):
    """Raised by _apply_setting when the value is invalid for the
    declared type. Maps to HTTP 400 in _handle_settings_update."""


class _SettingsNotFoundError(KeyError):
    """Raised by _apply_setting when the setting id isn't declared.
    Maps to HTTP 404 in _handle_settings_update."""


_SIDEKICK_HIDDEN_COMMANDS = frozenset({
    # Genuinely terminal-coupled commands — sidekick has its own
    # surfaces for these, OR they're nonsense outside a TUI.
    "clear",      # terminal screen wipe; sidekick scrollback differs
    "redraw",     # TUI repaint
    "skin",       # display theme; TUI-specific
    "indicator",  # TUI busy-indicator style (kaomoji/emoji/...)
    "statusbar",  # TUI status bar toggle
    "copy",       # terminal clipboard via OSC52
    "paste",      # terminal paste of system clipboard
    "image",      # terminal image attach; sidekick has its own attach UI
    "quit",       # close TUI; sidekick tabs close differently
})


def _serialize_command_registry() -> List[Dict[str, Any]]:
    """Build the JSON payload served by ``GET /v1/commands``.

    Pulls from the central ``hermes_cli.commands.COMMAND_REGISTRY`` and
    any plugin-registered commands (via the existing
    ``_iter_plugin_command_entries`` helper).

    Sidekick is a first-class chat surface, not a "messaging platform"
    adapter (telegram/slack), so the hermes-side ``cli_only`` filter —
    which hides TUI-only entries from those gateways — is
    over-conservative here. Most ``cli_only=True`` commands (busy,
    tools, skills, cron, snapshot, config, plugins, ...) route fine
    through the gateway and work in sidekick when typed manually; this
    just makes them discoverable in the slash menu. We only drop the
    explicitly TUI-coupled set in ``_SIDEKICK_HIDDEN_COMMANDS``.

    Aliases stay on the canonical row (the PWA matches both names
    against the same entry — no separate row per alias). Returns an
    empty list if ``hermes_cli`` is unavailable, so non-hermes test
    contexts don't blow up.
    """
    try:
        from hermes_cli.commands import (
            COMMAND_REGISTRY,
            _iter_plugin_command_entries,
        )
    except Exception:
        return []
    out: List[Dict[str, Any]] = []
    for cmd in COMMAND_REGISTRY:
        if cmd.name in _SIDEKICK_HIDDEN_COMMANDS:
            continue
        out.append({
            "name": cmd.name,
            "description": cmd.description,
            "category": cmd.category,
            "aliases": list(cmd.aliases),
            "args_hint": cmd.args_hint,
            "subcommands": list(cmd.subcommands),
        })
    try:
        plugin_entries = _iter_plugin_command_entries()
    except Exception:
        plugin_entries = []
    for name, description, args_hint in plugin_entries:
        out.append({
            "name": name,
            "description": description,
            "category": "Plugins",
            "aliases": [],
            "args_hint": args_hint or "",
            "subcommands": [],
        })
    return out


def check_sidekick_requirements() -> bool:
    """Return True when adapter dependencies are available.

    Required: aiohttp (already a hermes core dep — webhook adapter uses it).

    Note: ``Platform.SIDEKICK`` is created on demand by ``Platform._missing_``
    once this plugin's ``register(ctx)`` has called ``ctx.register_platform``,
    so we no longer have to verify the enum entry by hand. The
    ``SIDEKICK_PLATFORM_TOKEN`` gate lives in the auth path on the WS
    server, not here — adapter instantiation is allowed without a token,
    just unauthenticated requests get rejected.
    """
    if not AIOHTTP_AVAILABLE:
        logger.warning("[sidekick] aiohttp not installed")
        return False
    return True


class SidekickAdapter(BasePlatformAdapter):
    """Hermes platform adapter speaking JSON-over-WebSocket to the sidekick proxy.

    A single proxy client connects on startup and stays connected; per-
    conversation traffic is multiplexed by ``chat_id`` on every envelope.
    """

    # WS frames are not size-limited the way Telegram messages are, but we
    # still cap individual chunks to keep the JS side responsive.
    MAX_MESSAGE_LENGTH: int = 64 * 1024

    def __init__(self, config: PlatformConfig):
        # Platform.SIDEKICK is created on demand by Platform._missing_ as
        # soon as our register(ctx) calls ctx.register_platform("sidekick"),
        # so by the time we land here the enum lookup always succeeds.
        # If a future hermes version drops _missing_ we'd see an
        # AttributeError or ValueError below — surface it loudly rather
        # than papering over.
        super().__init__(config, Platform("sidekick"))

        extra = config.extra or {}
        self._host: str = extra.get(
            "host", os.getenv("SIDEKICK_PLATFORM_HOST", DEFAULT_HOST)
        )
        self._port: int = int(
            extra.get("port", os.getenv("SIDEKICK_PLATFORM_PORT", str(DEFAULT_PORT)))
        )
        self._token: str = extra.get(
            "token", os.getenv("SIDEKICK_PLATFORM_TOKEN", "")
        ).strip()

        # aiohttp server primitives
        self._app: Optional[web.Application] = None
        self._runner: Optional[web.AppRunner] = None
        self._site: Optional[web.TCPSite] = None

        # chat_ids we've seen at least one inbound message for in this process
        # lifetime. Used by send() to emit a synthetic ``session_changed`` on
        # the *first* outbound for a fresh chat_id; a future on-compression
        # callback would replace this synthetic emission.
        self._known_chat_ids: Set[str] = set()

        # Adapter-assigned message ids (returned via SendResult.message_id) so
        # subsequent edit_message calls reference the right outbound bubble on
        # the proxy/PWA side.
        self._message_seq = 0

        # session_changed polling state. Map of chat_id → (session_id, title)
        # last seen in state.db. We only emit envelopes for transitions —
        # the first observation seeds the cache silently. The poller task is
        # spawned in connect() and cancelled in disconnect().
        self._session_state_cache: Dict[str, Tuple[str, str]] = {}
        self._session_poll_task: Optional[asyncio.Task] = None
        # state.db path resolution. Hermes' own config picks this up from
        # HERMES_STATE_DB or the default ~/.hermes/state.db; we mirror that
        # so the adapter doesn't need a separate env var.
        self._state_db_path: Optional[Path] = self._resolve_state_db_path()

        # Tool-event support (Phase 3). Hooks fire sync from worker threads;
        # we need the adapter's event loop to schedule envelope sends.
        # Captured in connect() once the loop is actually running.
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        # Cache of session_id → chat_id resolved from state.db. Hot-
        # path lookup: we miss + reseed once per session_id so a
        # freshly-rotated session is picked up the moment its first
        # tool fires (after which it lives in cache permanently for
        # this process).
        self._sid_to_chat_id_cache: Dict[str, str] = {}
        # Per-tool_call_id: start time + chat_id, populated in
        # pre_tool_call and consumed in post_tool_call. Bounded by the
        # number of in-flight tools (typically 1, occasionally a few for
        # parallel tool calls). Stale entries (no matching post hook)
        # are unlikely but harmless — capped via the housekeeping check
        # below if it ever grows unreasonably.
        self._inflight_tool_calls: Dict[str, Tuple[float, str]] = {}

        # ── /v1/responses + /v1/events plumbing (refactor step 2) ─────
        # Per-chat-id queue: a /v1/responses request registers its queue
        # here on entry, drains it as the agent emits replies, and
        # removes it on exit. Outbound `_safe_send_envelope` routes
        # in-turn envelopes (reply_delta, reply_final, tool_call,
        # tool_result, typing) to the matching queue if registered.
        self._turn_queues: Dict[str, "asyncio.Queue[Dict[str, Any]]"] = {}
        # /v1/events subscribers: each connected proxy SSE stream owns a
        # queue here; out-of-turn envelopes (notification,
        # session_changed, image, error, plus any in-turn envelope with
        # no active turn queue) get fanned out to all subscribers.
        self._event_subscribers: Set["asyncio.Queue[Tuple[int, Dict[str, Any]]]"] = set()
        # Monotonic id for /v1/events SSE Last-Event-ID replay.
        self._event_id_counter: int = 0
        # Bounded replay ring so a transient /v1/events disconnect can
        # resume without losing recent envelopes.
        self._event_replay_ring: List[Tuple[int, Dict[str, Any]]] = []
    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def connect(self) -> bool:
        """Bind the WS server, listen for the proxy."""
        if not self._token:
            logger.error(
                "[sidekick] SIDEKICK_PLATFORM_TOKEN unset — refusing to start. "
                "All inbound connections will be rejected without it."
            )
            self._set_fatal_error(
                "missing_token",
                "SIDEKICK_PLATFORM_TOKEN env var is required",
                retryable=False,
            )
            return False

        # Port-conflict pre-check (same pattern as webhook adapter).
        try:
            with _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM) as s:
                s.settimeout(1)
                s.connect(("127.0.0.1", self._port))
            logger.error(
                "[sidekick] Port %d already in use. "
                "Set SIDEKICK_PLATFORM_PORT or platforms.sidekick.port.",
                self._port,
            )
            return False
        except (ConnectionRefusedError, OSError):
            pass  # port is free

        # client_max_size lifted from aiohttp's 1 MiB default — phone
        # photos attached via the PWA easily exceed that once base64-
        # encoded inside the JSON envelope. Match sidekick proxy's
        # MAX_BODY_BYTES so the bottleneck is consistent end-to-end.
        self._app = web.Application(client_max_size=50 * 1024 * 1024)
        self._app.router.add_get("/health", self._handle_health)
        # ── Agent contract HTTP routes ────────────────────────────────
        # OAI-Responses-shape surface the proxy talks to. See
        # docs/ABSTRACT_AGENT_PROTOCOL.md for the canonical reference.
        self._app.router.add_get(
            "/v1/conversations", self._handle_list_conversations
        )
        self._app.router.add_get(
            "/v1/conversations/{id}/items", self._handle_get_conversation_items
        )
        self._app.router.add_delete(
            "/v1/conversations/{id}", self._handle_delete_conversation
        )
        # Cross-device session rename. Local-IDB userTitle stamping
        # remains the source of truth from the originating device, but
        # this PATCH writes through to state.db so other connected
        # clients (Mac + iPhone) see the new title via the existing
        # session_changed envelope on /v1/events.
        self._app.router.add_patch(
            "/v1/conversations/{id}", self._handle_rename_conversation
        )
        # Gateway extension: cross-platform enumeration. Optional second
        # contract (`/v1/gateway/*`) the proxy probes-and-falls-back on.
        # Implemented here because hermes IS a gateway — telegram, slack,
        # whatsapp etc. live behind the same state.db. Stub agents and
        # single-channel agents simply don't expose this prefix; the
        # proxy 404s gracefully back to `/v1/conversations`.
        self._app.router.add_get(
            "/v1/gateway/conversations", self._handle_list_gateway_conversations
        )
        # Turn dispatch + out-of-turn event channel.
        self._app.router.add_post(
            "/v1/responses", self._handle_responses
        )
        self._app.router.add_get(
            "/v1/events", self._handle_events
        )
        # Optional settings extension. Today: a single "model" enum
        # entry that wraps hermes config + the openrouter catalog,
        # filtered by SIDEKICK_PREFERRED_MODELS. Adding more
        # (persona, temperature, ...) is purely additive: extend
        # _build_settings_schema + _apply_setting.
        self._app.router.add_get(
            "/v1/settings/schema", self._handle_settings_schema
        )
        self._app.router.add_post(
            "/v1/settings/{id}", self._handle_settings_update
        )
        # Slash-command catalog. Surfaced as JSON so the PWA composer
        # can render an autocomplete popover from the same registry the
        # CLI / Telegram / Slack consume. See proposal in the sidekick
        # repo's slashCommands.ts module.
        self._app.router.add_get(
            "/v1/commands", self._handle_list_commands
        )
        # Auxiliary-model advertisement. Hermes auto-routes media_urls
        # through `_enrich_message_with_vision` → `vision_analyze_tool`
        # → `auxiliary.vision` (see hermes-agent gateway/run.py:8275),
        # so the primary model never has to support vision directly.
        # Surface the configured auxiliary so the PWA can enable the
        # attachment button when the primary is text-only — without
        # this advertisement the button would stay disabled even though
        # the upload would actually work end-to-end.
        self._app.router.add_get(
            "/v1/sidekick/auxiliary-models", self._handle_auxiliary_models
        )
        # Model capability lookup — ground truth from hermes's models.dev
        # registry. Replaces the previous OpenRouter-catalog fetch +
        # regex-fallback in sidekick. Same data hermes consults at request
        # time for native-vs-text image routing.
        self._app.router.add_get(
            "/v1/sidekick/model-capabilities", self._handle_model_capabilities
        )
        # Cross-conversation FTS5 search. Reads against the same
        # messages_fts virtual table hermes_state.SessionDB maintains
        # — the index is hermes-owned, we just SELECT against it.
        # Returns the SearchResult shape (sessions+hits) the cmd+K
        # palette already consumes.
        self._app.router.add_get(
            "/v1/conversations/search", self._handle_search_conversations
        )

        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, self._host, self._port)
        await self._site.start()
        self._mark_connected()

        # Capture the running event loop + register as the live adapter so
        # synchronous tool-event hooks (which fire from worker threads via
        # asyncio.run_in_executor in run_agent.py) can schedule envelope
        # sends back onto our loop via run_coroutine_threadsafe.
        self._loop = asyncio.get_running_loop()
        global _active_adapter
        _active_adapter = self

        logger.info(
            "[sidekick] WS server listening on %s:%d (token=%s***)",
            self._host,
            self._port,
            self._token[:4],
        )

        # Ensure the read-side composite index for (user_id, source) is
        # present. The plugin's drawer aggregation + per-chat history
        # query both filter on this pair, and the upstream hermes-agent
        # schema only ships a single-column source index. Idempotent
        # (CREATE INDEX IF NOT EXISTS), best-effort.
        await asyncio.to_thread(self._ensure_state_db_indexes)

        # Spawn the state.db poller for session_changed emission. Logs
        # once at startup so an operator can confirm it's wired.
        if self._state_db_path is not None:
            self._session_poll_task = asyncio.create_task(
                self._session_poll_loop(),
                name="sidekick-session-poll",
            )
            logger.info(
                "[sidekick] session_changed poller armed against %s "
                "(interval=%.1fs)",
                self._state_db_path,
                SESSION_POLL_INTERVAL_S,
            )
        else:
            logger.warning(
                "[sidekick] state.db path not resolved — "
                "session_changed envelopes will not be emitted"
            )
        return True

    async def disconnect(self) -> None:
        """Stop accepting new connections, close the active proxy client."""
        # Drop the module-level live-adapter pointer FIRST so any in-flight
        # hook callback that fires during shutdown becomes a silent no-op
        # rather than racing against a half-closed loop / socket.
        global _active_adapter
        if _active_adapter is self:
            _active_adapter = None
        self._loop = None

        # Cancel the session poller before tearing down the WS so it can't
        # fire envelopes into a half-closed socket.
        if self._session_poll_task is not None:
            self._session_poll_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._session_poll_task
            self._session_poll_task = None

        if self._site is not None:
            with contextlib.suppress(Exception):
                await self._site.stop()
            self._site = None
        if self._runner is not None:
            with contextlib.suppress(Exception):
                await self._runner.cleanup()
            self._runner = None
        self._app = None
        self._mark_disconnected()
        logger.info("[sidekick] disconnected")

    # ------------------------------------------------------------------
    # HTTP / WS handlers
    # ------------------------------------------------------------------

    async def _handle_health(self, request: "web.Request") -> "web.Response":
        return web.json_response(
            {
                "status": "ok",
                "platform": "sidekick",
                "protocol_version": PROTOCOL_VERSION,
            }
        )

    async def _dispatch_message(
        self,
        *,
        chat_id: str,
        text: str,
        attachments: Optional[list] = None,
    ) -> None:
        """Build a MessageEvent and hand it to the gateway core.

        ``attachments`` is the array the PWA collects from the camera /
        image picker — each entry ``{type, mimeType, fileName,
        content}`` where ``content`` is a ``data:`` URL. We write each
        payload to a tempfile and pass the paths via ``media_urls``,
        matching how the telegram adapter populates downloaded photos
        (``gateway/platforms/telegram.py``). Hermes' vision tools read
        ``media_urls`` directly off the MessageEvent.
        """
        self._known_chat_ids.add(chat_id)
        source = self.build_source(
            chat_id=chat_id,
            chat_name=f"sidekick:{chat_id[:8]}",
            chat_type="dm",
            user_id=chat_id,        # one user-per-chat in single-tenant model
            user_name="sidekick-user",
        )

        media_urls: List[str] = []
        media_types: List[str] = []
        message_type = MessageType.TEXT
        if attachments:
            paths, mimes, dominant = self._materialize_attachments(attachments)
            if paths:
                media_urls = paths
                media_types = mimes
                message_type = dominant
                # Tempfiles outlive the turn intentionally. The agent
                # may follow up with `vision_analyze` after `reply_final`
                # (e.g. user asks "look closer at page 2"), and an
                # eager end-of-turn unlink races with that — observed
                # via vision_analyze raising "Invalid image source"
                # because the PNG was already gone. /tmp is swept by
                # systemd-tmpfiles on its own schedule (10d default on
                # Pi OS); single-user/single-host means stray PNGs are
                # harmless until then.

        # Pre-enrich images in parallel so a multi-page PDF (= N image
        # paths after rasterization) doesn't pay N×serial-vision-call
        # latency in the gateway's `_enrich_message_with_vision` loop.
        # See _parallel_image_enrich docstring for the trade-off.
        if media_urls:
            text, media_urls, media_types, message_type = await self._parallel_image_enrich(
                text, media_urls, media_types, message_type,
            )

        event = MessageEvent(
            text=text or "",
            message_type=message_type,
            source=source,
            message_id=str(uuid.uuid4()),
            media_urls=media_urls,
            media_types=media_types,
        )
        await self.handle_message(event)

    async def _parallel_image_enrich(
        self,
        text: str,
        media_urls: List[str],
        media_types: List[str],
        message_type: "MessageType",
    ) -> Tuple[str, List[str], List[str], "MessageType"]:
        """Pre-enrich image attachments via auxiliary vision in parallel.

        Why this lives in the sidekick plugin (and not in hermes core):
        sidekick is the only platform that rasterizes PDFs to N image
        pages — every other adapter (telegram, signal, slack, ...) sees
        at most a handful of attached images per turn. The gateway's
        ``_enrich_message_with_vision`` (gateway/run.py) iterates
        ``image_paths`` SERIALLY by design — fine for 1-3 images, brutal
        for a 21-page PDF (21 × ~5s = ~100s before the primary model
        sees any text). Parallelizing in the plugin keeps the win where
        the cost actually lands without forcing a hermes-core change.

        Strategy: split image entries off ``media_urls``, run
        ``vision_analyze_tool`` in parallel via ``asyncio.gather``, and
        prepend the descriptions to ``text`` using the SAME format the
        gateway's enrich loop produces — so agent behavior is identical
        (the path-embedded follow-up hint lets the agent re-call
        ``vision_analyze`` for a closer look at any specific page).

        Non-image media (audio, video) is left in ``media_urls`` for the
        gateway to handle through its own enrichers — those run once per
        attachment and aren't a multi-page bottleneck.
        """
        from tools.vision_tools import vision_analyze_tool

        image_indices = [
            i for i, m in enumerate(media_types)
            if m.startswith("image/") or message_type == MessageType.PHOTO
        ]
        if not image_indices:
            return text, media_urls, media_types, message_type

        image_paths = [media_urls[i] for i in image_indices]

        analysis_prompt = (
            "Describe everything visible in this image in thorough detail. "
            "Include any text, code, data, objects, people, layout, colors, "
            "and any other notable visual information."
        )

        async def _analyze_one(path: str) -> str:
            try:
                result_json = await vision_analyze_tool(
                    image_url=path,
                    user_prompt=analysis_prompt,
                )
                result = json.loads(result_json)
                if result.get("success"):
                    description = result.get("analysis", "")
                    return (
                        f"[The user sent an image~ Here's what I can see:\n{description}]\n"
                        f"[If you need a closer look, use vision_analyze with "
                        f"image_url: {path} ~]"
                    )
                return (
                    "[The user sent an image but I couldn't quite see it "
                    "this time (>_<) You can try looking at it yourself "
                    f"with vision_analyze using image_url: {path}]"
                )
            except Exception as e:
                logger.error("[sidekick] parallel vision enrich error: %s", e)
                return (
                    "[The user sent an image but something went wrong when I "
                    "tried to look at it~ You can try examining it yourself "
                    f"with vision_analyze using image_url: {path}]"
                )

        enriched_parts = await asyncio.gather(*(_analyze_one(p) for p in image_paths))

        prefix = "\n\n".join(enriched_parts)
        new_text = f"{prefix}\n\n{text}" if text else prefix

        # Strip image entries from the media arrays so the gateway's
        # serial enrich loop doesn't re-process them. Audio / video
        # entries (if any) are preserved for the gateway to handle.
        image_set = set(image_indices)
        keep = [(media_urls[i], media_types[i]) for i in range(len(media_urls)) if i not in image_set]
        if keep:
            new_urls, new_types = map(list, zip(*keep))
            new_kinds = [self._kind_for_mime(t) for t in new_types]
        else:
            new_urls, new_types, new_kinds = [], [], []
        return new_text, new_urls, new_types, self._dominant_message_type(new_kinds)

    @staticmethod
    def _rasterize_pdf(path: Path) -> List[Path]:
        """Rasterize a PDF to per-page PNG files alongside the source.

        Shells out to ``pdftoppm`` (poppler-utils). Output PNGs land in
        the same directory as ``path`` with the input stem as their
        prefix; pdftoppm names them ``<prefix>-<N>.png`` (zero-padded
        when there are 10+ pages, plain otherwise).

        Limits — all overridable via env (see module-level constants):

        * ``SIDEKICK_PDF_MAX_BYTES`` (default 20 MB): if the PDF on disk
          exceeds this, we log a warning and return ``[]`` — caller
          drops the attachment, agent sees no images for it.
        * ``SIDEKICK_PDF_MAX_PAGES`` (default 50): passed to pdftoppm
          via ``-l N`` so it stops after N pages.
        * ``SIDEKICK_PDF_DPI`` (default 150): ``-r N``.
        * ``SIDEKICK_PDF_RASTERIZE_TIMEOUT_S`` (default 30): subprocess
          timeout. On expiry we log + return ``[]``; the request
          continues without crashing.

        On any failure (encrypted/corrupt PDF → non-zero exit, missing
        ``pdftoppm`` binary, timeout) returns ``[]``. Never raises.
        """
        import subprocess

        try:
            file_size = path.stat().st_size
        except OSError as exc:
            logger.warning("[hermes-plugin] PDF stat failed (%s): %s", path, exc)
            return []

        if file_size > SIDEKICK_PDF_MAX_BYTES:
            logger.warning(
                "[hermes-plugin] PDF %s rejected: %dB > %dB cap",
                path, file_size, SIDEKICK_PDF_MAX_BYTES,
            )
            return []

        # pdftoppm writes <prefix>-1.png, <prefix>-2.png ... in the
        # parent dir. Use the input's stem as the prefix so cleanup
        # (which already walks the per-turn paths list) is uniform.
        prefix = str(path.with_suffix(""))
        cmd = [
            "pdftoppm",
            "-png",
            "-r", str(SIDEKICK_PDF_DPI),
            "-l", str(SIDEKICK_PDF_MAX_PAGES),
            str(path),
            prefix,
        ]
        try:
            subprocess.run(
                cmd,
                capture_output=True,
                timeout=SIDEKICK_PDF_RASTERIZE_TIMEOUT_S,
                check=True,
            )
        except FileNotFoundError:
            logger.error(
                "[hermes-plugin] pdftoppm not installed — PDF rasterization "
                "disabled. Install via `apt install poppler-utils` "
                "(Debian/Ubuntu) or `brew install poppler` (macOS)."
            )
            return []
        except subprocess.TimeoutExpired:
            logger.warning(
                "[hermes-plugin] pdftoppm timeout (>%ds) on %s — dropping",
                SIDEKICK_PDF_RASTERIZE_TIMEOUT_S, path,
            )
            return []
        except subprocess.CalledProcessError as exc:
            stderr = (exc.stderr or b"").decode(errors="ignore")[:200]
            logger.warning(
                "[hermes-plugin] pdftoppm failed on %s (rc=%d): %s",
                path, exc.returncode, stderr,
            )
            return []

        # Collect outputs. pdftoppm uses 1-based numbering; for ≤9
        # pages it writes "<prefix>-1.png" .. "<prefix>-9.png", for 10+
        # it zero-pads to the width of the page count
        # ("<prefix>-01.png" etc). Glob covers both shapes.
        parent = path.parent
        stem = path.stem
        pages = sorted(parent.glob(f"{stem}-*.png"))
        if not pages:
            logger.warning(
                "[hermes-plugin] pdftoppm produced no output for %s", path,
            )
            return []

        logger.info(
            "[hermes-plugin] rasterized %d pages from %s (%dp, %dB)",
            len(pages), path, len(pages), file_size,
        )
        return pages

    def _materialize_attachments(
        self, attachments: list,
    ) -> Tuple[List[str], List[str], "MessageType"]:
        """Decode base64 ``data:`` URL payloads to tempfiles. Returns
        ``(paths, mime_types, dominant_message_type)``.

        The PWA sends each attachment as
        ``{type, mimeType, fileName, content}`` where ``content`` is a
        full ``data:<mime>;base64,<payload>`` string. Hermes wants
        on-disk paths in ``MessageEvent.media_urls`` (telegram adapter
        models this — it downloads photos to a cache dir, then sets
        media_urls to those paths). We mirror that contract for the
        sidekick path: write to ``/tmp/sidekick-attach-<uuid>.<ext>``
        and let the OS clean tmpdirs on its own schedule (sidekick is
        single-user, single-host; a stray /tmp file is harmless).

        PDF attachments are rasterized server-side before they reach
        the agent: ``application/pdf`` payloads get written to a temp
        ``.pdf``, then ``_rasterize_pdf`` shells out to ``pdftoppm`` and
        replaces the PDF entry with one ``image/png`` entry per page.
        Vision-capable models (gemma-3, claude, gpt-4o, gemini) consume
        images natively, not PDFs — this keeps the existing media_urls
        → vision-tool pipeline doing all the work without each model
        backend needing to know about PDFs. The PDF tempfile itself is
        deleted as soon as rasterization completes; only the PNG pages
        are returned (and tracked for end-of-turn cleanup).

        Sidekick-only scope: telegram/whatsapp/slack/signal each have
        their own platform adapters with separate attachment flows
        (``gateway/platforms/*.py``). Cross-channel PDF support is a
        follow-up.
        """
        import base64
        import tempfile

        paths: List[str] = []
        mimes: List[str] = []
        kinds: List[str] = []
        for a in attachments:
            if not isinstance(a, dict):
                continue
            content = a.get("content")
            if not isinstance(content, str) or not content.startswith("data:"):
                continue
            try:
                header, b64 = content.split(",", 1)
            except ValueError:
                continue
            # header looks like 'data:image/png;base64' — pull mime.
            mime = a.get("mimeType") or ""
            if not mime and ";" in header:
                mime = header.split(":", 1)[1].split(";", 1)[0]
            try:
                payload = base64.b64decode(b64, validate=False)
            except Exception:
                logger.warning("[sidekick] base64 decode failed for attachment")
                continue
            ext = self._ext_for_mime(mime, a.get("fileName"))
            fd, path = tempfile.mkstemp(
                prefix="sidekick-attach-", suffix=ext, dir="/tmp",
            )
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(payload)
            except Exception:
                logger.exception("[sidekick] failed writing attachment to %s", path)
                continue
            # PDFs: rasterize to N PNGs, drop the original PDF tempfile,
            # and append the pages to the output instead. On any
            # rasterization failure (oversize, encrypted, missing
            # binary, timeout) _rasterize_pdf returns [] — we still
            # drop the PDF; the agent gets no images for it but the
            # turn proceeds normally.
            if mime.lower() == "application/pdf":
                pdf_path = Path(path)
                pages = self._rasterize_pdf(pdf_path)
                try:
                    pdf_path.unlink()
                except OSError:
                    pass
                for page in pages:
                    paths.append(str(page))
                    mimes.append("image/png")
                    kinds.append("image")
                continue
            paths.append(path)
            mimes.append(mime)
            kinds.append(self._kind_for_mime(mime))
        if not paths:
            return [], [], MessageType.TEXT
        return paths, mimes, self._dominant_message_type(kinds)

    @staticmethod
    def _dominant_message_type(kinds: List[str]) -> "MessageType":
        """First-wins precedence over a kinds list ('image' | 'video' |
        'audio' | 'document'). Empty list → TEXT. Used by both
        _materialize_attachments (initial classification) and
        _parallel_image_enrich (post-strip recompute) so the two paths
        never drift on classification rules."""
        if not kinds:
            return MessageType.TEXT
        first = kinds[0]
        if first == "video":
            return MessageType.VIDEO
        if first == "audio":
            return MessageType.AUDIO
        if first == "document":
            return MessageType.DOCUMENT
        return MessageType.PHOTO

    @staticmethod
    def _ext_for_mime(mime: str, file_name: Optional[str]) -> str:
        # Prefer the original filename's extension if present (preserves
        # JPEG vs PNG vs HEIC etc. for downstream tools that care).
        if file_name and "." in file_name:
            return "." + file_name.rsplit(".", 1)[-1].lower()
        if not mime:
            return ""
        # Lightweight mime → ext map. Don't pull mimetypes module just
        # for half a dozen entries.
        m = mime.lower()
        if m == "image/png": return ".png"
        if m == "image/jpeg" or m == "image/jpg": return ".jpg"
        if m == "image/webp": return ".webp"
        if m == "image/gif": return ".gif"
        if m == "image/heic": return ".heic"
        if m == "video/mp4": return ".mp4"
        if m == "video/quicktime": return ".mov"
        if m == "audio/mpeg" or m == "audio/mp3": return ".mp3"
        if m == "audio/wav": return ".wav"
        if m == "application/pdf": return ".pdf"
        return ""

    @staticmethod
    def _kind_for_mime(mime: str) -> str:
        m = (mime or "").lower()
        if m.startswith("image/"): return "image"
        if m.startswith("video/"): return "video"
        if m.startswith("audio/"): return "audio"
        return "document"

    # ------------------------------------------------------------------
    # HTTP read endpoints (agent contract Phase 1)
    # ------------------------------------------------------------------
    #
    # These mirror the abstract agent protocol's
    # /v1/conversations* endpoints (see docs/ABSTRACT_AGENT_PROTOCOL.md).
    # The same in-process state.db reads the session poller does back
    # them; no separate direct-state access path needed.

    def _check_http_auth(self, request: "web.Request") -> bool:
        """Validate ``Authorization: Bearer <token>``. Constant-time."""
        import hmac

        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        provided = header[len("Bearer ") :].strip()
        return hmac.compare_digest(provided, self._token)

    async def _handle_list_conversations(self, request: "web.Request") -> "web.Response":
        """GET /v1/conversations — return the sidekick-only drawer list.

        Channel-only counterpart to the cross-platform
        ``/v1/gateway/conversations``. Single-channel agents (stub,
        third-party OAI-compat agents that aren't gateways) implement
        only this. The proxy probes the gateway endpoint first and
        falls back here on 404, stamping ``source: 'sidekick'``."""
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")
        try:
            limit = max(1, min(int(request.query.get("limit", "50")), 200))
        except ValueError:
            return web.Response(status=400, text="invalid limit")

        rows = await asyncio.to_thread(
            self._summaries_by_user_id, (SIDEKICK_SOURCE,), limit,
        )
        data = [
            {
                "id": chat_id,
                "object": "conversation",
                "created_at": int(created_at),
                "metadata": {
                    "title": title or "",
                    "message_count": message_count,
                    "turn_count": turn_count,
                    "tool_count": tool_count,
                    "last_active_at": int(last_active_at),
                    "first_user_message": first_user_message,
                },
            }
            for (chat_id, _source, _chat_type, title, message_count,
                 turn_count, tool_count,
                 last_active_at, created_at, first_user_message) in rows
        ]
        return web.json_response({"object": "list", "data": data})

    async def _handle_get_conversation_items(self, request: "web.Request") -> "web.Response":
        """GET /v1/conversations/{id}/items — transcript replay.

        Aggregates messages across every state.db session whose
        ``(user_id, source)`` matches this chat. user_id IS the
        platform chat_id; rotations under the hood (compression forks
        AND session_reset auto-reset) all roll up into a single flat
        transcript ordered by ``(timestamp ASC, id ASC)``.

        Source is resolved at query time by probing state.db for any
        source associated with this user_id, preferring ``sidekick``
        on a collision (sidekick chat_ids are UUIDs, telegram chat_ids
        are short ints, so collisions are vanishingly unlikely in
        practice but the deterministic preference keeps behavior
        reproducible)."""
        # [items-trace] instrumentation (Jonathan, 2026-05-04 overnight)
        # — diagnose the 4-20s `/messages` latency. Print() bypasses
        # hermes logger config (which seemingly drops INFO from journal).
        # Removes once the bottleneck is identified.
        import time as _time
        import sys as _sys
        _trace_id = secrets.token_hex(3)
        _t0 = _time.monotonic()
        def _trace(event: str, extra: str = "") -> None:
            ms = int((_time.monotonic() - _t0) * 1000)
            print(f"[items-trace {_trace_id}] +{ms}ms {event}{' ' + extra if extra else ''}", flush=True, file=_sys.stderr)
        _trace("enter")
        if not self._check_http_auth(request):
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

        # Prefer the source carried in the prefixed id — that's what
        # disambiguates `(source, chat_id)` collisions. Fall back to
        # state.db source resolution for legacy un-prefixed callers.
        parsed_source, chat_id = _parse_gateway_id(raw_id)
        if parsed_source is not None:
            source = parsed_source
            _trace("source-from-prefix", f"source={source} chat={chat_id[:24]}")
        else:
            _trace("source-resolve-start", f"chat={chat_id[:24]}")
            source = await asyncio.to_thread(self._resolve_source_for_chat_id, chat_id)
            _trace("source-resolve-end", f"source={source}")
            if source is None:
                return web.Response(status=404, text="conversation not found")

        _trace("query-start", f"limit={limit} before={before_id}")
        result = await asyncio.to_thread(
            self._items_by_user_id, chat_id, source, limit, before_id,
        )
        _trace("query-end", f"rows={len(result[0]) if result else 0}")
        if result is None:
            return web.Response(status=404, text="conversation not found")
        items, first_id, has_more = result
        response = web.json_response({
            "object": "list",
            "data": items,
            "first_id": first_id,
            "has_more": has_more,
        })
        _trace("response-built")
        return response

    async def _handle_list_gateway_conversations(
        self, request: "web.Request"
    ) -> "web.Response":
        """GET /v1/gateway/conversations — cross-platform drawer list.

        Same OAI-compat row shape as `/v1/conversations` (`{id, object,
        created_at, metadata}`), but enumerates every platform in
        state.db (telegram / slack / whatsapp / sidekick / …) and adds
        `source` + `chat_type` to `metadata` so the proxy can render
        per-row badges. Sidekick's drawer relies on this for
        cross-platform visibility; non-sidekick rows are read-only.

        Backed by `_summaries_by_user_id` which groups state.db rows by
        `(user_id, source)` — chat_id IS user_id at the gateway. This
        means rotated session_ids (auto-reset, compression) all roll
        up into a single drawer entry; the previous sessions.json walk
        only saw the currently-active session per chat and lost the
        rest after rotation.

        Implementing this endpoint is what makes a plugin a "gateway" in
        sidekick's eyes. Single-channel agents (stub, openai-compat
        third-parties) leave it unimplemented and the proxy falls back
        to `/v1/conversations`."""
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")
        try:
            limit = max(1, min(int(request.query.get("limit", "50")), 200))
        except ValueError:
            return web.Response(status=400, text="invalid limit")

        rows = await asyncio.to_thread(
            self._summaries_by_user_id, GATEWAY_DRAWER_SOURCES, limit,
        )
        data = [
            {
                # Prefixed `${source}:${chat_id}` — see _format_gateway_id
                # rationale at module top. Clients treat as opaque; per-
                # chat handlers decode source-side via _parse_gateway_id.
                "id": _format_gateway_id(source, chat_id),
                "object": "conversation",
                "created_at": int(created_at),
                "metadata": {
                    "title": title or "",
                    "message_count": message_count,
                    "turn_count": turn_count,
                    "tool_count": tool_count,
                    "last_active_at": int(last_active_at),
                    "first_user_message": first_user_message,
                    "source": source,
                    "chat_type": chat_type,
                    # Native chat_id (pre-prefix) preserved for clients
                    # that need to display or correlate the platform-
                    # native identifier (e.g. WhatsApp @lid badge, debug).
                    "native_chat_id": chat_id,
                },
            }
            for (chat_id, source, chat_type, title, message_count,
                 turn_count, tool_count,
                 last_active_at, created_at, first_user_message) in rows
        ]
        return web.json_response({"object": "list", "data": data})

    async def _handle_delete_conversation(self, request: "web.Request") -> "web.Response":
        """DELETE /v1/conversations/{id} — hard delete with full cascade.

        Cascade ordering:
          1. state.db (sessions + messages rows)
          2. ~/.hermes/sessions/sessions.json (key removal)
          3. ~/.hermes/sessions/<sid>.jsonl (transcript file)
          4. Hindsight bank (memory units tagged with this session UUID)

        Best-effort on each step — sql failure aborts (the cascade can't
        proceed without knowing which session_id to scrub), filesystem
        failures log + continue, hindsight failures log + continue
        (privacy bug if hindsight scrub fails, but a stranded memory
        row is less bad than a stranded session row that re-ghosts the
        drawer)."""
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")
        raw_id = request.match_info["id"]
        # Source-aware delete — without the prefix we'd default to
        # SIDEKICK_SOURCE and silently scrub the wrong session when
        # chat_ids collide across platforms.
        parsed_source, chat_id = _parse_gateway_id(raw_id)
        source = parsed_source if parsed_source is not None else SIDEKICK_SOURCE
        if parsed_source is None:
            # Surfaces any caller still using bare-id DELETE so we can
            # tighten this fallback (eventually 400) once all callers
            # migrate. The 2026-05-03 data-loss regression flowed through
            # this exact path: a stale frontend cleanup hit bare-id
            # DELETE, this fallback defaulted to sidekick, and a real
            # session was wiped silently. The frontend cleanup is now
            # local-IDB-only (src/main.ts cleanupAbandonedChat) — any
            # bare-id DELETE arriving here is unexpected and worth a log.
            logger.warning(
                "[sidekick] bare-id DELETE %s — defaulting source=sidekick. "
                "Caller should use prefixed id `sidekick:%s` to be explicit.",
                raw_id, chat_id,
            )
        result = await asyncio.to_thread(
            self._delete_conversation_sync, chat_id, source,
        )
        if result == "not_found":
            return web.Response(status=404, text="conversation not found")
        if result == "error":
            return web.Response(status=500, text="delete failed")
        # Drop from in-process caches so the next list/poll doesn't
        # resurrect the row from stale state.
        self._session_state_cache.pop(chat_id, None)
        for sid in [s for s, c in self._sid_to_chat_id_cache.items() if c == chat_id]:
            self._sid_to_chat_id_cache.pop(sid, None)
        return web.json_response({"ok": True})

    async def _handle_rename_conversation(
        self, request: "web.Request"
    ) -> "web.Response":
        """PATCH /v1/conversations/{id} — set sessions.title.

        Body: ``{"title": "..."}`` — non-empty trimmed string ≤
        ``SESSION_TITLE_MAX_LEN`` chars. Updates every session row
        sharing ``(source, user_id=chat_id)`` so a chat that's been
        rotated by compression / auto-reset still surfaces the new
        title via ``_summaries_by_user_id`` (which picks the latest
        session's title).

        Sidekick-source-only today — telegram / slack / whatsapp don't
        expose a "rename" surface, and a sidekick-tab rename of a
        cross-source row would silently mutate state.db rows owned by
        a different platform. Rejected with 400 to make the boundary
        explicit.

        Emits a ``session_changed`` envelope so any other connected
        clients (PWA on a second device, the originating client's other
        tabs) see the live update via /v1/events. Same shape the
        compression poller uses; the event_id ring de-dupes if the
        poller's next tick observes the same change.
        """
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")
        raw_id = request.match_info["id"]
        parsed_source, chat_id = _parse_gateway_id(raw_id)
        source = parsed_source if parsed_source is not None else SIDEKICK_SOURCE
        if source != SIDEKICK_SOURCE:
            # Cross-source rename has no defined semantics yet — refuse
            # rather than silently mutate a non-sidekick session row.
            return web.json_response(
                {"error": "rename only supported for sidekick sessions"},
                status=400,
            )
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid json"}, status=400)
        title = body.get("title") if isinstance(body, dict) else None
        if not isinstance(title, str):
            return web.json_response(
                {"error": "title must be a string"}, status=400,
            )
        title = title.strip()
        if not title:
            return web.json_response(
                {"error": "title must be non-empty"}, status=400,
            )
        if len(title) > SESSION_TITLE_MAX_LEN:
            return web.json_response(
                {"error": f"title exceeds {SESSION_TITLE_MAX_LEN} chars"},
                status=400,
            )
        result = await asyncio.to_thread(
            self._rename_conversation_sync, chat_id, source, title,
        )
        if result == "not_found":
            return web.json_response(
                {"error": "conversation not found"}, status=404,
            )
        if result == "title_conflict":
            # state.db has a partial UNIQUE INDEX on title. Surfacing
            # 409 lets the PWA tell the user "another chat already
            # has that name" instead of crashing.
            return web.json_response(
                {"error": "another conversation already uses this title"},
                status=409,
            )
        if result == "error":
            return web.json_response({"error": "rename failed"}, status=500)
        # Surface to other connected clients. Use the same envelope
        # shape the compression poller emits — clients already know how
        # to consume it. session_id field is best-effort: we surface
        # whatever the poller has cached; downstream consumers key on
        # chat_id+title so a stale/empty session_id is harmless.
        cached_sid = (self._session_state_cache.get(chat_id) or ("", ""))[0]
        # Update the cache so the next poll tick doesn't immediately
        # re-emit a session_changed for the same (sid, title) pair.
        self._session_state_cache[chat_id] = (cached_sid, title)
        await self._safe_send_envelope({
            "type": "session_changed",
            "chat_id": chat_id,
            "session_id": cached_sid,
            "title": title,
        })
        return web.json_response({"ok": True, "title": title})

    # ── user_id-keyed read path (chat_id is the durable identity) ────
    #
    # Background: an earlier iteration of this plugin walked
    # ``~/.hermes/sessions/sessions.json``, which only points at the
    # *currently active* session for each session_key. When hermes
    # auto-reset rotates a session for a chat_id, the old session
    # loses its sessions.json mapping but state.db keeps the row with
    # ``user_id = <chat_id>``. The drawer then hid the old session
    # entirely and the history fetch only walked the
    # ``parent_session_id`` chain (which compression sets but
    # session_reset doesn't), so messages from rotated-out sessions
    # stopped being visible even though they were still in state.db.
    #
    # Fix: query state.db directly by ``(user_id, source)``, since
    # user_id IS the platform chat_id. The session_id rotation under
    # the hood is invisible to sidekick — every session that ever
    # belonged to this chat aggregates into one drawer row and replays
    # as one transcript. Compression-fork chains are subsumed (their
    # rows share user_id), so the recursive parent_session_id CTE is
    # no longer needed.
    #
    # Cross-platform safety: every query filters on ``user_id +
    # source`` together. Two platforms could in theory mint the same
    # chat_id (telegram numeric id vs sidekick UUID), but the source
    # discriminator keeps them distinct.

    def _summaries_by_user_id(
        self, sources: Tuple[str, ...], limit: int,
    ) -> list:
        """Drawer aggregation grouped by ``(user_id, source)``.

        Returns ``[(chat_id, source, chat_type, title, message_count,
        turn_count, tool_count, last_active_at, created_at,
        first_user_message), …]`` sorted most-recently-active first,
        bounded by ``limit``.

        ``turn_count`` is user-role messages (the user's mental model of
        "how many times have I said something"); ``tool_count`` is the
        opaque count of tool-call/result rows hermes inserted along the
        way. The drawer renders ``N turns · M tools`` when both are
        present (vs the misleading ``message_count`` which used to read
        as e.g. "39 msgs" when the user had only spoken twice and the
        agent had run 35 tool calls under the hood).

        ``sources`` is the platform allow-list — any non-empty
        ``sessions.source`` is included if its value is in this tuple.
        Pass ``("sidekick",)`` for the channel-only drawer; pass the
        full set (sidekick, telegram, slack, whatsapp, …) for the
        cross-platform gateway drawer.

        chat_type is fixed to "dm" because state.db doesn't carry it
        explicitly. The plugin's existing surface only exposed DM
        chats; group/channel inference would need an out-of-band
        signal (room id parsing) which lives in the platform adapters,
        not here.

        ``parent_session_id`` chains (compression forks) are walked
        via a recursive CTE that maps every session to its root
        user_id. The upstream hermes contract claims rotated sessions
        inherit user_id from the root, but in practice compaction
        creates child sessions with user_id=NULL (Jonathan field bug
        2026-05-12: neck-strain chat's compacted continuation invisible
        in the drawer because filtered out by the old
        ``WHERE user_id IS NOT NULL``). The CTE resolves the effective
        user_id by walking parent_session_id chains until we hit a
        session with user_id set; that root user_id is then used as
        the GROUP BY key for the drawer row.

        Where ORDER BY matters: ``ORDER BY started_at DESC LIMIT 1`` for
        the title pulls the *latest* session for the chat (whatever
        compression and session_reset did), which is what the drawer
        wants.
        """
        if self._state_db_path is None or not self._state_db_path.exists():
            return []
        if not sources:
            return []
        src_csv = ",".join(["?"] * len(sources))
        # Recursive CTE: session_root maps every session to its
        # effective (root_user_id, root_source) by walking
        # parent_session_id chains. Sessions with their own user_id
        # are their own root; sessions without inherit from their
        # parent's root. Hermes's compaction creates child sessions
        # with user_id=NULL, so this is the only way to roll them up
        # under the parent's user_id for drawer + history rendering.
        #
        # One row per resolved (root_user_id, source) pair:
        #   * MIN(started_at) — oldest session = drawer "created_at"
        #   * MAX over message timestamps — drawer "last_active_at"
        #   * SUM(COUNT(messages)) — total message_count across rotations
        #   * latest session's title (ORDER BY started_at DESC LIMIT 1)
        #   * very first user message ever (ORDER BY timestamp ASC LIMIT 1
        #     across all sessions that resolve to this user_id+source)
        # The system_prompt match in the recursive step distinguishes
        # compaction continuations (which INHERIT the parent's
        # sidekick-specific system_prompt) from delegate sub-task
        # sessions (which use hermes-agent's DEFAULT system_prompt
        # and just happen to share parent_session_id). Without this
        # gate the CTE over-includes — Jonathan's neck-strain chat
        # had 6 delegate sub-tasks chained off the root, inflating
        # the rolled-up message_count from a correct 157 (139 root +
        # 18 continuation) to 486 (incl. 329 sub-task messages).
        sql = f"""
            WITH RECURSIVE session_root(id, root_user_id, root_source, root_system_prompt) AS (
                SELECT id, user_id, source, system_prompt
                  FROM sessions
                 WHERE user_id IS NOT NULL
                UNION ALL
                SELECT s.id, sr.root_user_id, sr.root_source, sr.root_system_prompt
                  FROM sessions s
                  JOIN session_root sr ON s.parent_session_id = sr.id
                 WHERE s.user_id IS NULL
                   AND LENGTH(COALESCE(sr.root_system_prompt, '')) >= 200
                   AND SUBSTR(COALESCE(s.system_prompt, ''), 1, 200)
                       = SUBSTR(sr.root_system_prompt, 1, 200)
            )
            SELECT
                sr.root_user_id AS user_id,
                sr.root_source AS source,
                MIN(COALESCE(s.started_at, 0)) AS created_at,
                COALESCE(MAX(
                    (SELECT COALESCE(MAX(m.timestamp), s.started_at)
                       FROM messages m WHERE m.session_id = s.id)
                ), 0) AS last_active_at,
                SUM(
                    (SELECT COUNT(*) FROM messages m
                       WHERE m.session_id = s.id)
                ) AS message_count,
                SUM(
                    (SELECT COUNT(*) FROM messages m
                       WHERE m.session_id = s.id AND m.role = 'user')
                ) AS turn_count,
                SUM(
                    (SELECT COUNT(*) FROM messages m
                       WHERE m.session_id = s.id AND m.role = 'tool')
                ) AS tool_count,
                (SELECT COALESCE(s2.title, '')
                   FROM session_root sr2
                   JOIN sessions s2 ON s2.id = sr2.id
                   WHERE sr2.root_user_id = sr.root_user_id
                     AND sr2.root_source = sr.root_source
                   ORDER BY s2.started_at DESC LIMIT 1) AS title,
                (SELECT m.content
                   FROM messages m
                   JOIN session_root sr3 ON m.session_id = sr3.id
                   WHERE sr3.root_user_id = sr.root_user_id
                     AND sr3.root_source = sr.root_source
                     AND m.role = 'user'
                   ORDER BY m.timestamp ASC, m.id ASC LIMIT 1
                ) AS first_user_message
            FROM session_root sr
            JOIN sessions s ON s.id = sr.id
            WHERE sr.root_source IN ({src_csv})
            GROUP BY sr.root_user_id, sr.root_source
            ORDER BY last_active_at DESC
            LIMIT ?
        """
        params = list(sources) + [limit]
        uri = f"file:{self._state_db_path}?mode=ro"
        with contextlib.closing(
            sqlite3.connect(uri, uri=True, timeout=2.0)
        ) as conn:
            rows = conn.execute(sql, params).fetchall()
        out = []
        for (user_id, source, created_at, last_active_at, mcount,
             turn_count, tool_count, title, first_user) in rows:
            if not user_id:
                continue
            first_user_truncated = (first_user or "")[:80] or None
            out.append((
                user_id, source, "dm", title or "", int(mcount or 0),
                int(turn_count or 0), int(tool_count or 0),
                float(last_active_at or 0), float(created_at or 0),
                first_user_truncated,
            ))
        return out

    def _resolve_source_for_chat_id(self, chat_id: str) -> Optional[str]:
        """Pick a `sessions.source` for this chat_id.

        Used by the per-chat history handler, which doesn't carry a
        source on the URL. Prefers ``sidekick`` on a collision so the
        composer-editable behavior in the PWA stays consistent for
        sidekick-native chats; falls back to whatever source state.db
        has for the user_id otherwise (telegram, slack, etc.).

        Returns None when no session exists for the chat_id (treated
        as 404 by the caller).
        """
        if self._state_db_path is None or not self._state_db_path.exists():
            return None
        uri = f"file:{self._state_db_path}?mode=ro"
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
        self,
        chat_id: str,
        source: str,
        limit: int,
        before_id: Optional[int],
    ) -> Optional[Tuple[list, Optional[int], bool]]:
        """Transcript replay across every session that ever belonged
        to ``(user_id=chat_id, source)``.

        Returns ``(items, first_id, has_more)`` or ``None`` when no
        sessions exist for the pair (treated as 404 by the route
        handler).

        Replaces the old ``_read_conversation_items`` recursive CTE
        over ``parent_session_id``. Rotations done by session_reset
        (which doesn't set parent_session_id) used to drop messages
        from history; this query picks them up because they share
        user_id.

        Honors ``before_id`` for lazy paging: when set, only messages
        with ``id < before_id`` are returned.
        """
        if self._state_db_path is None or not self._state_db_path.exists():
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
            SELECT m.id, m.role, m.content, m.tool_name, m.timestamp,
                   sml.sidekick_id
            FROM messages m
            JOIN session_root sr ON m.session_id = sr.id
            LEFT JOIN sidekick_msg_links sml ON sml.state_db_id = m.id
        """
        params: list = [chat_id, source]
        if before_id is not None:
            sql += " WHERE m.id < ?"
            params.append(before_id)
        sql += " ORDER BY m.timestamp ASC, m.id ASC"
        uri = f"file:{self._state_db_path}?mode=ro"
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
        items = []
        for row_id, role, content, tool_name, ts, sidekick_id in rows:
            text = (content or "")
            if text.startswith("[CONTEXT COMPACTION"):
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
            # SSE-shape id (umsg_*/msg_*) when this row was persisted
            # by a sidekick turn that recorded its link. Absent for
            # legacy messages persisted before the link table existed,
            # for messages from other channels (telegram, slack, etc.),
            # and for tool/system rows. PWA's renderHistoryMessage
            # prefers this as the upsert key; falls back to integer id.
            if sidekick_id:
                item["sidekick_id"] = sidekick_id
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

    def _delete_conversation_sync(
        self, chat_id: str, source: str = SIDEKICK_SOURCE,
    ) -> str:
        """Synchronous cascade delete. Returns 'ok', 'not_found', or
        'error'. Worker-thread safe.

        Resolves the set of session_ids to scrub via
        ``WHERE user_id = chat_id AND source = ?`` — picks up every
        session that ever belonged to this `(source, chat_id)` pair
        (compression forks AND auto-reset rotations), no recursive
        parent-chain walk needed. ``source`` defaults to ``sidekick``
        for backward compat with un-prefixed delete callers."""
        if self._state_db_path is None or not self._state_db_path.exists():
            return "error"
        try:
            with contextlib.closing(sqlite3.connect(self._state_db_path, timeout=5.0)) as conn:
                conn.execute("PRAGMA foreign_keys = ON")
                with conn:
                    # Recursive CTE walks parent_session_id chains so
                    # compacted child sessions (user_id=NULL) are
                    # included in the cascade — otherwise a delete
                    # leaves orphan child sessions in state.db,
                    # consuming disk + occasionally surfacing
                    # ghost rows.
                    rows = conn.execute("""
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
                        SELECT id FROM session_root
                    """, (chat_id, source)).fetchall()
                    fork_sids = [r[0] for r in rows]
                    if not fork_sids:
                        return "not_found"
                    placeholders = ",".join(["?"] * len(fork_sids))
                    conn.execute(
                        f"DELETE FROM messages WHERE session_id IN ({placeholders})",
                        fork_sids,
                    )
                    conn.execute(
                        f"DELETE FROM sessions WHERE id IN ({placeholders})",
                        fork_sids,
                    )
        except Exception as exc:
            logger.warning("[sidekick] state.db delete failed for chat_id=%s: %s", chat_id, exc)
            return "error"
        # sessions.json: scrub the sidekick key. SESSION_KEY_PREFIX is
        # the sidekick-namespaced prefix; for non-sidekick deletes the
        # sessions.json entry (if any) belongs to a different platform
        # adapter and isn't ours to scrub here. Skip when source isn't
        # sidekick — hermes-agent's other adapters own their own keys.
        # jsonl + hindsight cascades below still run for any source.
        if source == SIDEKICK_SOURCE:
            sessions_index = self._state_db_path.parent / "sessions" / "sessions.json"
            try:
                if sessions_index.exists():
                    with open(sessions_index, encoding="utf-8") as f:
                        idx = json.load(f)
                    key = f"{SESSION_KEY_PREFIX}{chat_id}"
                    if isinstance(idx, dict) and key in idx:
                        del idx[key]
                        tmp = sessions_index.with_suffix(f".tmp.{os.getpid()}")
                        with open(tmp, "w", encoding="utf-8") as f:
                            json.dump(idx, f, indent=2)
                        os.replace(tmp, sessions_index)
            except Exception as exc:
                logger.warning("[sidekick] sessions.json scrub failed: %s", exc)
        # jsonl transcripts.
        for sid in fork_sids:
            jsonl = self._state_db_path.parent / "sessions" / f"{sid}.jsonl"
            try:
                if jsonl.exists():
                    jsonl.unlink()
            except Exception as exc:
                logger.warning("[sidekick] jsonl unlink failed for sid=%s: %s", sid, exc)
        # Hindsight cascade (privacy-critical — closes the regression
        # introduced in the platform-adapter migration where the new
        # delete path skipped the hindsight scrub the legacy path had).
        try:
            self._purge_hindsight_for_session_uuids(fork_sids)
        except Exception as exc:
            logger.warning("[sidekick] hindsight purge failed: %s", exc)
        return "ok"

    def _rename_conversation_sync(
        self, chat_id: str, source: str, title: str,
    ) -> str:
        """Synchronous rename. Returns 'ok', 'not_found', or 'error'.
        Worker-thread safe.

        Updates only the LATEST session row for ``(user_id=chat_id,
        source)`` — that's the row the drawer's ``_summaries_by_user_id``
        picks up via ``ORDER BY started_at DESC LIMIT 1``. We can't
        update all rotated sessions in one shot because hermes-agent's
        state.db schema has a partial UNIQUE INDEX on
        ``sessions(title) WHERE title IS NOT NULL`` — every other
        rotated session for this chat ALREADY holds a (likely auto-
        generated, distinct) title, and rewriting them all to the same
        new title violates that constraint. The drawer's read path
        already prefers the latest, so updating just that row is
        sufficient and constraint-safe.
        """
        if self._state_db_path is None or not self._state_db_path.exists():
            return "error"
        try:
            with contextlib.closing(
                sqlite3.connect(self._state_db_path, timeout=5.0)
            ) as conn:
                with conn:
                    # Find the latest session for this chat — that's
                    # the one the drawer surfaces and the one a rename
                    # should target.
                    row = conn.execute(
                        "SELECT id FROM sessions "
                        "WHERE user_id = ? AND source = ? "
                        "ORDER BY started_at DESC LIMIT 1",
                        (chat_id, source),
                    ).fetchone()
                    if row is None:
                        return "not_found"
                    latest_sid = row[0]
                    # If another session already holds this title,
                    # the partial UNIQUE INDEX would reject the UPDATE.
                    # Two cases to distinguish (Jonathan, 2026-05-05):
                    #
                    #  1. The conflicting row is a STALE SIBLING for the
                    #     SAME chat_id+source — i.e. a prior rotation
                    #     where the user had set this title before
                    #     hermes' session compression minted a new row.
                    #     The drawer only ever shows the latest row, so
                    #     the sibling's title is functionally orphaned.
                    #     Clear it so the latest row can take the name —
                    #     matches the user's mental model of "this CHAT
                    #     is named X" (not "this session_id is named X").
                    #
                    #  2. The conflicting row belongs to a DIFFERENT
                    #     chat — genuine cross-chat collision; reject
                    #     and let the caller surface a toast.
                    #
                    # Filtering on `id != latest_sid` so the idempotent
                    # case (latest row already has this title) falls
                    # through to a no-op UPDATE without spurious clear.
                    existing = conn.execute(
                        "SELECT id, user_id, source FROM sessions "
                        "WHERE title = ? AND id != ?",
                        (title, latest_sid),
                    ).fetchone()
                    if existing is not None:
                        other_id, other_user, other_source = existing
                        if other_user == chat_id and other_source == source:
                            # Stale sibling — release its grip on the title.
                            conn.execute(
                                "UPDATE sessions SET title = NULL "
                                "WHERE id = ?",
                                (other_id,),
                            )
                        else:
                            return "title_conflict"
                    conn.execute(
                        "UPDATE sessions SET title = ? WHERE id = ?",
                        (title, latest_sid),
                    )
        except Exception as exc:
            logger.warning(
                "[sidekick] state.db rename failed for chat_id=%s: %s",
                chat_id, exc,
            )
            return "error"
        return "ok"

    def _purge_hindsight_for_session_uuids(self, session_uuids: list) -> None:
        """Delete hindsight memories tagged with any of these session
        UUIDs. Reads hindsight URL + bank from env; no-op if hindsight
        isn't configured (local-only deployments without a memory store).

        Two storage shapes (both handled by the proxy's existing
        purgeHindsightSession in TS — we mirror the logic here):
          1. Live retains (document.id == session UUID): direct DELETE.
          2. Backfilled docs (random doc.id, session UUID in metadata):
             paginated metadata sweep.

        Best-effort: hindsight unreachable is logged but not fatal."""
        url = os.getenv("HINDSIGHT_URL", "").strip() or os.getenv("SIDEKICK_HINDSIGHT_URL", "").strip()
        if not url:
            return
        bank = os.getenv("HINDSIGHT_BANK", "").strip() or os.getenv("SIDEKICK_HINDSIGHT_BANK", "default").strip()
        api_key = os.getenv("HINDSIGHT_API_KEY", "").strip() or os.getenv("SIDEKICK_HINDSIGHT_API_KEY", "").strip()
        try:
            import urllib.request
            import urllib.parse
            headers = {"content-type": "application/json"}
            if api_key:
                headers["authorization"] = f"Bearer {api_key}"
            for sid in session_uuids:
                target = f"{url}/v1/default/banks/{urllib.parse.quote(bank, safe='')}/documents/{urllib.parse.quote(sid, safe='')}"
                req = urllib.request.Request(target, method="DELETE", headers=headers)
                try:
                    with urllib.request.urlopen(req, timeout=5.0) as resp:
                        if resp.status not in (200, 204, 404):
                            logger.warning("[sidekick] hindsight DELETE returned %s for sid=%s", resp.status, sid)
                except urllib.error.HTTPError as e:
                    if e.code != 404:
                        logger.warning("[sidekick] hindsight DELETE returned %s for sid=%s", e.code, sid)
                except Exception as exc:
                    logger.warning("[sidekick] hindsight DELETE failed for sid=%s: %s", sid, exc)
        except Exception as exc:
            logger.warning("[sidekick] hindsight purge setup failed: %s", exc)

    # ------------------------------------------------------------------
    # /v1/responses — turn dispatch with streaming SSE reply
    # ------------------------------------------------------------------
    #
    # OpenAI Responses API compatible. Body: {conversation, input,
    # stream}. Stream defaults to True. The handler registers a per-
    # chat-id queue, dispatches the message via handle_message (which
    # eventually causes the agent to call back into self.send /
    # self.edit_message — the modified _safe_send_envelope routes
    # those replies into our queue), and writes them out as SSE
    # frames per ABSTRACT_AGENT_PROTOCOL.md until reply_final or
    # TURN_TIMEOUT_S.

    @staticmethod
    def _coerce_input(field: Any) -> Optional[str]:
        """Accept a plain string or the array-of-{role, content} form.
        Returns None for unrecognized shapes."""
        if isinstance(field, str):
            return field
        if isinstance(field, list):
            parts: List[str] = []
            for m in field:
                if not isinstance(m, dict):
                    continue
                role = m.get("role")
                if role not in ("user", "system"):
                    continue
                content = m.get("content")
                if isinstance(content, str):
                    parts.append(content)
                elif isinstance(content, list):
                    for c in content:
                        if isinstance(c, dict) and isinstance(c.get("text"), str):
                            parts.append(c["text"])
            if parts:
                return "\n".join(parts)
        return None

    # ── Optional settings extension (/v1/settings/*) ──────────────────
    # Lets the PWA render an agent-owned controls panel without
    # frontend-side knowledge of what the agent supports. Today: one
    # "model" enum. Adding more knobs (persona, temperature, default
    # provider) is additive: append to _build_settings_schema() and
    # branch _apply_setting() on id.

    def _read_hermes_config(self) -> Dict[str, Any]:
        """Snapshot of ~/.hermes/config.yaml as a dict (or {} on failure).
        Used by every settings read so we work from one consistent
        view per request. Raw read — no normalization."""
        try:
            import yaml
            from hermes_cli.config import get_config_path
            cfg_path = get_config_path()
            if not cfg_path.exists():
                return {}
            with open(cfg_path, encoding="utf-8") as f:
                return yaml.safe_load(f) or {}
        except Exception as e:
            logger.warning("[sidekick] settings: read hermes config failed: %s", e)
            return {}

    def _read_preferred_models(self, cfg: Dict[str, Any]) -> List[str]:
        """Resolve the preferred-models glob list. Source of truth:
        `sidekick.preferred_models:` in ~/.hermes/config.yaml (a yaml
        list of glob strings). Falls back to SIDEKICK_PREFERRED_MODELS
        env (comma-separated) for env-only deployments. Empty result
        = no filter (full catalog)."""
        sk = cfg.get("sidekick") if isinstance(cfg.get("sidekick"), dict) else {}
        raw = sk.get("preferred_models")
        if isinstance(raw, list):
            out = [str(g).strip() for g in raw if isinstance(g, str) and str(g).strip()]
            if out:
                return out
        env_raw = (os.environ.get("SIDEKICK_PREFERRED_MODELS") or "").strip()
        if env_raw:
            return [g.strip() for g in env_raw.split(",") if g.strip()]
        return []

    def _build_settings_schema(self) -> List[Dict[str, Any]]:
        """Build the SettingDef[] list. Reads hermes config.yaml for
        the current model + the preferred-models glob filter (under
        `sidekick.preferred_models:`). Picker options merge OpenRouter
        (filtered by user's preferred-globs) with EVERY other
        authenticated provider's curated model list (e.g. openai-codex
        OAuth, copilot, anthropic). Provider is encoded into the option
        value: OpenRouter entries stay bare (vendor/model), every other
        provider prefixes with `<slug>:` (e.g. `openai-codex:gpt-5.5`).
        _apply_model_setting parses the prefix back to route the switch
        to the right provider."""
        import fnmatch
        cfg = self._read_hermes_config()

        # Current model + provider — hermes stores model as scalar
        # (`model: google/gemma-4-26b-a4b-it`) or dict (`model:
        # {default: ..., provider: ...}`); handle both. Default
        # provider when unset is "openrouter" (matches hermes default).
        current_model = ""
        current_provider = "openrouter"
        model_cfg = cfg.get("model")
        if isinstance(model_cfg, dict):
            current_model = (model_cfg.get("default") or "").strip()
            current_provider = (model_cfg.get("provider") or "openrouter").strip()
        elif isinstance(model_cfg, str):
            current_model = model_cfg.strip()
        # Encoded form of the current selection — what the picker will
        # show as the active option. OpenRouter stays bare; others
        # carry the slug prefix so they can be uniquely identified
        # (e.g. `gpt-5.5` is ambiguous between openai-codex and copilot,
        # `openai-codex:gpt-5.5` is not).
        if current_provider == "openrouter" or not current_model:
            current_value = current_model
        else:
            current_value = f"{current_provider}:{current_model}"

        # Preferred-models filter (string-list — also exposed as its
        # own SettingDef below so the chip UI can edit it).
        preferred = self._read_preferred_models(cfg)

        # Openrouter catalog. fetch_openrouter_models returns a list of
        # `(model_id, source_label)` tuples (curated by hermes — only
        # tool-supporting models, ranked by the preferred_ids list).
        # The label is "recommended" / "free" / "" — useful as a hint
        # in the dropdown but we just use the id for now to keep the
        # contract simple. Be defensive about shape: any future return
        # type change should degrade to "no options" instead of 500ing
        # the whole settings panel.
        catalog: List[Dict[str, Any]] = []
        try:
            from hermes_cli.models import fetch_openrouter_models
            raw = fetch_openrouter_models() or []
            for entry in raw:
                if isinstance(entry, tuple) and len(entry) >= 1:
                    mid = str(entry[0] or "").strip()
                    tag = str(entry[1] or "").strip() if len(entry) >= 2 else ""
                elif isinstance(entry, dict):
                    mid = str(entry.get("id") or "").strip()
                    tag = ""
                elif isinstance(entry, str):
                    mid = entry.strip()
                    tag = ""
                else:
                    continue
                if not mid:
                    continue
                label = f"{mid} ({tag})" if tag else mid
                catalog.append({"value": mid, "label": label, "group": "OpenRouter"})
        except Exception as e:
            logger.warning("[sidekick] settings: openrouter catalog fetch failed: %s", e)

        # Apply preferred-models filter to the catalog. Empty list =
        # no filter (full catalog).
        if preferred and catalog:
            catalog = [
                e for e in catalog
                if any(fnmatch.fnmatch(e["value"], g) for g in preferred)
            ]

        # Supplement with the LIVE openrouter catalog for any preferred
        # glob whose pattern matched nothing in hermes' curated list.
        # The curated list (hermes_cli/models.py:OPENROUTER_MODELS) is
        # a hand-maintained "tool-supporting" subset and lags reality —
        # e.g. google/gemma-4* never made it in. The user's explicit
        # preferred glob is the authoritative signal: if they asked for
        # gemma-4, give them what openrouter actually has matching that.
        if preferred:
            try:
                import urllib.request
                req = urllib.request.Request(
                    "https://openrouter.ai/api/v1/models",
                    headers={"Accept": "application/json"},
                )
                with urllib.request.urlopen(req, timeout=5.0) as resp:
                    payload = json.loads(resp.read().decode())
                live_ids = [
                    str(item.get("id") or "").strip()
                    for item in (payload.get("data") or [])
                    if isinstance(item, dict)
                ]
                seen = {e["value"] for e in catalog}
                for mid in live_ids:
                    if not mid or mid in seen:
                        continue
                    if any(fnmatch.fnmatch(mid, g) for g in preferred):
                        catalog.append({"value": mid, "label": mid, "group": "OpenRouter"})
                        seen.add(mid)
            except Exception as e:
                logger.warning(
                    "[sidekick] settings: live openrouter supplement failed: %s", e,
                )

        # Pull EVERY OTHER authenticated provider's curated model list
        # (Codex OAuth, Copilot OAuth, Anthropic API key, etc.). Each
        # gets a `<slug>:<model>` value prefix so the dropdown can
        # uniquely identify it and _apply_model_setting can route the
        # switch to the right provider. Glob filtering is NOT applied
        # here — the per-provider curated lists are small (7-14 entries)
        # and forcing the user to add globs for each new provider
        # would be tax. OpenRouter (the giant catalog) keeps the
        # globs above; other providers ship as-is.
        # User-controlled provider exclusion — `sidekick.exclude_providers`
        # in ~/.hermes/config.yaml lists provider slugs to suppress from the
        # picker even if hermes auto-detects credentials for them. Use case:
        # `list_authenticated_providers` is "discovery-oriented" — it shows
        # providers the user COULD switch to (e.g. anthropic detected via
        # CC's OAuth, copilot detected via gh CLI token) regardless of
        # whether the user wants inference routed there. This list is the
        # opt-out. Set 2026-05-03.
        sk_cfg = cfg.get("sidekick", {}) if isinstance(cfg.get("sidekick"), dict) else {}
        exclude_providers = set()
        for p in (sk_cfg.get("exclude_providers") or []):
            if isinstance(p, str):
                exclude_providers.add(p.strip().lower())
        # Per-model exclusion list — globs matched against the encoded
        # picker value `<slug>:<model>` (e.g. `openai-codex:gpt-5.1-codex-mini`).
        # Use case: a provider is generally usable but specific models are
        # auth-tier-locked (e.g. ChatGPT-account auth rejects gpt-5.1-codex-*
        # with HTTP 400). Curated by the user as they discover unusable
        # entries. Glob-friendly so e.g. `openai-codex:gpt-4*` blocks the
        # whole gpt-4 family at once.
        exclude_models_globs = []
        for m in (sk_cfg.get("exclude_models") or []):
            if isinstance(m, str) and m.strip():
                exclude_models_globs.append(m.strip())
        try:
            from hermes_cli.model_switch import list_authenticated_providers
            for prov in list_authenticated_providers(
                current_provider=current_provider,
                current_base_url=str((model_cfg or {}).get("base_url", "") if isinstance(model_cfg, dict) else ""),
                user_providers=cfg.get("providers"),
                custom_providers=cfg.get("custom_providers"),
            ) or []:
                slug = (prov.get("slug") or "").strip()
                name = (prov.get("name") or slug).strip()
                if not slug or slug == "openrouter":
                    # Skip OpenRouter — it's already in `catalog` above
                    # with full filter logic + live supplement.
                    continue
                if slug.lower() in exclude_providers:
                    continue
                for mid in (prov.get("models") or []):
                    mid_s = str(mid).strip()
                    if not mid_s:
                        continue
                    encoded = f"{slug}:{mid_s}"
                    if exclude_models_globs and any(
                        fnmatch.fnmatch(encoded, g) for g in exclude_models_globs
                    ):
                        continue
                    catalog.append({
                        "value": encoded,
                        "label": mid_s,
                        "group": name,
                    })
        except Exception as e:
            logger.warning(
                "[sidekick] settings: list_authenticated_providers failed: %s", e,
            )

        # Always include the current model in the options[] list so the
        # picker can show "what's set now" even if the catalog filter
        # excluded it. Use the encoded value (with provider prefix for
        # non-openrouter) so the picker matches what's stored. Group it
        # under "Current" so it shows at the top of the dropdown for
        # easy visibility.
        if current_value and not any(e["value"] == current_value for e in catalog):
            catalog.insert(0, {
                "value": current_value,
                "label": current_value,
                "group": "Current",
            })

        # Sort by (group_order, label) so the dropdown stays grouped:
        # Current first (if any), then OpenRouter (the largest catalog),
        # then other providers alphabetically. Within a group, sort by
        # label.
        _GROUP_RANK = {"Current": 0, "OpenRouter": 1}
        catalog.sort(key=lambda e: (
            _GROUP_RANK.get(e.get("group", ""), 2),
            (e.get("group") or "").lower(),
            (e.get("label") or "").lower(),
        ))

        return [
            {
                "id": "model",
                "label": "Model",
                "description": "LLM used for replies",
                "category": "Agent",
                "type": "enum",
                "value": current_value,
                "options": catalog,
            },
            {
                "id": "preferred_models",
                "label": "Preferred models",
                "description": (
                    "Glob patterns that filter the model dropdown above "
                    "(e.g. anthropic/*, google/gemini-*). Empty = full "
                    "openrouter catalog."
                ),
                "category": "Agent",
                "type": "string-list",
                "value": preferred,
                "placeholder": "e.g. anthropic/* + Enter",
            },
        ]

    async def _handle_settings_schema(self, request: "web.Request") -> "web.Response":
        """GET /v1/settings/schema — list the agent's user-facing knobs."""
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")
        try:
            schema = await asyncio.get_running_loop().run_in_executor(
                None, self._build_settings_schema,
            )
        except Exception as e:
            logger.exception("[sidekick] settings schema build failed")
            return web.json_response(
                {"error": {"type": "server_error", "message": str(e)}},
                status=500,
            )
        return web.json_response({"object": "list", "data": schema})

    async def _handle_settings_update(self, request: "web.Request") -> "web.Response":
        """POST /v1/settings/{id} — apply one setting."""
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")
        sid = request.match_info.get("id", "")
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError):
            return web.json_response(
                {"error": {"type": "invalid_request_error",
                           "message": "body is not valid JSON"}},
                status=400,
            )
        value = body.get("value")
        try:
            updated = await asyncio.get_running_loop().run_in_executor(
                None, self._apply_setting, sid, value,
            )
        except _SettingsValidationError as e:
            return web.json_response(
                {"error": {"type": "invalid_request_error", "message": str(e)}},
                status=400,
            )
        except _SettingsNotFoundError as e:
            return web.json_response(
                {"error": {"type": "invalid_request_error", "message": str(e)}},
                status=404,
            )
        except Exception as e:
            logger.exception("[sidekick] settings apply failed: %s", sid)
            return web.json_response(
                {"error": {"type": "server_error", "message": str(e)}},
                status=500,
            )
        return web.json_response(updated)

    async def _handle_auxiliary_models(self, request: "web.Request") -> "web.Response":
        """GET /v1/sidekick/auxiliary-models — surface the auxiliary models
        hermes is configured to route to. Today: just `vision`. The PWA's
        attachment-button gate uses this to enable the + button when the
        primary model is text-only but an auxiliary vision model is
        configured (hermes auto-enriches media_urls via the auxiliary
        vision pipeline; see hermes-agent gateway/run.py:_enrich_message_with_vision).
        """
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")
        cfg = self._read_hermes_config()
        aux = cfg.get("auxiliary") if isinstance(cfg.get("auxiliary"), dict) else {}
        vision_cfg = aux.get("vision") if isinstance(aux.get("vision"), dict) else {}
        vision_model = vision_cfg.get("model") if isinstance(vision_cfg.get("model"), str) else None
        return web.json_response({"vision": vision_model or None})

    async def _handle_model_capabilities(self, request: "web.Request") -> "web.Response":
        """GET /v1/sidekick/model-capabilities?provider=X&model=Y — return
        ground-truth capability metadata from the models.dev registry that
        hermes already uses for its native-vs-text image routing decision
        (see agent/image_routing.py:_lookup_supports_vision).

        Replaces sidekick's previous OpenRouter-catalog + regex-fallback
        approach with the same data hermes consults at request time. Returns
        the full ModelCapabilities shape (so future capability gates —
        tool-calling, reasoning, context window — share one source).

        Response shape (200):
          {"supports_vision": bool, "supports_tools": bool,
           "supports_reasoning": bool, "context_window": int,
           "max_output_tokens": int, "model_family": str}
        Returns null fields (404 if model unknown to models.dev) so the PWA
        can fall back to its `vision_fallback_model` advertisement when the
        primary's caps are unknown.
        """
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")
        provider = (request.query.get("provider") or "").strip()
        model = (request.query.get("model") or "").strip()
        if not model:
            return web.json_response(
                {"error": "model query param required"}, status=400,
            )
        # PWA-side picker values are composite ids: bare `<vendor>/<name>`
        # (OpenRouter) or `<provider-slug>:<name>` (e.g.
        # `openai-codex:gpt-5.5`, `copilot:gpt-5.4`). models.dev is keyed
        # by bare model id, so when we see a `<slug>:<model>` shape AND
        # no explicit provider was passed, decode it BEFORE the lookup.
        # Pre-2026-05-11 the prefix was passed verbatim and models.dev
        # missed every lookup for non-OpenRouter selections — PWA fell
        # through to the vision_fallback advertisement even for natively-
        # vision-capable models like openai-codex:gpt-5.5. The same
        # slash-vs-colon-prefix detection lives in _apply_model_setting
        # (line ~2626) — both call sites use it now.
        if not provider and ":" in model and "/" not in model.split(":", 1)[0]:
            slug, _, mid = model.partition(":")
            provider = slug.strip()
            model = mid.strip()
        try:
            from agent.models_dev import (
                get_model_capabilities,
                PROVIDER_TO_MODELS_DEV,
            )
            if provider:
                caps = get_model_capabilities(provider, model)
                resolved_provider = provider if caps is not None else None
            else:
                # PWA may not know the provider (the picker groups by
                # "OpenAI" / "OpenAI Codex" / "OpenRouter" but the value
                # is just the model ID). Try each known provider in
                # models.dev order and return the first match.
                caps = None
                resolved_provider = None
                for p in PROVIDER_TO_MODELS_DEV.keys():
                    candidate = get_model_capabilities(p, model)
                    if candidate is not None:
                        caps = candidate
                        resolved_provider = p
                        break
        except Exception as e:
            logger.exception("[sidekick] model-capabilities lookup failed")
            return web.json_response(
                {"error": {"type": "server_error", "message": str(e)}},
                status=500,
            )
        if caps is None:
            # Distinguish "unknown to models.dev" from "lookup errored" so
            # the PWA can route the fallback path (vision_fallback_model
            # advertisement) without the user seeing an error.
            return web.json_response(
                {"provider": provider or None, "model": model, "known": False},
                status=200,
            )
        return web.json_response({
            "provider": resolved_provider,
            "model": model,
            "known": True,
            "supports_vision": caps.supports_vision,
            "supports_tools": caps.supports_tools,
            "supports_reasoning": caps.supports_reasoning,
            "context_window": caps.context_window,
            "max_output_tokens": caps.max_output_tokens,
            "model_family": caps.model_family,
        })

    async def _handle_search_conversations(self, request: "web.Request") -> "web.Response":
        """GET /v1/conversations/search?q=&limit=20 — FTS5 cross-conversation search.

        Reads against hermes' `messages_fts` index (maintained by
        hermes_state.SessionDB) — we just SELECT, hermes owns the writes.
        Filters to user/assistant roles by default (tool blobs would
        dominate noise from JSON-heavy outputs). Returns the
        `{sessions, hits}` shape `src/proxyClientTypes.ts:SearchResult`
        defines, so the PWA cmd+K palette renders without translation.
        """
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")
        q = (request.query.get("q") or "").strip()
        try:
            limit = max(1, min(50, int(request.query.get("limit") or "20")))
        except (TypeError, ValueError):
            limit = 20
        if not q:
            return web.json_response({"sessions": [], "hits": []})
        if self._state_db_path is None or not self._state_db_path.exists():
            return web.json_response({"sessions": [], "hits": []})
        try:
            sessions, hits = await asyncio.get_running_loop().run_in_executor(
                None, self._search_conversations_sync, q, limit,
            )
        except Exception as e:
            logger.exception("[sidekick] search failed")
            return web.json_response(
                {"sessions": [], "hits": [], "error": str(e)},
                status=500,
            )
        return web.json_response({"sessions": sessions, "hits": hits})

    def _search_conversations_sync(
        self, q: str, limit: int,
    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """Synchronous worker for `/v1/conversations/search`.

        FTS5 query syntax: auto-prefix-wildcards on bare tokens (matches
        hermes_cli/web_server.py:740's pattern — `nimb` → `nimb*` so
        partial-word queries match). Quoted phrases and existing wildcards
        pass through. Tokens with FTS5 operator chars are passed verbatim
        for power users.
        """
        prefix_query = self._fts5_query_for(q)
        sql = f"""
            SELECT
                m.id           AS message_id,
                m.session_id   AS session_id,
                m.role         AS role,
                snippet(messages_fts, 0, '', '', '…', 32) AS snippet,
                m.timestamp    AS timestamp,
                s.user_id      AS chat_id,
                s.source       AS source,
                COALESCE(s.title, '') AS session_title
            FROM messages_fts
            JOIN messages m ON m.id = messages_fts.rowid
            JOIN sessions s ON s.id = m.session_id
            WHERE messages_fts MATCH ?
              AND m.role IN ('user', 'assistant')
              AND s.source IN ({",".join("?" for _ in GATEWAY_DRAWER_SOURCES)})
            ORDER BY rank
            LIMIT ?
        """
        params: List[Any] = [prefix_query, *GATEWAY_DRAWER_SOURCES, limit]
        uri = f"file:{self._state_db_path}?mode=ro"
        with contextlib.closing(
            sqlite3.connect(uri, uri=True, timeout=2.0)
        ) as conn:
            try:
                rows = conn.execute(sql, params).fetchall()
            except sqlite3.OperationalError:
                # FTS5 syntax error despite sanitization (e.g. user passed
                # raw `OR` token without context). Empty rather than 500 —
                # the cmd+K palette keeps showing the cached session-filter
                # results above.
                rows = []

        # Group by (chat_id, source) for the sessions list. Best rank
        # wins for ordering; preserve hit order in the flat list.
        hits: List[Dict[str, Any]] = []
        sessions_by_key: Dict[Tuple[str, str], Dict[str, Any]] = {}
        for (message_id, session_id, role, snippet, timestamp,
             chat_id, source, session_title) in rows:
            prefixed_id = _format_gateway_id(source, chat_id)
            hits.append({
                "session_id": prefixed_id,
                "message_id": int(message_id),
                "role": role or "",
                "snippet": snippet or "",
                "timestamp": float(timestamp or 0),
                "session_title": session_title or "",
                "session_source": source or "",
            })
            key = (chat_id, source)
            if key not in sessions_by_key:
                sessions_by_key[key] = {
                    "id": prefixed_id,
                    "source": source,
                    "title": session_title or None,
                    "snippet": None,
                    "messageCount": None,
                    "lastMessageAt": None,
                }

        return list(sessions_by_key.values()), hits

    @staticmethod
    def _fts5_query_for(q: str) -> str:
        """Auto-add prefix wildcards on bare tokens so partial words match.

        Mirrors hermes_cli/web_server.py:740. `"quoted phrases"` and
        existing `wildcards*` pass through. Tokens containing FTS5
        operator chars (parens, colons) pass through verbatim — power
        users get raw FTS5 syntax; everyone else gets prefix matching.

        Special-char tokens (e.g. `@s.whatsapp.net`, `foo-bar-baz`,
        `user@example.com`) are wrapped in double quotes so FTS5
        doesn't parse `-` as NOT, `.`/`@` as separators with prefix-*
        producing junk, etc. Quoted phrases match the unicode61-
        tokenized subwords as a NEAR-style consecutive run, which
        recovers indexability of these tokens. No prefix-* on quoted
        phrases (FTS5 doesn't allow it inside quotes; users typing
        these strings want exact substring anyway).

        Field-driven additions 2026-05-11: `@s.whatsapp.net` returned
        zero hits because `s.net` got tokenized weirdly with the prefix
        wildcard. Quoting fixes it. Same for dashed tokens — `-` is
        the FTS5 NOT operator and a bare token like `smoke-search-marker`
        was parsing as `smoke AND NOT search AND NOT marker`.
        """
        import re
        tokens = []
        for token in re.findall(r'"[^"]*"|\S+', q.strip()):
            # Power-user passthroughs: existing quotes, existing
            # wildcard, or any of (, ), : which the original logic
            # treated as raw-FTS5-syntax markers.
            if (token.startswith('"')
                    or token.endswith("*")
                    or any(c in token for c in '():')):
                tokens.append(token)
                continue
            # Wrap any token with non-word characters in quotes so
            # FTS5 operator chars (-, +, etc.) and unicode61 splitters
            # (@, ., /) don't corrupt the query. Escape embedded
            # quotes by doubling per FTS5 convention.
            if any(not (c.isalnum() or c == '_') for c in token):
                tokens.append('"' + token.replace('"', '""') + '"')
                continue
            tokens.append(token + "*")
        return " ".join(tokens) or q.strip()

    async def _handle_list_commands(self, request: "web.Request") -> "web.Response":
        """GET /v1/commands — slash-command catalog for the sidekick PWA.

        Serializes the central CommandDef registry from
        ``hermes_cli.commands`` plus any plugin-registered commands so
        the PWA composer can render an autocomplete popover. Filter
        rules mirror the gateway's other surfaces (telegram BotCommands,
        Slack subcommand mapping): drop ``cli_only`` entries unless
        their ``gateway_config_gate`` is truthy. Aliases ride on the
        canonical row (no separate entries) — the PWA matches both.

        Response shape:

            {
              "object": "list",
              "data": [
                {"name": "new", "description": "...", "category": "Session",
                 "aliases": ["reset"], "args_hint": "", "subcommands": []},
                ...
              ]
            }
        """
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")
        try:
            data = await asyncio.to_thread(_serialize_command_registry)
        except Exception as e:
            logger.exception("[sidekick] /v1/commands build failed")
            return web.json_response(
                {"error": {"type": "server_error", "message": str(e)}},
                status=500,
            )
        return web.json_response({"object": "list", "data": data})

    def _apply_setting(self, sid: str, value: Any) -> Dict[str, Any]:
        """Apply one setting and return the updated def. Synchronous —
        called from a thread executor since switch_model + config
        write are blocking. Raises _SettingsValidationError /
        _SettingsNotFoundError to map to 400 / 404 respectively."""
        if sid == "model":
            return self._apply_model_setting(value)
        if sid == "preferred_models":
            return self._apply_preferred_models_setting(value)
        raise _SettingsNotFoundError(f"unknown setting: {sid}")

    def _apply_preferred_models_setting(self, value: Any) -> Dict[str, Any]:
        """Persist the preferred-models glob list to
        ~/.hermes/config.yaml under `sidekick.preferred_models:`. The
        next /v1/settings/schema response uses the new list to filter
        the catalog. Already-cached agents are unaffected — this knob
        is purely a UI filter, not an agent-runtime setting."""
        if not isinstance(value, list):
            raise _SettingsValidationError("preferred_models value must be a list of strings")
        cleaned: List[str] = []
        seen: Set[str] = set()
        for entry in value:
            if not isinstance(entry, str):
                raise _SettingsValidationError(
                    f"preferred_models entries must be strings; got {type(entry).__name__}"
                )
            t = entry.strip()
            if not t or t in seen:
                continue
            # Conservative charset — globs are ASCII printables minus
            # whitespace + a few risky ones. Lets a forks-edit survive
            # round-trip through yaml without surprises.
            if any(ch in t for ch in (" ", "\t", "\n", "\r")):
                raise _SettingsValidationError(
                    f"preferred_models entry has whitespace: {t!r}"
                )
            seen.add(t)
            cleaned.append(t)
        try:
            import yaml
            from hermes_cli.config import get_config_path
            cfg_path = get_config_path()
            cfg: Dict[str, Any] = {}
            if cfg_path.exists():
                with open(cfg_path, encoding="utf-8") as f:
                    cfg = yaml.safe_load(f) or {}
            sk = cfg.get("sidekick")
            if not isinstance(sk, dict):
                sk = {}
                cfg["sidekick"] = sk
            sk["preferred_models"] = cleaned
            from hermes_cli.config import save_config
            save_config(cfg)
        except Exception as e:
            logger.exception("[sidekick] preferred_models persist failed")
            raise _SettingsValidationError(f"failed to write hermes config: {e}")
        # Return the freshly-rebuilt def (in case the schema build
        # normalized the list further — currently a no-op but keeps
        # the response shape consistent with model setting).
        new_schema = self._build_settings_schema()
        for s in new_schema:
            if s["id"] == "preferred_models":
                return s
        # Shouldn't reach here; fall through to a synthesized response.
        return {
            "id": "preferred_models",
            "label": "Preferred models",
            "category": "Agent",
            "type": "string-list",
            "value": cleaned,
        }

    def _apply_model_setting(self, value: Any) -> Dict[str, Any]:
        """Persist a new default model to hermes config.yaml, mirroring
        what `/model <name> --global` does in chat. Cached agents on
        existing sessions keep their model until evicted (typical
        case: next conversation start). New conversations pick up
        the new default immediately on next /v1/responses dispatch.

        The PWA may submit either `<vendor>/<model>` (OpenRouter, no
        prefix) or `<provider-slug>:<model>` (e.g. `openai-codex:gpt-5.5`,
        `copilot:gpt-5.4`). The colon prefix is the cue to route the
        switch via switch_model's `explicit_provider` arg so we don't
        have to detect-by-name. Provider names with colons in them
        would break this — none today."""
        if not isinstance(value, str) or not value.strip():
            raise _SettingsValidationError("model value must be a non-empty string")
        raw_value = value.strip()

        # Validate against the declared options[] (sidekick filter +
        # current). Same logic as _build_settings_schema; we re-derive
        # to avoid round-tripping through the schema endpoint.
        schema = self._build_settings_schema()
        model_def = next((s for s in schema if s["id"] == "model"), None)
        if model_def is None:
            raise _SettingsNotFoundError("model setting not declared")
        valid_values = {o["value"] for o in (model_def.get("options") or [])}
        if raw_value not in valid_values:
            raise _SettingsValidationError(
                f"value not in options[]: {raw_value!r}"
            )

        # Decode `<slug>:<model>` if present. Bare values (no colon)
        # are treated as openrouter-routed. Note OpenRouter IDs CAN
        # contain colons in the suffix (e.g. `google/gemma-4-26b:free`,
        # `:nitro`) — but those values always have a `/` BEFORE the
        # colon. Provider-slug prefixes never contain `/`. So: strip
        # the prefix only when the part before `:` has no slash.
        #
        # explicit_provider="openrouter" for bare values is load-bearing:
        # without it switch_model defaults to current_provider, which
        # rejects the model with "Model X not found in <current> listing"
        # whenever current is a non-OpenRouter provider (e.g. an
        # exhausted Codex credential blocking the user from switching
        # away to gemma).
        if ":" in raw_value and "/" not in raw_value.split(":", 1)[0]:
            slug, _, mid = raw_value.partition(":")
            explicit_provider = slug.strip()
            new_model = mid.strip()
        else:
            explicit_provider = "openrouter"
            new_model = raw_value

        # Read current state to feed switch_model.
        try:
            import yaml
            from hermes_cli.config import get_config_path
            cfg_path = get_config_path()
            cfg: Dict[str, Any] = {}
            if cfg_path.exists():
                with open(cfg_path, encoding="utf-8") as f:
                    cfg = yaml.safe_load(f) or {}
            raw_model = cfg.get("model")
            if isinstance(raw_model, dict):
                model_cfg = raw_model
            elif isinstance(raw_model, str):
                model_cfg = {"default": raw_model}
            else:
                model_cfg = {}
            current_model = (model_cfg.get("default") or "").strip()
            current_provider = (model_cfg.get("provider") or "openrouter").strip()
            current_base_url = (model_cfg.get("base_url") or "").strip()
            user_provs = cfg.get("providers")
            try:
                from hermes_cli.config import get_compatible_custom_providers
                custom_provs = get_compatible_custom_providers(cfg)
            except Exception:
                custom_provs = cfg.get("custom_providers")
        except Exception as e:
            raise _SettingsValidationError(
                f"failed to read hermes config: {e}"
            )

        # Delegate provider resolution via switch_model. Despite the
        # is_global flag's name, the function does NOT write config
        # itself — that's the caller's job (mirroring how cli.py and
        # gateway/run.py handle their own /model commands). We do it
        # below.
        try:
            from hermes_cli.model_switch import switch_model
            result = switch_model(
                raw_input=new_model,
                current_provider=current_provider,
                current_model=current_model,
                current_base_url=current_base_url,
                current_api_key="",
                is_global=True,
                explicit_provider=explicit_provider,
                user_providers=user_provs,
                custom_providers=custom_provs,
            )
        except Exception as e:
            logger.exception("[sidekick] switch_model raised")
            raise _SettingsValidationError(f"switch_model failed: {e}")
        if not result.success:
            raise _SettingsValidationError(
                result.error_message or "model switch rejected"
            )

        # Persist resolved model+provider+base_url to config.yaml so
        # the change survives restart (mirrors the persist block in
        # gateway/run.py:_handle_model_switch). switch_model itself
        # does NOT write — despite the is_global flag — so we have
        # to do it here, otherwise the setting reverts on the next
        # _build_settings_schema call (it reads config.yaml).
        try:
            from hermes_cli.config import save_config
            cfg.setdefault("model", {})
            if not isinstance(cfg["model"], dict):
                cfg["model"] = {"default": cfg["model"]}
            cfg["model"]["default"] = result.new_model
            if result.target_provider:
                cfg["model"]["provider"] = result.target_provider
            if result.base_url:
                cfg["model"]["base_url"] = result.base_url
            save_config(cfg)
        except Exception as e:
            logger.warning("[sidekick] failed to persist model to config.yaml: %s", e)

        # Re-derive the schema so the response reflects the actual
        # post-write state (catches cases where switch_model
        # normalized the model id to a canonical form).
        new_schema = self._build_settings_schema()
        return next((s for s in new_schema if s["id"] == "model"), schema[0])

    # Pretty names for the auth-error enrichment below. Provider slugs
    # come from hermes' credential pool; the user-facing reply uses
    # these instead so "openai-codex" doesn't appear verbatim.
    _PROVIDER_DISPLAY_NAMES = {
        "openai-codex": "ChatGPT (Codex)",
        "openrouter": "OpenRouter",
        "copilot": "GitHub Copilot",
        "anthropic": "Anthropic",
    }

    def _enrich_auth_error_text(self, original: str) -> Optional[str]:
        """If `original` is the misleading "Provider authentication
        failed: No <X> credentials stored" wrapper hermes core emits
        when its resolver skips an `exhausted` credential (post-429),
        return a richer replacement with reset time + UI hint.

        Returns None when no exhausted credential matches — caller
        keeps the original message unchanged.

        Intercept point lives in `_safe_send_envelope` so both
        blocking and streaming /v1/responses paths benefit from one
        substitution. Reads ~/.hermes/auth.json directly because
        hermes core has no read-only credential-status endpoint and
        we don't want to import its private auth_store internals.
        """
        if "Provider authentication failed" not in original:
            return None
        auth_path = Path(os.environ.get("HERMES_HOME") or "~/.hermes").expanduser() / "auth.json"
        try:
            with open(auth_path, encoding="utf-8") as f:
                store = json.load(f)
        except (OSError, json.JSONDecodeError):
            return None
        active = (store.get("active_provider") or "").strip()
        if not active:
            return None
        pool = store.get("credential_pool") or {}
        creds = pool.get(active) or []
        exhausted: Optional[Dict[str, Any]] = None
        for cred in creds:
            if isinstance(cred, dict) and cred.get("last_status") == "exhausted":
                exhausted = cred
                break
        if exhausted is None:
            return None
        display = self._PROVIDER_DISPLAY_NAMES.get(active, active)
        reset_at = exhausted.get("last_error_reset_at")
        when = ""
        if isinstance(reset_at, (int, float)) and reset_at > 0:
            now = time.time()
            remaining = max(0, int(reset_at - now))
            hours, mins = divmod(remaining // 60, 60)
            if hours >= 24:
                days, hours = divmod(hours, 24)
                relative = f"{days}d {hours}h"
            elif hours:
                relative = f"{hours}h {mins}m"
            else:
                relative = f"{mins}m"
            try:
                absolute = time.strftime("%a %-I:%M %p", time.localtime(reset_at))
            except Exception:
                absolute = time.strftime("%a %H:%M", time.localtime(reset_at))
            when = f" Resets in {relative} ({absolute})."
        return (
            f"⚠️ {display} usage limit reached.{when}"
            f" Switch to a different model in Settings → Agent → Model to continue."
        )

    async def _handle_responses(self, request: "web.Request") -> "web.StreamResponse":
        """POST /v1/responses — turn dispatch with optional streaming."""
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")
        try:
            body = await request.json()
        except (ValueError, json.JSONDecodeError):
            return web.json_response(
                {"error": {"type": "invalid_request_error",
                           "message": "body is not valid JSON"}},
                status=400,
            )

        conversation = body.get("conversation")
        input_field = body.get("input")
        stream = bool(body.get("stream", True))
        # Sidekick extension: optional `attachments` array — each entry
        # is `{type, mimeType, fileName, content}` where `content` is a
        # `data:<mime>;base64,<payload>` URL. NOT part of the OpenAI
        # Responses API today; tolerated as an additive field so a
        # raw OAI third-party speaking only the standard surface still
        # interoperates.
        raw_attachments = body.get("attachments")
        attachments = raw_attachments if isinstance(raw_attachments, list) else None
        # Sidekick extension: `voice: true` flags the input as dictated.
        # We prepend `[voice]` so the agent can recognise it (AGENTS.md
        # tells the agent to expect occasional STT errors in such turns
        # and to interpret them charitably). Lives in metadata
        # alongside user_message_id for OAI-blessed compatibility;
        # back-compat reads top-level `voice` from older PWA bundles.
        body_metadata = body.get("metadata") if isinstance(body.get("metadata"), dict) else {}
        voice_flag = body_metadata.get("voice") == "true" or body.get("voice") is True

        if not isinstance(conversation, str) or not conversation:
            return web.json_response(
                {"error": {"type": "invalid_request_error",
                           "message": "missing or invalid `conversation`"}},
                status=400,
            )
        if input_field is None:
            return web.json_response(
                {"error": {"type": "invalid_request_error",
                           "message": "missing `input`"}},
                status=400,
            )
        text = self._coerce_input(input_field)
        if text is None:
            return web.json_response(
                {"error": {"type": "invalid_request_error",
                           "message": "`input` must be a string or array of {role, content}"}},
                status=400,
            )
        if voice_flag and text and not text.lstrip().startswith("[voice]"):
            text = f"[voice] {text}"

        # Decode the gateway-prefixed conversation id. The drawer hands
        # back ids of the form `${source}:${chat_id}` (see
        # _format_gateway_id rationale). Sidekick's /v1/responses path
        # only dispatches for sidekick-source chats — the composer is
        # read-only for any other source upstream — so reject prefixes
        # that aren't ours rather than silently routing to a wrong-chat
        # adapter. Bare ids (no prefix) are accepted for backward compat
        # with un-prefixed callers.
        parsed_source, chat_id = _parse_gateway_id(conversation)
        if parsed_source is not None and parsed_source != SIDEKICK_SOURCE:
            return web.json_response(
                {"error": {"type": "invalid_request_error",
                           "message": (f"`conversation` source `{parsed_source}` "
                                       "is read-only via sidekick plugin")}},
                status=400,
            )
        response_id = f"resp_{secrets.token_hex(12)}"
        message_id = f"msg_{secrets.token_hex(10)}"
        created_at = int(time.time())

        # Sidekick extension: PWA may pre-mint the user-message id and
        # ship it as `metadata.user_message_id` (OAI Responses API
        # `metadata: Dict[str, str]` — a documented extension point
        # vanilla servers preserve unchanged; we read ours out). The
        # bubble it broadcasts in the `user_message` envelope below
        # uses this id as the dedup key for cross-device sync. When
        # absent (raw OAI third-parties, legacy clients pre-2026-05)
        # we mint one server-side; the originating device just won't
        # dedup against the broadcast.
        #
        # Back-compat: also accept the legacy top-level
        # `user_message_id` for one release cycle. Sidekick PWA
        # bundle v0.424+ uses metadata; older bundles still using
        # top-level get correct behavior until they're refreshed.
        # body_metadata captured above (voice handling).
        raw_user_msg_id = (
            body_metadata.get("user_message_id")
            or body.get("user_message_id")  # legacy top-level
        )
        if isinstance(raw_user_msg_id, str) and raw_user_msg_id:
            user_message_id = raw_user_msg_id
        else:
            user_message_id = f"umsg_{secrets.token_hex(10)}"

        # Cross-device user-message broadcast. Emit BEFORE dispatching
        # the turn so other connected PWA tabs render the user bubble
        # immediately (asymmetry fix: previously only the agent's reply
        # envelopes propagated to other devices, so the user's own
        # bubble was invisible until manual refresh). The originating
        # device dedups against this broadcast via `user_message_id`
        # (the optimistic bubble it already rendered shares the id).
        # Out-of-turn channel: this fires before _dispatch_message, so
        # there's no in-turn queue to bypass — _safe_send_envelope will
        # route it through _publish_out_of_turn which prefixes the
        # chat_id to `sidekick:<chat_id>` on the wire.
        await self._safe_send_envelope({
            "type": "user_message",
            "chat_id": chat_id,
            "message_id": user_message_id,
            "text": text,
        })

        # Register the turn queue. If a queue already exists for this
        # chat_id, replace it — the proxy is expected to serialize per-
        # chat (multiplexed via /api/sidekick/messages on the proxy
        # side), so this branch is purely defensive.
        queue: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue(maxsize=TURN_QUEUE_MAX)
        self._turn_queues[chat_id] = queue

        # Capture state.db's id high-water mark for this chat BEFORE
        # dispatching. After reply_final fires, any messages.id strictly
        # greater than this is a row hermes persisted during this turn —
        # used by _write_msg_links_after_turn to link the SSE-shape ids
        # the PWA knows (user_message_id, message_id) back to the
        # canonical state.db ids history-fetch will surface later.
        pre_high_water = await asyncio.to_thread(
            self._capture_msg_high_water_mark, chat_id,
        )

        if not stream:
            return await self._handle_responses_blocking(
                chat_id, text, queue, response_id, message_id, created_at,
                attachments=attachments,
                user_message_id=user_message_id, pre_high_water=pre_high_water,
            )
        return await self._handle_responses_streaming(
            request, chat_id, text, queue, response_id, message_id, created_at,
            attachments=attachments,
            user_message_id=user_message_id, pre_high_water=pre_high_water,
        )

    async def _handle_responses_blocking(
        self, chat_id: str, text: str,
        queue: "asyncio.Queue[Dict[str, Any]]",
        response_id: str, message_id: str, created_at: int,
        attachments: Optional[list] = None,
        user_message_id: str = "",
        pre_high_water: Optional[int] = None,
    ) -> "web.Response":
        """Non-streaming /v1/responses path. Dispatch, drain the queue
        until reply_final, return single JSON envelope."""
        reply_final_seen = False
        try:
            # _dispatch_message kicks off agent processing; replies
            # arrive on `queue` via _safe_send_envelope's fan-out.
            asyncio.create_task(self._dispatch_message(
                chat_id=chat_id, text=text, attachments=attachments,
            ))
            assembled = ""
            while True:
                env = await asyncio.wait_for(queue.get(), timeout=TURN_TIMEOUT_S)
                t = env.get("type")
                if t == "reply_delta":
                    # Hermes emits the accumulated text on each chunk.
                    # Track the latest; OAI-shape compaction below.
                    assembled = env.get("text", assembled) or assembled
                elif t == "reply_final":
                    reply_final_seen = True
                    break
            return web.json_response(self._build_response_envelope(
                response_id, message_id, created_at, assembled,
            ))
        except asyncio.TimeoutError:
            return web.json_response(
                {"error": {"type": "server_error", "message": "turn timed out"}},
                status=500,
            )
        finally:
            self._turn_queues.pop(chat_id, None)
            # Link the just-persisted state.db rows to the PWA's known
            # SSE-shape ids so a future history-fetch reload can dedup
            # against the IDB-cached bubbles. Only fires when a turn
            # actually completed; on timeout / error the rows hermes
            # may or may not have written aren't ours to claim.
            if reply_final_seen:
                await asyncio.to_thread(
                    self._write_msg_links_after_turn,
                    chat_id, pre_high_water, user_message_id, message_id,
                )

    async def _handle_responses_streaming(
        self, request: "web.Request",
        chat_id: str, text: str,
        queue: "asyncio.Queue[Dict[str, Any]]",
        response_id: str, message_id: str, created_at: int,
        attachments: Optional[list] = None,
        user_message_id: str = "",
        pre_high_water: Optional[int] = None,
    ) -> "web.StreamResponse":
        """Streaming /v1/responses. Emits OpenAI Responses-API SSE
        events as the agent produces output."""
        resp = web.StreamResponse(
            status=200,
            headers={
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                "x-accel-buffering": "no",
            },
        )
        await resp.prepare(request)

        async def write_sse(event: str, data: Dict[str, Any]) -> None:
            await resp.write(
                f"event: {event}\ndata: {json.dumps(data)}\n\n".encode("utf-8")
            )

        output_index = 0
        content_index = 0
        assembled = ""
        completed_emitted = False

        # Dispatch the message; replies flow back through `queue` via
        # _safe_send_envelope.
        asyncio.create_task(self._dispatch_message(
            chat_id=chat_id, text=text, attachments=attachments,
        ))

        try:
            while True:
                env = await asyncio.wait_for(queue.get(), timeout=TURN_TIMEOUT_S)
                t = env.get("type")
                if t == "reply_delta":
                    # Hermes streams accumulated text. First chunk
                    # (no edit flag) might be empty or full; subsequent
                    # chunks (edit=True) carry the running total.
                    full = env.get("text", "") or ""
                    if env.get("edit") and full.startswith(assembled):
                        delta_text = full[len(assembled):]
                    elif env.get("edit"):
                        # Non-additive edit (rare). Bump content_index
                        # so the client knows to start fresh.
                        delta_text = full
                        content_index += 1
                        assembled = ""
                    else:
                        # First (non-edit) delta — full content is the delta.
                        delta_text = full
                    if delta_text:
                        await write_sse("response.output_text.delta", {
                            "type": "response.output_text.delta",
                            "item_id": message_id,
                            "output_index": output_index,
                            "content_index": content_index,
                            "delta": delta_text,
                        })
                        assembled += delta_text
                elif t == "reply_final":
                    await write_sse("response.completed", {
                        "type": "response.completed",
                        "response": self._build_response_envelope(
                            response_id, message_id, created_at, assembled,
                        ),
                    })
                    completed_emitted = True
                    break
                elif t == "tool_call":
                    output_index += 1
                    args = env.get("args", {})
                    args_str = (
                        json.dumps(args) if isinstance(args, dict)
                        else str(env.get("_args_repr") or args)
                    )
                    await write_sse("response.output_item.added", {
                        "type": "response.output_item.added",
                        "output_index": output_index,
                        "item": {
                            "type": "function_call",
                            "id": env.get("call_id", ""),
                            "name": env.get("tool_name", ""),
                            "arguments": args_str,
                        },
                    })
                elif t == "tool_result":
                    result = env.get("result", "")
                    if isinstance(result, str):
                        result_out = result[:TOOL_RESULT_MAX_BYTES]
                    else:
                        try:
                            result_out = json.dumps(result)[:TOOL_RESULT_MAX_BYTES]
                        except Exception:
                            result_out = str(result)[:TOOL_RESULT_MAX_BYTES]
                    await write_sse("response.output_item.done", {
                        "type": "response.output_item.done",
                        "output_index": output_index,
                        "item": {
                            "type": "function_call_output",
                            "call_id": env.get("call_id", ""),
                            "output": result_out,
                        },
                    })
                    # Bump for any subsequent output. Reset assembled
                    # so a follow-up text item starts fresh.
                    output_index += 1
                    content_index = 0
                    assembled = ""
                elif t == "typing":
                    await write_sse("response.in_progress", {
                        "type": "response.in_progress",
                    })
                # Other envelope types are out-of-turn and shouldn't
                # arrive here. If they do (defensive), skip silently
                # rather than corrupt the response stream.
        except asyncio.TimeoutError:
            if not completed_emitted:
                with contextlib.suppress(Exception):
                    await write_sse("response.error", {
                        "type": "response.error",
                        "error": {"type": "server_error", "message": "turn timed out"},
                    })
        except (ConnectionResetError, asyncio.CancelledError):
            # Client disconnected mid-stream. Cleanup in finally.
            pass
        except Exception as exc:
            logger.warning("[sidekick] /v1/responses error for %s: %s", chat_id, exc)
            with contextlib.suppress(Exception):
                await write_sse("response.error", {
                    "type": "response.error",
                    "error": {"type": "server_error", "message": str(exc)},
                })
        finally:
            self._turn_queues.pop(chat_id, None)
            with contextlib.suppress(Exception):
                await resp.write_eof()
            # Mirror of the blocking handler's link-write — only fires
            # when reply_final actually completed (`completed_emitted`).
            # See _write_msg_links_after_turn for full rationale.
            if completed_emitted:
                await asyncio.to_thread(
                    self._write_msg_links_after_turn,
                    chat_id, pre_high_water, user_message_id, message_id,
                )
        return resp

    @staticmethod
    def _build_response_envelope(
        response_id: str, message_id: str,
        created_at: int, assembled: str,
    ) -> Dict[str, Any]:
        """Build the OpenAI Responses-API completed envelope."""
        return {
            "id": response_id,
            "object": "response",
            "status": "completed",
            "created_at": created_at,
            "model": "hermes",
            "output": [{
                "type": "message",
                "id": message_id,
                "role": "assistant",
                "content": [{"type": "output_text", "text": assembled}],
            }],
            "usage": {
                "input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 0,
            },
        }

    # ------------------------------------------------------------------
    # /v1/events — out-of-turn SSE channel
    # ------------------------------------------------------------------
    #
    # Persistent SSE for envelopes not tied to an active /v1/responses
    # turn: notifications (cron-driven), session_changed (compression-
    # rotation that didn't happen during a request), late tool events,
    # etc. The proxy keeps one of these open at all times and fans the
    # envelopes onto its persistent /api/sidekick/stream channel.

    async def _handle_events(self, request: "web.Request") -> "web.StreamResponse":
        """GET /v1/events — persistent SSE for out-of-turn envelopes."""
        if not self._check_http_auth(request):
            return web.Response(status=401, text="invalid token")

        last_event_id = request.headers.get("Last-Event-ID", "")
        cursor: Optional[int] = None
        if last_event_id:
            try:
                cursor = int(last_event_id)
            except ValueError:
                cursor = None

        queue: "asyncio.Queue[Tuple[int, Dict[str, Any]]]" = (
            asyncio.Queue(maxsize=TURN_QUEUE_MAX)
        )
        self._event_subscribers.add(queue)

        resp = web.StreamResponse(
            status=200,
            headers={
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                "x-accel-buffering": "no",
            },
        )
        await resp.prepare(request)

        async def write_evt(eid: int, event_name: str, data: Dict[str, Any]) -> None:
            await resp.write(
                f"id: {eid}\nevent: {event_name}\ndata: {json.dumps(data)}\n\n".encode("utf-8")
            )

        try:
            # Tight reconnect hint so a transient drop resumes sub-second.
            await resp.write(b"retry: 1000\n\n")
            # Replay anything from the ring strictly newer than cursor.
            for eid, env in list(self._event_replay_ring):
                if cursor is None or eid > cursor:
                    await write_evt(eid, env.get("type", "event"), env)
            # Live envelopes.
            while True:
                eid, env = await queue.get()
                await write_evt(eid, env.get("type", "event"), env)
        except (asyncio.CancelledError, ConnectionResetError):
            pass
        except Exception as exc:
            logger.warning("[sidekick] /v1/events error: %s", exc)
        finally:
            self._event_subscribers.discard(queue)
            with contextlib.suppress(Exception):
                await resp.write_eof()
        return resp

    # ------------------------------------------------------------------
    # Outbound
    # ------------------------------------------------------------------

    def _next_message_id(self) -> str:
        self._message_seq += 1
        return f"sk-{int(time.time())}-{self._message_seq}"

    async def _safe_send_envelope(self, env: Dict[str, Any]) -> bool:
        """Fan an outbound envelope to consumers.

        Routing:
          1. In-turn envelopes (reply_delta, reply_final, tool_call,
             tool_result, typing) for a chat with an active /v1/responses
             turn go to that turn's queue. Otherwise they fall through
             to the out-of-turn channel.
          2. All other envelope types (notification, session_changed,
             image, error) and orphaned in-turn envelopes go to the
             /v1/events out-of-turn channel + replay ring.

        Returns True if at least one consumer accepted the envelope.
        """
        env_type = env.get("type", "")
        chat_id = env.get("chat_id", "")
        in_turn_types = {"reply_delta", "reply_final", "tool_call",
                          "tool_result", "typing"}

        # Replace hermes' misleading "No <provider> credentials stored"
        # wrapper with a chat message that names the actual problem
        # (quota exhausted, reset time) and points the user at the UI
        # control. Single intercept point covers both /v1/responses
        # paths + the out-of-turn channel.
        if env_type == "reply_delta":
            text = env.get("text")
            if isinstance(text, str):
                replacement = self._enrich_auth_error_text(text)
                if replacement is not None:
                    env = {**env, "text": replacement}

        if env_type in in_turn_types and chat_id:
            queue = self._turn_queues.get(chat_id)
            if queue is not None:
                try:
                    queue.put_nowait(env)
                    return True
                except asyncio.QueueFull:
                    logger.warning(
                        "[sidekick] turn queue full for %s, dropping %s",
                        chat_id, env_type,
                    )

        return self._publish_out_of_turn(env)

    def _publish_out_of_turn(self, env: Dict[str, Any]) -> bool:
        """Push an envelope to /v1/events subscribers + the replay ring.

        Synchronous (asyncio.Queue.put_nowait is non-blocking). Drops
        envelopes for subscribers whose queue is full — protects the
        plugin from a hung consumer; the affected client gets gaps,
        which it can detect via Last-Event-ID skips on reconnect.

        Wire-side chat_id normalization: prefix bare chat_ids with
        ``sidekick:`` so the field matches the format the PWA pins via
        ``getViewed()`` (drawer rows + URLs use ``_format_gateway_id``,
        which always prefixes). Without this, post-tool-result `send()`
        envelopes (sk-* message ids) carry bare chat_ids and the PWA's
        handleReplyDelta gate drops them as off-screen — symptom: agent
        reply hangs behind the activity row until session-switch+back
        re-fetches via the prefixed `/v1/conversations/sidekick:.../items`
        path. Internal queue routing (in-turn path) keys on bare chat_id
        and is unaffected — only the wire field is rewritten.
        """
        chat_id = env.get("chat_id")
        if isinstance(chat_id, str) and chat_id and _GATEWAY_ID_SEP not in chat_id:
            env = {**env, "chat_id": _format_gateway_id(SIDEKICK_SOURCE, chat_id)}
        self._event_id_counter += 1
        eid = self._event_id_counter
        self._event_replay_ring.append((eid, env))
        if len(self._event_replay_ring) > EVENT_REPLAY_CAP:
            self._event_replay_ring.pop(0)

        delivered = False
        dead: List["asyncio.Queue"] = []
        for q in list(self._event_subscribers):
            try:
                q.put_nowait((eid, env))
                delivered = True
            except asyncio.QueueFull:
                logger.warning(
                    "[sidekick] /v1/events subscriber queue full, dropping %s",
                    env.get("type"),
                )
            except Exception:
                dead.append(q)
        for q in dead:
            self._event_subscribers.discard(q)
        return delivered

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """Emit a complete agent turn output as ``reply_delta`` + ``reply_final``.

        The gateway stream consumer calls ``send()`` for the first chunk of a
        response and then ``edit_message(message_id, ...)`` for subsequent
        streaming updates of the same logical bubble. We mirror that on the
        wire: the message_id we return here is what the proxy keys the
        UI bubble on.
        """
        message_id = self._next_message_id()
        # Surface a session_changed envelope the first time we ever see this
        # chat_id outbound. Today the gateway resolves session_id internally
        # so we don't have a stable session_id to surface; emit the chat_id
        # itself (the proxy already knows that) as a no-op stub. A future
        # on-compression callback would replace this with a real session_id.
        if chat_id not in self._known_chat_ids:
            self._known_chat_ids.add(chat_id)

        ok = await self._safe_send_envelope(
            {
                "type": "reply_delta",
                "chat_id": chat_id,
                "text": content,
                "message_id": message_id,
            }
        )
        await self._safe_send_envelope(
            {"type": "reply_final", "chat_id": chat_id, "message_id": message_id}
        )
        return SendResult(success=ok, message_id=message_id)

    # NOTE: We deliberately DO NOT override edit_message. The base class
    # default returns success=False with "Not supported", which the
    # gateway's tool-progress sender (gateway/run.py:9576) interprets as
    # "this adapter doesn't support edit-in-place" — and consequently
    # drains the entire progress queue silently without invoking the
    # adapter at all.
    #
    # That's the behaviour we want here. Tool-progress messages
    # (`⚙️ tool_name: "preview"` lines) reach sidekick TWICE on every
    # tool call: once via the gateway's progress_callback path (would
    # become reply_delta text bubbles if we accepted them) and once via
    # this plugin's own on_pre_tool_call hook (which emits proper
    # `tool_call` envelopes that the PWA routes to the activity-row,
    # collapsed-by-default per agentActivity=summary). Accepting both
    # produced the bug Jonathan hit 2026-05-01: N consecutive cumulative
    # agent bubbles with tool-call lines, the actual agent reply buried
    # beneath them, only re-rendering cleanly after a session-switch
    # (which re-fetches from state.db where the ephemeral progress
    # messages were never persisted).
    #
    # The agent's actual reply text still flows through `send()` as a
    # single full-text message (gateway/platforms/base.py:2150-2157
    # uses `_send_with_retry` which calls `adapter.send()` once with
    # the full text — no per-token edits), so dropping edit_message
    # costs us nothing for real replies.

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        """Best-effort typing indicator. Cosmetic; PWA may ignore."""
        await self._safe_send_envelope({"type": "typing", "chat_id": chat_id})

    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """Send an image envelope; PWA renders inline."""
        ok = await self._safe_send_envelope(
            {
                "type": "image",
                "chat_id": chat_id,
                "url": image_url,
                "caption": caption or "",
            }
        )
        return SendResult(success=ok)

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id, "type": "sidekick", "chat_id": chat_id}

    # ------------------------------------------------------------------
    # Tool-event emission (Phase 3)
    #
    # pre_tool_call / post_tool_call hooks fire from worker threads —
    # the agent dispatches every non-async tool via run_in_executor in
    # run_agent.py. We can't `await` from there, so we schedule envelope
    # sends onto the adapter's event loop with run_coroutine_threadsafe.
    # If the loop's gone (mid-shutdown) the schedule no-ops and the
    # event is dropped — non-critical observational data.
    #
    # The PWA gates rendering off the agentActivity setting, so the
    # adapter is intentionally promiscuous: it relays every sidekick
    # tool call/result faithfully and lets the client decide visibility.
    # ------------------------------------------------------------------

    @staticmethod
    def _serialize_args_for_envelope(
        args: Any,
    ) -> Tuple[Dict[str, Any], Optional[str]]:
        """Coerce a tool-call args dict into a JSON-serializable shape
        for the envelope. Returns (args_dict, args_repr_fallback).

        Order:
          1. If already a dict and round-trips through json: pass through.
          2. Else stringify with default=str and reparse.
          3. Else give up — return ({}, "<string repr>") so the PWA can
             show *something* instead of an empty args block.
        """
        if not isinstance(args, dict):
            try:
                return {}, json.dumps(args, default=str, ensure_ascii=False)
            except Exception:
                return {}, repr(args)
        try:
            json.dumps(args, ensure_ascii=False)
            return args, None
        except (TypeError, ValueError):
            pass
        try:
            stringified = json.dumps(args, default=str, ensure_ascii=False)
            reparsed = json.loads(stringified)
            if isinstance(reparsed, dict):
                return reparsed, None
            return {}, stringified
        except Exception:
            try:
                return {}, repr(args)
            except Exception:
                return {}, "<unrepresentable>"

    def _schedule_envelope(self, env: Dict[str, Any]) -> None:
        """Thread-safe envelope dispatch. Called from sync hook
        callbacks running on worker threads."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        coro = self._safe_send_envelope(env)
        try:
            asyncio.run_coroutine_threadsafe(coro, loop)
        except RuntimeError:
            # Loop in a non-running state mid-shutdown; drop silently.
            with contextlib.suppress(Exception):
                coro.close()

    def on_pre_tool_call(
        self,
        *,
        tool_name: str,
        args: Any,
        task_id: str = "",
        session_id: str = "",
        tool_call_id: str = "",
        **_kwargs: Any,
    ) -> None:
        """Hook callback. Sync, fires from worker thread. No-op for
        non-sidekick sessions."""
        if not session_id or not tool_call_id:
            return
        chat_id = self._resolve_chat_id_from_session_id(session_id)
        if not chat_id:
            return
        # Stamp the start time + chat_id so the post hook can compute
        # duration_ms without re-resolving anything.
        started = time.time()
        # Bound the in-flight map so a long-running session with weirdly
        # mismatched pre/post pairs can't grow it without limit. 256 is
        # well above any realistic concurrent-tool count.
        if len(self._inflight_tool_calls) > 256:
            self._inflight_tool_calls.clear()
        self._inflight_tool_calls[tool_call_id] = (started, chat_id)

        args_dict, args_repr = self._serialize_args_for_envelope(args)
        envelope: Dict[str, Any] = {
            "type": "tool_call",
            "chat_id": chat_id,
            "call_id": tool_call_id,
            "tool_name": tool_name,
            "args": args_dict,
            "started_at": _iso_from_epoch(started),
        }
        if args_repr is not None:
            envelope["_args_repr"] = args_repr
        self._schedule_envelope(envelope)

    def on_post_tool_call(
        self,
        *,
        tool_name: str,
        args: Any,
        result: Any,
        task_id: str = "",
        session_id: str = "",
        tool_call_id: str = "",
        **_kwargs: Any,
    ) -> None:
        """Hook callback. Sync, fires from worker thread. No-op when
        there's no matching pre_tool_call entry (filters non-sidekick)."""
        if not tool_call_id:
            return
        entry = self._inflight_tool_calls.pop(tool_call_id, None)
        if entry is None:
            # Either pre fired in a non-sidekick session (and we filtered
            # out), or the agent path skipped the pre hook (edge case).
            # Re-resolve to be safe; fall through silently if still not
            # ours.
            chat_id = self._resolve_chat_id_from_session_id(session_id)
            if not chat_id:
                return
            duration_ms = 0
        else:
            started, chat_id = entry
            duration_ms = max(0, int((time.time() - started) * 1000))

        # Cap result string size — see TOOL_RESULT_MAX_BYTES rationale.
        result_str: Optional[str]
        truncated = False
        if result is None:
            result_str = None
        elif isinstance(result, str):
            result_str = result
        else:
            try:
                result_str = json.dumps(result, default=str, ensure_ascii=False)
            except Exception:
                result_str = repr(result)
        if isinstance(result_str, str):
            encoded = result_str.encode("utf-8", errors="replace")
            if len(encoded) > TOOL_RESULT_MAX_BYTES:
                # Decode a clean prefix; ignore errors so we don't split
                # a UTF-8 sequence mid-byte.
                result_str = encoded[:TOOL_RESULT_MAX_BYTES].decode(
                    "utf-8", errors="ignore"
                )
                truncated = True

        envelope: Dict[str, Any] = {
            "type": "tool_result",
            "chat_id": chat_id,
            "call_id": tool_call_id,
            "result": result_str,
            "error": None,
            "duration_ms": duration_ms,
        }
        if truncated:
            envelope["_truncated"] = True
        self._schedule_envelope(envelope)

    # ------------------------------------------------------------------
    # session_changed polling
    #
    # Watch state.db for (session_id, title) transitions on the chat_ids
    # we know about and emit a `session_changed` envelope when either
    # changes. Picked over
    # (a) hermes-side hooks (would require a hermes patch — explicit
    # opt-in only) and (c) PWA polling (more client-side complexity,
    # doesn't free push notifications). Trade-off: ~1s lag between a
    # compression-driven session swap and the PWA seeing the new title.
    # ------------------------------------------------------------------

    @staticmethod
    def _resolve_state_db_path() -> Optional[Path]:
        """Find the gateway's state.db. Mirrors hermes' own resolution
        order so the adapter doesn't introduce a new env var.

        Resolution: HERMES_STATE_DB env → HERMES_HOME/state.db →
        ~/.hermes/state.db. Returns None if nothing exists; caller logs.
        """
        env_path = os.getenv("HERMES_STATE_DB", "").strip()
        if env_path:
            p = Path(env_path).expanduser()
            return p if p.exists() else None
        home_path = os.getenv("HERMES_HOME", "").strip()
        if home_path:
            p = Path(home_path).expanduser() / "state.db"
            if p.exists():
                return p
        default = Path("~/.hermes/state.db").expanduser()
        return default if default.exists() else None

    def _ensure_state_db_indexes(self) -> None:
        """Create read-side indexes the plugin's queries depend on.

        State.db is owned by hermes-agent core (sessions table schema is
        defined upstream). The plugin's drawer + history queries group
        and filter on ``(user_id, source)``; the upstream schema only
        has ``idx_sessions_source``, so the user_id grouping currently
        falls back to a full scan. ``CREATE INDEX IF NOT EXISTS`` is
        idempotent and safe to run on every adapter startup; if the
        upstream schema later adds the same composite index, this is a
        no-op.

        Best-effort: a failure here doesn't block adapter startup. The
        queries still produce correct results without the index, just
        slower.
        """
        if self._state_db_path is None or not self._state_db_path.exists():
            return
        try:
            with contextlib.closing(
                sqlite3.connect(self._state_db_path, timeout=5.0)
            ) as conn:
                with conn:
                    conn.execute(
                        "CREATE INDEX IF NOT EXISTS "
                        "idx_sessions_user_id_source "
                        "ON sessions(user_id, source)"
                    )
                    # Plugin-owned side table mapping hermes' canonical
                    # state.db integer message ids to the SSE-shape ids
                    # the plugin emits to the PWA. Closes the dedup
                    # gap between live SSE bubbles (keyed by umsg_*/
                    # msg_*) and history-fetch reconciliation (which
                    # only sees integer ids). Without it, every PWA
                    # reload duplicates the IDB-restored transcript on
                    # top of the server replay because no key matches.
                    # See agent/image_routing.py-style architectural
                    # note: hermes core's `messages` schema is upstream-
                    # owned and has no client_id column; carrying our
                    # own table keeps the change plugin-local.
                    conn.execute(
                        "CREATE TABLE IF NOT EXISTS sidekick_msg_links ("
                        "state_db_id INTEGER PRIMARY KEY, "
                        "sidekick_id TEXT NOT NULL UNIQUE)"
                    )
                    conn.execute(
                        "CREATE INDEX IF NOT EXISTS "
                        "idx_sidekick_msg_links_sidekick_id "
                        "ON sidekick_msg_links(sidekick_id)"
                    )
        except Exception as exc:
            logger.warning(
                "[sidekick] index ensure failed (non-fatal): %s", exc
            )

    def _capture_msg_high_water_mark(self, chat_id: str) -> Optional[int]:
        """Return the largest state.db `messages.id` for this sidekick
        chat, or None when the chat is brand new / state.db missing.
        Read just before dispatching a turn so we can identify which
        rows the turn newly persisted (ids strictly greater than the
        captured value)."""
        if self._state_db_path is None or not self._state_db_path.exists():
            return None
        uri = f"file:{self._state_db_path}?mode=ro"
        try:
            with contextlib.closing(
                sqlite3.connect(uri, uri=True, timeout=2.0)
            ) as conn:
                row = conn.execute(
                    "SELECT MAX(m.id) FROM messages m "
                    "JOIN sessions s ON m.session_id = s.id "
                    "WHERE s.user_id = ? AND s.source = ?",
                    (chat_id, SIDEKICK_SOURCE),
                ).fetchone()
            return int(row[0]) if row and row[0] is not None else None
        except Exception:
            return None

    def _write_msg_links_after_turn(
        self,
        chat_id: str,
        pre_high_water: Optional[int],
        user_message_id: str,
        assistant_message_id: str,
    ) -> None:
        """Link the two state.db rows hermes just persisted (one user,
        one assistant) to the SSE-shape ids the PWA already knows.

        Called once per completed turn, after the streaming handler
        sees `reply_final` (which the upstream emits AFTER persisting
        the assistant message; the user message persists earlier in
        the same dispatch). The first new row with role='user' gets
        linked to the PWA's user_message_id; the first new row with
        role='assistant' gets linked to the plugin-minted message_id.
        Tool / system rows are intentionally not linked — the PWA's
        history-fetch dedup keys off these two roles only.

        Idempotent via UNIQUE constraint on `sidekick_id` plus INSERT
        OR IGNORE — replaying a turn never produces duplicate rows.

        Best-effort: a write failure here doesn't break the turn (the
        envelope was already streamed to the client). It only means
        the next reload of THIS turn's bubbles falls through to the
        integer-id path, which is the same behavior we'd get for
        legacy pre-fix messages anyway."""
        if self._state_db_path is None or not self._state_db_path.exists():
            return
        if not user_message_id and not assistant_message_id:
            return
        after = pre_high_water if pre_high_water is not None else 0
        try:
            with contextlib.closing(
                sqlite3.connect(self._state_db_path, timeout=5.0)
            ) as conn:
                rows = conn.execute(
                    "SELECT m.id, m.role FROM messages m "
                    "JOIN sessions s ON m.session_id = s.id "
                    "WHERE s.user_id = ? AND s.source = ? AND m.id > ? "
                    "ORDER BY m.id ASC",
                    (chat_id, SIDEKICK_SOURCE, after),
                ).fetchall()
                mapping: List[Tuple[int, str]] = []
                seen_user = False
                seen_assistant = False
                for state_db_id, role in rows:
                    if role == "user" and not seen_user and user_message_id:
                        mapping.append((int(state_db_id), user_message_id))
                        seen_user = True
                    elif role == "assistant" and not seen_assistant and assistant_message_id:
                        mapping.append((int(state_db_id), assistant_message_id))
                        seen_assistant = True
                if not mapping:
                    return
                with conn:
                    conn.executemany(
                        "INSERT OR IGNORE INTO sidekick_msg_links "
                        "(state_db_id, sidekick_id) VALUES (?, ?)",
                        mapping,
                    )
        except Exception as exc:
            logger.warning(
                "[sidekick] msg-link write failed (non-fatal): %s", exc
            )

    async def _session_poll_loop(self) -> None:
        """Background task: poll state.db every ~1.5s and emit
        ``session_changed`` envelopes for any chat_id whose
        (session_id, title) tuple changes.

        Skips polling while no proxy client is connected — there's no
        listener to push to, and a queued event would race against the
        proxy's reconnect handshake.
        """
        # Small initial delay so the gateway has a chance to write the
        # first sessions row before our first SELECT (avoids one
        # spurious "no rows yet" log).
        await asyncio.sleep(SESSION_POLL_INTERVAL_S)
        while True:
            try:
                # Skip when nobody's listening — the moment a proxy
                # subscribes to /v1/events we resume from the cached
                # state, so a transition that happened during the
                # disconnect still fires once on reconnect.
                if not self._event_subscribers:
                    await asyncio.sleep(SESSION_POLL_INTERVAL_S)
                    continue
                await self._poll_sessions_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                # Never let a transient sqlite error kill the poller —
                # we want it to recover the next tick.
                logger.exception("[sidekick] session poll iteration failed")
            await asyncio.sleep(SESSION_POLL_INTERVAL_S)

    async def _poll_sessions_once(self) -> None:
        """One pass over the gateway's sessions table. Pushed off the
        event loop via a thread executor so the (tiny) sqlite read
        doesn't stall the WS pump."""
        rows = await asyncio.to_thread(self._read_session_rows)
        for chat_id, session_id, title in rows:
            prev = self._session_state_cache.get(chat_id)
            current = (session_id or "", title or "")
            if prev is None:
                # First sighting of this chat_id since adapter startup.
                # Seed the cache; we'd rather miss the very first
                # session_id on this run than emit on a hot reload.
                self._session_state_cache[chat_id] = current
                continue
            if prev == current:
                continue
            self._session_state_cache[chat_id] = current
            logger.info(
                "[sidekick] session_changed chat_id=%s session_id=%s title=%r",
                chat_id,
                current[0],
                current[1],
            )
            await self._safe_send_envelope({
                "type": "session_changed",
                "chat_id": chat_id,
                "session_id": current[0],
                "title": current[1],
            })

    def _resolve_chat_id_from_session_id(self, session_id: str) -> Optional[str]:
        """Map a hermes session_id back to its sidekick chat_id, if any.

        chat_id IS ``sessions.user_id`` for sidekick sessions, so we
        look it up directly in state.db (one row, primary-key seek).
        Non-sidekick sessions naturally fail to resolve (source filter)
        and the caller treats that as "not for us" — that's the filter
        for tool calls coming from telegram / whatsapp / etc. running
        on the same gateway. Safe to call from worker threads.

        Cached because tool-event hooks fire on a hot path; the cache
        is keyed by session_id so a rotated chat picks up the new sid
        on its first tool fire post-rotation.
        """
        if not session_id:
            return None
        cached = self._sid_to_chat_id_cache.get(session_id)
        if cached is not None:
            return cached
        if self._state_db_path is None or not self._state_db_path.exists():
            return None
        try:
            uri = f"file:{self._state_db_path}?mode=ro"
            with contextlib.closing(
                sqlite3.connect(uri, uri=True, timeout=2.0)
            ) as conn:
                row = conn.execute(
                    "SELECT user_id FROM sessions WHERE id = ? AND source = ?",
                    (session_id, SIDEKICK_SOURCE),
                ).fetchone()
        except Exception:
            return None
        if row is None or not row[0]:
            return None
        chat_id = row[0]
        self._sid_to_chat_id_cache[session_id] = chat_id
        return chat_id

    def _read_session_rows(self) -> list:
        """Synchronous sqlite read — runs in a worker thread. Returns
        ``[(chat_id, session_id, title), …]`` for every sidekick
        chat's currently-latest session. Callers swallow exceptions.

        Powers the session_changed poller: a transition in either
        ``session_id`` or ``title`` for a known chat_id triggers a
        ``session_changed`` envelope to the proxy.

        Picks the LATEST session per ``user_id`` (chat_id) where
        ``source = 'sidekick'`` — i.e., whatever rotation
        compression/auto-reset has done, the row reflects what hermes
        is actively writing into right now. Also opportunistically
        refreshes the session_id → chat_id cache so the tool-event
        hook resolver gets warm data without an extra read.
        """
        if self._state_db_path is None or not self._state_db_path.exists():
            return []
        # For each sidekick user_id, pick the row with the largest
        # started_at. The window-function approach keeps this to a
        # single round-trip; the index on (user_id, source) added at
        # startup speeds the partition scan.
        sql = """
            SELECT user_id, id, COALESCE(title, '') FROM (
                SELECT
                    s.user_id,
                    s.id,
                    s.title,
                    ROW_NUMBER() OVER (
                        PARTITION BY s.user_id
                        ORDER BY s.started_at DESC
                    ) AS rn
                FROM sessions s
                WHERE s.source = ? AND s.user_id IS NOT NULL
            )
            WHERE rn = 1
        """
        uri = f"file:{self._state_db_path}?mode=ro"
        try:
            with contextlib.closing(
                sqlite3.connect(uri, uri=True, timeout=2.0)
            ) as conn:
                rows = conn.execute(sql, (SIDEKICK_SOURCE,)).fetchall()
        except sqlite3.OperationalError:
            # Older SQLite without window functions — fall back to a
            # correlated subquery. Pi 5 ships SQLite 3.40+ so this is
            # belt-and-braces only.
            sql_fallback = """
                SELECT s.user_id, s.id, COALESCE(s.title, '')
                FROM sessions s
                WHERE s.source = ?
                  AND s.user_id IS NOT NULL
                  AND s.started_at = (
                      SELECT MAX(s2.started_at) FROM sessions s2
                      WHERE s2.user_id = s.user_id AND s2.source = ?
                  )
            """
            with contextlib.closing(
                sqlite3.connect(uri, uri=True, timeout=2.0)
            ) as conn:
                rows = conn.execute(
                    sql_fallback, (SIDEKICK_SOURCE, SIDEKICK_SOURCE),
                ).fetchall()
        out = [(chat_id, sid, title) for chat_id, sid, title in rows]
        # Refresh the sid → chat_id cache opportunistically.
        self._sid_to_chat_id_cache = {sid: cid for cid, sid, _t in out}
        return out


# ---------------------------------------------------------------------------
# Hermes plugin entry point
#
# The plugin manifest (plugin.yaml) ships next to this file; hermes' plugin
# loader will import this module and call ``register(ctx)``. We don't have
# anything to register at the PluginContext level — the platform adapter is
# wired in via the ``_create_adapter`` factory branch added by the patch.
# This stub exists so the plugin shows up in ``hermes plugins list``.
# ---------------------------------------------------------------------------


def _sidekick_env_enablement() -> Optional[Dict[str, Any]]:
    """Read SIDEKICK_PLATFORM_TOKEN at startup.

    Returning a non-None dict signals to the platform registry that the
    plugin is enabled for this run. Mirrors the env-var gate the
    pre-migration patch installed in ``_apply_env_overrides``: token
    present → enabled, missing → adapter never instantiates.
    """
    token = os.getenv("SIDEKICK_PLATFORM_TOKEN")
    if not token:
        return None
    return {"enabled": True, "token": token}


def register(ctx) -> None:  # noqa: ANN001 — PluginContext type is internal
    """Hermes plugin entry point.

    Two responsibilities:

    1. Platform registration (added 2026-05). Replaces the
       0001-add-sidekick-platform.patch we used to carry against
       gateway/config.py + gateway/run.py + hermes_cli/platforms.py.
       Upstream's gateway/platform_registry.py now offers a clean
       hook for this.
    2. Tool-event hooks (pre_tool_call / post_tool_call). These dispatch
       to the live SidekickAdapter via a module-level reference set in
       connect(); when no adapter is live the callbacks are silent
       no-ops.
    """
    try:
        ctx.register_platform(
            name="sidekick",
            label="Sidekick",
            adapter_factory=lambda cfg: SidekickAdapter(cfg),
            check_fn=check_sidekick_requirements,
            required_env=["SIDEKICK_PLATFORM_TOKEN"],
            install_hint="aiohttp ships with hermes-agent — no extra packages needed",
            env_enablement_fn=_sidekick_env_enablement,
            allowed_users_env="SIDEKICK_PLATFORM_ALLOWED_USERS",
            allow_all_env="SIDEKICK_PLATFORM_ALLOW_ALL_USERS",
            emoji="🎙️",
            pii_safe=False,
            allow_update_command=True,
            platform_hint=(
                "You are chatting via the Sidekick PWA — a same-browser "
                "interface with full markdown + image rendering. Replies "
                "are streamed token-by-token. The user can also speak to "
                "you via the audio bridge (Deepgram STT → text → reply → "
                "TTS), so when audio is in flight, prefer concise replies."
            ),
        )
    except AttributeError:
        # Older hermes-agent without ctx.register_platform — fall back to
        # the patch-driven path (Platform.SIDEKICK + _create_adapter
        # branch). If both are missing, the adapter just won't load and
        # the gateway logs will say so. We don't crash the plugin.
        logger.warning(
            "[sidekick] ctx.register_platform unavailable on this hermes "
            "version; falling back to patch-driven registration"
        )
    except Exception:
        logger.exception("[sidekick] register_platform failed")

    def _pre(**kwargs: Any) -> None:
        adapter = _active_adapter
        if adapter is None:
            return
        try:
            adapter.on_pre_tool_call(**kwargs)
        except Exception:
            logger.exception("[sidekick] pre_tool_call hook crashed")

    def _post(**kwargs: Any) -> None:
        adapter = _active_adapter
        if adapter is None:
            return
        try:
            adapter.on_post_tool_call(**kwargs)
        except Exception:
            logger.exception("[sidekick] post_tool_call hook crashed")

    try:
        ctx.register_hook("pre_tool_call", _pre)
        ctx.register_hook("post_tool_call", _post)
    except Exception:
        logger.exception(
            "[sidekick] failed to register pre/post_tool_call hooks; "
            "tool-event envelopes will not be emitted"
        )
        return
    logger.debug("[sidekick] registered pre_tool_call / post_tool_call hooks")
