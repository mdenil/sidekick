/**
 * @fileoverview Pure-projection tests — covers the join between
 * durable, inflight, and pendingSends, the dedup rules, and the sort
 * ordering. The reconciler is exercised in a separate browser smoke;
 * here we only test the data transform.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { project } from './projection.ts';
import type { ChatState, ConversationItem, SidekickEnvelope, PendingSend } from './types.ts';

function state(partial: Partial<ChatState>): ChatState {
  return {
    durable: [],
    inflight: [],
    pendingSends: [],
    pagination: { firstId: null, hasMore: false },
    ...partial,
  };
}

const T0 = 1_747_000_000_000;
function u(id: string, text: string, ts = T0): ConversationItem {
  return { id, sidekick_id: id, role: 'user', content: text, timestamp: ts };
}
function a(id: string, text: string, ts = T0, toolCalls?: string): ConversationItem {
  return { id, sidekick_id: id, role: 'assistant', content: text, timestamp: ts, tool_calls: toolCalls };
}
function tool(id: string, callId: string, name: string, content: string, ts = T0): ConversationItem {
  return { id, role: 'tool', content, tool_call_id: callId, tool_name: name, timestamp: ts };
}

describe('project: durable only', () => {
  it('empty state → empty specs', () => {
    assert.deepEqual(project(state({})), []);
  });

  it('user → assistant pair', () => {
    const s = state({ durable: [u('umsg_1', 'hello'), a('msg_1', 'hi', T0 + 1000)] });
    const out = project(s);
    assert.equal(out.length, 2);
    assert.equal(out[0].kind, 'user');
    assert.equal(out[0].key, 'umsg_1');
    assert.equal(out[1].kind, 'assistant');
    assert.equal(out[1].key, 'msg_1');
  });

  it('assistant tool_calls fold into activity row keyed to the preceding user', () => {
    const tc = JSON.stringify([{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"q":"x"}' } }]);
    const s = state({
      durable: [
        u('umsg_1', 'search please'),
        a('msg_1', 'searching...', T0 + 1, tc),
        tool('5', 'c1', 'web_search', '{"results":[]}', T0 + 2),
      ],
    });
    const out = project(s);
    // user (T0) → activity row (T0) → assistant (T0+1) → tool merged into activity row
    const kinds = out.map(s => s.kind);
    assert.deepEqual(kinds, ['user', 'activityRow', 'assistant']);
    const ar = out.find(s => s.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.key, 'turn:umsg_1');
    assert.equal(ar.tools.length, 1);
    assert.equal(ar.tools[0].callId, 'c1');
    assert.equal(ar.tools[0].name, 'web_search');
    assert.equal(ar.tools[0].result, '{"results":[]}');
    assert.equal(ar.complete, true);
  });

  it('hermes unix-seconds timestamps get normalized to ms', () => {
    const sec = 1_747_000_000;  // < 1e12
    const s = state({ durable: [{ id: 'u1', sidekick_id: 'umsg_1', role: 'user', content: 'x', timestamp: sec }] });
    const out = project(s);
    assert.equal(out[0].timestamp, sec * 1000);
  });
});

describe('project: inflight', () => {
  it('user_message envelope produces a user bubble when no durable match', () => {
    const env: SidekickEnvelope = { type: 'user_message', chat_id: 'c', message_id: 'umsg_2', text: 'hello' };
    const s = state({ inflight: [env] });
    const out = project(s);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'user');
    assert.equal(out[0].key, 'umsg_2');
    assert.equal(out[0].text, 'hello');
  });

  it('user_message envelope matching durable does not duplicate', () => {
    const s = state({
      durable: [u('umsg_1', 'hi')],
      inflight: [{ type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'hi' }],
    });
    const out = project(s);
    assert.equal(out.filter(s => s.kind === 'user').length, 1);
  });

  it('streaming reply_delta concatenates into one assistant bubble; reply_final flips streaming off', () => {
    const s = state({
      durable: [u('umsg_1', 'q')],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'reply_delta', chat_id: 'c', text: 'hel', message_id: 'msg_x' },
        { type: 'reply_delta', chat_id: 'c', text: 'lo', message_id: 'msg_x' },
        { type: 'reply_final', chat_id: 'c', message_id: 'msg_x' },
      ],
    });
    const out = project(s);
    const ag = out.find(x => x.kind === 'assistant');
    assert.ok(ag && ag.kind === 'assistant');
    assert.equal(ag.text, 'hello');
    assert.equal(ag.streaming, false);
  });

  it('tool_call + tool_result land in an activity row keyed to the in-flight turn', () => {
    const s = state({
      durable: [u('umsg_1', 'q')],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'tool_call', chat_id: 'c', call_id: 'c1', tool_name: 'web', args: { q: 'x' } },
        { type: 'tool_result', chat_id: 'c', call_id: 'c1', tool_name: 'web', result: 'ok', duration_ms: 42 },
      ],
    });
    const out = project(s);
    const ar = out.find(s => s.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.key, 'turn:umsg_1');
    assert.equal(ar.tools[0].callId, 'c1');
    assert.equal(ar.tools[0].result, 'ok');
    assert.equal(ar.tools[0].durationMs, 42);
    assert.equal(ar.complete, false);
  });

  it('tool_result without a prior tool_call still uses tool_name when present', () => {
    const s = state({
      durable: [u('umsg_1', 'q')],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'tool_result', chat_id: 'c', call_id: 'c1', tool_name: 'search_files', result: '{"total_count":1,"matches":[]}', duration_ms: 42 },
      ],
    });
    const out = project(s);
    const ar = out.find(s => s.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.tools[0].name, 'search_files');
  });

  it('tool_result without a name infers common tools from result shape', () => {
    const s = state({
      durable: [u('umsg_1', 'q')],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'tool_result', chat_id: 'c', call_id: 'c1', tool_name: '', result: '{"total_count":1,"matches":[]}', duration_ms: 42 },
      ],
    });
    const out = project(s);
    const ar = out.find(s => s.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.tools[0].name, 'search_files');
  });

  it('tool_result with placeholder name still infers common tools from result shape', () => {
    const s = state({
      durable: [u('umsg_1', 'q')],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'tool_result', chat_id: 'c', call_id: 'c1', tool_name: 'tool', result: '{"total_count":1,"matches":[]}', duration_ms: 42 },
      ],
    });
    const out = project(s);
    const ar = out.find(s => s.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.tools[0].name, 'search_files');
  });

  it('tool_result renames an earlier placeholder tool_call when the result carries the real name', () => {
    const s = state({
      durable: [u('umsg_1', 'q')],
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'tool_call', chat_id: 'c', call_id: 'c1', tool_name: 'tool', args: {} },
        { type: 'tool_result', chat_id: 'c', call_id: 'c1', tool_name: 'search_files', result: '{"total_count":1,"matches":[]}', duration_ms: 42 },
      ],
    });
    const out = project(s);
    const ar = out.find(s => s.kind === 'activityRow');
    assert.ok(ar && ar.kind === 'activityRow');
    assert.equal(ar.tools[0].name, 'search_files');
    assert.equal(ar.tools[0].result, '{"total_count":1,"matches":[]}');
  });

  it('ordering: user → activity row → assistant within the same turn', () => {
    const s = state({
      inflight: [
        { type: 'user_message', chat_id: 'c', message_id: 'umsg_1', text: 'q' },
        { type: 'reply_delta', chat_id: 'c', text: 'a', message_id: 'msg_1' },
        { type: 'tool_call', chat_id: 'c', call_id: 'c1', tool_name: 't', args: {} },
      ],
    });
    const out = project(s);
    const kinds = out.map(s => s.kind);
    assert.deepEqual(kinds, ['user', 'activityRow', 'assistant']);
  });
});

describe('project: pending sends', () => {
  it('pending send not yet acknowledged renders with pending=true', () => {
    const p: PendingSend = { messageId: 'umsg_x', text: 'hi', sentAt: T0, source: 'text' };
    const s = state({ pendingSends: [p] });
    const out = project(s);
    assert.equal(out.length, 1);
    const u = out[0];
    assert.ok(u.kind === 'user');
    assert.equal(u.pending, true);
    assert.equal(u.source, 'text');
  });

  it('pending send superseded by inflight user_message echo: only one bubble, source preserved', () => {
    const p: PendingSend = { messageId: 'umsg_x', text: 'hi', sentAt: T0, source: 'voice', attachments: [{ dataUrl: 'data:', mimeType: 'image/png' }] };
    const s = state({
      pendingSends: [p],
      inflight: [{ type: 'user_message', chat_id: 'c', message_id: 'umsg_x', text: 'hi' }],
    });
    const out = project(s);
    const users = out.filter(s => s.kind === 'user');
    assert.equal(users.length, 1);
    assert.equal(users[0].kind, 'user');
    // From inflight branch, source + attachments came from pending lookup.
    if (users[0].kind === 'user') {
      assert.equal(users[0].source, 'voice');
      assert.equal(users[0].attachments?.length, 1);
    }
  });

  it('failed pending send: pending=false, failed=true', () => {
    const p: PendingSend = { messageId: 'umsg_x', text: 'hi', sentAt: T0, failed: true };
    const out = project(state({ pendingSends: [p] }));
    assert.equal(out.length, 1);
    if (out[0].kind === 'user') {
      assert.equal(out[0].pending, false);
      assert.equal(out[0].failed, true);
    }
  });
});

describe('project: dedup keys', () => {
  it('sidekick_id is preferred over numeric id for user key', () => {
    const s = state({ durable: [{ id: 42, sidekick_id: 'umsg_x', role: 'user', content: 'q', timestamp: T0 }] });
    const out = project(s);
    assert.equal(out[0].key, 'umsg_x');
  });

  it('numeric id falls back when sidekick_id absent', () => {
    const s = state({ durable: [{ id: 42, role: 'user', content: 'q', timestamp: T0 }] });
    const out = project(s);
    assert.equal(out[0].key, '42');
  });

  it('inflight reply_final does NOT duplicate a durable assistant row that arrived without sidekick_id (field bug 2026-05-19)', () => {
    // Active-chat dupe field repro: user sent a message, plugin mirrored
    // the assistant row but the link write didn't land (sidekick_id NULL).
    // Without content-fallback dedup, durable keyed by integer "101" and
    // inflight keyed by "msg_xyz" rendered as two separate bubbles.
    const s = state({
      durable: [
        { id: 100, sidekick_id: 'umsg_q', role: 'user', content: 'hey test message', timestamp: T0 },
        // Assistant row arrived without sidekick_id — the bug shape.
        { id: 101, role: 'assistant', content: 'Hey — received.', timestamp: T0 + 1000 },
      ],
      inflight: [
        { type: 'reply_delta', chat_id: 'c', message_id: 'msg_xyz', text: 'Hey — received.' },
        { type: 'reply_final', chat_id: 'c', message_id: 'msg_xyz' },
      ],
    });
    const out = project(s);
    const assistantBubbles = out.filter(o => o.kind === 'assistant');
    assert.equal(assistantBubbles.length, 1,
      `expected exactly 1 assistant bubble (durable keyed by integer id); `
      + `got ${assistantBubbles.length}: ${JSON.stringify(assistantBubbles.map(a => ({ key: a.key, text: (a as any).text })))}`);
    // The surviving bubble is the durable one (keyed by integer id), not
    // the inflight one — durable is the canonical source once both exist.
    assert.equal(assistantBubbles[0].key, '101');
  });

  it('inflight reply_final preserved when no matching durable assistant row exists (background-race contract)', () => {
    // Counterpart to the dupe test: when durable doesn't have the
    // assistant row yet (background-chat reply landed via SSE but
    // mirror hasn't caught up), the inflight envelope must render.
    const s = state({
      durable: [
        { id: 100, sidekick_id: 'umsg_q', role: 'user', content: 'hey', timestamp: T0 },
      ],
      inflight: [
        { type: 'reply_delta', chat_id: 'c', message_id: 'msg_xyz', text: 'Hi back.' },
        { type: 'reply_final', chat_id: 'c', message_id: 'msg_xyz' },
      ],
    });
    const out = project(s);
    const assistantBubbles = out.filter(o => o.kind === 'assistant');
    assert.equal(assistantBubbles.length, 1);
    assert.equal(assistantBubbles[0].key, 'msg_xyz');
    assert.equal((assistantBubbles[0] as any).text, 'Hi back.');
  });

  it('durable-vs-durable: items endpoint returning two assistant rows with same content renders ONE bubble (field bug 2026-05-19)', () => {
    // Server-side bug shape: `sidekick.db.msg_links` had two rows for
    // the same logical assistant message — one from envelope write-
    // through (sidekick_id="msg_xyz", real timestamp), one from
    // reconcile Pass 2 fallback (sidekick_id="legacy:101", timestamp=0
    // because... still unknown). The items endpoint returned both;
    // projection's key-based dedup saw them as different (different
    // sidekick_ids); both rendered. Result: one user-visible reply
    // duplicated, with one copy showing 01:00 BST (= unix 0 → UTC+1).
    const s = state({
      durable: [
        { id: 100, sidekick_id: 'umsg_q', role: 'user', content: 'hey test message', timestamp: T0 },
        // Bad duplicate row — timestamp=0.
        { id: 101, sidekick_id: 'legacy:101', role: 'assistant', content: 'Hey — received.', timestamp: 0 },
        // Good row — real timestamp.
        { id: 102, sidekick_id: 'msg_xyz', role: 'assistant', content: 'Hey — received.', timestamp: T0 + 1000 },
      ],
    });
    const out = project(s);
    const assistantBubbles = out.filter(o => o.kind === 'assistant');
    assert.equal(assistantBubbles.length, 1,
      `expected ONE assistant bubble (dedup by content); got ${assistantBubbles.length}: `
      + `${JSON.stringify(assistantBubbles.map(b => ({ key: b.key, ts: b.timestamp, text: (b as any).text })))}`);
    // Winner is the row with the real timestamp (msg_xyz at T0+1000).
    assert.equal(assistantBubbles[0].key, 'msg_xyz');
  });

  it('durable-vs-durable: two assistant rows with same content + same valid timestamp picks the higher id deterministically', () => {
    // Defensive: if BOTH rows have real timestamps that happen to match
    // (e.g. plugin write-through + reconcile Pass 2 fired in the same
    // second), the projection must still emit one bubble — pick by
    // a stable tiebreak so future runs render identically.
    const s = state({
      durable: [
        { id: 100, sidekick_id: 'msg_a', role: 'assistant', content: 'same text', timestamp: T0 + 1000 },
        { id: 101, sidekick_id: 'msg_b', role: 'assistant', content: 'same text', timestamp: T0 + 1000 },
      ],
    });
    const out = project(s);
    const assistantBubbles = out.filter(o => o.kind === 'assistant');
    assert.equal(assistantBubbles.length, 1);
    // Higher id wins on tie ("msg_b" > "msg_a" lex order).
    assert.equal(assistantBubbles[0].key, 'msg_b');
  });

  it('durable-vs-durable dedup does NOT collapse genuinely different content', () => {
    const s = state({
      durable: [
        { id: 100, sidekick_id: 'msg_a', role: 'assistant', content: 'first reply', timestamp: T0 + 1000 },
        { id: 101, sidekick_id: 'msg_b', role: 'assistant', content: 'second reply', timestamp: T0 + 2000 },
      ],
    });
    const out = project(s);
    const assistantBubbles = out.filter(o => o.kind === 'assistant');
    assert.equal(assistantBubbles.length, 2);
  });

  it('inflight reply_final preserved when durable has DIFFERENT-content assistant row without sidekick_id', () => {
    // Defensive: the content match must be exact. A no-link durable row
    // with text "old reply" must not steal the inflight bubble for
    // "new reply".
    const s = state({
      durable: [
        { id: 100, sidekick_id: 'umsg_q', role: 'user', content: 'q', timestamp: T0 },
        { id: 101, role: 'assistant', content: 'old reply', timestamp: T0 + 1000 },
      ],
      inflight: [
        { type: 'reply_delta', chat_id: 'c', message_id: 'msg_new', text: 'new reply' },
        { type: 'reply_final', chat_id: 'c', message_id: 'msg_new' },
      ],
    });
    const out = project(s);
    const assistantBubbles = out.filter(o => o.kind === 'assistant');
    assert.equal(assistantBubbles.length, 2);
    assert.deepEqual(assistantBubbles.map(b => b.key).sort(), ['101', 'msg_new']);
  });

  it('notification with matching sidekick_id renders once when durable and inflight both contain it', () => {
    const s = state({
      durable: [
        { id: 101, sidekick_id: 'notif_1', role: 'assistant', kind: 'cron', content: 'Cron done', timestamp: T0 },
      ],
      inflight: [
        { type: 'notification', chat_id: 'c', kind: 'cron', content: 'Cron done', sidekick_id: 'notif_1' },
      ],
    });
    const out = project(s);
    const notifications = out.filter(o => o.kind === 'notification');
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].key, 'notif:notif_1');
  });
});

describe('project: ordering across turns', () => {
  it('two turns end-to-end: u1 → ar1 → a1 → u2 → ar2 → a2', () => {
    const tc = JSON.stringify([{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }]);
    const s = state({
      durable: [
        u('umsg_1', 'q1', T0),
        a('msg_1', 'a1', T0 + 1000, tc),
        tool('5', 'c1', 't', 'ok', T0 + 2000),
        u('umsg_2', 'q2', T0 + 3000),
        a('msg_2', 'a2', T0 + 4000),
      ],
    });
    const out = project(s);
    const seq = out.map(s => `${s.kind}:${s.key}`);
    assert.deepEqual(seq, [
      'user:umsg_1',
      'activityRow:turn:umsg_1',
      'assistant:msg_1',
      'user:umsg_2',
      'assistant:msg_2',
    ]);
  });

  it('preserves durable server order when adjacent turns share the same timestamp', () => {
    const sameSecond = 1_779_298_560;
    const s = state({
      durable: [
        u('umsg_1', 'Going via a skill is a good idea', sameSecond - 60),
        tool('5', 'c1', 'skill_view', '{"name":"r2-raise-brain"}', sameSecond - 59),
        a('msg_done', 'Done. Split is live.', sameSecond),
        u('umsg_2', '> I preserved the old monolithic skill here', sameSecond),
        tool('6', 'c2', 'skill_view', '{"name":"hermes-agent"}', sameSecond),
        a('msg_good', 'Good push. You were right.', sameSecond),
      ],
    });
    const out = project(s);
    assert.deepEqual(out.map(s => `${s.kind}:${s.key}`), [
      'user:umsg_1',
      'activityRow:turn:umsg_1',
      'assistant:msg_done',
      'user:umsg_2',
      'activityRow:turn:umsg_2',
      'assistant:msg_good',
    ]);
  });
});
