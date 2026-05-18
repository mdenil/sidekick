"""Plugin-owned web push dispatch.

Mirrors the openclaw plugin's ``src/push-dispatch.js``. Engagement
filter + mute filter + pywebpush send + prune 404/410.

Called from ``SidekickAdapter._safe_send_envelope`` for any envelope
the plugin emits. Decoupled from the proxy's notification module —
when ``SIDEKICK_PUSH_OWNED_BY_PLUGIN=true``, the proxy delegates to
this and skips its own dispatch path.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Dict, Optional

from pywebpush import webpush, WebPushException  # type: ignore

from .sidekick_state import (
    ensure_vapid_keys,
    list_subscriptions,
    is_muted,
    mark_subscription_used,
    remove_subscription,
)

logger = logging.getLogger("hermes.sidekick.push")

# Visibility heartbeat valid for 2 seconds — matches the openclaw
# plugin + the original proxy implementation Jonathan flagged was
# correct (responsiveness-biased; flicker handled structurally).
ENGAGEMENT_WINDOW_MS = 2_000


class EngagementState:
    """Per-chat last-visibility-heartbeat tracker."""

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


def _is_push_eligible(env: Dict) -> bool:
    """Mirrors the proxy's isPushEligible: explicit `should_push`
    flag wins; falls back to type allowlist."""
    should = env.get("should_push")
    if isinstance(should, bool):
        return should
    return env.get("type") in ("reply_final", "notification")


def _build_payload(env: Dict, *, body_override: Optional[str] = None) -> Dict:
    """Translate an envelope into the push payload shape sw.js
    expects: ``{title, body, chat_id?, tag?, url?}``.

    Simplified vs. the proxy's ``envelopeToPayload`` (no cron parser
    yet; can lift it from ``proxy/sidekick/notifications/dispatch.ts``
    when we wire the hermes-side cron path through the plugin)."""
    chat_id = env.get("chat_id", "") if isinstance(env.get("chat_id"), str) else ""
    speaker = env.get("speaker") if isinstance(env.get("speaker"), str) else "Sidekick"
    title_emoji = "⏰" if env.get("kind") == "cron" else "💬"
    body = body_override or env.get("content") or env.get("text") or ""
    if isinstance(body, str):
        body = body[:200]
    else:
        body = str(body)[:200]
    return {
        "title": f"{title_emoji} {speaker}",
        "body": body,
        "chat_id": chat_id,
        "tag": chat_id or "sidekick",
        "url": f"/?chat_id={chat_id}" if chat_id else "/",
    }


class PushDispatcher:
    def __init__(self, db, *, vapid_subject: str, engagement: Optional[EngagementState] = None) -> None:
        self.db = db
        self.engagement = engagement or EngagementState()
        self._vapid_subject = vapid_subject
        self._vapid = None  # lazy

    def _ensure_vapid(self) -> Dict[str, str]:
        if self._vapid is None:
            self._vapid = ensure_vapid_keys(self.db, self._vapid_subject)
        return self._vapid

    def dispatch_envelope(self, env: Dict, *, body_override: Optional[str] = None) -> Dict:
        """Fire push for a single envelope. Synchronous (called inside
        the aiohttp worker, but pywebpush itself is sync-blocking;
        per-subscription HTTP is the dominant cost). Returns
        ``{delivered, pruned, skipped?}``.
        """
        if not _is_push_eligible(env):
            return {"delivered": 0, "pruned": 0, "skipped": "not_eligible"}
        chat_id = env.get("chat_id")
        if not isinstance(chat_id, str) or not chat_id:
            return {"delivered": 0, "pruned": 0, "skipped": "missing_chat_id"}
        if self.engagement.is_engaged(chat_id):
            return {"delivered": 0, "pruned": 0, "skipped": "user_engaged"}
        if is_muted(self.db, chat_id):
            return {"delivered": 0, "pruned": 0, "skipped": "muted"}
        vapid = self._ensure_vapid()
        subs = list_subscriptions(self.db)
        if not subs:
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
        logger.info("dispatch chat=%s delivered=%d pruned=%d", chat_id, delivered, pruned)
        return {"delivered": delivered, "pruned": pruned}
