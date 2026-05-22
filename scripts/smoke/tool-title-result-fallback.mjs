// Tool title fallback: durable result-only tool rows can lack tool_name
// while carrying useful identity inside the JSON result payload.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'tool-title-result-fallback';
export const DESCRIPTION = 'tool rows fall back to result.name/description when tool_name and args are missing';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-tool-title-result-fallback';
const LONG_RESULT_TAIL = 'FULL_RESULT_SENTINEL_TAIL';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT_ID, {
    title: 'Tool Title Result Fallback',
    messages: [
      { role: 'user', content: 'show tool title fallback', sidekick_id: 'umsg_tool_title_fallback', timestamp: t0 },
      {
        role: 'tool',
        content: JSON.stringify({
          success: true,
          name: 'gog',
          description: 'Google Workspace CLI for Gmail, Calendar, Docs.',
          details: 'This long result should remain readable when the row is expanded. ' +
            'x'.repeat(700) + LONG_RESULT_TAIL,
        }),
        tool_call_id: 'call_gog_result_only',
        timestamp: t0 + 1,
      },
    ],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForSelector('.tool-row-summary', { timeout: 4_000 });
  const title = await page.evaluate(() => document.querySelector('.tool-row-summary')?.textContent || '');
  assert(title.includes('gog'), `expected fallback tool name gog, got ${JSON.stringify(title)}`);
  assert(title.includes('Google Workspace'), `expected fallback description, got ${JSON.stringify(title)}`);
  assert(!title.includes('undefined'), `tool title should not include undefined, got ${JSON.stringify(title)}`);
  await page.click('.tool-row-summary');
  const resultText = await page.evaluate(() => document.querySelector('.tool-result-text')?.textContent || '');
  assert(resultText.includes(LONG_RESULT_TAIL), 'expanded tool result should include the full long result tail');
  log('result-only tool row title used result.name + result.description and full expanded result text ✓');
}
