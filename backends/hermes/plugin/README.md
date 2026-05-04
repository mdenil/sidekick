# Sidekick hermes plugin

Hermes platform adapter that turns sidekick (PWA + Node proxy) into a
peer of telegram / slack / signal — a gateway-managed chat surface where
hermes owns the `chat_id → session_id` mapping natively.

The adapter exposes the abstract agent contract over HTTP+SSE
(`/v1/responses`, `/v1/conversations*`, `/v1/events`, plus the
sidekick gateway extension `/v1/gateway/conversations`,
`/v1/settings/*`, `/v1/commands`). See the sidekick repo's
[`docs/ABSTRACT_AGENT_PROTOCOL.md`](../../../docs/ABSTRACT_AGENT_PROTOCOL.md)
for the canonical reference.

This directory contains the **plugin source**. Installing it is opt-in.

The module docstring at the top of `__init__.py` is the authoritative
envelope catalogue + adapter surface reference. Read it before
modifying the plugin.

## Highlights

- Owns the `chat_id → session_id` resolution against hermes' state.db.
  Sessions rotate (compression, manual `/reset`); the read path walks
  rotations transparently so the drawer + transcript stay coherent.
- Emits the cross-device `user_message` broadcast on every
  `POST /v1/responses` so other connected PWA tabs render the user's
  bubble immediately. PWA's pre-minted `user_message_id` is the
  dedup key for the originating tab.
- Persists agent-declared settings (`/v1/settings/*`) back to
  `~/.hermes/config.yaml` under the `sidekick:` namespace so changes
  survive restarts and agree across CLI + PWA.
- Slash-command catalog (`/v1/commands`) wraps the hermes-cli
  registry; categories `cli_only` are filtered out (PWA can't
  exercise terminal affordances).
- Cross-platform drawer (`/v1/gateway/conversations`) — telegram /
  slack / whatsapp sessions surface alongside sidekick's own with a
  source badge.

## Files

| File | Purpose |
|------|---------|
| `__init__.py` | The adapter — `BasePlatformAdapter` subclass + aiohttp HTTP server speaking the agent contract. The plugin loader walks `<plugin-dir>/__init__.py`. |
| `plugin.yaml` | Hermes plugin manifest. |
| `0001-add-sidekick-platform.patch` | Required `hermes-agent` patch (see below). |

## Install

Hermes' plugin loader doesn't currently support registering a new
platform adapter via `PluginContext` (the API exposes hooks, tools, slash
commands, etc — not platform registration). Until upstream issue
[hermes-agent#3823](https://github.com/.../issues/3823) lands, the
adapter must be registered by patching the gateway directly. The plugin
files still load through the normal plugin loader; only the
`Platform.SIDEKICK` enum + `_create_adapter` factory branch live in the
patch.

```bash
# 1. Patch hermes-agent.
cd <your hermes-agent install>
patch -p1 < <path-to-this-dir>/0001-add-sidekick-platform.patch

# 2. Install the plugin (symlink so edits in the sidekick repo land
#    immediately in ~/.hermes/plugins/ without a re-copy).
rm -rf ~/.hermes/plugins/sidekick
ln -s <path-to-this-dir> ~/.hermes/plugins/sidekick

# 3. Enable in ~/.hermes/config.yaml:
#    plugins:
#      enabled:
#        - sidekick

# 4. Auth token + (optional) port in ~/.hermes/.env:
echo "SIDEKICK_PLATFORM_TOKEN=$(openssl rand -hex 32)" >> ~/.hermes/.env
# echo 'SIDEKICK_PLATFORM_PORT=8645' >> ~/.hermes/.env  # default

# 5. Restart the gateway.
```

The same `SIDEKICK_PLATFORM_TOKEN` value goes into the sidekick proxy
config so the proxy's WebSocket client can authenticate.

## Smoke test

With the plugin running, in another terminal:

```bash
SIDEKICK_PLATFORM_TOKEN=<the-token> python3 wscat-test.py \
    --chat-id test-conv-1 \
    --text "count to 5"
```

Expected: a `hello` envelope, then streaming `reply_delta` envelopes,
then `reply_final`.

## Wire protocol

HTTP+SSE on `:8645` (default; configurable via
`SIDEKICK_PLATFORM_PORT`). Endpoints listed in the top-level
[`README.md`](../../../README.md) endpoint inventory; full details
in the module docstring at the top of `__init__.py`.

Auth: `Authorization: Bearer <SIDEKICK_PLATFORM_TOKEN>` on every
request. Same token goes into the sidekick proxy's
`SIDEKICK_PLATFORM_TOKEN` env so the proxy can authenticate as a
client.

## Known limitations

* `reply_to` threading is ignored on outbound — sidekick has no thread
  primitive in the PWA today.
