/**
 * HTTP routes for unread state + pin storage.
 *
 *   GET  /v1/unread                       → {chats: [...], total: N}
 *   POST /v1/unread/seen                  ← {chat_id}
 *   POST /v1/unread/mark                  ← {chat_id, marked: bool}
 *
 *   GET  /v1/pins                         → {pins: [...]}
 *   GET  /v1/pins?chat_id=...             → {pins: [... for chat]}
 *   POST /v1/pins                         ← {chat_id, msg_id, role, text, timestamp}
 *   DELETE /v1/pins/{chat_id}/{msg_id}
 *
 *  All mutations broadcast a `pins_changed` or `unread_changed`
 *  envelope to /v1/events subscribers so connected PWAs refresh
 *  without polling. Cross-device sync rides this.
 */
import {
  getUnreadRow, markSeen, setMarked, computeUnread,
} from './unread-storage.js';
import {
  listPins, upsertPin, deletePin,
} from './pins-storage.js';

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req, cap = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > cap) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return {}; }
}

export function registerUnreadPinsRoutes(api, { db, eventBus, agentId, profile }) {
  // ── /v1/unread ───────────────────────────────────────────────────
  api.registerHttpRoute({
    path: '/v1/unread',
    auth: 'plugin', match: 'exact',
    handler: (_req, res) => {
      try {
        const data = computeUnread(db, { agentId, profile });
        sendJson(res, 200, data);
      } catch (err) {
        sendJson(res, 500, { error: 'unread_compute_failed', message: String(err?.message ?? err) });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: '/v1/unread/seen',
    auth: 'plugin', match: 'exact',
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return true; }
      const body = await readJson(req);
      const chatId = body?.chat_id ?? body?.chatId;
      if (!chatId) { sendJson(res, 400, { error: 'invalid_request', message: 'chat_id required' }); return true; }
      markSeen(db, chatId);
      // Broadcast so other devices refresh badges. Payload includes
      // the chat_id that changed; clients re-fetch /v1/unread for the
      // authoritative aggregate.
      eventBus.pushEnvelope({
        type: 'unread_changed',
        chat_id: chatId,
        cause: 'seen',
      });
      sendJson(res, 200, { ok: true, chat_id: chatId });
      return true;
    },
  });

  api.registerHttpRoute({
    path: '/v1/unread/mark',
    auth: 'plugin', match: 'exact',
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return true; }
      const body = await readJson(req);
      const chatId = body?.chat_id ?? body?.chatId;
      const marked = body?.marked === true;
      if (!chatId) { sendJson(res, 400, { error: 'invalid_request', message: 'chat_id required' }); return true; }
      setMarked(db, chatId, marked);
      eventBus.pushEnvelope({
        type: 'unread_changed',
        chat_id: chatId,
        cause: marked ? 'mark' : 'unmark',
      });
      sendJson(res, 200, { ok: true, chat_id: chatId, marked });
      return true;
    },
  });

  // ── /v1/pins ─────────────────────────────────────────────────────
  api.registerHttpRoute({
    path: '/v1/pins',
    auth: 'plugin', match: 'exact',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        const url = new URL(req.url, 'http://localhost');
        const chatId = url.searchParams.get('chat_id');
        const pins = listPins(db, chatId ? { chatId } : {});
        sendJson(res, 200, { pins });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const { chat_id, msg_id, role, text, timestamp } = body ?? {};
        if (!chat_id || !msg_id || !role || typeof text !== 'string') {
          sendJson(res, 400, { error: 'invalid_request', message: 'chat_id+msg_id+role+text required' });
          return true;
        }
        upsertPin(db, { chatId: chat_id, msgId: msg_id, role, text, timestamp });
        eventBus.pushEnvelope({
          type: 'pins_changed',
          chat_id,
          cause: 'pin',
          msg_id,
        });
        sendJson(res, 200, { ok: true });
        return true;
      }
      sendJson(res, 405, { error: 'method_not_allowed' });
      return true;
    },
  });

  // DELETE /v1/pins/{chat_id}/{msg_id}
  api.registerHttpRoute({
    path: '/v1/pins/',
    auth: 'plugin', match: 'prefix',
    handler: async (req, res) => {
      if (req.method !== 'DELETE') { sendJson(res, 405, { error: 'method_not_allowed' }); return true; }
      const url = new URL(req.url, 'http://localhost');
      const m = url.pathname.match(/^\/v1\/pins\/([^/]+)\/([^/]+)\/?$/);
      if (!m) { sendJson(res, 404, { error: 'not_found' }); return true; }
      const chatId = decodeURIComponent(m[1]);
      const msgId = decodeURIComponent(m[2]);
      const { removed } = deletePin(db, { chatId, msgId });
      if (removed) {
        eventBus.pushEnvelope({
          type: 'pins_changed',
          chat_id: chatId,
          cause: 'unpin',
          msg_id: msgId,
        });
      }
      sendJson(res, 200, { ok: true, removed });
      return true;
    },
  });
}
