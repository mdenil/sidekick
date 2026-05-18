"""Push subs / mutes / prefs / pins / unread / VAPID CRUD against
the supplemental sqlite. Python parity of the openclaw plugin's
``src/push-storage.js`` + ``src/pins-storage.js`` + ``src/unread-storage.js``.

Keep this module pure: storage operations only. Dispatch logic
(engagement filter, web-push call) lives in ``sidekick_dispatcher.py``.
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional

import base64
import os

from py_vapid import Vapid
from cryptography.hazmat.primitives.serialization import (
    load_pem_public_key, load_pem_private_key,
    Encoding, PublicFormat, PrivateFormat, NoEncryption,
)
from cryptography.hazmat.primitives.asymmetric import ec


# ── VAPID ─────────────────────────────────────────────────────────────

def _b64url_to_raw(b64url: str) -> bytes:
    """base64url-no-pad → raw bytes (Web Push VAPID format)."""
    pad = "=" * ((4 - len(b64url) % 4) % 4)
    return base64.urlsafe_b64decode(b64url + pad)


def _raw_to_b64url(raw: bytes) -> str:
    """raw bytes → base64url-no-pad (Web Push VAPID format)."""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def ensure_vapid_keys(db, subject: str) -> Dict[str, str]:
    """Return the active VAPID identity. On first call:
      1. If env vars VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY are present
         (the proxy's legacy config), import them — keeps existing
         push subscriptions valid after the parity switchover.
      2. Otherwise generate fresh keys.
    Subsequent calls return the persisted row.

    Storage format: base64url-no-pad raw bytes for both halves.
    pywebpush accepts this directly via `vapid_private_key`; sending
    the public to the PWA via /v1/push/vapid-public-key wraps it
    through `vapid_public_key_b64url` (which is a no-op for already-
    encoded values).
    """
    row = db.fetchone("SELECT public_key, private_key, subject FROM vapid_keys WHERE id = 1")
    if row:
        return {"public_key": row["public_key"], "private_key": row["private_key"], "subject": row["subject"]}
    env_pub = os.environ.get("VAPID_PUBLIC_KEY", "").strip()
    env_priv = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
    if env_pub and env_priv:
        public_b64 = env_pub
        private_b64 = env_priv
    else:
        vapid = Vapid()
        vapid.generate_keys()
        # Convert generated PEM keys to raw b64url for storage.
        pub_key = load_pem_public_key(vapid.public_pem())
        public_b64 = _raw_to_b64url(
            pub_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
        )
        priv_key = load_pem_private_key(vapid.private_pem(), password=None)
        private_b64 = _raw_to_b64url(
            priv_key.private_numbers().private_value.to_bytes(32, "big")
        )
    db.exec(
        "INSERT INTO vapid_keys (id, public_key, private_key, subject, created_at) "
        "VALUES (1, ?, ?, ?, ?)",
        (public_b64, private_b64, subject, time.time()),
    )
    return {"public_key": public_b64, "private_key": private_b64, "subject": subject}


def vapid_public_key_b64url(public_key: str) -> str:
    """Return the public key in base64url-no-pad form (what the PWA's
    ``PushManager.subscribe({applicationServerKey})`` expects).

    Our storage format already IS base64url (see ``ensure_vapid_keys``);
    this function exists as the stable contract the route handler
    calls — independent of internal storage decisions."""
    return public_key


# ── Push subscriptions ────────────────────────────────────────────────

def upsert_subscription(db, *, endpoint: str, p256dh: str, auth: str, user_agent: str = "") -> Dict[str, Any]:
    existing = db.fetchone("SELECT created_at FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
    now = time.time()
    if existing:
        db.exec(
            "UPDATE push_subscriptions SET p256dh = ?, auth = ?, user_agent = ? WHERE endpoint = ?",
            (p256dh, auth, user_agent, endpoint),
        )
        return {"created": False}
    db.exec(
        "INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at, last_used_at) "
        "VALUES (?, ?, ?, ?, ?, NULL)",
        (endpoint, p256dh, auth, user_agent, now),
    )
    return {"created": True}


def remove_subscription(db, endpoint: str) -> Dict[str, Any]:
    cur = db.exec("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
    return {"removed": cur.rowcount > 0}


def list_subscriptions(db) -> List[Dict[str, Any]]:
    rows = db.fetchall(
        "SELECT endpoint, p256dh, auth, user_agent AS userAgent, created_at, last_used_at AS lastUsedAt "
        "FROM push_subscriptions ORDER BY created_at ASC"
    )
    return [dict(r) for r in rows]


def mark_subscription_used(db, endpoint: str) -> None:
    db.exec("UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?", (time.time(), endpoint))


# ── Mutes / prefs ─────────────────────────────────────────────────────

def set_mute(db, chat_id: str, muted: bool) -> None:
    if muted:
        db.exec(
            "INSERT OR IGNORE INTO push_mutes (chat_id, muted_at) VALUES (?, ?)",
            (chat_id, time.time()),
        )
    else:
        db.exec("DELETE FROM push_mutes WHERE chat_id = ?", (chat_id,))


def is_muted(db, chat_id: str) -> bool:
    return db.fetchone("SELECT 1 FROM push_mutes WHERE chat_id = ?", (chat_id,)) is not None


def list_mutes(db) -> List[Dict[str, Any]]:
    return [dict(r) for r in db.fetchall(
        "SELECT chat_id AS chatId, muted_at AS mutedAt FROM push_mutes ORDER BY muted_at DESC"
    )]


def get_pref(db, key: str, fallback=None):
    row = db.fetchone("SELECT value_json FROM push_prefs WHERE key = ?", (key,))
    if not row:
        return fallback
    try:
        return json.loads(row["value_json"])
    except Exception:
        return fallback


def set_pref(db, key: str, value) -> None:
    db.exec(
        "INSERT INTO push_prefs (key, value_json) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        (key, json.dumps(value)),
    )


def list_prefs(db) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for row in db.fetchall("SELECT key, value_json FROM push_prefs"):
        try:
            out[row["key"]] = json.loads(row["value_json"])
        except Exception:
            out[row["key"]] = None
    return out


# ── Pins ──────────────────────────────────────────────────────────────

def list_pins(db, chat_id: Optional[str] = None) -> List[Dict[str, Any]]:
    if chat_id:
        rows = db.fetchall(
            "SELECT chat_id AS chatId, msg_id AS msgId, role, text, timestamp, "
            "pinned_at AS pinnedAt FROM pins WHERE chat_id = ? ORDER BY pinned_at DESC",
            (chat_id,),
        )
    else:
        rows = db.fetchall(
            "SELECT chat_id AS chatId, msg_id AS msgId, role, text, timestamp, "
            "pinned_at AS pinnedAt FROM pins ORDER BY pinned_at DESC"
        )
    return [dict(r) for r in rows]


def upsert_pin(db, *, chat_id: str, msg_id: str, role: str, text: str, timestamp: Optional[float] = None) -> None:
    now = time.time()
    db.exec(
        "INSERT INTO pins (chat_id, msg_id, role, text, timestamp, pinned_at) "
        "VALUES (?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(chat_id, msg_id) DO UPDATE SET "
        "  role = excluded.role, text = excluded.text, timestamp = excluded.timestamp",
        (chat_id, msg_id, role, text, timestamp if timestamp is not None else now, now),
    )


def delete_pin(db, *, chat_id: str, msg_id: str) -> Dict[str, Any]:
    cur = db.exec("DELETE FROM pins WHERE chat_id = ? AND msg_id = ?", (chat_id, msg_id))
    return {"removed": cur.rowcount > 0}


# ── Unread state ──────────────────────────────────────────────────────

def mark_seen(db, chat_id: str, *, now: Optional[float] = None) -> None:
    if now is None:
        now = time.time()
    db.exec(
        "INSERT INTO unread_state (chat_id, last_read_at, marked_unread) "
        "VALUES (?, ?, 0) "
        "ON CONFLICT(chat_id) DO UPDATE SET "
        "  last_read_at = excluded.last_read_at, marked_unread = 0",
        (chat_id, now),
    )


def set_marked(db, chat_id: str, marked: bool) -> None:
    db.exec(
        "INSERT INTO unread_state (chat_id, last_read_at, marked_unread) "
        "VALUES (?, NULL, ?) "
        "ON CONFLICT(chat_id) DO UPDATE SET marked_unread = excluded.marked_unread",
        (chat_id, 1 if marked else 0),
    )


def get_unread_row(db, chat_id: str) -> Optional[Dict[str, Any]]:
    row = db.fetchone(
        "SELECT chat_id AS chatId, last_read_at AS lastReadAt, marked_unread AS markedUnread "
        "FROM unread_state WHERE chat_id = ?",
        (chat_id,),
    )
    return dict(row) if row else None


def list_unread_state(db) -> List[Dict[str, Any]]:
    return [dict(r) for r in db.fetchall(
        "SELECT chat_id AS chatId, last_read_at AS lastReadAt, marked_unread AS markedUnread "
        "FROM unread_state"
    )]


# ── msg_links (in-flight → durable id bridge) ────────────────────────

def upsert_msg_link(db, *, id: str, chat_id: str, role: str, content: str,
                    agent_row_id: Optional[str] = None,
                    status: str = "final",
                    kind: Optional[str] = None,
                    tool_name: Optional[str] = None,
                    tool_call_id: Optional[str] = None) -> None:
    now = time.time()
    db.exec(
        "INSERT INTO msg_links (id, chat_id, role, content, kind, tool_name, "
        "                       tool_call_id, created_at, updated_at, status, agent_row_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET "
        "  content = excluded.content, "
        "  kind = COALESCE(excluded.kind, msg_links.kind), "
        "  tool_name = COALESCE(excluded.tool_name, msg_links.tool_name), "
        "  tool_call_id = COALESCE(excluded.tool_call_id, msg_links.tool_call_id), "
        "  updated_at = excluded.updated_at, "
        "  status = excluded.status, "
        "  agent_row_id = COALESCE(excluded.agent_row_id, msg_links.agent_row_id)",
        (id, chat_id, role, content, kind, tool_name, tool_call_id, now, now, status, agent_row_id),
    )


def list_msg_links_for_chat(db, chat_id: str, *, limit: int = 500) -> List[Dict[str, Any]]:
    rows = db.fetchall(
        "SELECT id, chat_id AS chatId, role, content, kind, tool_name AS toolName, "
        "       tool_call_id AS toolCallId, agent_row_id AS agentRowId, "
        "       created_at AS createdAt, updated_at AS updatedAt, status "
        "FROM msg_links WHERE chat_id = ? ORDER BY created_at ASC LIMIT ?",
        (chat_id, limit),
    )
    return [dict(r) for r in rows]
