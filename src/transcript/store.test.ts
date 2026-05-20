/**
 * @fileoverview Store-level tests — specifically the contract for
 * draining stale inflight envelopes on durable refresh.
 *
 * Contract evolution:
 *
 * v1 (commit 4d2f7dd, 2026-05-18): `setDurable` dropped EVERY
 * completed-turn envelope (anything up to & including the last
 * reply_final), assuming durable was authoritative for those turns.
 * Fixed the ghost-tail bug where durable rows arrived with
 * sidekick_id NULL (the plugin's link-table write had silently
 * failed) — projection couldn't dedup against inflight by key,
 * resulting in duplicate ghost bubbles. Dropping inflight removed
 * the duplicate at the cost of trusting durable absolutely.
 *
 * v2 (this file, 2026-05-19): `setDurable` only drops envelopes
 * whose `reply_final.message_id` is present in durable's
 * `sidekick_id` set. The v1 assumption broke for background-chat
 * replies: SSE delivered reply_final to the inflight store, but
 * a subsequent switch-in fired setDurable BEFORE the plugin had
 * mirrored the assistant row into state.db / sidekick.db. With
 * v1 the inflight envelope (the only source of truth) got nuked
 * and the user saw a blank session until a second switch-away-
 * and-back (by which time the mirror caught up).
 *
 * The v1 ghost-tail symptom is addressed at the source by the
 * supplemental store self-heal (phase-3 fingerprint linker,
 * phase-4 orphan drop) — durable rows should now reliably arrive
 * with sidekick_id. When the link write somehow still fails, v2
 * leaves the inflight envelope alone; the user sees a brief
 * duplicate rather than missing content, which is the safer
 * trade.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getState, setDurable, appendInflight, clearInflightThroughReplyFinal } from './store.ts';
import type { ConversationItem, SidekickEnvelope } from './types.ts';

const CHAT = 'orphan-test';

function reset(): void {
  // Force a fresh state by wiping durable + inflight.
  setDurable(CHAT, [], { firstId: null, hasMore: false });
  const s = getState(CHAT);
  s.inflight.length = 0;
  s.pendingSends.length = 0;
}

function userMsg(message_id: string, text: string): SidekickEnvelope {
  return { type: 'user_message', chat_id: CHAT, message_id, text };
}
function replyDelta(message_id: string, text: string): SidekickEnvelope {
  return { type: 'reply_delta', chat_id: CHAT, message_id, text };
}
function replyFinal(message_id: string, text?: string): SidekickEnvelope {
  return { type: 'reply_final', chat_id: CHAT, message_id, text };
}
function typing(): SidekickEnvelope {
  return { type: 'typing', chat_id: CHAT };
}
function durableUserRow(id: number, content: string, sidekick_id?: string): ConversationItem {
  const row: ConversationItem = { id, role: 'user', content, timestamp: 1_779_120_000 + id };
  if (sidekick_id) row.sidekick_id = sidekick_id;
  return row;
}
function durableAssistantRow(id: number, content: string, sidekick_id?: string): ConversationItem {
  const row: ConversationItem = { id, role: 'assistant', content, timestamp: 1_779_120_000 + id };
  if (sidekick_id) row.sidekick_id = sidekick_id;
  return row;
}

describe('store: setDurable conditionally drains completed-turn inflight envelopes', () => {
  it('keeps in-progress turn envelopes untouched when no reply_final present', () => {
    reset();
    appendInflight(CHAT, userMsg('umsg_A', 'hello'));
    appendInflight(CHAT, typing());
    appendInflight(CHAT, replyDelta('msg_A', 'hi'));
    // Active turn: no reply_final yet → setDurable must NOT drop these.
    setDurable(CHAT, [], { firstId: null, hasMore: false });
    const s = getState(CHAT);
    assert.equal(s.inflight.length, 3);
    assert.equal(s.inflight[0].type, 'user_message');
    assert.equal(s.inflight[2].type, 'reply_delta');
  });

  it('drops a completed turn when durable contains the reply_final.message_id as sidekick_id', () => {
    reset();
    appendInflight(CHAT, userMsg('umsg_A', 'hello'));
    appendInflight(CHAT, typing());
    appendInflight(CHAT, replyDelta('msg_A', 'hi'));
    appendInflight(CHAT, replyFinal('msg_A', 'hi'));
    // Durable mirror caught up: assistant row carries the SSE-shape
    // message_id as sidekick_id. Projection dedup will key off this
    // sidekick_id, so the store can safely drain the inflight copy.
    setDurable(CHAT, [
      durableUserRow(1, 'hello', 'umsg_A'),
      durableAssistantRow(2, 'hi', 'msg_A'),
    ], { firstId: null, hasMore: false });
    const s = getState(CHAT);
    assert.equal(s.inflight.length, 0);
  });

  it('drops only the completed-turn envelopes whose mirror landed; preserves the trailing in-progress turn', () => {
    reset();
    // Turn 1 — closed, mirrored
    appendInflight(CHAT, userMsg('umsg_A', 'q1'));
    appendInflight(CHAT, replyDelta('msg_A', 'a1'));
    appendInflight(CHAT, replyFinal('msg_A', 'a1'));
    // Turn 2 — closed, mirrored
    appendInflight(CHAT, userMsg('umsg_B', 'q2'));
    appendInflight(CHAT, replyDelta('msg_B', 'a2'));
    appendInflight(CHAT, replyFinal('msg_B', 'a2'));
    // Turn 3 — in progress (no reply_final yet)
    appendInflight(CHAT, userMsg('umsg_C', 'q3'));
    appendInflight(CHAT, typing());
    appendInflight(CHAT, replyDelta('msg_C', 'a3 streaming…'));
    setDurable(CHAT, [
      durableUserRow(1, 'q1', 'umsg_A'),
      durableAssistantRow(2, 'a1', 'msg_A'),
      durableUserRow(3, 'q2', 'umsg_B'),
      durableAssistantRow(4, 'a2', 'msg_B'),
    ], { firstId: null, hasMore: false });
    const s = getState(CHAT);
    // Only the trailing in-progress turn 3 envelopes survive.
    assert.equal(s.inflight.length, 3);
    assert.equal(s.inflight[0].type, 'user_message');
    assert.equal((s.inflight[0] as any).message_id, 'umsg_C');
    assert.equal(s.inflight[2].type, 'reply_delta');
  });

  it('preserves completed-turn envelopes when durable is stale (background-chat race)', () => {
    // Field bug 2026-05-19 (Jonathan): reply lands in chat A via SSE
    // while user is on chat B. User switches to A; replaySessionMessages
    // calls setDurable(A, server_messages_for_A, ...) and the server's
    // /messages response doesn't include the new reply yet (state.db
    // / sidekick.db write-through hasn't landed). Without this fix,
    // the inflight reply_final got nuked under the v1 assumption that
    // durable was authoritative — and the user saw a blank session
    // until they switched away and back.
    reset();
    appendInflight(CHAT, userMsg('umsg_A', 'hello'));
    appendInflight(CHAT, replyDelta('msg_A', 'hi'));
    appendInflight(CHAT, replyFinal('msg_A', 'hi'));
    // Server-side mirror hasn't caught up: durable has the user row
    // but NOT the assistant row. Inflight is the only copy of the
    // reply — must not be dropped.
    setDurable(CHAT, [
      durableUserRow(1, 'hello', 'umsg_A'),
    ], { firstId: null, hasMore: false });
    const s = getState(CHAT);
    assert.equal(s.inflight.length, 3,
      `expected all 3 envelopes preserved (durable stale); got ${s.inflight.length}`);
    assert.equal((s.inflight[2] as any).message_id, 'msg_A');
  });

  it('preserves completed-turn envelopes when durable rows lack sidekick_id', () => {
    // Historical scenario (Jonathan field bug 2026-05-18, ghost tail):
    // the plugin's link-table write silently failed, leaving durable
    // assistant rows with sidekick_id NULL. Under v1 the store
    // nuked the inflight on the assumption that durable was good;
    // under v2 we don't assume — supplemental-store's phase-3/4
    // self-heal is the real fix for the underlying NULL-sidekick_id
    // bug, and v2 keeping the inflight envelope shows a brief
    // duplicate at worst (the projection will eventually dedup once
    // the link gets re-established), never blank content.
    reset();
    appendInflight(CHAT, userMsg('umsg_ghost', 'This is great'));
    appendInflight(CHAT, replyDelta('msg_ghost', 'Yep'));
    appendInflight(CHAT, replyFinal('msg_ghost', 'Yep'));
    // Durable rows arrive without sidekick_id — the bug shape.
    setDurable(CHAT, [
      { id: 100, role: 'user', content: 'This is great', timestamp: 1_779_121_069 },
      { id: 101, role: 'assistant', content: 'Yep', timestamp: 1_779_121_069 },
    ], { firstId: null, hasMore: false });
    const s = getState(CHAT);
    assert.equal(s.inflight.length, 3,
      `expected inflight preserved when durable lacks sidekick_id (safer than nuking content); got ${s.inflight.length}`);
  });
});

describe('store: targeted post-final inflight drain', () => {
  it('clears through the named reply_final and preserves a trailing in-progress turn', () => {
    reset();
    appendInflight(CHAT, userMsg('umsg_A', 'q1'));
    appendInflight(CHAT, replyDelta('msg_A', 'a1'));
    appendInflight(CHAT, replyFinal('msg_A', 'a1'));
    appendInflight(CHAT, userMsg('umsg_B', 'q2'));
    appendInflight(CHAT, replyDelta('msg_B', 'a2 streaming'));

    clearInflightThroughReplyFinal(CHAT, 'msg_A');

    const s = getState(CHAT);
    assert.equal(s.inflight.length, 2);
    assert.equal((s.inflight[0] as any).message_id, 'umsg_B');
    assert.equal((s.inflight[1] as any).message_id, 'msg_B');
  });

  it('does nothing when the named reply_final is not present', () => {
    reset();
    appendInflight(CHAT, userMsg('umsg_A', 'q1'));
    appendInflight(CHAT, replyDelta('msg_A', 'a1'));

    clearInflightThroughReplyFinal(CHAT, 'msg_missing');

    const s = getState(CHAT);
    assert.equal(s.inflight.length, 2);
  });
});
