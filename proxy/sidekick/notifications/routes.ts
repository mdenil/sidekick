// /api/sidekick/notifications/* handlers — Web Push subscription
// roundtrip. Phase 3a: subscribe/unsubscribe + the public-key probe
// the client needs before it can call PushManager.subscribe().
//
//   GET    /api/sidekick/notifications/vapid-public-key
//          → { publicKey: string } | 503
//   POST   /api/sidekick/notifications/subscribe
//          body: { endpoint, keys: {p256dh, auth}, userAgent? }
//          → { ok: true, created: boolean, total: number } | 503/400
//   POST   /api/sidekick/notifications/unsubscribe
//          body: { endpoint }
//          → { ok: true, removed: boolean } | 503/400
//   POST   /api/sidekick/notifications/test
//          body: { endpoint?, title?, body? }
//          → { ok: true, dispatched: number, failed: number } | 503
//          Phase 3a stub: returns { ok: true, dispatched: 0, failed: 0,
//          note: 'dispatch lands in 3c' }. The route exists now so the
//          client + smoke tests have a stable endpoint to call against.
//
// 503 is returned when VAPID env is missing — the feature is silently
// off, the UI surfaces the message. 400 is for malformed bodies.

import { isConfigured, getVapidConfig } from './index.ts';
import {
  upsertSubscription,
  removeSubscription,
  listSubscriptions,
} from './storage.ts';
import { dispatchPush } from './dispatch.ts';
import { setMuted, listMutedChats } from './mutes.ts';

const MAX_BODY_BYTES = 8 * 1024;  // subscriptions are tiny, generous

async function readJsonBody(req: any): Promise<any> {
  let raw = '';
  let aborted = false;
  req.on('data', (c: any) => {
    raw += c;
    if (raw.length > MAX_BODY_BYTES) {
      aborted = true;
      req.destroy();
    }
  });
  req.on('error', () => { aborted = true; });
  await new Promise<void>((resolve) => {
    req.on('end', () => resolve());
    req.on('close', () => resolve());
  });
  if (aborted) throw new Error('body too large');
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

function sendJson(res: any, status: number, payload: any): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** GET /api/sidekick/notifications/vapid-public-key
 *  Client fetches this before calling pushManager.subscribe(). The
 *  public key isn't a secret — it's the application-server identity
 *  that gets signed into every push request. Returns 503 (not 404) when
 *  VAPID env is missing so the client can distinguish "feature disabled"
 *  from "wrong proxy version". */
export function handleSidekickVapidPublicKey(req: any, res: any): void {
  const vapid = getVapidConfig();
  if (!vapid) {
    return sendJson(res, 503, {
      error: 'vapid_unconfigured',
      detail: 'Set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT in .env.',
    });
  }
  sendJson(res, 200, { publicKey: vapid.publicKey });
}

/** POST /api/sidekick/notifications/subscribe
 *  Store a PushSubscription from the client. Body shape mirrors
 *  PushSubscription.toJSON() plus an optional userAgent for debugging:
 *    { endpoint: "https://...", keys: { p256dh, auth }, userAgent? }
 *  Re-subscribing the same endpoint updates the row (rotating keys). */
export async function handleSidekickSubscribe(req: any, res: any): Promise<void> {
  if (!isConfigured()) {
    return sendJson(res, 503, { error: 'vapid_unconfigured' });
  }
  let body: any;
  try { body = await readJsonBody(req); }
  catch (e: any) { return sendJson(res, 400, { error: 'bad_body', detail: e.message }); }
  if (!body || typeof body.endpoint !== 'string'
      || !body.keys || typeof body.keys.p256dh !== 'string'
      || typeof body.keys.auth !== 'string') {
    return sendJson(res, 400, {
      error: 'invalid_subscription',
      detail: 'Expected { endpoint, keys: { p256dh, auth }, userAgent? }',
    });
  }
  const userAgent = typeof body.userAgent === 'string' ? body.userAgent.slice(0, 200) : '';
  const result = await upsertSubscription({
    endpoint: body.endpoint,
    keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
    userAgent,
  });
  sendJson(res, 200, { ok: true, ...result });
}

/** POST /api/sidekick/notifications/unsubscribe
 *  Remove a subscription by endpoint URL. Idempotent. */
export async function handleSidekickUnsubscribe(req: any, res: any): Promise<void> {
  if (!isConfigured()) {
    return sendJson(res, 503, { error: 'vapid_unconfigured' });
  }
  let body: any;
  try { body = await readJsonBody(req); }
  catch (e: any) { return sendJson(res, 400, { error: 'bad_body', detail: e.message }); }
  if (!body || typeof body.endpoint !== 'string') {
    return sendJson(res, 400, { error: 'invalid_body', detail: 'Expected { endpoint }' });
  }
  const removed = await removeSubscription(body.endpoint);
  sendJson(res, 200, { ok: true, removed });
}

/** GET /api/sidekick/notifications/mutes
 *  Return the list of currently-muted chat_ids. PWA reads this at boot
 *  + after toggling so the 3-dots menu can show the right label
 *  ("Mute" vs "Unmute") per chat. */
export function handleSidekickListMutes(req: any, res: any): void {
  if (!isConfigured()) {
    return sendJson(res, 503, { error: 'vapid_unconfigured' });
  }
  sendJson(res, 200, { muted_chats: listMutedChats() });
}

/** POST /api/sidekick/notifications/mute
 *  Toggle a chat's mute state. Body:
 *    { chat_id: string, muted: boolean }
 *  Idempotent: setting an already-muted chat to muted=true returns the
 *  same result. Mute is GLOBAL across all subscriptions in v1. */
export async function handleSidekickSetMute(req: any, res: any): Promise<void> {
  if (!isConfigured()) {
    return sendJson(res, 503, { error: 'vapid_unconfigured' });
  }
  let body: any;
  try { body = await readJsonBody(req); }
  catch (e: any) { return sendJson(res, 400, { error: 'bad_body', detail: e.message }); }
  if (!body || typeof body.chat_id !== 'string' || !body.chat_id
      || typeof body.muted !== 'boolean') {
    return sendJson(res, 400, {
      error: 'invalid_body',
      detail: 'Expected { chat_id: string, muted: boolean }',
    });
  }
  try {
    const result = await setMuted(body.chat_id, body.muted);
    sendJson(res, 200, { ok: true, ...result });
  } catch (e: any) {
    sendJson(res, 500, { error: 'mute_failed', detail: e?.message });
  }
}

/** POST /api/sidekick/notifications/test
 *  Dispatch a synthetic push to every stored subscription. Body is
 *  optional:
 *    { title?, body? }
 *  Defaults to a "Test from Sidekick" payload. Returns counts of
 *  delivered / failed / pruned subscriptions. Pruned subscriptions are
 *  the ones the push service reported as gone (404/410) — storage
 *  removes them so future dispatches don't waste a roundtrip. */
export async function handleSidekickTest(req: any, res: any): Promise<void> {
  if (!isConfigured()) {
    return sendJson(res, 503, { error: 'vapid_unconfigured' });
  }
  let body: any = null;
  try { body = await readJsonBody(req); }
  catch { /* tolerate empty / malformed body — test endpoint is forgiving */ }
  const title = (body && typeof body.title === 'string' && body.title)
    || 'Test from Sidekick';
  const text = (body && typeof body.body === 'string' && body.body)
    || 'Web Push is wired end-to-end ✓';
  const eligible = listSubscriptions().length;
  const result = await dispatchPush({ title, body: text });
  sendJson(res, 200, { ok: true, eligible, ...result });
}
