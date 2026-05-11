// Mock backend for sidekick PWA smoke scenarios.
//
// Intercepts /api/sidekick/* via Playwright page.route() and serves
// scripted responses. No real hermes/LLM/Deepgram calls.
//
// Use:
//   import { installMockBackend } from './mock-backend.mjs';
//   const mock = await installMockBackend(page);
//   // mock.addChat(chat_id, {title, messages, lastActiveAt})
//   // mock.simulateReply(chat_id, text)         — push a reply via the
//   //                                              persistent stream
//   // ...
//   await mock.close();   // tears down the in-process SSE server
//
// /api/sidekick/stream is served by a real in-process http.Server on
// an ephemeral 127.0.0.1 port (mirrors the proxy-test harness pattern
// at proxy/sidekick/__tests__/proxy-harness.ts).
// Playwright forwards the PWA's /api/sidekick/stream request to that
// local server via `route.continue({ url })`, so the EventSource sees
// a single long-lived connection — `pushReply` / `pushSessionChanged`
// land within milliseconds instead of having to wait for the
// `retry: 200` reconnect cycle that `route.fulfill` was forced into.
//
// Other endpoints (sessions list, messages, config, keyterms) stay as
// `route.fulfill` — they're one-shot HTTP, no streaming need.
//
// Scenarios that exercise the LLM logic itself (tool-turn, etc.)
// should use the real backend via export const BACKEND = 'real'.
// Drawer / UX / persistence tests don't care about LLM behavior and
// run fine against the mock — orders of magnitude faster.

import * as http from 'node:http';

/** @typedef {{
 *    chatId: string,
 *    title: string,
 *    messages: Array<{role: string, content: string, timestamp?: number}>,
 *    lastActiveAt: number,
 *  }} MockChat
 */

export async function installMockBackend(page) {
  const chats = new Map();          // chat_id → MockChat
  /** Mirrors the real proxy's inflight cache. Tests opt in via
   *  setInflight(chatId, [...]) to simulate a chat with envelopes
   *  not yet persisted in state.db (e.g. an in-flight turn). The
   *  history-fetch handler appends these as the `inflight` field. */
  const inflightByChat = new Map();
  /** When true (default), POST /api/sidekick/messages auto-emits a
   *  reply via SSE 50ms later. Tests that want to drive envelopes
   *  manually (e.g. assert the thinking-dots label transitions
   *  across typing → tool_call → canvas.show) call
   *  mock.setAutoReplyEnabled(false) to suppress the auto-reply
   *  and push their own envelopes via pushEnvelope. */
  let autoReplyEnabled = true;
  /** Mirror hermes-core's post-turn persistence semantics. When true,
   *  the sessions list endpoint suppresses `first_user_message` for
   *  chats that have no assistant message yet — i.e. mid-turn, hermes
   *  hasn't fired `append_to_transcript` and the server-side state.db
   *  is empty for that chat. Tests that exercise the in-flight window
   *  (drawer snippets, mid-turn switch-away) flip this to `true`. The
   *  default `false` matches the legacy mock behavior most tests rely
   *  on (persistence is instant at POST time, which is wrong vs prod
   *  but convenient for non-timing tests). */
  let postTurnPersistence = false;
  /** Active SSE responses (real http.ServerResponse objects). */
  const streamSubs = new Set();
  let envelopeId = 0;
  // Replay ring — so a freshly-connecting PWA tab (or a Last-Event-Id
  // resume after a temporary disconnect) sees recent envelopes.
  const recent = [];

  const broadcast = (env) => {
    envelopeId++;
    const id = envelopeId;
    recent.push({ id, env });
    if (recent.length > 128) recent.shift();
    const frame = `id: ${id}\nevent: ${env.type}\ndata: ${JSON.stringify(env)}\n\n`;
    for (const sub of streamSubs) {
      try { sub.write(frame); }
      catch {}
    }
  };

  // Real in-process http.Server hosting /api/sidekick/stream as a
  // proper persistent SSE endpoint. Playwright redirects the PWA's
  // request here via route.continue({ url }) below.
  const sseServer = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    // Read Last-Event-Id from header OR ?lastEventId= (Playwright may
    // strip non-allowlisted request headers when forwarding).
    const headerId = req.headers['last-event-id'];
    const url = new URL(req.url || '/', 'http://x');
    const queryId = url.searchParams.get('lastEventId');
    const cursor = headerId
      ? Number.parseInt(String(headerId), 10)
      : queryId
      ? Number.parseInt(queryId, 10)
      : -1;

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
      'connection': 'keep-alive',
    });
    // Tiny retry hint so a connection drop reconnects fast (the real
    // proxy uses 5000ms; tests want sub-second).
    res.write('retry: 200\n\n');
    // Replay anything since the cursor.
    for (const entry of recent) {
      if (entry.id <= cursor) continue;
      res.write(`id: ${entry.id}\nevent: ${entry.env.type}\ndata: ${JSON.stringify(entry.env)}\n\n`);
    }
    streamSubs.add(res);
    const drop = () => { streamSubs.delete(res); };
    req.on('close', drop);
    res.on('close', drop);
  });
  // Track open sockets so `close()` can hang up immediately rather
  // than waiting for the OS keep-alive timeout to drain.
  const openSockets = new Set();
  sseServer.on('connection', (sock) => {
    openSockets.add(sock);
    sock.on('close', () => openSockets.delete(sock));
  });
  await new Promise((resolve, reject) => {
    sseServer.once('error', reject);
    sseServer.listen(0, '127.0.0.1', () => resolve());
  });
  const sseAddr = sseServer.address();
  const ssePort = typeof sseAddr === 'object' && sseAddr ? sseAddr.port : 0;
  const sseUrl = `http://127.0.0.1:${ssePort}/stream`;

  // GET /api/sidekick/sessions — canned list from the in-memory map.
  await page.route('**/api/sidekick/sessions*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/messages')) {
      // Per-chat history endpoint — handled by the next route.
      return route.fallback();
    }
    if (route.request().method() !== 'GET') return route.fallback();
    const sessions = Array.from(chats.values()).map(c => {
      // Mirror the proxy's first_user_message derivation: pick the
      // first role='user' message and truncate to 80 chars. Lets the
      // drawer fall back to a snippet when title is still empty.
      //
      // Post-turn persistence mode (real hermes behavior): suppress
      // first_user_message until at least one assistant message has
      // landed — production hermes' append_to_transcript fires AFTER
      // agent_result is computed, so during the in-flight window the
      // server-side state.db has nothing for this chat. Tests that
      // verify drawer behavior during in-flight turns set
      // mock.setPostTurnPersistence(true).
      const hasAssistantReply = c.messages.some(m => m.role === 'assistant');
      const firstUser = c.messages.find(m => m.role === 'user');
      const visiblePostTurn = !postTurnPersistence || hasAssistantReply;
      const firstUserMessage = firstUser && visiblePostTurn
        ? String(firstUser.content || '').slice(0, 80)
        : null;
      // message_count is also gated: real hermes' append_to_transcript
      // fires post-turn, so /v1/gateway/conversations returns 0 until
      // reply_final lands. Both `first_user_message` AND `message_count`
      // need the same gate or the PWA's cleanup heuristic (messageCount
      // > 0 → "server knows", spare from cleanup) misbehaves only in
      // production, not in tests.
      const messageCount = visiblePostTurn ? c.messages.length : 0;
      return {
        chat_id: c.chatId,
        session_id: `mock-${c.chatId}`,
        source: c.source || 'sidekick',
        title: c.title,
        last_active_at: new Date(c.lastActiveAt).toISOString(),
        message_count: messageCount,
        created_at: new Date(c.lastActiveAt).toISOString(),
        first_user_message: firstUserMessage,
      };
    });
    sessions.sort((a, b) => (b.last_active_at || '').localeCompare(a.last_active_at || ''));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessions }),
    });
  });

  // GET /api/sidekick/sessions/<chat_id>/messages — canned transcript.
  // Each message's `id` matches the SSE envelope `message_id` the
  // proxy emitted for that same content — mirrors the real proxy
  // (proxy/sidekick/history.ts maps `id: it.id` and upstream.ts
  // emits the same `it.id` as `message_id` on reply_delta /
  // reply_final). Tests rely on this alignment for cross-path dedup.
  await page.route(/.*\/api\/sidekick\/sessions\/[^/]+\/messages/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const url = new URL(route.request().url());
    const m = url.pathname.match(/\/sessions\/([^/]+)\/messages/);
    const chatId = m ? decodeURIComponent(m[1]) : '';
    const chat = chats.get(chatId);
    const messages = chat ? chat.messages.map((m, i) => {
      const out = {
        id: m.message_id || `mock-msg-history-${chatId}-${i}`,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp || (chat.lastActiveAt / 1000),
      };
      // Mirror the real plugin's surfacing of sidekick_id from
      // sidekick_msg_links — present when the live SSE round-trip
      // recorded a link, absent for legacy / other-channel rows.
      // Tests can opt in per-message by setting `sidekick_id` on the
      // mock chat's message dict.
      if (m.sidekick_id) out.sidekick_id = m.sidekick_id;
      return out;
    }) : [];
    // Inflight envelopes — mirror the real proxy's behavior of
    // surfacing envelopes from in-flight turns (the user message +
    // tool calls + streaming reply deltas that haven't been
    // persisted to state.db yet). Tests opt in by calling
    // mock.setInflight(chatId, [envelopes...]).
    const inflightEnvelopes = inflightByChat.get(chatId) || [];
    const responseBody = {
      messages,
      firstId: null,
      hasMore: false,
      ...(inflightEnvelopes.length > 0 ? { inflight: inflightEnvelopes } : {}),
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(responseBody),
    });
  });

  // DELETE /api/sidekick/sessions/<chat_id> — drop from the in-memory map.
  await page.route(/.*\/api\/sidekick\/sessions\/[^/]+$/, async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    const url = new URL(route.request().url());
    const m = url.pathname.match(/\/sessions\/([^/]+)$/);
    const chatId = m ? decodeURIComponent(m[1]) : '';
    chats.delete(chatId);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  // POST /api/sidekick/messages — fire-and-forget, returns 202.
  // Body has {chat_id, text}. Auto-creates the chat in our map and
  // schedules a reply envelope on the persistent stream.
  await page.route('**/api/sidekick/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    let body;
    try { body = JSON.parse(route.request().postData() || '{}'); }
    catch { body = {}; }
    const chatId = body.chat_id;
    const text = body.text || '';
    // user_message_id may ride on the body OR on metadata.
    // Mirrors what real plugin reads — see backends/hermes/plugin/__init__.py.
    const incomingUserMsgId =
      body.user_message_id
      || (body.metadata && body.metadata.user_message_id)
      || null;
    if (chatId) {
      let chat = chats.get(chatId);
      if (!chat) {
        chat = { chatId, title: '', messages: [], lastActiveAt: Date.now() };
        chats.set(chatId, chat);
      }
      // Mirror plugin behavior: emit a user_message envelope BEFORE
      // dispatch so cross-device clients render the bubble. Echo back
      // the PWA-supplied user_message_id (if any) so the originating
      // device's renderedMessages.upsert collapses idempotently.
      const userMsgId = incomingUserMsgId || `umsg_mock_${envelopeId + 1}`;
      const replyText = `[mock] echo: ${text}`;
      const messageId = `mock-msg-${envelopeId + 1}`;
      // Persist the user+assistant rows with their SSE-shape ids so a
      // later history-fetch returns sidekick_id matching what the live
      // user_message / reply_final envelopes carried. Without this, the
      // smoke's history endpoint mints synthetic ids that DON'T match
      // the optimistic-bubble or user_message keys — and the smoke
      // silently exercises a different upsert path than production.
      // Reproducing field bug 2026-05-11: the user bubble in production
      // is keyed by umsg_*, the history-replay path ALSO needs to upsert
      // with umsg_* (via sidekick_id) for the bubble to render after a
      // switch-away-and-back clear-and-replay.
      chat.messages.push({
        role: 'user',
        content: text,
        message_id: userMsgId,
        sidekick_id: userMsgId,
        timestamp: Date.now() / 1000,
      });
      chat.lastActiveAt = Date.now();
      if (!autoReplyEnabled) {
        // Test wants to drive envelopes manually — skip the auto-
        // reply but still broadcast user_message so cross-device
        // optimistic-bubble dedup works.
        setTimeout(() => {
          broadcast({
            type: 'user_message',
            chat_id: chatId,
            message_id: userMsgId,
            text,
          });
        }, 0);
      } else {
      setTimeout(() => {
        broadcast({
          type: 'user_message',
          chat_id: chatId,
          message_id: userMsgId,
          text,
        });
        broadcast({ type: 'typing', chat_id: chatId });
        broadcast({
          type: 'reply_delta',
          chat_id: chatId,
          text: replyText,
          message_id: messageId,
        });
        broadcast({ type: 'reply_final', chat_id: chatId, message_id: messageId });
        chat.messages.push({
          role: 'assistant',
          content: replyText,
          message_id: messageId,
          sidekick_id: messageId,
          timestamp: Date.now() / 1000,
        });
        chat.lastActiveAt = Date.now();
      }, 50);
      }
    }
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, message_id: `mock-${envelopeId + 1}` }),
    });
  });

  // GET /api/sidekick/stream — persistent SSE forwarded to the
  // in-process http.Server above. Playwright's `route.continue({ url })`
  // re-issues the request to the new URL and pipes the response body
  // back to the page, including streamed chunks. That gives us a real
  // long-lived SSE channel: `pushReply` / `pushSessionChanged` write
  // straight to `streamSubs` and the PWA sees them immediately, no
  // EventSource-reconnect hop required.
  await page.route('**/api/sidekick/stream', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const lastEventId = route.request().headers()['last-event-id'];
    // Forward Last-Event-Id as a query param too — some Playwright
    // versions strip the header when overriding `url`.
    const target = lastEventId
      ? `${sseUrl}?lastEventId=${encodeURIComponent(lastEventId)}`
      : sseUrl;
    await route.continue({ url: target });
  });

  // GET /config — minimal config so the PWA doesn't 404. Anchor to
  // origin-root with a regex; a glob like `**/config` also matches
  // `/api/sidekick/config`, which silently turned settings.load() into
  // a no-op (the runtime-config payload has no `settings` field) — every
  // mocked-backend test was reading DEFAULTS for every yaml-backed key.
  await page.route(/^https?:\/\/[^/]+\/config(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        gwToken: 'mock-token',
        appName: 'SideKick',
        appSubtitle: 'Agent Portal',
        agentLabel: 'Clawdian',
        themePrimary: '',
        backend: 'proxy-client',
      }),
    });
  });

  // /api/sidekick/settings/* — agent-declared settings extension.
  // Tests configure schema via mock.setSettingsSchema([...]). null
  // schema = agent doesn't implement extension (route returns 404),
  // matching the contract for opt-out agents.
  let settingsSchema = null;            // null | SettingDef[]
  /** Records the most recent /api/sidekick/settings/{id} POST so
   *  tests can assert the body shape forwarded matches what they
   *  expected. */
  let lastSettingsPost = null;
  await page.route(/.*\/api\/sidekick\/settings(?:\/.*)?/, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method === 'GET' && url.pathname.endsWith('/settings/schema')) {
      if (settingsSchema === null) {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'settings not supported' } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ object: 'list', data: settingsSchema }),
      });
      return;
    }
    const m = method === 'POST' && url.pathname.match(/\/settings\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      let body;
      try { body = JSON.parse(route.request().postData() || '{}'); }
      catch { body = {}; }
      lastSettingsPost = { id, body };
      if (settingsSchema === null) {
        await route.fulfill({ status: 404, contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'settings not supported' } }) });
        return;
      }
      const def = settingsSchema.find((s) => s.id === id);
      if (!def) {
        await route.fulfill({ status: 404, contentType: 'application/json',
          body: JSON.stringify({ error: { message: `unknown setting: ${id}` } }) });
        return;
      }
      const value = body?.value;
      if (def.type === 'enum') {
        const ok = (def.options ?? []).some((o) => o.value === value);
        if (!ok) {
          await route.fulfill({ status: 400, contentType: 'application/json',
            body: JSON.stringify({ error: { message: `value not in options[]: ${JSON.stringify(value)}` } }) });
          return;
        }
      }
      def.value = value;
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(def) });
      return;
    }
    return route.fallback();
  });

  // /api/sidekick/commands — slash-command catalog. Tests configure
  // via mock.setCommandsCatalog([...]). null = upstream agent doesn't
  // implement the extension (route returns 404), matching the
  // contract for opt-out agents. Default is null so existing smokes
  // see a no-op slashCommands module.
  let commandsCatalog = null;        // null | CommandDef[]
  await page.route(/.*\/api\/sidekick\/commands(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (commandsCatalog === null) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'commands not supported' } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ object: 'list', data: commandsCatalog }),
    });
  });

  // GET /api/keyterms — empty list, harmless.
  await page.route('**/api/keyterms', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  return {
    /** Add a synthetic chat to the mock's in-memory state. The PWA
     *  drawer will list it; clicking it returns the canned messages.
     *  Use `??` for `title` so callers can pre-seed an empty-string
     *  title (untitled-chat scenarios), which `||` would otherwise
     *  swap for the "Mock chat" default. */
    addChat(chatId, opts = {}) {
      chats.set(chatId, {
        chatId,
        source: opts.source || 'sidekick',
        title: opts.title ?? 'Mock chat',
        messages: opts.messages || [],
        lastActiveAt: opts.lastActiveAt || Date.now(),
      });
    },
    /** Push a reply envelope as if the agent generated it. The active
     *  stream subscriber will receive it on its next reconnect.
     *  `messageId` lets the test pin a stable id — useful for
     *  cross-path dedup tests where history's `id` must match the
     *  envelope's `message_id`. Defaults to a fresh synthetic id. */
    pushReply(chatId, text, messageId) {
      const id = messageId || `mock-msg-${envelopeId + 1}`;
      broadcast({ type: 'reply_delta', chat_id: chatId, text, message_id: id });
      broadcast({ type: 'reply_final', chat_id: chatId, message_id: id });
    },
    /** Push a session_changed envelope (e.g. for title-update tests).
     *  Also updates the in-memory chat's title to match — mimics what
     *  real hermes does (state.db title column updated alongside the
     *  envelope), so the next listSessions response carries the new
     *  title and the drawer's refresh catches up. */
    pushSessionChanged(chatId, title, sessionId = `mock-${chatId}`) {
      const chat = chats.get(chatId);
      if (chat) chat.title = title;
      broadcast({ type: 'session_changed', chat_id: chatId, session_id: sessionId, title });
    },
    /** Generic escape hatch — broadcast an arbitrary envelope onto the
     *  SSE channel. Smokes that need to exercise envelope shapes the
     *  built-in helpers don't cover (tool_call, tool_result, custom
     *  notification kinds) call this directly. The envelope must
     *  include a `type` field; `chat_id` is also required by the PWA's
     *  router. */
    pushEnvelope(env) { broadcast(env); },
    /** Set the inflight envelope list for a chat. The next
     *  /api/sidekick/sessions/<chatId>/messages GET will include
     *  these as the `inflight` field, mirroring the real proxy's
     *  in-memory inflight cache. Pass `null` or an empty array to
     *  clear. Tests use this to simulate the "switch-back during
     *  in-flight turn" scenario without needing the real proxy.
     */
    setInflight(chatId, envelopes) {
      if (!envelopes || envelopes.length === 0) {
        inflightByChat.delete(chatId);
      } else {
        inflightByChat.set(chatId, envelopes);
      }
    },
    /** Suppress the auto-reply on POST /messages. Tests that drive
     *  envelopes by hand (label-transition state machines, manual
     *  reply timing) call setAutoReplyEnabled(false). The
     *  user_message broadcast still fires (cross-device dedup
     *  expects it); the typing + reply envelopes do not. */
    setAutoReplyEnabled(enabled) {
      autoReplyEnabled = !!enabled;
    },
    /** Toggle the in-flight persistence semantics. Default `false`
     *  (legacy: chats are visible in /sessions immediately on POST).
     *  Set `true` for tests that need to mirror real hermes behavior
     *  where first_user_message is absent until reply_final lands. */
    setPostTurnPersistence(enabled) {
      postTurnPersistence = !!enabled;
    },
    /** Configure the /v1/settings/schema response. Pass null to
     *  declare the agent doesn't implement the extension (route
     *  returns 404). The handler also recognizes POST /settings/{id}
     *  with an enum-validation pass; getLastSettingsPost() returns
     *  what the PWA most recently sent. */
    setSettingsSchema(schema) {
      settingsSchema = schema;
      lastSettingsPost = null;
    },
    getLastSettingsPost() { return lastSettingsPost; },
    /** Configure /api/sidekick/commands. Pass null to declare the
     *  agent doesn't implement the extension (route returns 404).
     *  Each entry is a CommandDef from
     *  proxy/sidekick/upstream.ts — { name, description, category,
     *  aliases, args_hint, subcommands }. */
    setCommandsCatalog(catalog) { commandsCatalog = catalog; },

    /** Inspect/snapshot. */
    chatCount() { return chats.size; },
    listChats() { return Array.from(chats.values()); },
    getChat(chatId) { return chats.get(chatId); },
    /** Tear down the in-process SSE server. Call from the runner's
     *  cleanup so we don't leak ports between scenarios. */
    async close() {
      // Close active SSE responses + sockets first so server.close()
      // resolves immediately instead of waiting for the keep-alive
      // timeout to drain.
      for (const sub of streamSubs) {
        try { sub.end(); } catch {}
      }
      streamSubs.clear();
      for (const sock of openSockets) {
        try { sock.destroy(); } catch {}
      }
      openSockets.clear();
      await new Promise((resolve) => sseServer.close(() => resolve()));
    },
  };
}
