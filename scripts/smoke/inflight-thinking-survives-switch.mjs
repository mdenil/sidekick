// Field bug 2026-05-11 (Jonathan, multi-session juggle):
//
//   "Interacting with my agent in two different sessions... we're
//    having dropouts between them as I switch back and forth. Some
//    of my bubbles are disappearing."
//
// The disappearing bubbles fall into two camps. The user-message
// half is pinned by switch-during-inflight-existing-target.mjs (the
// cleanupAbandonedChat / inflight-cache fix from 2026-05-11). This
// smoke pins the OTHER half: the agent-side "thinking..." indicator.
//
// Repro:
//   1. User sends a message in chat A. showThinking() creates a
//      DOM-only .pending .streaming bubble while the agent works.
//   2. User switches to chat B before the agent has emitted any
//      reply_delta / reply_final envelopes (early-window switch).
//   3. replaySessionMessages clears A's transcript DOM.
//   4. User switches back to A. State.db still has 0 messages (turn
//      not finalized), inflight cache has just the user_message
//      envelope. replayInflight renders the user bubble. But:
//      the thinking bubble was DOM-only and is now GONE.
//   5. The user sees their message + complete silence. Looks like a
//      hang. The agent is fine — just no indicator.
//
// Fix shape: after replayInflight, if the inflight set signals
// mid-turn (has user_message, no reply_final) AND no streaming bubble
// exists, re-create the thinking indicator via showThinking().
//
// Real-backend repro: scripts/dev-tests/multi-session-timer-flow.mjs
// captures this against the live hermes stack (failures named
// switch.A1 / switch.B1 — "chat A/B has an in-flight agent bubble").

import { waitForReady, openSidebar, send, captureNextChatId, clickNewChat, clickRow, assert } from './lib.mjs';

export const NAME = 'inflight-thinking-survives-switch';
export const DESCRIPTION = 'Switch-away during in-flight turn must restore the thinking indicator on switch-back';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_B = 'mock-switch-target';
const PROMPT = 'set a 10 second timer';

export function MOCK_SETUP(mock) {
  // Pre-seeded chat B so the user has somewhere to switch TO.
  mock.addChat(CHAT_B, {
    title: 'Existing Chat With Content',
    source: 'sidekick',
    messages: [
      { role: 'user', content: 'hi', timestamp: Date.now() / 1000 - 120 },
      { role: 'assistant', content: 'hello!', timestamp: Date.now() / 1000 - 119 },
    ],
    lastActiveAt: Date.now() - 60_000,
  });
  // Keep the in-flight window open + hide message_count and
  // first_user_message during it (real hermes timing).
  mock.setAutoReplyEnabled(false);
  mock.setPostTurnPersistence(true);
}

async function getStreamingBubble(page) {
  return page.evaluate(() => {
    const el = document.querySelector('#transcript .line.agent.streaming');
    if (!el) return null;
    return {
      pending: el.classList.contains('pending'),
      streaming: el.classList.contains('streaming'),
      replyId: el.getAttribute('data-reply-id') || '',
      dotText: (el.querySelector('.thinking-dots')?.textContent || '').trim(),
    };
  });
}

async function getUserBubbles(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('#transcript .line.s0, #transcript .line.user'))
    .map(el => ({
      msgId: el.getAttribute('data-message-id') || '',
      text: (el.textContent || '').trim().slice(0, 80),
    })));
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // Mint chat A via the real new-chat flow so chat_id minting +
  // sb-new-chat handler match production.
  const chatAP = captureNextChatId(page);
  await clickNewChat(page);
  const chatA = await chatAP;
  log(`chat A: ${chatA}`);

  // Send the prompt. showThinking fires immediately, creates the
  // pending bubble. Sanity-check it's there before the switch.
  await send(page, PROMPT);
  await page.waitForTimeout(500);
  const initialThink = await getStreamingBubble(page);
  assert(initialThink !== null,
    `pre-switch: thinking bubble should exist after send, got ${JSON.stringify(initialThink)}`);
  log(`pre-switch: thinking bubble present (pending=${initialThink.pending}, dot="${initialThink.dotText}") ✓`);

  // Stage the inflight envelope the proxy WOULD have at this moment —
  // user_message only, no reply yet. The next /messages fetch for
  // chat A will surface this as `inflight: [...]`. Use the actual
  // user-bubble msgId from the DOM so the envelope's id matches what
  // the PWA already rendered (dedupes correctly).
  const userBubble = (await getUserBubbles(page))[0];
  assert(userBubble && userBubble.msgId,
    `pre-switch: user bubble must have a msgId, got ${JSON.stringify(userBubble)}`);
  // Envelope shape matches production hermes (proxyClient adapter
  // reads env.text on line 474, NOT env.content). Sending the wrong
  // field name → handleUserMessage upserts with empty text and WIPES
  // the bubble text — a real defensive-coding gap, but a separate
  // invariant from the thinking-indicator survival this smoke pins.
  mock.setInflight(chatA, [
    {
      type: 'user_message',
      chat_id: chatA,
      message_id: userBubble.msgId,
      text: PROMPT,
      timestamp: Date.now() / 1000,
    },
  ]);
  log(`staged inflight user_message for chat A (msgId=${userBubble.msgId}) ✓`);

  // Switch to chat B — the heavy resumeSession path. This clears A's
  // transcript DOM as part of the cross-session render.
  await clickRow(page, CHAT_B);
  await page.waitForTimeout(800);
  log(`switched to chat B`);

  // Switch back to chat A. replaySessionMessages re-renders from
  // state.db (0 msgs) + replayInflight (1 user_message). With the
  // fix in place, showThinking() fires post-replayInflight so the
  // pending indicator surfaces. Pre-fix: nothing creates it, the
  // user sees their message alone.
  await clickRow(page, chatA);
  await page.waitForTimeout(1200);

  // PRECISE FIELD-BUG ASSERTION.
  const restoredThink = await getStreamingBubble(page);
  assert(
    restoredThink !== null,
    `switch-back: thinking bubble should be restored for in-flight chat, found none. ` +
    `userBubbles=${JSON.stringify(await getUserBubbles(page))}`,
  );
  log(`switch-back: thinking bubble restored (pending=${restoredThink.pending}, dot="${restoredThink.dotText}") ✓`);

  // Belt + braces: the user bubble should still be there too (covers
  // the OTHER half of the disappearing-bubbles report, already pinned
  // by switch-during-inflight-existing-target.mjs but worth co-asserting).
  const userAfterSwitch = await getUserBubbles(page);
  assert(
    userAfterSwitch.some(b => b.text.includes(PROMPT.slice(0, 20))),
    `switch-back: user bubble should survive, got ${JSON.stringify(userAfterSwitch)}`,
  );
  log(`switch-back: user bubble preserved ✓`);
}
