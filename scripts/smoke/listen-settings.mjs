// Scenario: Listen-mode settings panel persists the per-device STT
// engine. Used to also pin the Sendword + Silence-cutoff rows; those
// were retired when listenSendword/listenSilenceSec collapsed into the
// canonical commitPhrase + silenceSec keys (shared between both audio
// modes via src/audio/shared/handsfree.ts) — STT engine is the only
// genuinely Listen-only setting now.
//
// Asserts:
//   1. The #set-listen-stt row exists.
//   2. Setting listenSttEngine="silence-only" persists in settings.get()
//      (per-device key — survives a full page reload).

import { waitForReady } from './lib.mjs';

export const NAME = 'listen-settings';
export const DESCRIPTION = 'Listen settings panel rows round-trip values';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, fail, url }) {
  // waitForReady (vs bare goto+waitForSelector) holds until the body
  // shows "Connected", which rides past the cold-SW-activation reload
  // that boot does on first install. Without it, change-event handlers
  // for #set-listen-stt aren't wired yet when the test fires the event.
  await waitForReady(page, url);

  // Open settings panel — find the gear button.
  await page.evaluate(() => {
    const btn = document.querySelector('[data-action="settings"], #btn-settings, #sb-settings');
    btn?.click();
  });

  // The remaining Listen-only row is the STT engine selector.
  const found = await page.locator('#set-listen-stt').count();
  if (found === 0) fail('expected #set-listen-stt in settings panel');
  log('Listen STT engine row present');

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
  if ((snapshot).listenSttEngine !== 'silence-only') {
    fail(`expected listenSttEngine="silence-only", got ${(snapshot).listenSttEngine}`);
  }
  log('listenSttEngine round-tripped through settings.get()');
}
