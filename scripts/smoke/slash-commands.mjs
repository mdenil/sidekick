// Scenario: slash-command popover renders from the agent's
// /v1/commands catalog, filters as the user types, and dispatches
// the highlighted command on Enter — firing the local-clear callback
// for reset-shaped commands (/new, /reset, /clear).
//
// Test plan (mocked):
//   1. Configure mock.setCommandsCatalog([...]) with three entries
//      (/new, /clear, /voice) so we can exercise filter + alias
//      + dispatch.
//   2. Wait for ready; the PWA's onStatus(connected) handler fires
//      slashCommands.refresh() which GETs /api/sidekick/commands.
//   3. Type `/` into the composer. Assert .slash-popover renders +
//      contains at least 1 row (the catalog items).
//   4. Type `cle` (so composer reads `/cle`). Assert filter narrows
//      to /clear only.
//   5. Press Enter. Assert:
//      - composer cleared,
//      - reset-signal fired (renderedMessages cleared as the local
//        side-effect — verified by seeding a fake bubble before
//        Enter and asserting it's gone after).

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

  // Seed a fake chat line so we can verify renderedMessages.clear()
  // is invoked by the reset-signal callback.
  await page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (t) {
      const fake = document.createElement('div');
      fake.className = 'line agent test-fake-bubble';
      fake.textContent = 'pre-clear marker';
      t.appendChild(fake);
    }
  });
  const linesBefore = await page.locator('.test-fake-bubble').count();
  assert(linesBefore === 1, `seed: expected 1 fake bubble, got ${linesBefore}`);

  // Press Enter on /clear. Should:
  //  - Dispatch via slashCommands (POST /api/sidekick/messages with
  //    text=/clear),
  //  - Fire onResetSignal which clears renderedMessages — the fake
  //    bubble in #transcript SHOULD be wiped.
  //  - Close the popover, clear the composer.
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

  // Local-clear fired — fake bubble gone. (renderedMessages.clear
  // wipes #transcript children including our seed.)
  await page.waitForFunction(
    () => document.querySelectorAll('.test-fake-bubble').length === 0,
    null,
    { timeout: 2_000 },
  );
  const linesAfter = await page.locator('.test-fake-bubble').count();
  assert(linesAfter === 0, `expected fake bubble cleared, still ${linesAfter}`);
  log('reset-signal fired: fake bubble cleared ✓');
}
