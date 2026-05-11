// Pin the streaming-indicator's pending-bubble + .thinking-dots
// element. When the user sends, backend.onSend fires → showThinking
// creates a pending agent bubble containing a .thinking-dots span.
// This is the foundation the label-transition state machine
// updates as `typing` / `tool_call` / `canvas.show` envelopes
// arrive (handleActivity in main.ts:4471).
//
// Refactor risk: the streaming indicator state machine is a
// candidate for extraction to src/streamingIndicator.ts. If the
// extraction loses the showThinking → backend.onSend wiring (or
// the .thinking-dots creation inside showThinking), this smoke
// fails — surfaces the regression before it ships.
//
// Test plan (mocked):
//   1. Open a seeded chat. Suppress mock auto-reply so the
//      thinking-dots stay visible long enough to inspect.
//   2. Send a message.
//   3. Assert: within 1s, a .thinking-dots span exists in the DOM
//      with non-empty text content.

import { waitForReady, openSidebar, clickRow, send, assert } from './lib.mjs';

export const NAME = 'streaming-label-transitions';
export const DESCRIPTION = 'showThinking creates a pending agent bubble with .thinking-dots on every send';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-streaming-labels';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Streaming label test',
    messages: [
      { role: 'user', content: 'seed user msg',
        sidekick_id: 'umsg_streaming_labels_seed',
        timestamp: Date.now() / 1000 - 60 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // Suppress auto-reply so the .thinking-dots stays visible —
  // otherwise reply_final lands at +50ms and finalizes the bubble,
  // removing the span before the smoke can inspect it.
  mock.setAutoReplyEnabled(false);

  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    () => /seed user msg/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  log('chat opened ✓');

  // Send a message. backend.onSend → showThinking → pending bubble
  // with .thinking-dots span appears.
  await send(page, 'trigger thinking');

  // Assert the .thinking-dots span materialized with non-empty
  // default label text. The exact text is in main.ts (showThinking
  // sets "thinking…"); we just check non-empty here so the smoke
  // doesn't crack on benign cosmetic changes — the regression target
  // is "the span EXISTS at all", not "the text says exactly X".
  await page.waitForFunction(
    () => {
      const dots = document.querySelector('.thinking-dots');
      return dots && (dots.textContent || '').trim().length > 0;
    },
    null,
    { timeout: 3_000, polling: 50 },
  );

  const dotsState = await page.evaluate(() => {
    const dots = document.querySelector('.thinking-dots');
    return dots ? {
      exists: true,
      text: (dots.textContent || '').trim(),
      parentClass: dots.parentElement?.className || '',
    } : { exists: false };
  });
  assert(
    dotsState.exists,
    `.thinking-dots span should exist after send, got ${JSON.stringify(dotsState)}`,
  );
  assert(
    /agent|streaming/.test(dotsState.parentClass || ''),
    `.thinking-dots should be inside an agent/streaming bubble, parent class: ${JSON.stringify(dotsState.parentClass)}`,
  );
  log(`thinking-dots present: ${JSON.stringify(dotsState)} ✓`);
}
