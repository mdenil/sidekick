# OpenClaw Compatibility — Backlog Note

**Status**: research notes from a 2026-04-29 audit. NOT a plan to ship.
File this for the day someone wants a sidekick-openclaw integration —
e.g. to publish on clawhub or to validate that the
`docs/ABSTRACT_AGENT_PROTOCOL.md` contract really is portable.

**TL;DR**: Yes, sidekick's protocol is implementable as an openclaw
plugin. Use `definePluginEntry` + `api.registerHttpRoute(...)`, NOT
the channel-plugin idiom (`defineChannelPluginEntry` /
`api.registerChannel(...)`) — channel plugins have an inverted
data-flow model that doesn't fit. Three open questions on openclaw
internals would need source-level audit before committing.

---

## Sources

- [https://docs.openclaw.ai/plugins/building-plugins](https://docs.openclaw.ai/plugins/building-plugins)
- [https://docs.openclaw.ai/plugins/architecture](https://docs.openclaw.ai/plugins/architecture)
- [https://docs.openclaw.ai/plugins/sdk-entrypoints](https://docs.openclaw.ai/plugins/sdk-entrypoints)
- [https://docs.openclaw.ai/plugins/sdk-channel-plugins](https://docs.openclaw.ai/plugins/sdk-channel-plugins)

---

## What openclaw plugins look like

Openclaw plugins run **in-process with the gateway** (single-process,
JS/TS, jiti-loaded). No sandboxing — same trust boundary as core code.
Architecturally analogous to hermes-agent's in-process Python plugins.

Plugins register capabilities through an `api` object passed to
`register(api)`:

- `api.registerTool(...)` — agent-callable tools
- `api.registerProvider(...)` — text/image/video/speech inference
- `api.registerChannel(...)` — messaging platforms (Slack, Telegram, etc.)
- `api.registerHttpRoute(...)` — arbitrary HTTP endpoints
- `api.registerHook(...)` — internal event hooks
- `api.registerCli(...)` — CLI metadata
- (more — see sdk-entrypoints page)

Plugins declare config schema in `openclaw.plugin.json` and publish
to clawhub via `clawhub package publish org/plugin`. Users install
via `openclaw plugins install <package-name>`.

---

## Why the channel-plugin idiom is the WRONG fit

Openclaw's `defineChannelPluginEntry` / `api.registerChannel(...)` is
purpose-built for **messaging-platform adapters** — Slack, Telegram,
Matrix, etc. The data flow is:

```
External platform (Slack)
       │ webhook POST
       ▼
Channel plugin (registered via api.registerChannel)
   - registers HTTP webhook for inbound
   - declares outbound: { sendText, sendMedia } callbacks
       │
       ▼ (runtime calls outbound.sendText to push reply)
       ▼
External platform (Slack — receives reply)
```

The channel is **passive on the outbound side**: openclaw core decides
when a reply is ready and CALLS BACK into the channel's `sendText` to
deliver it. The channel doesn't open an outbound stream; it provides
a callback the runtime invokes.

For sidekick, the data flow is **inverted**:

```
PWA (browser)
       │ /api/sidekick/messages POST
       ▼
Sidekick proxy
       │ /v1/responses POST + SSE stream
       ▼
Agent (any /v1/*-speaking server, incl. an openclaw-plugin)
```

The proxy makes outbound HTTP calls TO the agent. The agent responds
with a streaming SSE body. There's no callback-style delivery.

If we tried to map sidekick onto channel-plugin semantics, we'd need
two webhooks (one for inbound from proxy, one the channel POSTs to
when delivering replies via `sendText`) and lose streaming. Don't.

**Use `definePluginEntry` + `api.registerHttpRoute(...)` instead.**
The plugin mounts `/v1/responses`, `/v1/conversations`,
`/v1/conversations/{id}/items`, `DELETE /v1/conversations/{id}` as
plain HTTP routes on openclaw's HTTP server. The proxy treats the
plugin identically to backends/hermes/plugin or the stub agent — same
`HTTPAgentUpstream` impl, just a different `UPSTREAM_URL`.

**Openclaw is a gateway, not a single channel.** The openclaw web
app already has a session browser today; sidekick exposing that
view is a primary motivation for the integration. So the plugin
SHOULD also implement the gateway extension namespace — at minimum
`GET /v1/gateway/conversations` returning openclaw's full session
list with `metadata.source` set per row (sidekick falls back to
`/v1/conversations` and stamps `source: "sidekick"` if the
extension is absent). See ABSTRACT_AGENT_PROTOCOL.md "Optional
gateway extension".

---

## Architecture sketch

```
┌─────────────────────────────────────────────────┐
│ Openclaw gateway (single process)                │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ sidekick-openclaw-plugin                   │  │
│  │  (definePluginEntry, in-process)           │  │
│  │                                            │  │
│  │  registers HTTP routes via                 │  │
│  │  api.registerHttpRoute({path: "/v1/...",   │  │
│  │                          handler: …})       │  │
│  │                                            │  │
│  │  handlers query openclaw runtime APIs       │  │
│  │  in-process for session enumeration         │  │
│  │  + dispatch turns to openclaw agent loop    │  │
│  └────────────────────────────────────────────┘  │
└─────────────────┬────────────────────────────────┘
                  │ HTTP+SSE (the agent contract)
                  │
┌─────────────────▼────────────────┐
│ Sidekick proxy                    │
│  HTTPAgentUpstream — talks /v1/*  │
│  (UPSTREAM_URL points at openclaw │
│   gateway's HTTP port)            │
└──────────────────────────────────┘
```

The sidekick proxy doesn't change between backends/hermes/plugin and
openclaw-plugin upstreams — it just points at a different `UPSTREAM_URL`.

---

## Open questions (would need source-level audit)

These are NOT blocking the sidekick refactor. They block the openclaw
plugin specifically.

### Q1: Does `api.registerHttpRoute` support streaming SSE responses?

The docs cover route registration but not response streaming
semantics. `/v1/responses` requires SSE chunking
(`response.output_text.delta` events, terminated by
`response.completed`). Almost certainly works — any Node HTTP server
supports streaming — but worth confirming with a 5-line proof of
concept before committing.

If not supported: file an issue upstream, fall back to non-streaming
`POST /v1/responses` (`stream: false` mode) which is part of the
contract anyway. Sidekick handles non-streaming agents — turn just
appears as a single chunk instead of progressively.

### Q2: How does an in-process openclaw plugin enumerate sessions?

`/v1/conversations` and `/v1/gateway/conversations` (drawer lists)
require the plugin to query openclaw's session store. The docs say
"openclaw runtime owns session/approval/message metadata" but the
public API surface for querying isn't documented in the pages I read.

Three possibilities:

1. **Public API exists** — `api.runtime.sessions.list(...)` or similar.
   Cleanest. Use it, ship the plugin.
2. **Internal API** — runtime exposes session manager via a non-public
   import path. Pragmatic; works in-process (since the plugin shares
   the gateway's process); fragile to openclaw refactors.
3. **No API at all** — plugin reads openclaw's storage (sqlite or
   filesystem) directly, same fallback backends/hermes/plugin uses today.
   Encapsulated by virtue of being in-process; ugly but functional.

The `accountId / sessionKey / sessionId` scope hints in the channel-
plugin docs suggest (1) probably exists in some form. Verify by
reading openclaw source.

### Q3: Authentication model for plugin HTTP routes

`api.registerHttpRoute({path, auth: "plugin", handler})` — the docs
mention `auth: "plugin"` but don't fully describe it. Sidekick proxy
uses bearer-token auth (`SIDEKICK_PLATFORM_TOKEN`). Need to confirm
the openclaw `auth: "plugin"` mode is compatible with bearer tokens
or describe how to wire a custom auth handler.

---

## Cost estimate (when it gets prioritized)

Assuming the three open questions resolve favorably (streaming works,
session API exists, auth is wireable):

- Sidekick-openclaw plugin: ~1-2 days. Most of the work is mapping
  openclaw's session-manager calls onto the `/v1/conversations*`
  shape, plus the SSE response writer for `/v1/responses`. The
  plugin scaffold itself is small.
- Clawhub package publish + verification: ~half day.
- Documentation update (openclaw config in
  `hermes-agent-workflow/scripts/bootstrap.sh` analog,
  README example): ~half day.

If any of Q1-Q3 require an upstream openclaw change: add 1-2 weeks
for the round-trip (file issue, contribute, wait for release).

---

## Required: prefix-encode the gateway `id` field

**This is a contract requirement, not openclaw-specific.** The agent
protocol's `ConversationSummary.id` is globally unique
(`ABSTRACT_AGENT_PROTOCOL.md` "Multi-identity rule for `id`"). For a
multi-channel gateway like openclaw — where the same `native_chat_id`
can recur under different sources — the plugin MUST emit:

```
id = "${source}:${native_chat_id}"
```

…and surface the platform-native chat_id as `metadata.native_chat_id`.

**Why we know this is a real problem (2026-05-02 hermes precedent):**
hermes' first cut of the gateway endpoint emitted `id := chat_id` (i.e.
the platform `user_id`). When Jonathan's WhatsApp `@lid`
(`199999999999999@lid`) ended up shared with a sidekick test session,
the gateway returned two rows with identical `id`. Sidekick rendered
two LIs with the same `data-chat-id`; clicking either activated both;
history fetch went through `_resolve_source_for_chat_id` which picks
one arbitrarily and returned the wrong session content. Fix lived
entirely in the plugin: `_format_gateway_id(source, chat_id)` at the
gateway-list emit point + `_parse_gateway_id` at the per-chat URL
handlers. See `backends/hermes/plugin/__init__.py` (search for
`_GATEWAY_ID_SEP`).

**Openclaw plugin specifics:**

- The drawer-list handler (`/v1/gateway/conversations`) emits
  `id = f"{source}:{native_id}"` for every row. `metadata.source` and
  `metadata.native_chat_id` carry the components separately for client
  display.
- The per-chat handlers (`/v1/conversations/{id}/items`, DELETE,
  `/v1/responses` dispatch) split the prefix off the URL `id` to
  resolve source-aware queries against openclaw's session store. If
  openclaw exposes `accountId / sessionKey / sessionId` natively (per
  the channel-plugin docs hint at line 182 of this doc), the
  decoded `(source, native_id)` pair maps directly onto the
  appropriate openclaw key — likely `(source = channel name,
  native_id = sessionKey)` or similar; resolve in Q2.
- `/v1/responses` rejects non-sidekick prefixes (composer is
  read-only upstream for those) and strips the sidekick prefix
  before dispatch — same shape as the hermes plugin's
  `_handle_responses` source-gate.
- Single-channel mode (openclaw configured with one channel):
  source is constant, prefix is a no-op disambiguator. No special
  case needed — uniform encoding.

**Why this saves work in the openclaw refactor:** the encoding
helpers (`_format_gateway_id` / `_parse_gateway_id`) are pure
functions with no openclaw or hermes dependencies. Copy them
verbatim into the openclaw plugin, swap the data source from
`_summaries_by_user_id` to whatever openclaw runtime API enumerates
sessions, and the contract conformance falls out for free. Tests in
`backends/hermes/plugin/tests/test_user_id_queries.py` (search
"Gateway id encoding") show the expected behavior at the unit level
and translate directly.

---

## What NOT to do

- **Don't fork channel-plugin code.** The data-flow mismatch is
  fundamental, not cosmetic. `definePluginEntry` + `registerHttpRoute`
  is the right shape.
- **Don't reach into openclaw's `state.db` from the sidekick proxy.**
  That's the same abstraction leak we just closed in the
  hermes-gateway refactor. The plugin (running in openclaw's process)
  is the seam; it owns the storage access. Proxy talks pure HTTP.
- **Don't add openclaw-specific code to the sidekick proxy's
  `proxy/agents/`.** The whole point of the refactor is that
  `HTTPAgentUpstream` is one impl, agent-agnostic. If openclaw
  forces per-agent code on the proxy side, that's a sign we did
  something wrong.

---

## Backlog hooks

When sidekick-openclaw becomes a priority:

1. Read this doc.
2. Read `docs/ABSTRACT_AGENT_PROTOCOL.md` (the contract the plugin
   implements).
3. Read `docs/SIDEKICK_BACKEND_REFACTOR.md` (how the proxy thinks
   about upstreams).
4. Resolve Q1-Q3 by reading openclaw source (probably 2-3h).
5. Sketch the plugin under `~/code/sidekick-openclaw-plugin/` (new
   sibling repo — published to clawhub independently).
6. Wire it as an alt upstream into the sidekick smoke-test runner
   to prove end-to-end.

---

*Notes from the 2026-04-29 audit.*
