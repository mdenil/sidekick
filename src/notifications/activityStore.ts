import { log } from '../util/log.ts';

export type ActivityKind = 'approval' | 'cron' | 'agent_reply' | 'notification';
export type ActivityResolution = 'approved' | 'approved_session' | 'denied' | 'dismissed' | 'stale';

export interface ActivityItem {
  id: string;
  chatId: string | null;
  kind: ActivityKind;
  title: string;
  body: string;
  createdAt: number;
  urgent: boolean;
  read: boolean;
  messageId?: string | null;
  resolved?: ActivityResolution;
}

const STORAGE_KEY = 'sidekick.activity.items.v1';
const itemsById = new Map<string, ActivityItem>();
let hydrated = false;
let serverHydrated = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function notifyChange(): void {
  try {
    window.dispatchEvent(new CustomEvent('sidekick:activity-changed'));
  } catch { /* non-DOM hosts */ }
}

function persist(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const items = Array.from(itemsById.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 200);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch (e: any) {
    log(`[activity] persist failed: ${e?.message ?? e}`);
  }
}

export function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  // Periodic stale-approval check (every 60s). Production threshold is
  // 30 min; the tick interval is much smaller so a freshly-staled approval
  // ages out within a minute, not whenever the user next opens the tray.
  // Smokes don't rely on this — they call the test seam directly — so a
  // long interval is fine. Safe to start once at hydrate.
  if (typeof window !== 'undefined' && typeof setInterval === 'function') {
    setInterval(runApprovalStaleCheck, 60_000);
    // Test seams: exposed on window so the smoke can drive the check
    // deterministically (set a small threshold + fire the check now).
    (window as any).__sidekickSetApprovalStaleMsForTest = setApprovalStaleMsForTest;
    (window as any).__sidekickRunApprovalStaleCheckForTest = runApprovalStaleCheck;
  }
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const x of parsed) {
      if (!x || typeof x.id !== 'string' || !x.id) continue;
      itemsById.set(x.id, {
        id: x.id,
        chatId: typeof x.chatId === 'string' ? x.chatId : null,
        kind: normalizeKind(x.kind),
        title: typeof x.title === 'string' ? x.title : 'Notification',
        body: typeof x.body === 'string' ? x.body : '',
        createdAt: typeof x.createdAt === 'number' ? x.createdAt : Date.now(),
        urgent: x.urgent === true,
        read: x.read === true,
        messageId: typeof x.messageId === 'string' ? x.messageId : null,
        resolved: normalizeResolution(x.resolved),
      });
    }
  } catch (e: any) {
    log(`[activity] hydrate failed: ${e?.message ?? e}`);
  }
  void refreshFromServer();
}

function normalizeItem(x: any): ActivityItem | null {
  if (!x || typeof x.id !== 'string' || !x.id) return null;
  const rawCreated = typeof x.createdAt === 'number' ? x.createdAt : Date.now();
  return {
    id: x.id,
    chatId: typeof x.chatId === 'string' ? x.chatId : null,
    kind: normalizeKind(x.kind),
    title: typeof x.title === 'string' ? x.title : 'Notification',
    body: typeof x.body === 'string' ? x.body : '',
    createdAt: rawCreated < 10_000_000_000 ? rawCreated * 1000 : rawCreated,
    urgent: x.urgent === true,
    read: x.read === true,
    messageId: typeof x.messageId === 'string' ? x.messageId : null,
    resolved: normalizeResolution(x.resolved),
  };
}

function payloadForServer(item: ActivityItem): Record<string, unknown> {
  return {
    id: item.id,
    chat_id: item.chatId,
    kind: item.kind,
    title: item.title,
    body: item.body,
    created_at: item.createdAt / 1000,
    urgent: item.urgent,
    read: item.read,
    message_id: item.messageId || null,
    resolved: item.resolved || null,
  };
}

async function postJson(path: string, body: Record<string, unknown>): Promise<void> {
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) log(`[activity] POST ${path} failed: HTTP ${r.status}`);
  } catch (e: any) {
    log(`[activity] POST ${path} failed: ${e?.message ?? e}`);
  }
}

export async function refreshFromServer(): Promise<void> {
  hydrate();
  try {
    const r = await fetch('/api/sidekick/activity?limit=200', { cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    const next = new Map<string, ActivityItem>();
    for (const raw of (Array.isArray(data?.items) ? data.items : [])) {
      const item = normalizeItem(raw);
      if (item) next.set(item.id, item);
    }
    // Preserve freshly-arrived, still-unresolved approvals the server
    // snapshot doesn't know about yet. A pending approval is added to the
    // local store SYNCHRONOUSLY by upsertNotification, but its POST to
    // /api/sidekick/activity is fire-and-forget. The server ALSO emits an
    // `activity_changed` cross-device sync the moment it records the
    // approval, which fires `refreshFromServer` here. If this GET races
    // ahead of our own POST (or of the server's own write), the snapshot
    // lacks the approval — and the wholesale `itemsById.clear()` below
    // would wipe the pending/actionable row out from under the user before
    // they can tap Approve/Deny. Carrying the local-only pending approval
    // into `next` keeps the row visible + actionable; the following
    // refresh (after the POST round-trips) reconciles it from the server
    // with consistent state. We only ever carry UNRESOLVED approvals: a
    // resolved/dismissed row lives on the server and reflects normally, so
    // this never resurrects a decided approval.
    for (const [id, item] of itemsById) {
      if (item.kind === 'approval' && !item.resolved && !next.has(id)) {
        next.set(id, item);
      }
    }
    pruneSupersededApprovals(next);
    const firstServerHydrate = !serverHydrated;
    serverHydrated = true;
    if (firstServerHydrate && next.size === 0 && itemsById.size > 0) {
      for (const item of itemsById.values()) {
        void postJson('/api/sidekick/activity', payloadForServer(item));
      }
      return;
    }
    let changed = next.size !== itemsById.size;
    if (!changed) {
      for (const [id, item] of next) {
        if (JSON.stringify(itemsById.get(id)) !== JSON.stringify(item)) { changed = true; break; }
      }
    }
    if (!changed) return;
    itemsById.clear();
    for (const [id, item] of next) itemsById.set(id, item);
    persist();
    notifyChange();
  } catch (e: any) {
    if (!serverHydrated) log(`[activity] server hydrate failed: ${e?.message ?? e}`);
  }
}

function requestRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshFromServer();
  }, 150);
}

function pruneSupersededApprovals(items: Map<string, ActivityItem>): void {
  // "Agent moved on" — any unresolved approval that has a newer
  // non-approval item for the same chat gets resolved as 'dismissed'.
  // Used to delete the row outright; now marks it resolved so the user
  // can still see "we asked for approval here, the agent moved past it"
  // in the tray history with a Dismissed pill (2026-05-28 keep-with-pill
  // model).
  const newestByChat = new Map<string, number>();
  for (const item of items.values()) {
    if (!item.chatId || item.kind === 'approval') continue;
    newestByChat.set(item.chatId, Math.max(newestByChat.get(item.chatId) ?? 0, item.createdAt));
  }
  for (const [id, item] of Array.from(items.entries())) {
    if (item.kind !== 'approval' || item.resolved || !item.chatId) continue;
    const newer = newestByChat.get(item.chatId) ?? 0;
    if (newer > item.createdAt) {
      items.set(id, { ...item, read: true, resolved: 'dismissed' });
      void postJson('/api/sidekick/activity/resolve', { id, resolution: 'dismissed' });
    }
  }
}

function normalizeKind(kind: unknown): ActivityKind {
  if (kind === 'approval' || kind === 'cron' || kind === 'agent_reply') return kind;
  return 'notification';
}

function normalizeResolution(x: unknown): ActivityResolution | undefined {
  if (x === 'approved' || x === 'approved_session' || x === 'denied' || x === 'dismissed' || x === 'stale') return x;
  return undefined;
}

function titleFor(kind: ActivityKind, chatLabel?: string): string {
  if (kind === 'approval') return chatLabel ? `Approval required · ${chatLabel}` : 'Approval required';
  if (kind === 'cron') return chatLabel ? `Cron · ${chatLabel}` : 'Cron';
  if (kind === 'agent_reply') return chatLabel ? `Reply · ${chatLabel}` : 'Agent reply';
  return chatLabel || 'Notification';
}

export function upsertNotification(args: {
  chatId: string | null;
  kind: string;
  content: string;
  sidekickId?: string | null;
  urgent?: boolean;
  chatLabel?: string | null;
}): ActivityItem | null {
  hydrate();
  const kind = normalizeKind(args.kind);
  if (kind !== 'approval' && kind !== 'cron' && kind !== 'agent_reply') return null;
  const id = args.sidekickId || `${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const prev = itemsById.get(id);
  const item: ActivityItem = {
    id,
    chatId: args.chatId,
    kind,
    title: prev?.title || titleFor(kind, args.chatLabel || undefined),
    body: args.content || prev?.body || '',
    createdAt: prev?.createdAt || Date.now(),
    urgent: args.urgent === true || kind === 'approval',
    read: prev?.read ?? false,
    messageId: args.sidekickId || prev?.messageId || null,
    resolved: prev?.resolved,
  };
  itemsById.set(id, item);
  persist();
  notifyChange();
  void postJson('/api/sidekick/activity', payloadForServer(item));
  return item;
}

export function listActivity(): ActivityItem[] {
  hydrate();
  return Array.from(itemsById.values()).sort((a, b) => {
    const au = a.kind === 'approval' && !a.resolved ? 1 : 0;
    const bu = b.kind === 'approval' && !b.resolved ? 1 : 0;
    if (au !== bu) return bu - au;
    return b.createdAt - a.createdAt;
  });
}

export function unresolvedApprovalCount(): number {
  hydrate();
  let n = 0;
  for (const item of itemsById.values()) {
    if (item.kind === 'approval' && !item.resolved) n++;
  }
  return n;
}

export function unreadActivityCount(): number {
  hydrate();
  let n = 0;
  for (const item of itemsById.values()) {
    if (!item.read && !item.resolved) n++;
  }
  return n;
}

export function markRead(id: string): void {
  hydrate();
  const item = itemsById.get(id);
  if (!item || item.read) return;
  const next = { ...item, read: true };
  itemsById.set(id, next);
  persist();
  notifyChange();
  void postJson('/api/sidekick/activity', payloadForServer(next));
}

export function dismissApprovalsForChat(chatId: string): void {
  hydrate();
  if (!chatId) return;
  let changed = false;
  for (const [id, item] of Array.from(itemsById.entries())) {
    if (item.chatId !== chatId || item.kind !== 'approval' || item.resolved) continue;
    itemsById.delete(id);
    changed = true;
    void fetch(`/api/sidekick/activity/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  }
  if (changed) {
    persist();
    notifyChange();
  }
}

/** Mark every unresolved approval for `chatId` as resolved with the given
 *  outcome. Replaces the destructive `dismissApprovalsForChat` on every
 *  caller that knows the outcome: user-action paths pass 'approved' /
 *  'approved_session' / 'denied'; the "agent moved on" path passes
 *  'dismissed'; the stale-check path passes 'stale'. Resolved approvals
 *  STAY in the tray with their outcome pill — the row is the user-visible
 *  audit trail of "what I (or the agent) decided, and when." */
export function resolveApprovalsForChat(chatId: string, resolution: ActivityResolution): void {
  hydrate();
  if (!chatId) return;
  let changed = false;
  for (const [id, item] of Array.from(itemsById.entries())) {
    if (item.chatId !== chatId || item.kind !== 'approval' || item.resolved) continue;
    itemsById.set(id, { ...item, read: true, resolved: resolution });
    changed = true;
    void postJson('/api/sidekick/activity/resolve', { id, resolution });
  }
  if (changed) {
    persist();
    notifyChange();
  }
}

/** Stale-approval auto-resolution. Production threshold = 30 minutes;
 *  smokes override via `setApprovalStaleMsForTest`. Resolves any unresolved
 *  approval whose `createdAt` is older than the threshold to 'stale' so
 *  the tray doesn't accumulate forgotten pending approvals. Sticky once
 *  resolved (won't re-pend on later chat activity — `item.resolved` gate
 *  in `resolveApprovalsForChat` and elsewhere). */
const APPROVAL_STALE_MS_DEFAULT = 30 * 60 * 1000;
let approvalStaleMs = APPROVAL_STALE_MS_DEFAULT;

export function runApprovalStaleCheck(): void {
  hydrate();
  const now = Date.now();
  let changed = false;
  for (const [id, item] of Array.from(itemsById.entries())) {
    if (item.kind !== 'approval' || item.resolved) continue;
    if (now - item.createdAt < approvalStaleMs) continue;
    itemsById.set(id, { ...item, read: true, resolved: 'stale' });
    changed = true;
    void postJson('/api/sidekick/activity/resolve', { id, resolution: 'stale' });
  }
  if (changed) {
    persist();
    notifyChange();
  }
}

/** Test seam: shrink the stale window so smokes finish in seconds, not
 *  30 minutes. Only callable from debug mode. Pairs with the smoke's
 *  `window.__sidekickSetApprovalStaleMsForTest`. */
export function setApprovalStaleMsForTest(ms: number): void {
  if (typeof ms !== 'number' || !(ms > 0)) return;
  approvalStaleMs = ms;
}

export function markChatRead(chatId: string): void {
  hydrate();
  if (!chatId) return;
  let changed = false;
  for (const [id, item] of Array.from(itemsById.entries())) {
    if (item.chatId !== chatId || item.read) continue;
    itemsById.set(id, { ...item, read: true });
    changed = true;
  }
  if (changed) {
    persist();
    notifyChange();
  }
  void postJson('/api/sidekick/activity/seen', { chat_id: chatId });
}

export function markAllRead(): void {
  hydrate();
  let changed = false;
  for (const [id, item] of Array.from(itemsById.entries())) {
    if (item.read) continue;
    itemsById.set(id, { ...item, read: true });
    changed = true;
  }
  if (changed) {
    persist();
    notifyChange();
  }
  void postJson('/api/sidekick/activity/seen', { all: true });
}

export function resolveActivity(id: string, resolution: ActivityResolution): void {
  hydrate();
  const item = itemsById.get(id);
  if (!item) return;
  itemsById.set(id, { ...item, read: true, resolved: resolution });
  persist();
  notifyChange();
  void postJson('/api/sidekick/activity/resolve', { id, resolution });
}

export function dismissActivity(id: string): void {
  hydrate();
  if (!itemsById.delete(id)) return;
  persist();
  notifyChange();
  void fetch(`/api/sidekick/activity/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
}

export function clearResolved(): void {
  hydrate();
  let changed = false;
  for (const [id, item] of Array.from(itemsById.entries())) {
    if (item.resolved || item.read) {
      itemsById.delete(id);
      changed = true;
    }
  }
  if (!changed) return;
  persist();
  notifyChange();
}

export function clearDismissible(): void {
  hydrate();
  let changed = false;
  for (const [id, item] of Array.from(itemsById.entries())) {
    if (item.kind === 'approval' && !item.resolved) continue;
    itemsById.delete(id);
    changed = true;
  }
  if (!changed) return;
  persist();
  notifyChange();
  void postJson('/api/sidekick/activity/clear', {});
}

if (typeof window !== 'undefined') {
  window.addEventListener('sidekick:server-activity-changed', () => requestRefresh());
}
