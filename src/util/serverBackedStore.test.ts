/**
 * @fileoverview Deterministic race tests for ServerBackedStore's
 * stale-snapshot guards (the zombie-resurrection bug: a refresh GET
 * racing a local delete re-applied the pre-delete snapshot, and the
 * firstServerHydrate push-up then un-deleted it server-side).
 *
 * The activity smoke only hit these windows ~50% of the time. Here a
 * fake fetch holds every request open until the test resolves it, so
 * each of the three guard windows is forced exactly:
 *   (a) GET issued before a local commit() → mutationEpoch changed
 *   (b) GET response arrives while a write is in flight → pendingWrites > 0
 *   (c) write starts AND settles entirely within the GET's flight →
 *       writesSettled changed (pendingWrites back to 0 — the subtle one)
 * A discarded snapshot must also reschedule a refresh so the store
 * converges once writes go quiet.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ServerBackedStore, type ServerBackedStoreConfig } from './serverBackedStore.ts';

type Item = { id: string; v: number };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function snapshot(items: Array<{ id: string; v?: number }>): Response {
  return { ok: true, json: async () => ({ items }) } as unknown as Response;
}

/** Fake fetch: every call is held open until the test resolves it. */
function fetchController() {
  const calls: Array<{ url: string; init?: RequestInit; d: ReturnType<typeof deferred<Response>> }> = [];
  const fetchImpl = ((url: unknown, init?: RequestInit) => {
    const d = deferred<Response>();
    calls.push({ url: String(url), init, d });
    return d.promise;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function makeStore(
  fetchImpl: typeof fetch,
  logs: string[],
  extra: Partial<ServerBackedStoreConfig<Item>> = {},
) {
  return new ServerBackedStore<Item>({
    storageKey: null, // node has no localStorage; race guards are in-memory
    endpoint: '/api/test/items',
    extract: (d) => d.items ?? [],
    parse: (raw) => (raw && typeof raw.id === 'string' ? { id: raw.id, v: raw.v ?? 0 } : null),
    idOf: (i) => i.id,
    changeEvent: 'test:items-changed',
    debounceMs: 1,
    fetchImpl,
    log: (m) => logs.push(m),
    ...extra,
  });
}

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

/** Seed the store with [a, b] via one clean refresh. */
async function seed(store: ServerBackedStore<Item>, calls: ReturnType<typeof fetchController>['calls']) {
  const p = store.refreshFromServer();
  assert.equal(calls.length, 1);
  calls[0].d.resolve(snapshot([{ id: 'a' }, { id: 'b' }]));
  await p;
  assert.deepEqual([...store.items.keys()].sort(), ['a', 'b']);
}

describe('ServerBackedStore stale-snapshot guards', () => {
  it('baseline: clean refresh applies the snapshot and does not reschedule', async () => {
    const { calls, fetchImpl } = fetchController();
    const logs: string[] = [];
    const store = makeStore(fetchImpl, logs);
    await seed(store, calls);
    await tick();
    assert.equal(calls.length, 1, 'no rescheduled refresh after a clean apply');
    assert.ok(!logs.some((l) => l.includes('discarded')));
  });

  it('guard (a): commit() during the GET flight discards the stale snapshot', async () => {
    const { calls, fetchImpl } = fetchController();
    const logs: string[] = [];
    const store = makeStore(fetchImpl, logs);
    await seed(store, calls);

    const p = store.refreshFromServer(); // GET #2 held open
    store.items.delete('b'); // optimistic local delete...
    store.commit(); // ...bumps mutationEpoch mid-flight
    calls[1].d.resolve(snapshot([{ id: 'a' }, { id: 'b' }])); // pre-delete zombie snapshot
    await p;

    assert.deepEqual([...store.items.keys()], ['a'], 'zombie b must NOT resurrect');
    assert.ok(logs.some((l) => l.includes('refresh discarded')), 'went through the guard, not equality');

    // Discard reschedules; the rescheduled GET converges on fresh state.
    await tick();
    assert.equal(calls.length, 3, 'discard reschedules a refresh');
    calls[2].d.resolve(snapshot([{ id: 'a' }]));
    await tick();
    assert.deepEqual([...store.items.keys()], ['a']);
  });

  it('guard (b): GET response while a write is in flight is discarded', async () => {
    const { calls, fetchImpl } = fetchController();
    const logs: string[] = [];
    const store = makeStore(fetchImpl, logs);
    await seed(store, calls);

    // Local delete + commit BEFORE the GET starts, so mutationEpoch is
    // stable during the flight — isolates the pendingWrites guard.
    store.items.delete('b');
    store.commit();

    const write = deferred<void>();
    const writeP = store.trackWrite(() => write.promise); // DELETE in flight

    const p = store.refreshFromServer(); // GET #2
    calls[1].d.resolve(snapshot([{ id: 'a' }, { id: 'b' }])); // server hasn't seen the DELETE yet
    await p;

    assert.deepEqual([...store.items.keys()], ['a'], 'zombie b must NOT resurrect');
    assert.ok(logs.some((l) => l.includes('pendingWrites 1')), 'discarded via the in-flight-write guard');

    write.resolve();
    await writeP;
    await tick();
    assert.equal(calls.length, 3, 'discard rescheduled a refresh');
    calls[2].d.resolve(snapshot([{ id: 'a' }]));
    await tick();
    assert.deepEqual([...store.items.keys()], ['a']);
  });

  it('guard (c): write that starts AND settles within the GET flight is still caught', async () => {
    const { calls, fetchImpl } = fetchController();
    const logs: string[] = [];
    const store = makeStore(fetchImpl, logs);
    await seed(store, calls);

    store.items.delete('b');
    store.commit(); // epoch bumped BEFORE the GET → guard (a) can't fire

    const p = store.refreshFromServer(); // GET #2 held open
    // The DELETE runs to completion while the GET is in flight:
    // pendingWrites is back to 0 by response time — only writesSettled
    // betrays the race.
    await store.trackWrite(async () => {});
    calls[1].d.resolve(snapshot([{ id: 'a' }, { id: 'b' }]));
    await p;

    assert.deepEqual([...store.items.keys()], ['a'], 'zombie b must NOT resurrect');
    assert.ok(logs.some((l) => /settled 0→1/.test(l)), 'discarded via the writesSettled guard');
  });

  it('postJson runs under the write tracker (a racing GET gets discarded)', async () => {
    const { calls, fetchImpl } = fetchController();
    const logs: string[] = [];
    const store = makeStore(fetchImpl, logs);
    await seed(store, calls);

    const postP = store.postJson('/api/test/items', { id: 'c' }); // call #2, held open
    const refreshP = store.refreshFromServer(); // call #3
    assert.equal(calls.length, 3);
    calls[2].d.resolve(snapshot([{ id: 'a' }, { id: 'b' }])); // snapshot without c
    await refreshP;

    assert.ok(logs.some((l) => l.includes('refresh discarded')), 'POST in flight forces a discard');

    calls[1].d.resolve({ ok: true } as unknown as Response);
    await postP;
  });

  it('discarded snapshots converge: refresh applies once writes go quiet', async () => {
    const { calls, fetchImpl } = fetchController();
    const logs: string[] = [];
    const store = makeStore(fetchImpl, logs);
    await seed(store, calls);

    const p = store.refreshFromServer();
    store.items.delete('b');
    store.commit(); // mid-flight → discard + reschedule
    calls[1].d.resolve(snapshot([{ id: 'a' }, { id: 'b' }]));
    await p;
    await tick(); // rescheduled GET #3 fires

    // Server has now caught up; no writes in flight → snapshot applies.
    calls[2].d.resolve(snapshot([{ id: 'a' }, { id: 'c' }]));
    await tick();
    assert.deepEqual([...store.items.keys()].sort(), ['a', 'c']);
    assert.ok(logs.some((l) => l.includes('refresh applied')));
  });

  it('reconcile returning "skip" aborts the apply', async () => {
    const { calls, fetchImpl } = fetchController();
    const logs: string[] = [];
    const store = makeStore(fetchImpl, logs, {
      reconcile: (_next, _current, ctx) => (ctx.firstServerHydrate ? 'skip' : undefined),
    });
    const p = store.refreshFromServer();
    calls[0].d.resolve(snapshot([{ id: 'a' }]));
    await p;
    assert.equal(store.items.size, 0, 'skip must leave items untouched');

    // Second refresh is no longer firstServerHydrate → applies.
    const p2 = store.refreshFromServer();
    calls[1].d.resolve(snapshot([{ id: 'a' }]));
    await p2;
    assert.deepEqual([...store.items.keys()], ['a']);
  });
});
