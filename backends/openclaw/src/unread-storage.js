/**
 * Unread state — the SSOT for sidebar badges, app badge, and push
 * dispatch eligibility.
 *
 * One row per chat tracks `last_read_at`. Everything derives:
 *   - sidebar badge[X]  = count of push-eligible events in X with
 *                         timestamp > last_read_at[X]
 *   - app badge         = sum of those per-chat counts
 *   - push fires        = on agent event AND chat not engaged AND
 *                         not muted AND subscribers exist
 *
 * The count is computed by joining against the durable jsonl (read
 * via openclaw-store.readSessionMessages) — same source of truth the
 * items handler uses. No counter to maintain; no drift possible.
 *
 * Cross-device sync: callers broadcast an `unread_changed` envelope
 * after any seen/mark mutation (done in the route handlers).
 */
import {
  resolveStateDir, listSessions, readSessionMessages, isDeliveryMirror,
} from './openclaw-store.js';

const AGENT_ID = process.env.OPENCLAW_SK_AGENT || 'dev';
const PROFILE = process.env.OPENCLAW_SK_PROFILE || 'sk-integ';

/** Lookup the read-pointer row for one chat, or null. */
export function getUnreadRow(db, chatId) {
  return db.prepare(`
    SELECT chat_id AS chatId, last_read_at AS lastReadAt, marked_unread AS markedUnread
    FROM unread_state WHERE chat_id = ?
  `).get(chatId) ?? null;
}

/** Mark a chat as seen (last_read_at = now). */
export function markSeen(db, chatId, now = Date.now() / 1000) {
  db.prepare(`
    INSERT INTO unread_state (chat_id, last_read_at, marked_unread)
    VALUES (@chat_id, @last_read_at, 0)
    ON CONFLICT(chat_id) DO UPDATE SET
      last_read_at  = excluded.last_read_at,
      marked_unread = 0
  `).run({ chat_id: chatId, last_read_at: now });
}

/** Toggle the sticky marked_unread bit. Doesn't touch last_read_at. */
export function setMarked(db, chatId, marked) {
  db.prepare(`
    INSERT INTO unread_state (chat_id, last_read_at, marked_unread)
    VALUES (@chat_id, NULL, @marked)
    ON CONFLICT(chat_id) DO UPDATE SET
      marked_unread = excluded.marked_unread
  `).run({ chat_id: chatId, marked: marked ? 1 : 0 });
}

/** Whether an openclaw stored message row counts as a push-eligible
 *  user-facing event for unread accounting. Mirrors the push
 *  dispatcher's eligibility set so the badge count matches what
 *  fired pushes.
 *
 *  Excludes:
 *    - tool calls / tool results (machine chatter)
 *    - delivery-mirror duplicates
 *    - codex narration (rejected via the items mapper's structural
 *      filter, but for unread accounting we count the message-tool
 *      call as the user-facing event, not the narration)
 *    - the user's own messages (echoes of what they sent — never
 *      "unread" for the originator) */
function isUnreadCountable(msg) {
  if (msg.role !== 'assistant') return false;
  if (isDeliveryMirror(msg)) return false;
  if (!Array.isArray(msg.content)) return false;
  // Count once per assistant row that has either a message-tool call
  // (the user-facing reply) OR plain text without a message-tool
  // call in the SAME row (pure assistant reply).
  return msg.content.some(
    (c) => (c?.type === 'toolCall' && c?.name === 'message') || c?.type === 'text',
  );
}

/** Compute per-chat unread counts across all sessions in the agent.
 *  Returns `{chats: [{chat_id, unread_count, marked_unread, last_read_at}], total}`.
 *
 *  total = sum of per-chat unread_counts (Jonathan picked sum over
 *  chat-count for higher-fidelity feedback; the schema doesn't care,
 *  switching would be a one-line aggregation change). */
export function computeUnread(db, { agentId = AGENT_ID, profile = PROFILE } = {}) {
  const stateDir = resolveStateDir({ profile });
  const sessions = listSessions({ stateDir, agentId });
  const rows = db.prepare(`
    SELECT chat_id AS chatId, last_read_at AS lastReadAt, marked_unread AS markedUnread
    FROM unread_state
  `).all();
  const stateByChat = new Map(rows.map((r) => [r.chatId, r]));

  const out = [];
  let total = 0;
  for (const [sessionKey, entry] of Object.entries(sessions)) {
    // Plugin externalizes chat ids in stripped form (matches PWA
    // mintChatId). Match the same stripping the items handler uses.
    const agentPrefix = `agent:${agentId}:`;
    const chatId = sessionKey.startsWith(agentPrefix)
      ? sessionKey.slice(agentPrefix.length)
      : sessionKey;
    const state = stateByChat.get(chatId);
    const lastReadAtSec = state?.lastReadAt ?? 0;
    const lastReadAtMs = lastReadAtSec * 1000;

    let count = 0;
    if (state?.markedUnread) {
      // Sticky-unread: count at least 1 so the chat surfaces with a
      // badge even after viewing.
      count = 1;
    } else {
      // O(n) walk per chat. Fine at single-digit chat volumes; cache
      // in the supplemental store if this becomes hot.
      const messages = readSessionMessages({ stateDir, agentId, sessionId: entry.sessionId });
      for (const m of messages) {
        if (!isUnreadCountable(m)) continue;
        const ts = m.timestamp ?? (m.wrapperTs ? Date.parse(m.wrapperTs) : 0);
        if (ts > lastReadAtMs) count += 1;
      }
    }

    if (count > 0 || state?.markedUnread) {
      out.push({
        chat_id: chatId,
        unread_count: count,
        marked_unread: !!state?.markedUnread,
        last_read_at: state?.lastReadAt ?? null,
      });
      total += count;
    }
  }
  return { chats: out, total };
}
