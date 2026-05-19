/**
 * @fileoverview Store-level tests — specifically the contract for
 * draining stale inflight envelopes on durable refresh.
 *
 * Bug context (Jonathan field repro 2026-05-18, chat 54f0e929):
 * `_write_msg_links_after_turn` on the plugin side silently failed
 * for some state.db rows, leaving sidekick_id NULL. The PWA's
 * projection then couldn't dedup those rows' integer-id keys against
 * the inflight envelopes' SSE-shape umsg_ / msg_ keys, so completed
 * turns produced duplicate "ghost" bubbles at the bottom of the
 * transcript with synthetic timestamps. The fix below ensures the
 * store drops envelopes for turns whose reply_final has fired,
 * because durable is authoritative for those turns regardless of
 * whether the link-table write landed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getState, setDurable, appendInflight } from './store.ts';
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
function durableRow(id: number, role: 'user' | 'assistant', content: string, ts = 1_779_120_000 + id): ConversationItem {
  return { id, role, content, timestamp: ts };
}

describe('store: setDurable drains completed-turn inflight envelopes', () => {
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

  it('drops a completed turn (reply_final at tail) on next setDurable', () => {
    reset();
    appendInflight(CHAT, userMsg('umsg_A', 'hello'));
    appendInflight(CHAT, typing());
    appendInflight(CHAT, replyDelta('msg_A', 'hi'));
    appendInflight(CHAT, replyFinal('msg_A', 'hi'));
    // Turn closed → setDurable considers durable authoritative.
    setDurable(CHAT, [durableRow(1, 'user', 'hello'), durableRow(2, 'assistant', 'hi')], {
      firstId: null,
      hasMore: false,
    });
    const s = getState(CHAT);
    assert.equal(s.inflight.length, 0);
  });

  it('drops only the completed-turn envelopes, preserves the trailing in-progress turn', () => {
    reset();
    // Turn 1 — closed
    appendInflight(CHAT, userMsg('umsg_A', 'q1'));
    appendInflight(CHAT, replyDelta('msg_A', 'a1'));
    appendInflight(CHAT, replyFinal('msg_A', 'a1'));
    // Turn 2 — closed
    appendInflight(CHAT, userMsg('umsg_B', 'q2'));
    appendInflight(CHAT, replyDelta('msg_B', 'a2'));
    appendInflight(CHAT, replyFinal('msg_B', 'a2'));
    // Turn 3 — in progress (no reply_final yet)
    appendInflight(CHAT, userMsg('umsg_C', 'q3'));
    appendInflight(CHAT, typing());
    appendInflight(CHAT, replyDelta('msg_C', 'a3 streaming…'));
    setDurable(CHAT, [], { firstId: null, hasMore: false });
    const s = getState(CHAT);
    // Only the trailing in-progress turn 3 envelopes survive.
    assert.equal(s.inflight.length, 3);
    assert.equal(s.inflight[0].type, 'user_message');
    assert.equal((s.inflight[0] as any).message_id, 'umsg_C');
    assert.equal(s.inflight[2].type, 'reply_delta');
  });

  it('regression: ghost-turn tail does not survive a refresh', () => {
    // Mirrors Jonathan's 2026-05-18 field bug. Plugin failed to write
    // the link table for "This is great" turn (3 envelopes never got
    // their state.db rows linked to SSE-shape umsg_*/msg_* keys). Then
    // user sent more turns. Local inflight kept growing with envelopes
    // whose keys would never dedup against durable.
    //
    // With the fix, the moment durable refreshes after the orphan
    // turn's reply_final fired, those envelopes drain.
    reset();
    appendInflight(CHAT, userMsg('umsg_ghost', 'This is great'));
    appendInflight(CHAT, replyDelta('msg_ghost', 'Yep'));
    appendInflight(CHAT, replyFinal('msg_ghost', 'Yep'));
    // Durable comes back with the row but WITHOUT a sidekick_id link
    // (no `sidekick_id` field). That's exactly the bug shape.
    setDurable(CHAT, [
      { id: 100, role: 'user', content: 'This is great', timestamp: 1_779_121_069 },
      { id: 101, role: 'assistant', content: 'Yep', timestamp: 1_779_121_069 },
    ], { firstId: null, hasMore: false });
    const s = getState(CHAT);
    // Inflight drained → projection won't produce a duplicate ghost
    // turn from these envelopes. The durable rows render under their
    // integer-id keys; that's a single bubble, not two.
    assert.equal(s.inflight.length, 0);
  });
});
