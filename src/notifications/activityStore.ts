import { log } from '../util/log.ts';

export type ActivityKind = 'approval' | 'cron' | 'agent_reply' | 'notification';
export type ActivityResolution = 'approved' | 'approved_session' | 'denied' | 'dismissed';

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
}

function normalizeKind(kind: unknown): ActivityKind {
  if (kind === 'approval' || kind === 'cron' || kind === 'agent_reply') return kind;
  return 'notification';
}

function normalizeResolution(x: unknown): ActivityResolution | undefined {
  if (x === 'approved' || x === 'approved_session' || x === 'denied' || x === 'dismissed') return x;
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
  itemsById.set(id, { ...item, read: true });
  persist();
  notifyChange();
}

export function resolveActivity(id: string, resolution: ActivityResolution): void {
  hydrate();
  const item = itemsById.get(id);
  if (!item) return;
  itemsById.set(id, { ...item, read: true, resolved: resolution });
  persist();
  notifyChange();
}

export function dismissActivity(id: string): void {
  hydrate();
  if (!itemsById.delete(id)) return;
  persist();
  notifyChange();
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
