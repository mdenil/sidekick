// Field bug 2026-05-11 (Jonathan): "I lost a user bubble" report.
//
// Diagnosis: handleUserMessage's upsert was unconditional on `text`,
// with a `text || ''` fallback. A user_message envelope carrying an
// empty/missing text would therefore OVERWRITE an existing populated
// bubble's text with empty string — and the user's words disappear.
//
// Production hermes envelopes always carry text. The defensive guard
// nonetheless matters because the inflight cache replays envelopes
// verbatim, and any serialization race / future metadata-only ping
// would clobber the originating-device's optimistic bubble.
//
// Test plan:
//   1. POST /messages → optimistic user bubble renders with the prompt text.
//   2. mock.pushEnvelope({ type: 'user_message', message_id: <same id>,
//      text: '' }) → simulates the empty-text envelope arriving via SSE.
//   3. Assert the bubble's text is STILL the original prompt.
//
// Pre-fix: bubble text was '' after the second envelope. Post-fix:
// handleUserMessage short-circuits when text is empty.

import { waitForReady, openSidebar, send, captureNextChatId, clickNewChat, assert } from './lib.mjs';

export const NAME = 'user-message-empty-text-noop';
export const DESCRIPTION = 'A user_message envelope with empty text must not wipe an existing bubble (defensive)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const PROMPT = 'hello agent';

export function MOCK_SETUP(mock) {
  // Suppress the mock's auto-reply so we have a clean window to inject
  // our own envelope without other broadcasts racing.
  mock.setAutoReplyEnabled(false);
}

async function readBubble(page) {
  return page.evaluate(() => {
    const el = document.querySelector('#transcript .line.s0, #transcript .line.user');
    if (!el) return null;
    return {
      msgId: el.getAttribute('data-message-id') || '',
      text: (el.querySelector('.text')?.textContent || '').trim(),
    };
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  const chatAP = captureNextChatId(page);
  await clickNewChat(page);
  const chatId = await chatAP;
  log(`chat: ${chatId}`);

  await send(page, PROMPT);
  await page.waitForTimeout(500);

  // The mock's POST handler already broadcasts a user_message envelope
  // back with the actual text. Wait briefly for that to settle so the
  // bubble is in the "finalized" state with the proper text.
  await page.waitForTimeout(300);

  const before = await readBubble(page);
  assert(before && before.text.includes(PROMPT),
    `pre-noop: bubble should carry prompt text, got ${JSON.stringify(before)}`);
  assert(before.msgId,
    `pre-noop: bubble needs a msgId for the empty-text envelope to target, got ${JSON.stringify(before)}`);
  log(`pre-noop: bubble text=${JSON.stringify(before.text)} msgId=${before.msgId} ✓`);

  // Inject the empty-text envelope. With the fix in place,
  // handleUserMessage short-circuits and the bubble's text is preserved.
  mock.pushEnvelope({
    type: 'user_message',
    chat_id: chatId,
    message_id: before.msgId,
    text: '',
  });
  await page.waitForTimeout(300);

  const after = await readBubble(page);
  assert(after && after.text.includes(PROMPT),
    `post-noop: bubble text should be preserved, got ${JSON.stringify(after)}`);
  log(`post-noop: bubble text preserved (${JSON.stringify(after.text)}) ✓`);

  // Sanity: a SUBSEQUENT envelope with the SAME id and non-empty text
  // still updates (idempotent upsert path still works).
  mock.pushEnvelope({
    type: 'user_message',
    chat_id: chatId,
    message_id: before.msgId,
    text: PROMPT,  // same text; the upsert just re-renders identically
  });
  await page.waitForTimeout(300);

  const final = await readBubble(page);
  assert(final && final.text.includes(PROMPT),
    `final: bubble survives a same-text idempotent envelope, got ${JSON.stringify(final)}`);
  log(`final: bubble text still intact (${JSON.stringify(final.text)}) ✓`);
}
