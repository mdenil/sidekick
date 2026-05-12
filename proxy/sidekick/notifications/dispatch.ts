// Push dispatch — fan an envelope out to every stored subscription via
// the web-push library, prune dead subscriptions on the wire, and
// stamp lastUsedAt on success.
//
// Phase 3c. Wired into proxy/sidekick/stream.ts's broadcast path:
// `pushEnvelope` calls `maybeDispatchEnvelope` AFTER broadcasting to
// live SSE subscribers; the gate inside decides whether to actually
// send a push based on type + active-subscriber presence.
//
// Eligibility policy today: `reply_final` and `notification` envelopes
// get pushed when no live SSE subscriber for that chat_id is attached.
// The longer-term goal is a plugin-driven `should_push: true` flag;
// when the plugin lands the flag, replace isPushEligibleType() with a
// flag check. Until then, hardcoded type policy keeps this pure-sidekick.

import webpush from 'web-push';
import { getVapidConfig } from './index.ts';
import {
  listSubscriptions,
  removeSubscription,
  markUsed,
} from './storage.ts';

let vapidApplied = false;

/** Per-subscription send function. The default wraps webpush.sendNotification
 *  (real network call to Apple/FCM/Mozilla relay) and is gated by lazy
 *  setVapidDetails on first call. Tests replace this via __setSenderForTest
 *  so the proxy/dispatch chain can be smoked without hitting external
 *  services AND without needing real (65-byte-decoded) VAPID keys — every
 *  gate decision becomes pinnable.
 *
 *  Errors should throw with `.statusCode` (number) so the dispatch loop's
 *  404/410-prune branch still works. Other failures don't need a statusCode. */
export type PushSender = (
  target: { endpoint: string; keys: { p256dh: string; auth: string } },
  body: string,
  opts: { TTL: number },
) => Promise<void>;

const defaultSender: PushSender = async (target, body, opts) => {
  if (!vapidApplied) {
    const vapid = getVapidConfig();
    if (!vapid) throw new Error('VAPID not configured');
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    vapidApplied = true;
  }
  await webpush.sendNotification(target, body, opts);
};

let sender: PushSender = defaultSender;

/** Cheap configured-vs-not check for the dispatch gate. The real
 *  VAPID-key-validation happens inside defaultSender on first use;
 *  a mocked sender bypasses it entirely. */
function ensureConfigured(): boolean {
  return getVapidConfig() !== null;
}

/** Test-only seam: swap the sender for a stub. Production never calls
 *  this. Returns a restore-callback for symmetry with patch/unpatch
 *  patterns elsewhere. */
export function __setSenderForTest(fn: PushSender): () => void {
  const prev = sender;
  sender = fn;
  return () => { sender = prev; };
}

/** Test-only seam: reset module-level state. Mirrors the
 *  notifications/index.ts __resetForTest pattern so a test rig can
 *  start each case from a clean slate. */
export function __resetDispatchForTest(): void {
  sender = defaultSender;
  vapidApplied = false;
}

export interface PushPayload {
  title: string;
  body: string;
  chat_id?: string;
  tag?: string;
  icon?: string;
  url?: string;
}

export interface DispatchResult {
  dispatched: number;
  failed: number;
  pruned: number;
}

/** Send `payload` to every stored subscription. Returns a summary. On
 *  a 404 or 410 from the push service (subscription expired / unsubscribed
 *  on the client side without a roundtrip), the row is removed from
 *  storage so future dispatches don't keep trying it. Other failures
 *  (timeouts, transient 5xx) are counted as failed but the row stays. */
export async function dispatchPush(payload: PushPayload): Promise<DispatchResult> {
  if (!ensureConfigured()) {
    console.warn('[notifications] dispatchPush called but VAPID unconfigured');
    return { dispatched: 0, failed: 0, pruned: 0 };
  }
  const subs = listSubscriptions();
  if (subs.length === 0) return { dispatched: 0, failed: 0, pruned: 0 };

  let dispatched = 0;
  let failed = 0;
  let pruned = 0;
  const body = JSON.stringify(payload);

  await Promise.all(subs.map(async (sub) => {
    try {
      await sender(
        { endpoint: sub.endpoint, keys: sub.keys },
        body,
        // 30s TTL — push services hold for delivery up to this long if
        // the device is offline. Beyond that the message is dropped;
        // the user has plainly missed it and the SSE state.db replay
        // will catch them up when they next open the app.
        { TTL: 30 },
      );
      dispatched += 1;
      await markUsed(sub.endpoint);
    } catch (e: any) {
      const code = e?.statusCode ?? 0;
      if (code === 404 || code === 410) {
        // Gone-style errors: the subscription is dead. Prune so we
        // don't keep trying. The client will re-subscribe on next
        // toggle-on or app open with the permission grant intact.
        await removeSubscription(sub.endpoint);
        pruned += 1;
      } else {
        failed += 1;
        console.warn(
          `[notifications] dispatchPush failure ` +
          `(endpoint=${sub.endpoint.slice(0, 60)}…, status=${code}, msg=${e?.message ?? e})`,
        );
      }
    }
  }));

  return { dispatched, failed, pruned };
}

/** Envelope-types eligible for push delivery — fallback policy when an
 *  envelope arrives WITHOUT an explicit `should_push` flag from the
 *  plugin. Newer plugins set the flag directly per envelope and
 *  preempt this list (see isPushEligible). Conservative list — only
 *  user-facing turn outputs (the final assistant reply) and explicit
 *  `notification` envelopes. Streaming deltas / typing / tool events
 *  deliberately don't push. */
const PUSH_ELIGIBLE_TYPES = new Set<string>(['reply_final', 'notification']);

/** Decide whether an envelope should be pushed. Plugin-driven flag
 *  takes precedence; falls back to the type allowlist when the flag
 *  isn't present (backwards compat with plugin versions that haven't
 *  adopted should_push yet).
 *
 *  Truthy `should_push` → eligible regardless of type. Lets the plugin
 *  promote a tool-summary `notification` or suppress a chatty
 *  `reply_final` based on content the proxy can't see.
 *
 *  Boolean false `should_push: false` → NOT eligible, even if the
 *  type would otherwise qualify. Lets the plugin opt out of push for
 *  a `reply_final` that's just a tool acknowledgement.
 *
 *  Absent / non-boolean → consult PUSH_ELIGIBLE_TYPES. Old plugins
 *  keep working unchanged. */
export function isPushEligible(env: Record<string, any>): boolean {
  if (typeof env.should_push === 'boolean') return env.should_push;
  return PUSH_ELIGIBLE_TYPES.has(env.type);
}

/** @deprecated Use isPushEligible(env) — the type-only variant ignores
 *  the plugin's should_push flag. Kept as a thin shim during the
 *  flag-adoption window so any external caller doesn't break. */
export function isPushEligibleType(envelopeType: string): boolean {
  return PUSH_ELIGIBLE_TYPES.has(envelopeType);
}

/** Translate a sidekick envelope into a push payload. The shape matches
 *  the sw.js push listener's expectations:
 *    { title, body, chat_id?, tag?, icon?, url? }
 *  Falls back to "Sidekick" / empty body when the envelope is missing
 *  the obvious fields — the receive side handles those gracefully.
 *
 *  `bodyOverride` lets the caller supply text the envelope itself
 *  doesn't carry. Used for reply_final, which has no `text`/`content`
 *  field; stream.ts drains the per-chat replyBuffer (accumulated from
 *  preceding reply_delta envelopes) and threads the result through. */
export function envelopeToPayload(env: Record<string, any>, bodyOverride?: string): PushPayload {
  const chatId = typeof env.chat_id === 'string' ? env.chat_id : '';
  const speaker = typeof env.speaker === 'string' && env.speaker
    ? env.speaker
    : 'Sidekick';
  // notification envelopes can carry an explicit title field; fall back
  // to the speaker label otherwise. reply_final envelopes don't have a
  // title field but their speaker IS the natural label.
  const title = typeof env.title === 'string' && env.title
    ? env.title
    : speaker;
  // Take the first ~140 chars of the content; long replies hit the
  // OS-level truncation anyway, and shorter payloads ride the push
  // service's compact path on iOS.
  const raw = typeof bodyOverride === 'string' && bodyOverride ? bodyOverride
    : typeof env.content === 'string' ? env.content
    : typeof env.text === 'string' ? env.text
    : '';
  const body = raw.length > 140 ? raw.slice(0, 137) + '…' : raw;
  // Emoji title prefix by envelope kind. iOS PWA ignores the icon
  // field on the lock-screen banner (always shows the app icon), so a
  // prefix is the only category cue that actually renders. Branches
  // ordered most-specific → most-generic; unknown types fall through
  // with no prefix.
  const prefix =
    env.type === 'reply_final' ? '💬 '
    : env.type === 'notification' && env.kind === 'cron' ? '⏰ '
    : env.type === 'notification' ? '🔔 '
    : '';
  return {
    title: prefix + title,
    body,
    chat_id: chatId,
    // tag coalesces per-chat: same chat = same tag = OS replaces the
    // prior notification instead of stacking.
    tag: chatId ? `chat:${chatId}` : undefined,
    url: chatId ? `/?chat=${encodeURIComponent(chatId)}` : '/',
  };
}
