// Pins the dictateRealtime toggle (#112): a mic-button TAP must route to
// batch-memo transcription when realtime dictation is OFF, and to live
// streaming dictation when it's ON.
//
// Why: per-pause streaming finals over-punctuate long-form speech. The
// fix lets the user flip dictation to "record the whole utterance, batch
// one /transcribe on stop, drop the clean transcript into the composer
// WITHOUT auto-send". That OFF path reuses the memo/outbox pipeline via
// startDictate → startMemo(false) (the fork lives in main.ts startDictate).
//
// The streaming-ON injection path is covered by dictate-cursor-injection
// and the memo→composer half by memo-outbox-flow; THIS test pins the new
// contract — that startDictate consults settings.dictateRealtime and
// forks accordingly. Observable: the `.memo-bar` recording UI appears ONLY
// on the OFF path; on the OFF path the stopped recording's transcript
// lands in the composer and is NOT submitted.
//
// Driven via window.__micDispatch (a test hook mirroring window.__listen)
// so we exercise the real startMicMode('tap') dispatch without
// synthesizing pointer-gesture timing. /transcribe is stubbed; the shared
// browser's fake media device satisfies getUserMedia + MediaRecorder.

import { waitForReady, resetServerSettings, assert } from './lib.mjs';

export const NAME = 'dictate-realtime-toggle';
export const DESCRIPTION = 'Mic tap forks on settings.dictateRealtime: OFF → batch memo into composer (no auto-send), ON → live streaming dictation (no memo bar)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const setDictateRealtime = (page, value) =>
  page.evaluate(async (v) => {
    const settings = await import('/build/settings.mjs');
    settings.set('dictateRealtime', v);
    return settings.get().dictateRealtime;
  }, value);

const composerValue = (page) =>
  page.evaluate(() => document.getElementById('composer-input')?.value ?? '');

const memoBarPresent = (page) =>
  page.evaluate(() => !!document.querySelector('.memo-bar'));

const userBubbleCount = (page, text) =>
  page.evaluate((t) =>
    Array.from(document.querySelectorAll('#transcript .line.s0'))
      .filter((el) => el.dataset?.text === t || el.textContent.includes(t)).length,
    text);

export default async function run({ page, log }) {
  await waitForReady(page);
  await resetServerSettings(page, { streamingEngine: 'server', tts: false });

  const TRANSCRIPT = 'this is a long form dictation that should not auto send';
  await page.route(/\/transcribe(\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, transcript: TRANSCRIPT }),
    }),
  );

  // ── OFF: tap routes to memo (batch) — recording bar appears ──────────
  const offVal = await setDictateRealtime(page, false);
  assert(offVal === false, `expected dictateRealtime=false in-memory, got ${offVal}`);

  await page.evaluate(() => window.__micDispatch('tap'));
  await page.waitForSelector('.memo-bar', { timeout: 8_000 });
  assert(await memoBarPresent(page),
    'OFF: a mic tap with dictateRealtime=false must enter memo (batch) mode — the .memo-bar recording UI never appeared, so startDictate did not fork to startMemo.');
  log('OFF ✓ tap entered memo recording mode (.memo-bar present)');

  // Let MediaRecorder capture a few hundred ms of (silent fake-device)
  // audio before stopping — an instant stop yields a null/empty blob and
  // handleMemoResult would have nothing to transcribe.
  await page.waitForTimeout(600);

  // Stop the recording the way the user does — click the composer send
  // button (startMemo wires its onclick to memo.stop → handleMemoResult
  // with autoSend=false). The transcript should land in the composer
  // and NOT be submitted.
  await page.evaluate(() => document.getElementById('composer-send')?.click());
  await page.waitForFunction(
    (t) => (document.getElementById('composer-input')?.value ?? '').includes(t),
    TRANSCRIPT, { timeout: 8_000 },
  );
  assert((await composerValue(page)).includes(TRANSCRIPT),
    'OFF: stopped batch recording should drop the transcript into the composer');
  assert((await userBubbleCount(page, TRANSCRIPT)) === 0,
    'OFF: batch dictation must NOT auto-send — no user bubble should appear');
  assert(!(await memoBarPresent(page)),
    'OFF: the memo bar should be torn down after the recording is sent');
  log('OFF ✓ transcript landed in composer, not submitted');

  // ── ON: tap routes to live streaming dictation — no memo bar ─────────
  // Clear the composer so a stray match can't pass the ON assertion.
  await page.evaluate(() => {
    const ta = document.getElementById('composer-input');
    if (ta) { ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  const onVal = await setDictateRealtime(page, true);
  assert(onVal === true, `expected dictateRealtime=true in-memory, got ${onVal}`);

  await page.evaluate(() => window.__micDispatch('tap'));
  // Give the dispatch a beat to either open the streaming session or (the
  // bug) fall into memo. The streaming path never mounts a .memo-bar.
  await page.waitForTimeout(1_000);
  assert(!(await memoBarPresent(page)),
    'ON: a mic tap with dictateRealtime=true must use live streaming dictation, NOT memo — a .memo-bar appeared, so the fork ignored the toggle.');
  log('ON ✓ tap did NOT enter memo mode (streaming dictation path)');

  log('PASS: dictateRealtime gates the mic-tap dispatch (OFF=batch-memo→composer, ON=streaming)');
}
