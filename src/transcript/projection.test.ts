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
});
