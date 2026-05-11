# scripts/dev-tests/

Ad-hoc real-backend probes. NOT part of the smoke runner; not gated; not
auto-discovered. Run by name during diagnostic sessions when the mocked
harness can't reproduce a field bug.

## What goes here

- One-off Playwright scripts that drive the real PWA against the real
  proxy + real hermes stack.
- Diagnostic captures (e.g. dumping IDB, intercepting /messages
  responses, mutation observers) used to trace a bug back to its
  source.
- Methodology fixtures — preserved repros that document HOW we caught a
  past field bug, so future debug sessions can copy + adapt rather
  than rediscover.

## What does NOT go here

- Regression-gate tests → those go in `scripts/smoke/` with
  `STATUS='implemented'` (mocked) or `STATUS='install-only'` (real
  backend, slow / API-key gated).
- Proxy-layer integration tests → `proxy/sidekick/__tests__/`.

## Running

Each file is self-contained. Invoke directly:

```
SMOKE_CHROMIUM=/home/jscholz/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome \
  node --experimental-strip-types --disable-warning=ExperimentalWarning \
  scripts/dev-tests/real-timer-flow.mjs
```

Scripts share helpers from `../smoke/lib.mjs` but DO NOT install the
mock backend — they hit the live `/api/sidekick/*` surface served by
the running proxy on `:3001`.

## The methodology these scripts encode

When a user reports a field bug and the mocked smoke suite is green:

1. **Write the real-backend repro here first.** Drive the actual user
   flow against the real stack. Capture the precise failure mode (DOM
   state, network payloads, IDB state, console logs).
2. **Identify why the mock didn't catch it.** Usually the mock cheats
   in a way that hides the production timing (e.g. mock-backend
   returning `first_user_message` at POST time instead of post-turn).
3. **Teach the mock the production semantics** so a mocked smoke can
   repro the bug. Add a flag if needed (e.g.
   `mock.setPostTurnPersistence(true)`).
4. **Port the failing assertion into `scripts/smoke/`** as the
   permanent regression gate.
5. **Keep the dev-tests/ script around** as documentation — future
   debug sessions can copy the structure rather than rediscover.

See `~/code/hermes-agent-private/DEVELOPMENT.md` "Test at the right
layer" for context.
