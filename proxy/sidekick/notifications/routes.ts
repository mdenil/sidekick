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

/** POST /api/sidekick/notifications/test
 *  Phase 3a stub. Dispatch lands in 3c — for now the endpoint just
 *  acknowledges the request so the client + smoke tests have a stable
 *  surface to point at. Returns the count of subscriptions that WOULD
 *  receive a push, but doesn't actually send one. */
export async function handleSidekickTest(req: any, res: any): Promise<void> {
  if (!isConfigured()) {
    return sendJson(res, 503, { error: 'vapid_unconfigured' });
  }
  // Drain the body so the socket doesn't stall, but don't validate yet.
  try { await readJsonBody(req); } catch { /* ignore — test endpoint is tolerant */ }
  const total = listSubscriptions().length;
  sendJson(res, 200, {
    ok: true,
    dispatched: 0,
    failed: 0,
    eligible: total,
    note: 'dispatch lands in Phase 3c — endpoint is a stub today',
  });
}
