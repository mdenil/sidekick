// GET /api/sidekick/sessions/<chat_id>/messages — per-chat transcript
// replay through the agent contract. The upstream's
// `/v1/conversations/{id}/items` walks the parent_session_id chain
// server-side so the proxy doesn't need to maintain its own CTE; we
// just translate OAI items → the existing on-the-wire shape that the
// PWA renderer consumes today.

import { getUpstream } from './index.ts';
import type { UpstreamAgent } from './upstream.ts';

export async function handleSidekickSessionMessages(req, res, chatId: string) {
  // Validate chat_id shape. Accepts:
  //   - IDB-minted UUIDs (URL-safe base16+dash) for sidekick chats
  //   - Cross-platform IDs (whatsapp `@lid` / `@s.whatsapp.net`,
  //     telegram numeric, slack `[CD]<id>`, etc.) for sessions
  //     surfaced through /v1/gateway/conversations
  // Allowed: alphanumeric + the chars commonly seen in messaging
  // platform identifiers: . _ - @ : . Length cap stays 128.
  if (!chatId || !/^[A-Za-z0-9._@:-]{1,128}$/.test(chatId)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid chat_id' }));
    return;
  }
  const upstream = getUpstream();
  if (!upstream) {
    // Match the sessions-list endpoint: return an empty transcript
    // rather than 503 so the PWA can render its IDB cache without
    // showing an error toast for what's really an enrichment endpoint.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      messages: [], firstId: null, hasMore: false, unconfigured: true,
    }));
    return;
  }
  const url = new URL(req.url, 'http://x');
  const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') || '200', 10)));
  const beforeRaw = url.searchParams.get('before');
  const before = beforeRaw && /^\d+$/.test(beforeRaw) ? parseInt(beforeRaw, 10) : null;
  return handleSessionMessagesViaUpstream(upstream, res, chatId, limit, before);
}

async function handleSessionMessagesViaUpstream(
  upstream: UpstreamAgent,
  res: any,
  chatId: string,
  limit: number,
  before: number | null,
): Promise<void> {
  // [/messages-trace] instrumentation (Jonathan, 2026-05-04 overnight) —
  // diagnose where the 4-20s server-side latency lives. Three phase
  // timings: enter, upstream-call, response-serialize. Disable by
  // commenting out once the bottleneck is identified.
  const traceId = `msgs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const t0 = Date.now();
  const trace = (event: string, extra: string = '') =>
    console.log(`[messages-trace ${traceId}] +${Date.now() - t0}ms ${event} chat=${chatId}${extra ? ' ' + extra : ''}`);
  trace('enter', `limit=${limit}${before !== null ? ` before=${before}` : ''}`);
  try {
    trace('upstream-call-start');
    const r = await upstream.getMessages(chatId, {
      limit,
      ...(before !== null ? { before } : {}),
    });
    trace('upstream-call-end', `n=${r.items?.length ?? 0}`);
    const messages = r.items.map((it) => ({
      id: it.id,
      role: it.role,
      content: it.content,
      timestamp: it.created_at,
      ...(it.tool_name ? { toolName: it.tool_name } : {}),
    }));
    trace('serialize-start');
    const body = JSON.stringify({
      messages,
      firstId: r.first_id,
      hasMore: r.has_more,
    });
    trace('serialize-end', `bytes=${body.length}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
    trace('response-sent');
  } catch (e: any) {
    trace('failed', `err=${e.message}`);
    console.error('[sidekick] session messages failed:', e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}
