"""Plugin-owned web push dispatch.

Mirrors the openclaw plugin's ``src/push-dispatch.js`` + the
sidekick proxy's ``proxy/sidekick/notifications/dispatch.ts``.
Engagement filter + per-kind toggle + mute filter + cron-aware body
shaping + pywebpush send + prune 404/410.

Called from ``SidekickAdapter._safe_send_envelope`` for any envelope
the plugin emits. Decoupled from the proxy's notification module —
when ``SIDEKICK_PUSH_OWNED_BY_PLUGIN=true``, the proxy delegates to
this and skips its own dispatch path.

Observability: every gate decision logs at WARNING so the journal
answers "why didn't push fire for envelope X?" without re-reading
the code. (Default Python root logger level is WARNING; INFO is
silenced in stock hermes-gateway. Field bug 2026-05-18.)
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Dict, Optional

from pywebpush import webpush, WebPushException  # type: ignore

from .sidekick_state import (
    ensure_vapid_keys,
    list_subscriptions,
    is_muted,
    get_pref,
    mark_subscription_used,
    remove_subscription,
)

logger = logging.getLogger("hermes.sidekick.push")

# Visibility heartbeat valid for 2 seconds — matches the openclaw
# plugin + the proxy's original implementation.
ENGAGEMENT_WINDOW_MS = 2_000

# How much of the body to ship in the push payload. Watch banners
# truncate hard; Apple's notification service tends to clip ~200
# chars on Series 6/Watch app banners. Keep the budget conservative.
PUSH_BODY_MAX_CHARS = 200


# ── Per-type icons ─────────────────────────────────────────────────────
#
# Title prefix that helps the user discriminate notifications on the
# watch glance. Sourced from envelope `type` first (most specific),
# then `kind` (for `notification` envelopes — cron / reminder /
# approval / etc.), then a generic fallback.
#
# Keep this map small + concrete: any random emoji renders fine on
# Apple Watch banners and the Android system tray; an exhaustive
# taxonomy would just spread cognitive load.
_TYPE_ICONS: Dict[str, str] = {
    # Top-level envelope types the plugin actually pushes.
    "reply_final": "💬",     # agent text reply (most common)
    "notification": "🔔",    # default for unknown kind below; overridden by _KIND_ICONS
}
_KIND_ICONS: Dict[str, str] = {
    "cron": "⏰",        # scheduled task output
    "reminder": "📌",    # one-shot reminder fire
    "approval": "🛑",    # human-in-the-loop request
    "alert": "⚠️",       # plugin-side alert (e.g. doctor)
    "achievement": "🎉", # background goal completion
    "background": "🌀",  # /background result landing
    "tool": "🔧",        # tool-event-as-push (rare; for ops tools that opt in)
}


def _icon_for(env: Dict) -> str:
    """Pick the title-prefix emoji. Kind takes precedence over type
    because `notification` envelopes carry the kind discriminator
    while `reply_final` always means agent text."""
    kind = env.get("kind") if isinstance(env.get("kind"), str) else ""
    if kind and kind in _KIND_ICONS:
        return _KIND_ICONS[kind]
    env_type = env.get("type") if isinstance(env.get("type"), str) else ""
    if env_type in _TYPE_ICONS:
        return _TYPE_ICONS[env_type]
    return "💬"  # generic chat icon as a last resort


class EngagementState:
    """Per-chat last-visibility-heartbeat tracker.

    Note: callers must use the SAME chat_id shape on both sides.
    The plugin's envelope path uses the source-stripped id (UUID
    only); ``handle_visibility`` normalizes the PWA-supplied
    ``sidekick:<uuid>`` form via ``_strip_source_prefix`` before
    recording. See sidekick_routes.py.
    """

    def __init__(self) -> None:
        self._last_seen: Dict[str, int] = {}

    def mark_visible(self, chat_id: str) -> None:
        self._last_seen[chat_id] = int(time.time() * 1000)

    def is_engaged(self, chat_id: str, *, now_ms: Optional[int] = None) -> bool:
        ts = self._last_seen.get(chat_id)
        if ts is None:
            return False
        if now_ms is None:
            now_ms = int(time.time() * 1000)
        return now_ms - ts < ENGAGEMENT_WINDOW_MS


class ReplyBuffer:
    """Per-chat accumulator for the most recent ``reply_delta`` text.

    ``reply_final`` envelopes carry no text — the agent's reply
    streams as cumulative-text on ``reply_delta``, terminated by an
    empty ``reply_final``. To produce a push body, we cache the last
    delta text per chat and drain it on the matching final.

    Self-healing: if a new turn starts before the prior final
    arrives, its first delta overwrites the stale buffer. Drain
    on final ALWAYS clears, even when the gate suppresses dispatch,
    so the buffer can't accumulate stale state.
    """

    def __init__(self) -> None:
        self._latest: Dict[str, str] = {}

    def set_latest(self, chat_id: str, text: str) -> None:
        if not chat_id or not isinstance(text, str):
            return
        self._latest[chat_id] = text

    def take_and_clear(self, chat_id: str) -> str:
        if not chat_id:
            return ""
        text = self._latest.pop(chat_id, "")
        return text


# ── Cron content shaping ───────────────────────────────────────────────
#
# Hermes' cron scheduler wraps the agent's reply in a fixed
# boilerplate shell:
#
#     Cronjob Response: {task_name}
#     (job_id: {job_id})
#     -------------
#
#     {agent body}
#
#     To stop or manage this job, send me a new message (e.g. ...).
#
# Naive forwarding to a watch banner eats the entire visible band
# on boilerplate + metadata before reaching the agent's actual reply.
# Strip the wrapper so the body LEADS with content the user wants to
# read, and demote metadata to a trailing suffix that only fits when
# there's headroom.
#
# Mirror of proxy/sidekick/notifications/dispatch.ts parseCronContent
# + stripLeadingMetadata. Verbatim regex for cross-language parity.
_CRON_HEADER_RE = re.compile(
    r"^Cronjob Response:\s*(.+?)\s*\n"
    r"\(job_id:\s*([^)]+)\)\s*\n"
    r"-+\s*\n+"
    r"([\s\S]*?)"
    r"(?:\n+To stop or manage this job[^\n]*\.?\s*)?$"
)
_META_LINE_RE = re.compile(
    r"^\s*(?:session_id|job_id|chat_id|message_id|user_id|run_id|trace_id)\s*:\s*\S",
    re.IGNORECASE,
)
_SEP_OR_BLANK_RE = re.compile(r"^\s*(?:-{3,}|=+|\*+)?\s*$")


def _parse_cron_content(raw: str) -> Dict[str, str]:
    """Split a canonical cron-wrapped reply into {task_name, job_id, body}.

    Falls back to {taskName='', jobId='', body=raw} when the input
    doesn't match the canonical shape — future hermes versions could
    change the template and we degrade gracefully."""
    m = _CRON_HEADER_RE.match(raw or "")
    if not m:
        return {"task_name": "", "job_id": "", "body": raw or ""}
    return {
        "task_name": m.group(1).strip(),
        "job_id": m.group(2).strip(),
        "body": m.group(3).strip(),
    }


def _strip_leading_metadata(s: str) -> str:
    """Strip session_id: / job_id: / chat_id: style metadata lines
    AND leading dashes/blanks from the start of a notification body.
    Stops at the first non-metadata line."""
    lines = (s or "").split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        if _META_LINE_RE.match(line) or _SEP_OR_BLANK_RE.match(line):
            i += 1
            continue
        break
    return "\n".join(lines[i:])


def _build_payload(env: Dict, *, body_override: Optional[str] = None) -> Dict:
    """Translate an envelope into the push payload shape sw.js
    expects: ``{title, body, chat_id?, tag?, url?}``.

    Title carries a discriminator emoji (per envelope type/kind) so
    a user can tell apart agent-reply vs cron-output vs reminder at
    a glance on the watch.

    Body LEADS with content (the agent's actual reply / the cron
    output's agent-body / the notification text), with metadata
    (job_id) demoted to a trailing suffix only if the headroom allows.
    For cron output the wrapper is parsed so we don't waste the
    banner on boilerplate.
    """
    chat_id = env.get("chat_id", "") if isinstance(env.get("chat_id"), str) else ""
    speaker = env.get("speaker") if isinstance(env.get("speaker"), str) else "Sidekick"
    icon = _icon_for(env)
    kind = env.get("kind") if isinstance(env.get("kind"), str) else ""

    raw_body = body_override or env.get("content") or env.get("text") or ""
    if not isinstance(raw_body, str):
        raw_body = str(raw_body)

    # Cron-shape detection: structured wrapper → split into
    # (task_name, job_id, body). Title can lead with the task name;
    # body leads with the agent's actual content.
    cron_parsed: Optional[Dict[str, str]] = None
    if kind == "cron" or _CRON_HEADER_RE.match(raw_body):
        cron_parsed = _parse_cron_content(raw_body)

    if cron_parsed and cron_parsed["body"]:
        body = cron_parsed["body"]
        # Title carries the task name (more useful than "Sidekick" on
        # a watch when there are many cron jobs).
        title_label = cron_parsed["task_name"] or speaker
    else:
        # Generic notification: strip leading metadata lines if present.
        body = _strip_leading_metadata(raw_body)
        title_label = speaker

    # Demote remaining job_id/run_id metadata to a trailing suffix.
    # Only attach it if there's slack in the budget — body content
    # wins under truncation.
    suffix = ""
    if cron_parsed and cron_parsed["job_id"]:
        suffix = f"\n— job:{cron_parsed['job_id'][:24]}"

    available = PUSH_BODY_MAX_CHARS - len(suffix)
    if len(body) > available:
        body = body[: max(0, available - 1)].rstrip() + "…"
    body = body + suffix

    return {
        "title": f"{icon} {title_label}".strip(),
        "body": body[:PUSH_BODY_MAX_CHARS],
        "chat_id": chat_id,
        "tag": chat_id or "sidekick",
        "url": f"/?chat_id={chat_id}" if chat_id else "/",
    }


# ── Per-kind toggles ───────────────────────────────────────────────────
#
# Mirrors the proxy's `prefs.ts` / `PushKinds`. Each top-level
# envelope type or notification.kind maps to a pref key the user
# toggles in Settings → Notifications. False = silenced, True or
# unset = enabled.

_PREF_PUSH_KIND_PREFIX = "push_kind_"


def _is_kind_enabled(db, env: Dict) -> bool:
    """Pull the relevant pref key for this envelope. Defaults to
    enabled when the pref is unset so a fresh install still pushes."""
    # Top-level type → kind key. reply_final → 'agent_reply';
    # notification with kind=X → X; bare notification → 'notification'.
    env_type = env.get("type") if isinstance(env.get("type"), str) else ""
    kind_name: Optional[str] = None
    if env_type == "reply_final":
        kind_name = "agent_reply"
    elif env_type == "notification":
        env_kind = env.get("kind") if isinstance(env.get("kind"), str) else ""
        kind_name = env_kind or "notification"
    if not kind_name:
        return True  # unknown type — let it through; another gate will catch it
    pref_key = f"{_PREF_PUSH_KIND_PREFIX}{kind_name}"
    val = get_pref(db, pref_key)
    if val is None:
        return True
    if isinstance(val, bool):
        return val
    # Pref store may serialize as "true"/"false" strings.
    if isinstance(val, str):
        return val.lower() not in ("false", "0", "off", "no")
    return True


def _is_push_eligible(env: Dict) -> bool:
    """Mirrors the proxy's isPushEligible: explicit `should_push`
    flag wins; falls back to type allowlist."""
    should = env.get("should_push")
    if isinstance(should, bool):
        return should
    return env.get("type") in ("reply_final", "notification")


class PushDispatcher:
    def __init__(
        self,
        db,
        *,
        vapid_subject: str,
        engagement: Optional[EngagementState] = None,
        reply_buffer: Optional[ReplyBuffer] = None,
    ) -> None:
        self.db = db
        self.engagement = engagement or EngagementState()
        self.reply_buffer = reply_buffer or ReplyBuffer()
        self._vapid_subject = vapid_subject
        self._vapid = None  # lazy

    def _ensure_vapid(self) -> Dict[str, str]:
        if self._vapid is None:
            self._vapid = ensure_vapid_keys(self.db, self._vapid_subject)
        return self._vapid

    def observe_envelope(self, env: Dict) -> Optional[str]:
        """Side-channel: record reply_delta text for later use as the
        body on reply_final. Returns the drained body for reply_final
        envelopes (caller passes to dispatch_envelope as body_override).
        No-op for unrelated types.

        Always drain on reply_final, even when the gate suppresses
        dispatch — the buffer would otherwise leak.
        """
        env_type = env.get("type") if isinstance(env.get("type"), str) else ""
        chat_id = env.get("chat_id") if isinstance(env.get("chat_id"), str) else ""
        if not chat_id:
            return None
        if env_type == "reply_delta":
            text = env.get("text")
            if isinstance(text, str) and text:
                self.reply_buffer.set_latest(chat_id, text)
            return None
        if env_type == "reply_final":
            # Drain whether or not we actually push. The accumulated text
            # is the agent's full reply (each delta carries cumulative
            # text — see proxyClient handleEnvelope).
            return self.reply_buffer.take_and_clear(chat_id)
        return None

    def dispatch_envelope(self, env: Dict, *, body_override: Optional[str] = None) -> Dict:
        """Fire push for a single envelope. Synchronous (called inside
        the aiohttp worker, but pywebpush itself is sync-blocking;
        per-subscription HTTP is the dominant cost). Returns
        ``{delivered, pruned, skipped?}``.
        """
        env_type = env.get("type", "?")
        chat_id_for_log = env.get("chat_id", "?") if isinstance(env.get("chat_id"), str) else "?"
        if not _is_push_eligible(env):
            logger.warning("skip type=%s chat=%s reason=not_eligible", env_type, chat_id_for_log)
            return {"delivered": 0, "pruned": 0, "skipped": "not_eligible"}
        chat_id = env.get("chat_id")
        if not isinstance(chat_id, str) or not chat_id:
            logger.warning("skip type=%s chat=%s reason=missing_chat_id", env_type, chat_id_for_log)
            return {"delivered": 0, "pruned": 0, "skipped": "missing_chat_id"}
        # Per-kind enablement: user toggled this category off in
        # Settings → Notifications. Cheap check; runs before engagement
        # so a silenced kind doesn't even consume an engagement slot.
        if not _is_kind_enabled(self.db, env):
            logger.warning("skip type=%s chat=%s reason=kind_disabled", env_type, chat_id)
            return {"delivered": 0, "pruned": 0, "skipped": "kind_disabled"}
        if self.engagement.is_engaged(chat_id):
            logger.warning("skip type=%s chat=%s reason=user_engaged", env_type, chat_id)
            return {"delivered": 0, "pruned": 0, "skipped": "user_engaged"}
        if is_muted(self.db, chat_id):
            logger.warning("skip type=%s chat=%s reason=muted", env_type, chat_id)
            return {"delivered": 0, "pruned": 0, "skipped": "muted"}
        vapid = self._ensure_vapid()
        subs = list_subscriptions(self.db)
        if not subs:
            logger.warning("skip type=%s chat=%s reason=no_subscribers", env_type, chat_id)
            return {"delivered": 0, "pruned": 0, "skipped": "no_subscribers"}
        payload = json.dumps(_build_payload(env, body_override=body_override))
        delivered = 0
        pruned = 0
        for sub in subs:
            wp_sub = {
                "endpoint": sub["endpoint"],
                "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
            }
            try:
                webpush(
                    subscription_info=wp_sub,
                    data=payload,
                    vapid_private_key=vapid["private_key"],
                    vapid_claims={"sub": vapid["subject"]},
                    ttl=3600,
                )
                mark_subscription_used(self.db, sub["endpoint"])
                delivered += 1
            except WebPushException as err:
                code = getattr(err.response, "status_code", 0)
                if code in (404, 410):
                    remove_subscription(self.db, sub["endpoint"])
                    pruned += 1
                else:
                    logger.warning("push send failed (%s): %s", code, err)
            except Exception as err:  # network / unexpected
                logger.warning("push send error: %s", err)
        logger.warning(
            "dispatch type=%s chat=%s delivered=%d pruned=%d (of %d subs)",
            env_type, chat_id, delivered, pruned, len(subs),
        )
        return {"delivered": delivered, "pruned": pruned}
