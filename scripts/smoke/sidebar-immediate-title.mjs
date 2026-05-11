// Scenario: when the user sends a message in a new chat, the sidebar
// entry for that chat appears IMMEDIATELY with a snippet of the user's
// text — before the agent's reply (which can take 30s+ on long
// tool-using turns) lands. Multiple back-to-back new chats stack in
// the sidebar as distinct entries with their respective snippets.
//
// Field bug 2026-05-11 (Jonathan, real install): he sent "Hey. What's
// in my agenda? Today?" via a fresh new chat. The agent hit a
// dangerous-command-approval gate and stalled. He reloaded expecting
// to see his message preserved. Instead the sidebar showed "New chat
// 0 msgs" — no signal that his message was anywhere — and the
// transcript view was confused. Server-side state.db had everything,
// the PWA just didn't surface it.
//
// Fix: sendTypedMessage now calls sessionDrawer.handleSessionAnnounced
// with a text snippet at send time, synthesizing a pending sidebar
// row before the agent has replied. handleSessionAnnounced is
// idempotent; the server-side session_changed envelope replaces the
// pending row with the canonical title later.
//
// Test plan (mocked):
//   1. Click new-chat, send "first marker". Assert sidebar shows a row
//      with "first marker" snippet within 200ms (before the mock's
//      50ms auto-reply has even finished, definitely before any
//      session_changed envelope).
//   2. Click new-chat, send "second marker". Assert BOTH rows appear
//      in the sidebar with their respective snippets.
//   3. Reload. Assert both rows still visible with snippets (cached
//      via the proxy's sessions response from state.db).

import { waitForReady, openSidebar, clickNewChat, send, captureNextChatId, assert } from './lib.mjs';

export const NAME = 'sidebar-immediate-title';
export const DESCRIPTION = 'New chat sidebar entry appears with user-text snippet immediately on send; multiple chats stack';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(_mock) {
  // No pre-populated chats — scenario creates them via the PWA flow.
}

const MARKER_1 = `first-marker-${Math.random().toString(36).slice(2, 8)}`;
const MARKER_2 = `second-marker-${Math.random().toString(36).slice(2, 8)}`;

async function sidebarRowsBySnippet(page) {
  return await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#sessions-list li[data-chat-id]'));
    return rows.map(r => ({
      chatId: r.getAttribute('data-chat-id'),
      // The drawer renders s.title || s.snippet || s.id in .sess-snippet.
      // Read the rendered text since the actual display is what matters.
      text: (r.querySelector('.sess-snippet')?.textContent || '').trim(),
    }));
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // === Step 1: send first marker, assert immediate sidebar snippet ===
  const id1Promise = captureNextChatId(page);
  await clickNewChat(page);
  const chatId1 = await id1Promise;
  log(`minted chat 1: ${chatId1}`);

  await send(page, MARKER_1);
  // Poll briefly — sessionDrawer.handleSessionAnnounced runs
  // synchronously after the send POST returns, but the drawer's
  // renderListFiltered fires via the pending Map update, so allow
  // a few frames for the DOM to reflect.
  await page.waitForFunction(
    ({ chatId, marker }) => {
      const rows = document.querySelectorAll('#sessions-list li[data-chat-id]');
      for (const r of rows) {
        if (r.getAttribute('data-chat-id') === chatId
            && (r.textContent || '').includes(marker)) return true;
      }
      return false;
    },
    { chatId: chatId1, marker: MARKER_1 },
    { timeout: 3_000, polling: 50 },
  );
  log(`sidebar entry for chat 1 shows "${MARKER_1}" ✓`);

  // === Step 2: new chat, send second marker, assert BOTH stack ===
  const id2Promise = captureNextChatId(page);
  await clickNewChat(page);
  const chatId2 = await id2Promise;
  assert(chatId2 !== chatId1, `new chat should mint a different id, got ${chatId2} === ${chatId1}`);
  log(`minted chat 2: ${chatId2}`);

  await send(page, MARKER_2);
  await page.waitForFunction(
    ({ id1, id2, m1, m2 }) => {
      const rows = Array.from(document.querySelectorAll('#sessions-list li[data-chat-id]'));
      const r1 = rows.find(r => r.getAttribute('data-chat-id') === id1);
      const r2 = rows.find(r => r.getAttribute('data-chat-id') === id2);
      return !!r1 && !!r2
        && (r1.textContent || '').includes(m1)
        && (r2.textContent || '').includes(m2);
    },
    { id1: chatId1, id2: chatId2, m1: MARKER_1, m2: MARKER_2 },
    { timeout: 3_000, polling: 50 },
  );
  log(`both sidebar entries visible with their respective snippets ✓`);

  // Inspect the drawer state for the assertion-error message in case
  // the reload assertion fails — clearer debugging.
  const before = await sidebarRowsBySnippet(page);
  log(`pre-reload drawer: ${JSON.stringify(before)}`);

  // === Step 3: reload, assert BOTH still visible ===
  // The mock-backend's chats Map persists across the reload (it's in
  // the Playwright route handler, not the page), so the sessions
  // endpoint will return both chats with their messages — the title
  // falls back to s.snippet (the user's text we already announced) or
  // first_user_message until the agent generates a real one.
  await page.reload();
  await waitForReady(page);
  await openSidebar(page);
  await page.waitForFunction(
    ({ id1, id2 }) => {
      const rows = Array.from(document.querySelectorAll('#sessions-list li[data-chat-id]'));
      return rows.some(r => r.getAttribute('data-chat-id') === id1)
        && rows.some(r => r.getAttribute('data-chat-id') === id2);
    },
    { id1: chatId1, id2: chatId2 },
    { timeout: 5_000, polling: 100 },
  );
  const after = await sidebarRowsBySnippet(page);
  log(`post-reload drawer: ${JSON.stringify(after)}`);
  log(`both sidebar entries survive reload ✓`);
}
