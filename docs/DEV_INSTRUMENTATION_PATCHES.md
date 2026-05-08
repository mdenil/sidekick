# Hand-applied node_modules instrumentation patches

This file documents patches that live INSIDE `node_modules/` for diagnostic
instrumentation. They do NOT survive `npm ci` / `npm install`. If you reinstall
deps and lose the field traces, re-apply the diffs below.

These patches gate behind `?dictate-debug=1` / `?debug-relay=1` in practice
because they only push to `window.__MICVAD_TRACE_BUF__`, which is flushed by
`src/audio/shared/speechVad/index.ts`'s flush loop — and that flush only runs
when the VAD path is hot. Smokes / playwright don't enable the flag, so these
traces are silent in CI and on regular user pageloads.

---

## `node_modules/@ricky0123/vad-web/dist/real-time-vad.js`

Adds `[micvad-trace]` lines around `MicVAD.new()`, `model-fetch-start/end`,
`startOnLoad-await-start/resolved`. Routes through `window.__MICVAD_TRACE_BUF__`
plus console.log so `speechVad/index.ts` can flush on watchdog timeout.

Originally added as v3 of the trace patch (Jonathan, 2026-05-04..05). Verbatim
diff is large; see `git log -p -- 'silver/notes/notes_session_2026_05_06_barge.md'`
for prior context. Phase strings emitted: `new() entered`, `model-fetch-start`,
`model-fetch-end`, `model-fetch-failed`, `startOnLoad-await-start`,
`startOnLoad-resolved`, `startOnLoad-failed`, `new() returning`.

---

## `node_modules/@ricky0123/vad-web/dist/models/legacy.js`

Adds `[micvad-trace] silero/<phase>` lines around `SileroLegacy.new`'s
inner steps. v4 of the trace patch (Jonathan, 2026-05-05). Phase strings:
`silero/entered`, `silero/modelFetcher-start`, `silero/modelFetcher-end`,
`silero/InferenceSession.create-start`, `silero/InferenceSession.create-end`,
`silero/tensors-created`, `silero/model-constructed`.

---

## `node_modules/@ricky0123/vad-web/dist/default-model-fetcher.js`

Added 2026-05-08 to localize the 15s Mac Chrome hang. The default upstream
is a one-liner; replaced with a phase-traced version emitting:
`[micvad-trace] modelFetcher/fetch-start path=...`,
`modelFetcher/fetch-headers status=N type=...`,
`modelFetcher/arrayBuffer-end bytes=N`,
`modelFetcher/failed name: msg`.

```js
const defaultModelFetcher = (path) => {
    const _t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    const _logTrace = (e) => {
        const ms = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - _t0));
        const line = `[micvad-trace] +${ms}ms modelFetcher/${e}`;
        try { console.log(line); } catch {}
        try {
            if (typeof window !== 'undefined') {
                window.__MICVAD_TRACE_BUF__ = window.__MICVAD_TRACE_BUF__ || [];
                window.__MICVAD_TRACE_BUF__.push(line);
            }
        } catch {}
    };
    _logTrace(`fetch-start path=${path}`);
    return fetch(path)
        .then((model) => {
            _logTrace(`fetch-headers status=${model.status} type=${model.type} ok=${model.ok} cache=${model.headers?.get?.('x-cache') || 'n/a'}`);
            return model.arrayBuffer();
        })
        .then((buf) => {
            _logTrace(`arrayBuffer-end bytes=${buf?.byteLength ?? '?'}`);
            return buf;
        })
        .catch((e) => {
            _logTrace(`failed ${e?.name || 'err'}: ${e?.message || e}`);
            throw e;
        });
};
exports.defaultModelFetcher = defaultModelFetcher;
```

---

## When to remove these patches

Once the Mac Chrome MicVAD hang is diagnosed and either fixed or
deterministically routed away from (e.g. force `vad=bridge` on Mac Chrome
permanently), strip all three patches. Track via the corresponding trace
strings — `git grep micvad-trace` should return zero hits in `node_modules`
and only the flusher in `src/audio/shared/speechVad/index.ts`.

Long-term, if these traces prove durable, migrate to a `patch-package`
postinstall hook so they survive reinstalls.
