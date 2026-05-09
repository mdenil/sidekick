// Scenario: slash-command popover renders from the agent's
// /v1/commands catalog, filters as the user types, and dispatches
// the highlighted command on Enter — firing the local reset-signal
// for reset-shaped commands (/new, /reset, /clear).
//
// Reset-signal semantics changed 2026-05-04 (main.ts:1428-1450):
// it NO LONGER wipes renderedMessages/transcript. Doing so caused
// a "lost history!" panic — server-side session_reset mints a fresh
// session_id but keeps the chat_id, so history is still visible
// post-reset. Right behavior: leave rendered scroll alone, drop a
// "— context reset, agent forgot prior turns —" system delimiter
// so the user sees where the boundary is. This test was inverted to
// match: assert the system delimiter line appears, NOT that the
// transcript is wiped.
//
// Test plan (mocked):
//   1. Configure mock.setCommandsCatalog([...]) with three entries.
//   2. Wait for ready (catalog GET fires on connect).
//   3. Type `/` → assert popover with rows.
//   4. Type `/cle` → assert filter narrows to /clear.
//   5. Enter → assert:
//      - composer cleared,
//      - popover closed,
//      - "context reset" system line appears in transcript.

import { waitForReady, SEL, assert } from './lib.mjs';

export const NAME = 'slash-commands';
export const DESCRIPTION = 'Slash-command popover renders from /v1/commands, filters, and dispatches with reset-signal';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(mock) {
  mock.setCommandsCatalog([
    {
      name: 'new', description: 'Start a new session', category: 'Session',
      aliases: ['reset'], args_hint: '', subcommands: [],
    },
    {
      name: 'clear', description: 'Clear the current chat', category: 'Session',
      aliases: [], args_hint: '', subcommands: [],
    },
    {
      name: 'voice', description: 'Toggle voice mode', category: 'Configuration',
      aliases: [], args_hint: '[on|off|tts|status]',
      subcommands: ['on', 'off', 'tts', 'status'],
    },
  ]);
}

export default async function run({ page, log }) {
  await waitForReady(page);

  // Wait for the catalog fetch to land. Cheap polling — we just need
  // catalog.length>0 inside slashCommands. The module exposes nothing
  // publicly for this, so we rely on `/` opening the popover.
  await page.fill(SEL.composer, '/');
  // The popover opens on the first keystroke after catalog arrival.
  // Give it a generous wait for the round-trip.
  await page.waitForSelector('.slash-popover', { state: 'visible', timeout: 3_000 });
  log('popover opened on /');

  // Assert at least one row rendered.
  const rowCount0 = await page.locator('.slash-popover-row').count();
  assert(rowCount0 >= 1, `expected >=1 popover row, got ${rowCount0}`);
  log(`popover rendered ${rowCount0} rows`);

  // Type `cle` (so composer reads `/cle`) — should narrow to /clear.
  await page.fill(SEL.composer, '/cle');
  await page.waitForFunction(
    () => {
      const rows = Array.from(document.querySelectorAll('.slash-popover-row'));
      return rows.length === 1 && /\/clear/.test(rows[0].textContent || '');
    },
    null,
    { timeout: 2_000 },
  );
  const rowCount1 = await page.locator('.slash-popover-row').count();
  assert(rowCount1 === 1, `expected 1 row after filter, got ${rowCount1}`);
  log('filter narrowed to /clear');

  // Press Enter on /clear. Should:
  //  - Dispatch via slashCommands (POST /api/sidekick/messages with text=/clear).
  //  - Fire onResetSignal → adds the "context reset" system delimiter
  //    line (NOT a renderedMessages.clear — see file header).
  //  - Close the popover + clear the composer.
  await page.focus(SEL.composer);
  await page.keyboard.press('Enter');

  // Popover closed.
  await page.waitForFunction(
    () => {
      const p = document.querySelector('.slash-popover');
      return !p || p.style.display === 'none';
    },
    null,
    { timeout: 2_000 },
  );
  log('popover closed after Enter');

  // Composer cleared.
  const composerVal = await page.locator(SEL.composer).inputValue();
  assert(composerVal === '', `composer should be empty post-dispatch, got ${JSON.stringify(composerVal)}`);
  log('composer cleared');

  // Reset-signal fired — the "— context reset, agent forgot prior
  // turns —" delimiter line should appear in the transcript. Used to
  // verify by checking renderedMessages.clear wiped a seeded bubble;
  // that semantics was retired (see file header), and the delimiter
  // line is the right post-2026-05-04 signal.
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('#transcript .line.system'))
      .some(el => /context reset/i.test(el.textContent || '')),
    null,
    { timeout: 3_000 },
  );
  log('reset-signal fired: "context reset" delimiter line rendered ✓');
}
