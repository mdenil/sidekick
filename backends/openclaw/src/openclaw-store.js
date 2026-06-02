/**
 * Read openclaw's native session/message store directly from disk.
 *
 * Why on-disk reads instead of gateway WS calls:
 *   - The plugin runs in-process with openclaw but has no documented
 *     in-process API for invoking gateway methods (registerGatewayMethod
 *     is for adding methods, not calling them).
 *   - Going through a loopback WS would require the plugin to pair as
 *     its own device + get scope approval — same hoop the CLI hits.
 *   - openclaw's own `sessions.list` handler reads the same files we
 *     read here (see `src/gateway/server-methods/sessions.ts`
 *     `loadCombinedSessionStoreForGateway` in the openclaw gateway).
 *     So we're not bypassing a smart layer — we're reading the source
 *     of truth.
 *
 * Layout:
 *   {stateDir}/agents/{agentId}/sessions/sessions.json
 *     - dict of { [sessionKey]: SessionRegistryEntry }
 *     - sessionKey shape: "agent:{agentId}:{slot}" e.g. "agent:dev:main"
 *     - entry fields: sessionId, updatedAt(ms), sessionStartedAt(ms),
 *       chatType, sessionFile (absolute path to the .jsonl)
 *   {stateDir}/agents/{agentId}/sessions/{sessionId}.jsonl
 *     - line 1: {type:"session", ...} header
 *     - lines 2+: {type:"message", id, parentId, timestamp, message:{role,content,...}}
 *     - openclaw's chat.history returns the unwrapped `message` objects
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Locate the openclaw state dir for a given profile.
 *  Matches openclaw's CLI convention: `--profile sk-integ` → `~/.openclaw-sk-integ`.
 *  Falls back to OPENCLAW_STATE_DIR env if set (parity with openclaw CLI). */
export function resolveStateDir({ profile = 'sk-integ' } = {}) {
  if (process.env.OPENCLAW_STATE_DIR) return process.env.OPENCLAW_STATE_DIR;
  return join(homedir(), `.openclaw-${profile}`);
}

/** List sessions for an agent. Returns the raw sessions.json entries
 *  keyed by sessionKey (e.g. "agent:dev:main"). */
export function listSessions({ stateDir, agentId = 'dev' } = {}) {
  const path = join(stateDir, 'agents', agentId, 'sessions', 'sessions.json');
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw);
}

/** Read a session's full message log. Returns the unwrapped `message`
 *  objects in file order (oldest first). Filters out the header line
 *  and any non-message records.
 *
 *  Returns [] (not null) on missing file — chats can exist in
 *  sessions.json before any messages are written. */
export function readSessionMessages({ stateDir, agentId = 'dev', sessionId }) {
  const path = join(stateDir, 'agents', agentId, 'sessions', `${sessionId}.jsonl`);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let parsed;
    try { parsed = JSON.parse(line); }
    catch { continue; }  // skip corrupt lines defensively
    if (parsed?.type !== 'message') continue;
    if (!parsed.message) continue;
    out.push({
      wrapperId: parsed.id,
      parentId: parsed.parentId,
      wrapperTs: parsed.timestamp,
      ...parsed.message,
    });
  }
  return out;
}

/** Return just the first user message text from a session — used to
 *  populate ConversationSummary.metadata.first_user_message. Returns
 *  null when there's no user row (rare: cron-spawned chats). */
export function firstUserMessageText(messages) {
  for (const m of messages) {
    if (m.role === 'user') {
      // user.content can be a string or an array — handle both.
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        const txt = m.content.find((c) => c?.type === 'text')?.text;
        if (typeof txt === 'string') return txt;
      }
    }
  }
  return null;
}

/** Filter out openclaw's internal delivery-mirror duplicates. These
 *  are assistant rows with `provider:"openclaw", model:"delivery-mirror"`
 *  that re-render the substantive assistant text emitted by the
 *  `message` tool. Keeping them would double every reply in the PWA
 *  transcript. */
export function isDeliveryMirror(msg) {
  return msg?.provider === 'openclaw' && msg?.model === 'delivery-mirror';
}
