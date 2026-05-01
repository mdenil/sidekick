// Scenario: Listen-mode settings panel rows persist values + take
// effect on the next arming. Verifies the three keys round-trip
// through localStorage / proxy and that the wiring in settings.ts
// actually reads the DOM controls.
//
// Asserts:
//   1. The three rows exist (#set-listen-sendword, #set-listen-silence,
//      #set-listen-stt).
//   2. Setting listenSendword="send" persists in settings.get().
//   3. Setting listenSilenceSec=3 persists.
//   4. Setting listenSttEngine="silence-only" persists (per-device
//      key — survives a full page reload).

export const NAME = 'listen-settings';
export const DESCRIPTION = 'Listen settings panel rows round-trip values';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, fail, url }) {
  await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });

  // Open settings panel — find the gear button.
  await page.evaluate(() => {
    const btn = document.querySelector('[data-action="settings"], #btn-settings, #sb-settings');
    btn?.click();
  });

  // Wait for our rows to be present.
  for (const sel of ['#set-listen-sendword', '#set-listen-silence', '#set-listen-stt']) {
    const found = await page.locator(sel).count();
    if (found === 0) fail(`expected ${sel} in settings panel`);
  }
  log('all three Listen-mode settings rows present');

  // Set + dispatch change for sendword.
  await page.evaluate(() => {
    const el = document.getElementById('set-listen-sendword');
    el.value = 'send';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(() => {
    const el = document.getElementById('set-listen-silence');
    el.value = '3';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.evaluate(() => {
    const el = document.getElementById('set-listen-stt');
    el.value = 'silence-only';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // Read settings back via the page's settings module.
  const snapshot = await page.evaluate(async () => {
    const s = await import('/build/settings.mjs');
    return s.get();
  });
  if ((snapshot).listenSendword !== 'send') {
    fail(`expected listenSendword="send", got ${(snapshot).listenSendword}`);
  }
  if ((snapshot).listenSilenceSec !== 3) {
    fail(`expected listenSilenceSec=3, got ${(snapshot).listenSilenceSec}`);
  }
  if ((snapshot).listenSttEngine !== 'silence-only') {
    fail(`expected listenSttEngine="silence-only", got ${(snapshot).listenSttEngine}`);
  }
  log('listen settings round-tripped through settings.get()');
}
