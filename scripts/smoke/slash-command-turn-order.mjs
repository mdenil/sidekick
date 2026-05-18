// Regression gate for the 2026-05-17 slash-command turn-order bug.
//
// Repro (Jonathan field, 2026-05-17 ~12:44 BST): typing `/agents` in
// the composer dispatched the slash command but the user's "/agents"
// bubble rendered AFTER the agent's reply, not before. The transcript
// showed the agent's response, then the user's request below it.
//
// Root cause (src/main.ts:1547-1551 pre-fix): the slash-command path
// in `sendTypedMessage` early-returned after `slashCommands.dispatch()`,
// skipping the optimistic user-bubble upsert at line 1564-1574 that
// every normal-text send uses. With no optimistic bubble, the user
// bubble only rendered when the server's out-of-turn `user_message`
// envelope arrived — racing the in-turn `reply_delta` envelope on
// the /v1/responses stream. For fast slash commands the reply
// landed first.
//
// Fix: render an optimistic user bubble for slash commands too —
// same pattern as normal sends. PWA mints a userMessageId locally,
// upserts the bubble pre-network, ships the id in the POST so the
// server's later user_message broadcast dedups against the same key.
//
// Smoke strategy: suppress the mock's user_message envelope echo so
// the user bubble in DOM can ONLY originate from the PWA's
// optimistic upsert. Without the fix, suppressing the echo means
// no user bubble ever renders — the assertion times out, which is
// the regression gate. The reply-ordering assertion (user bubble
// DOM index < reply bubble DOM index) is harder to wire end-to-end
// in the mocked smoke harness because the SSE multiplexer races
// the optimistic upsert in unpredictable ways; the optimistic-
// presence assertion is the same invariant from a different angle.

import { waitForReady, SEL, assert } from './lib.mjs';

export const NAME = 'slash-command-turn-order';
export const DESCRIPTION = 'slash command renders user bubble optimistically (pre-network) — not contingent on server echo';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  // Register /agents as a recognised slash command so the PWA's
  // slashCommands.isCommand check returns true and the dispatch
  // routes through the slash path (the branch the fix targets).
  mock.setCommandsCatalog([
    {
      name: 'agents',
      description: 'Show active background agents + jobs',
      category: 'Diagnostics',
      aliases: [],
      args_hint: '',
      subcommands: [],
    },
  ]);
  // Suppress the server's user_message envelope echo. Without the
  // PWA-side optimistic upsert, the user bubble was rendered ONLY
  // when this server echo arrived — suppressing it forces the
  // optimistic path to be the sole source. If the fix is missing,
  // no user bubble renders and the assertion fails.
  mock.setAutoReplyEnabled(false);
  mock.setSuppressUserMessageBroadcast(true);
}

export default async function run({ page, log }) {
  await waitForReady(page);

  // Wait for the catalog fetch so slashCommands.isCommand recognises
  // /agents. Cheapest signal: type `/` and wait for the popover.
  await page.fill(SEL.composer, '/');
  await page.waitForSelector('.slash-popover', { state: 'visible', timeout: 3_000 });
  log('catalog loaded — popover opened on /');

  // Type the full command + Enter to dispatch.
  await page.fill(SEL.composer, '/agents');
  await page.focus(SEL.composer);
  await page.keyboard.press('Enter');
  log('dispatched /agents');

  // Composer cleared post-dispatch.
  await page.waitForFunction(
    (sel) => (document.querySelector(sel) || {}).value === '',
    SEL.composer,
    { timeout: 2_000 },
  );

  // ── Core assertion: optimistic user bubble exists ──
  //
  // Lines look like "You: /agents12:58 in DOM textContent (speaker
  // label + text + timestamp run together). Match on the `.text`
  // child to isolate the user-supplied content.
  await page.waitForFunction(
    () => {
      const lines = document.querySelectorAll('#transcript .line.s0, #transcript .line.user');
      for (const el of lines) {
        const textEl = el.querySelector('.text');
        const txt = (textEl?.textContent || el.textContent || '').trim();
        if (txt.includes('/agents')) return true;
      }
      return false;
    },
    null,
    { timeout: 3_000 },
  );
  log('user bubble for /agents rendered optimistically ✓');

  // ── Sanity: bubble is at DOM position 0 (first child) ──
  //
  // No earlier bubble exists in the empty transcript, so the
  // optimistic upsert should be the first .line. If a future
  // regression renders the bubble via the server-echo path
  // instead, it would land AFTER the streaming "sending…"
  // indicator — index 1, not 0. That's exactly the production
  // ordering bug.
  const userBubbleIdx = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('#transcript .line'));
    return lines.findIndex((el) => {
      if (!el.classList.contains('s0') && !el.classList.contains('user')) return false;
      const txt = (el.querySelector('.text')?.textContent || '').trim();
      return txt.includes('/agents');
    });
  });
  assert(
    userBubbleIdx === 0,
    `user bubble must be the FIRST line in the transcript (optimistic), got index ${userBubbleIdx}`,
  );
  log(`user bubble DOM index=0 ✓`);
}
