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

/** Lazily apply VAPID details to the web-push module on first send.
 *  Cheaper than running on every dispatch + avoids a startup-order
 *  dependency between notifications.init() and the module load. */
function ensureVapid(): boolean {
  if (vapidApplied) return true;
  const vapid = getVapidConfig();
  if (!vapid) return false;
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  vapidApplied = true;
  return true;
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
  if (!ensureVapid()) {
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
      await webpush.sendNotification(
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

/** Envelope-types that are eligible for push delivery. Conservative
 *  list — only user-facing turn outputs (the final assistant reply)
 *  and explicit `notification` envelopes from the plugin. Streaming
 *  deltas / typing / tool events deliberately don't push. */
const PUSH_ELIGIBLE_TYPES = new Set<string>(['reply_final', 'notification']);

export function isPushEligibleType(envelopeType: string): boolean {
  return PUSH_ELIGIBLE_TYPES.has(envelopeType);
}

/** Translate a sidekick envelope into a push payload. The shape matches
 *  the sw.js push listener's expectations:
 *    { title, body, chat_id?, tag?, icon?, url? }
 *  Falls back to "Sidekick" / empty body when the envelope is missing
 *  the obvious fields — the receive side handles those gracefully. */
export function envelopeToPayload(env: Record<string, any>): PushPayload {
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
  const raw = typeof env.content === 'string' ? env.content
    : typeof env.text === 'string' ? env.text
    : '';
  const body = raw.length > 140 ? raw.slice(0, 137) + '…' : raw;
  return {
    title,
    body,
    chat_id: chatId,
    // tag coalesces per-chat: same chat = same tag = OS replaces the
    // prior notification instead of stacking.
    tag: chatId ? `chat:${chatId}` : undefined,
    url: chatId ? `/?chat=${encodeURIComponent(chatId)}` : '/',
  };
}
