// GET /api/sidekick/sessions/<chat_id>/messages — per-chat transcript
// replay through the agent contract. The upstream's
// `/v1/conversations/{id}/items` walks the parent_session_id chain
// server-side so the proxy doesn't need to maintain its own CTE; we
// just translate OAI items → the existing on-the-wire shape that the
// PWA renderer consumes today.

import { getUpstream } from './index.ts';
import * as inflight from './inflight.ts';
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
      // SSE-shape id (umsg_*/msg_*) when the plugin recorded a link
      // for this row in sidekick_msg_links. PWA's renderHistoryMessage
      // prefers this over the integer id as the dedup key so reload
      // bubbles match the IDB-cached SSE-shape ones. Absent for
      // legacy rows / other-channel rows / tool+system rows.
      ...(it.sidekick_id ? { sidekick_id: it.sidekick_id } : {}),
      // Notification kind ('cron', 'reminder', etc.) — plumbed
      // through for role='notification' rows so the PWA's renderer
      // can show the appropriate emoji + label.
      ...(it.kind ? { kind: it.kind } : {}),
    }));
    // Inflight envelopes — envelopes the proxy has forwarded during
    // an in-flight turn that haven't been persisted to state.db yet
    // (hermes-core persists post-turn). Empty for any chat that
    // isn't currently mid-turn. Only included for fresh history
    // fetches (before-cursor paging skips it — older pages can't
    // contain inflight by definition).
    //
    // Dedup against state.db: any inflight envelope whose msgId is
    // already canonical (has a sidekick_id in the state.db rows we
    // just fetched) is redundant — the PWA would render it twice
    // (once from state.db, once from inflight replay) or, worse,
    // re-surface "old" envelopes the user already saw and the system
    // already finalized.
    //
    // Why this is the structural fix (vs filtering at record() time
    // or warmup-window heuristics): the inflight cache is allowed to
    // accumulate from any source — live-turn dispatch, gateway events
    // ring replay on reconnect, the record()-cancels-pendingDrop edge
    // case for cron-active chats. None of those sources need to know
    // about each other if the boundary check is "filter at serve."
    // Field bug 2026-05-12 (chat 99298465, Jonathan): cron-response
    // bubbles from 1-2 hours ago kept reappearing on switch-in because
    // sidekick restarts re-seeded the inflight cache from the gateway
    // ring; the boundary filter makes that whole class of accumulation
    // bug invisible.
    const allInflight = before === null ? inflight.getForChat(chatId) : [];
    const canonicalIds = new Set<string>();
    for (const it of r.items) {
      if (it.sidekick_id) canonicalIds.add(it.sidekick_id);
    }
    const inflightEnvelopes = allInflight.filter((env) => {
      const mid = typeof (env as any).message_id === 'string'
        ? (env as any).message_id
        : '';
      if (!mid) return true;  // can't dedup without id — pass through
      return !canonicalIds.has(mid);
    });
    trace('serialize-start');
    const body = JSON.stringify({
      messages,
      firstId: r.first_id,
      hasMore: r.has_more,
      ...(inflightEnvelopes.length > 0 ? { inflight: inflightEnvelopes } : {}),
    });
    trace('serialize-end', `bytes=${body.length}${inflightEnvelopes.length ? ` inflight=${inflightEnvelopes.length}` : ''}`);
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
