// When SIDEKICK_PUSH_OWNED_BY_PLUGIN=true, push storage + dispatch live
// in the backend plugin's supplemental DB (see
// backends/openclaw/src/push-*.js). The proxy stops
// owning the JSON files + web-push send; it just forwards the PWA's
// /api/sidekick/notifications/* calls to upstream /v1/push/* and skips
// local dispatch in stream.ts.
//
// Hermes still uses the legacy in-proxy storage until its plugin grows
// an equivalent surface. This env flag is the per-backend switch.

import * as http from 'node:http';

const UPSTREAM_BASE = (process.env.SIDEKICK_PLATFORM_URL || 'http://127.0.0.1:8645').replace(/\/+$/, '');
const UPSTREAM_TOKEN = (process.env.SIDEKICK_PLATFORM_TOKEN || '').trim();

export function isPushOwnedByPlugin(): boolean {
  return process.env.SIDEKICK_PUSH_OWNED_BY_PLUGIN === 'true'
      || process.env.SIDEKICK_PUSH_OWNED_BY_PLUGIN === '1';
}

interface ForwardResult {
  status: number;
  body: any;
}

async function forwardRaw(
  path: string,
  method: 'GET' | 'POST',
  body: any | null,
): Promise<ForwardResult> {
  const headers: Record<string, string> = {
    accept: 'application/json',
  };
  if (body) headers['content-type'] = 'application/json';
  if (UPSTREAM_TOKEN) headers['authorization'] = `Bearer ${UPSTREAM_TOKEN}`;
  const r = await fetch(`${UPSTREAM_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed: any = null;
  try { parsed = await r.json(); }
  catch { parsed = null; }
  return { status: r.status, body: parsed };
}

function sendJson(res: http.ServerResponse, status: number, body: any): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, cap = 8 * 1024): Promise<any | null> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > cap) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve(null);
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(e as Error); }
    });
    req.on('error', reject);
  });
}

/** /api/sidekick/notifications/vapid-public-key → /v1/push/vapid-public-key */
export async function delegateVapid(req: http.IncomingMessage, res: http.ServerResponse) {
  const r = await forwardRaw('/v1/push/vapid-public-key', 'GET', null);
  sendJson(res, r.status, r.body ?? {});
}

export async function delegateSubscribe(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readBody(req);
    const r = await forwardRaw('/v1/push/subscribe', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
}

export async function delegateUnsubscribe(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readBody(req);
    const r = await forwardRaw('/v1/push/unsubscribe', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
}

export async function delegateListMutes(req: http.IncomingMessage, res: http.ServerResponse) {
  const r = await forwardRaw('/v1/push/mutes', 'GET', null);
  // PWA expects `{muted_chats: string[]}` shape; plugin returns
  // `{mutes: [{chatId, mutedAt}]}`. Normalize here so the PWA surface
  // is unchanged regardless of whose storage backs it.
  const mutes = Array.isArray(r.body?.mutes) ? r.body.mutes : [];
  const muted_chats = mutes.map((m: any) => m.chatId).filter(Boolean);
  sendJson(res, r.status, { muted_chats });
}

export async function delegateSetMute(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readBody(req);
    const r = await forwardRaw('/v1/push/mute', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
}

export async function delegateGetPrefs(req: http.IncomingMessage, res: http.ServerResponse) {
  const r = await forwardRaw('/v1/push/prefs', 'GET', null);
  // Plugin returns `{prefs: {...}}`; the legacy PWA expects a flat
  // object. Unwrap.
  sendJson(res, r.status, r.body?.prefs ?? r.body ?? {});
}

export async function delegateSetPrefs(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readBody(req);
    // Legacy PWA sends a flat object; plugin expects {key, value}. The
    // simplest forwarding is one POST per key; do it sequentially so
    // any per-key error surfaces.
    if (!body || typeof body !== 'object') {
      return sendJson(res, 400, { error: 'invalid_body' });
    }
    let last: ForwardResult | null = null;
    for (const [key, value] of Object.entries(body)) {
      last = await forwardRaw('/v1/push/prefs', 'POST', { key, value });
      if (last.status >= 400) return sendJson(res, last.status, last.body ?? {});
    }
    // Return the final state.
    const get = await forwardRaw('/v1/push/prefs', 'GET', null);
    sendJson(res, 200, get.body?.prefs ?? {});
  } catch (e: any) { sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
}

export async function delegateVisibility(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readBody(req);
    const r = await forwardRaw('/v1/push/visibility', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
}

export async function delegateTest(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readBody(req);
    const r = await forwardRaw('/v1/push/test', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
}

// ── Unread state (SSOT for sidebar/app badge/push) ────────────────────

export async function delegateUnread(_req: http.IncomingMessage, res: http.ServerResponse) {
  const r = await forwardRaw('/v1/unread', 'GET', null);
  sendJson(res, r.status, r.body ?? {});
}

export async function delegateUnreadSeen(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readBody(req);
    const r = await forwardRaw('/v1/unread/seen', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
}

export async function delegateUnreadMark(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readBody(req);
    const r = await forwardRaw('/v1/unread/mark', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
}

// ── Pin sync (server-of-truth for cross-device pins) ──────────────────

export async function delegatePinsList(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url || '/api/sidekick/pins';
  const query = url.includes('?') ? '?' + url.split('?')[1] : '';
  const r = await forwardRaw(`/v1/pins${query}`, 'GET', null);
  sendJson(res, r.status, r.body ?? {});
}

export async function delegatePinUpsert(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readBody(req);
    const r = await forwardRaw('/v1/pins', 'POST', body);
    sendJson(res, r.status, r.body ?? {});
  } catch (e: any) { sendJson(res, 400, { error: 'bad_body', detail: e?.message }); }
}

export async function delegatePinDelete(
  _req: http.IncomingMessage, res: http.ServerResponse,
  chatId: string, msgId: string,
) {
  const path = `/v1/pins/${encodeURIComponent(chatId)}/${encodeURIComponent(msgId)}`;
  const r = await forwardRaw(path, 'POST' /* method override below */, null);
  void r;
  // forwardRaw doesn't support DELETE today; use fetch directly so we
  // don't have to thread method through. Keep parity with the GET/POST
  // helpers but with DELETE method.
  const r2 = await fetch(`${UPSTREAM_BASE}${path}`, {
    method: 'DELETE',
    headers: UPSTREAM_TOKEN ? { authorization: `Bearer ${UPSTREAM_TOKEN}` } : {},
  });
  let body: any = null;
  try { body = await r2.json(); } catch { body = null; }
  sendJson(res, r2.status, body ?? {});
}
