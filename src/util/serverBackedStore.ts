// Server-SSOT read-through collection store.
//
// Extracted from the two hand-rolled implementations that had drifted
// (activityStore.ts + pins/store.ts). They were structurally the same
// store — in-memory Map mirror, optimistic local writes, diff-aware
// notify, debounced background refresh, a CustomEvent to drive repaint
// — but pins silently omitted the localStorage perf cache, so a cold
// relaunch left the pin drawer empty until the network returned. That
// omission is exactly why this base exists: persistence is the DEFAULT
// here, so a future collection store can't forget it and silently
// regress boot perf.
//
// The server remains the source of truth. localStorage is ONLY a
// perf cache for instant first paint: hydrate() loads it synchronously
// (well, the read is sync) so the UI paints from cache, then
// refreshFromServer() reconciles against the canonical server state and
// repaints only if something actually changed. Clearing localStorage
// must never lose data — the server still has it.
//
// Domain-specific reconciliation (e.g. activity's "carry pending
// approvals" / "first-hydrate migration push") lives in the per-store
// `reconcile` hook, not here.

import { apiUrl } from '../apiBase.ts';

export interface ServerBackedStoreConfig<T> {
  /** localStorage key for the perf cache. null disables persistence. */
  storageKey: string | null;
  /** GET endpoint (app-absolute path) for the canonical server snapshot. */
  endpoint: string;
  /** Optional fetch init for the GET (e.g. { cache: 'no-store' }). */
  fetchInit?: RequestInit;
  /** Pull the array of raw records out of the server JSON response. */
  extract: (data: any) => any[];
  /** Normalize + validate a raw record (from server OR localStorage) into
   *  T. Return null to skip. Used for BOTH paths so stored and fetched
   *  records normalize identically. */
  parse: (raw: any) => T | null;
  /** Stable id for a T. */
  idOf: (item: T) => string;
  /** CustomEvent dispatched on local change — drives the UI repaint. */
  changeEvent: string;
  /** CustomEvent observed for cross-device server pushes; fires a
   *  debounced refresh when seen. */
  serverChangeEvent?: string;
  /** Also refresh when the page returns to the foreground (iOS PWA can
   *  come back after a long background). */
  refreshOnVisible?: boolean;
  /** Debounce window coalescing refresh triggers (ms). Default 200. */
  debounceMs?: number;
  /** Equality for diff-aware notify. Default: size + per-item JSON
   *  compare. Override when only some fields matter. */
  equal?: (current: Map<string, T>, next: Map<string, T>) => boolean;
  /** Cap persisted entries to the top-N after persistSort. */
  persistCap?: number;
  /** Sort applied before persistCap + serialize. */
  persistSort?: (a: T, b: T) => number;
  /** Domain reconcile hook. Runs after `next` is built from the server,
   *  before the diff/apply. May MUTATE `next`. Return 'skip' to abort the
   *  apply entirely (e.g. a first-hydrate migration that pushes local
   *  state UP to an empty server and waits for the next refresh). */
  reconcile?: (
    next: Map<string, T>,
    current: Map<string, T>,
    ctx: { firstServerHydrate: boolean },
  ) => 'skip' | void;
  /** One-time synchronous setup, run the first time hydrate()/refresh
   *  loads (after the localStorage read). For intervals, test seams, etc. */
  onFirstHydrate?: () => void;
  /** Logger for best-effort failures. */
  log?: (msg: string) => void;
}

export class ServerBackedStore<T> {
  /** In-memory mirror — the synchronous source of truth for renders.
   *  Domain modules read and (optimistically) mutate this directly, then
   *  call commit(). */
  readonly items = new Map<string, T>();

  private hydrated = false;
  private serverHydrated = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cfg: ServerBackedStoreConfig<T>;

  constructor(cfg: ServerBackedStoreConfig<T>) {
    this.cfg = cfg;
    if (typeof window !== 'undefined') {
      if (cfg.serverChangeEvent) {
        window.addEventListener(cfg.serverChangeEvent, () => this.requestRefresh());
      }
      if (cfg.refreshOnVisible) {
        document?.addEventListener?.('visibilitychange', () => {
          if (document.visibilityState === 'visible') this.requestRefresh();
        });
      }
    }
  }

  /** Idempotent. Loads the localStorage cache for instant paint, runs
   *  one-time setup, then kicks a background server refresh. */
  hydrate(): void {
    if (this.ensureLocal()) void this.refreshFromServer();
  }

  /** Loads localStorage + runs onFirstHydrate exactly once. Returns true
   *  on the first call so the caller can decide whether to kick a refresh.
   *  Deliberately does NOT trigger a refresh itself, so refreshFromServer
   *  can call it without recursing. */
  private ensureLocal(): boolean {
    if (this.hydrated) return false;
    this.hydrated = true;
    this.loadFromStorage();
    try { this.cfg.onFirstHydrate?.(); } catch (e: any) { this.cfg.log?.(`onFirstHydrate failed: ${e?.message ?? e}`); }
    return true;
  }

  private loadFromStorage(): void {
    if (!this.cfg.storageKey || typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(this.cfg.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const x of parsed) {
        const item = this.cfg.parse(x);
        if (item) this.items.set(this.cfg.idOf(item), item);
      }
    } catch (e: any) {
      this.cfg.log?.(`hydrate failed: ${e?.message ?? e}`);
    }
  }

  /** Fetch the canonical server snapshot and reconcile. Only persists +
   *  notifies when the reconciled state actually differs (repaint-storm
   *  guard). */
  async refreshFromServer(): Promise<void> {
    this.ensureLocal();
    try {
      const r = await fetch(apiUrl(this.cfg.endpoint), this.cfg.fetchInit);
      if (!r.ok) return;
      const data = await r.json();
      const next = new Map<string, T>();
      for (const raw of this.cfg.extract(data)) {
        const item = this.cfg.parse(raw);
        if (item) next.set(this.cfg.idOf(item), item);
      }
      const firstServerHydrate = !this.serverHydrated;
      this.serverHydrated = true;
      if (this.cfg.reconcile?.(next, this.items, { firstServerHydrate }) === 'skip') return;
      if (this.isEqual(this.items, next)) return;
      this.items.clear();
      for (const [k, v] of next) this.items.set(k, v);
      this.persist();
      this.notifyChange();
    } catch (e: any) {
      if (!this.serverHydrated) this.cfg.log?.(`server hydrate failed: ${e?.message ?? e}`);
    }
  }

  /** Debounced refresh — coalesces bursts of cross-device sync envelopes
   *  into one fetch. */
  requestRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshFromServer();
    }, this.cfg.debounceMs ?? 200);
  }

  /** Persist the perf cache + fire the change event. Call after a direct
   *  (optimistic) mutation of `items`. */
  commit(): void {
    this.persist();
    this.notifyChange();
  }

  notifyChange(): void {
    try {
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent(this.cfg.changeEvent));
      }
    } catch { /* non-DOM hosts (test runner) */ }
  }

  /** Convenience POST helper for domain mutation paths that mirror to the
   *  server fire-and-forget. */
  async postJson(path: string, body: Record<string, unknown>): Promise<void> {
    try {
      const r = await fetch(apiUrl(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) this.cfg.log?.(`POST ${path} failed: HTTP ${r.status}`);
    } catch (e: any) {
      this.cfg.log?.(`POST ${path} failed: ${e?.message ?? e}`);
    }
  }

  private persist(): void {
    if (!this.cfg.storageKey || typeof localStorage === 'undefined') return;
    try {
      let arr = Array.from(this.items.values());
      if (this.cfg.persistSort) arr = arr.sort(this.cfg.persistSort);
      if (this.cfg.persistCap != null) arr = arr.slice(0, this.cfg.persistCap);
      localStorage.setItem(this.cfg.storageKey, JSON.stringify(arr));
    } catch (e: any) {
      this.cfg.log?.(`persist failed: ${e?.message ?? e}`);
    }
  }

  private isEqual(current: Map<string, T>, next: Map<string, T>): boolean {
    if (this.cfg.equal) return this.cfg.equal(current, next);
    if (current.size !== next.size) return false;
    for (const [id, item] of next) {
      if (JSON.stringify(current.get(id)) !== JSON.stringify(item)) return false;
    }
    return true;
  }
}
