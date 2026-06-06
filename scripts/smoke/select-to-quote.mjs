// Select-to-quote (P1): selecting text in a transcript bubble floats a
// "Quote" button; pressing it inserts the selection as a markdown
// blockquote into the composer, caret parked below for the reply.
//
// This smoke drives the full path:
//   1. Programmatically select text inside a seed bubble's .text span and
//      dispatch mouseup (mirrors what a real drag-select fires).
//   2. Assert the .quote-fab appears.
//   3. Press it (pointerdown — the handler the button listens on) and
//      assert the composer value gained `> <selected text>` plus a blank
//      line below for the reply.
//   4. Select a SECOND passage, quote again, and assert both quotes
//      accumulate as distinct `> ` blocks in the one composer message.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'select-to-quote';
export const DESCRIPTION = 'transcript selection → Quote button → markdown blockquote in composer; quotes accumulate';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-select-to-quote';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Select to quote test',
    messages: [
      { role: 'assistant',
        content: 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.',
        sidekick_id: 'amsg_select_seed',
        timestamp: Date.now() / 1000 - 60 },
    ],
    lastActiveAt: Date.now() - 1000,
  });
}

// Select `count` characters starting at `start` within the first text node
// of the seed bubble's .text span, then fire the mouseup that selectToQuote
// listens for. Returns the selected substring.
async function selectInBubble(page, start, count) {
  return await page.evaluate(({ start, count }) => {
    const span = document.querySelector('#transcript .line.agent .text');
    if (!span) throw new Error('seed bubble .text span not found');
    // Find the first text node holding the content.
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!node) throw new Error('no text node in bubble');
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, Math.min(start + count, node.textContent.length));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return sel.toString();
  }, { start, count });
}

async function pressQuoteFab(page) {
  await page.waitForFunction(() => {
    const fab = document.querySelector('.quote-fab');
    return fab && fab.style.display !== 'none';
  }, null, { timeout: 3_000, polling: 50 });
  await page.evaluate(() => {
    const fab = document.querySelector('.quote-fab');
    fab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(
    () => /quick brown fox/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 4_000, polling: 50 },
  );
  log('chat opened ✓');

  // First quote: "quick brown fox".
  const first = await selectInBubble(page, 4, 15);
  assert(first === 'quick brown fox', `unexpected first selection: "${first}"`);
  log(`selected: "${first}"`);
  await pressQuoteFab(page);

  await page.waitForFunction(
    () => (document.getElementById('composer-input')?.value || '').includes('> quick brown fox'),
    null, { timeout: 3_000, polling: 50 },
  );
  const afterFirst = await page.inputValue('#composer-input');
  assert(afterFirst.startsWith('> quick brown fox'), `composer missing quote block: ${JSON.stringify(afterFirst)}`);
  assert(/\n\n$/.test(afterFirst), `expected a blank line below the quote for the reply: ${JSON.stringify(afterFirst)}`);
  log('first quote inserted as blockquote with reply space ✓');

  // The fab should hide and the selection clear after quoting.
  const fabHidden = await page.evaluate(() => {
    const fab = document.querySelector('.quote-fab');
    return !fab || fab.style.display === 'none';
  });
  assert(fabHidden, 'quote-fab should hide after pressing it');

  // Type a reply, then accumulate a SECOND quote.
  await page.evaluate(() => {
    const el = document.getElementById('composer-input');
    el.value += 'my reply to the first';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const second = await selectInBubble(page, 44, 8); // "Pack my "
  log(`selected: "${second}"`);
  await pressQuoteFab(page);

  await page.waitForFunction(
    (sel) => {
      const v = document.getElementById('composer-input')?.value || '';
      return (v.match(/^> /gm) || []).length >= 2 && v.includes('> ' + sel.trim());
    },
    second,
    { timeout: 3_000, polling: 50 },
  );
  const afterSecond = await page.inputValue('#composer-input');
  const quoteLines = (afterSecond.match(/^> /gm) || []).length;
  assert(quoteLines >= 2, `expected ≥2 quote lines after accumulating, got ${quoteLines}: ${JSON.stringify(afterSecond)}`);
  assert(afterSecond.includes('my reply to the first'), 'reply text between quotes was lost');
  log('second quote accumulated into the same message ✓');
}
