// Pin cursor-aware injection in dictate mode (the streaming branch of
// btn-mic). Streaming-on means live STT writes finals/interims into
// the composer textarea AT the user's caret, not appended.
//
// Test plan (mocked, no real WebRTC):
//   1. Pre-fill the composer textarea with "before  after" and place
//      the caret between the two words at offset 7.
//   2. Open a dictate session with a MockSTTProvider so we can fire
//      synthetic transcript events without standing up a real STT pipe.
//   3. Fire an interim, then an `is_final` for "middle". Each event
//      is dispatched through the provider's listener, which is what
//      dictate.ts subscribes to via onTranscript.
//   4. Assert the textarea now contains "before middle after" — the
//      final landed AT the caret, not appended.
//   5. Assert the caret is now positioned at the end of the inserted
//      text (anchor + committedLen, mirroring the user's typing
//      mental model).
//
// The dictate.ts module exposes a `provider` opt on start() specifically
// for tests like this (see its top-level docstring).

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'dictate-cursor-injection';
export const DESCRIPTION = 'Streaming-mode is_final lands at composer caret, not appended';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log }) {
  await waitForReady(page);

  // Pre-fill the composer textarea + place the caret between the two
  // words. The textarea must be focused for the caret-set to "stick"
  // in a way dictate.ts's ensureAnchor() can read from selectionStart.
  const PRE_TEXT = 'before  after';  // two spaces between words
  const CARET_AT = 7;                 // points at the second space
  await page.evaluate((args) => {
    const ta = document.getElementById('composer-input');
    if (!ta) throw new Error('composer-input not found');
    ta.focus();
    ta.value = args.text;
    ta.setSelectionRange(args.at, args.at);
    // Fire input event so any auto-resize / send-button-state listeners
    // see the updated value (matches the textarea-typed-by-user shape).
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, { text: PRE_TEXT, at: CARET_AT });

  log(`composer pre-fill: "${PRE_TEXT}" with caret at offset ${CARET_AT}`);

  // Drive dictate.ts directly with a MockSTTProvider — no WebRTC, no
  // network. The provider exposes a `fire(ev)` hook so the test can
  // inject transcript events.
  await page.evaluate(async () => {
    const dictate = await import('/build/audio/realtime/dictate.mjs');

    // Simple mock implementing the STTProvider interface.
    class MockSTTProvider {
      constructor() { this.listener = null; }
      async start() { /* no-op — nothing real to spin up */ }
      async stop() { /* no-op */ }
      onTranscript(cb) {
        this.listener = cb;
        return () => { if (this.listener === cb) this.listener = null; };
      }
      // Test-only entry point: inject an event into the listener.
      fire(ev) {
        if (this.listener) this.listener(ev);
      }
    }

    const provider = new MockSTTProvider();
    // Stash on window so the test can call fire() outside this scope.
    window.__dictateMock = provider;

    // initialCursor = the caret offset captured at gesture site (here:
    // the value we pre-set above). dictate.ts's ensureAnchor uses this
    // as the splice point for the first interim/final.
    await dictate.start({
      sessionId: null,
      initialCursor: 7,
      provider,
    });
  });

  // Fire an interim first (mirrors how Deepgram streams: interim
  // refines, then is_final locks in). Both should land at offset 7.
  await page.evaluate(() => {
    window.__dictateMock.fire({
      type: 'transcript',
      role: 'user',
      is_final: false,
      text: 'mid',
    });
  });

  let after = await page.evaluate(() => {
    const ta = document.getElementById('composer-input');
    return { value: ta.value, selStart: ta.selectionStart, selEnd: ta.selectionEnd };
  });
  log(`after interim "mid": value=${JSON.stringify(after.value)} caret=${after.selStart}`);
  assert(
    after.value.startsWith('before') && after.value.includes('mid') && after.value.endsWith(' after'),
    `interim should splice at offset 7; got ${JSON.stringify(after.value)}`,
  );

  // Now fire the final — should replace the interim in place with
  // "middle" + advance committedLen.
  await page.evaluate(() => {
    window.__dictateMock.fire({
      type: 'transcript',
      role: 'user',
      is_final: true,
      text: 'middle',
    });
  });

  after = await page.evaluate(() => {
    const ta = document.getElementById('composer-input');
    return { value: ta.value, selStart: ta.selectionStart, selEnd: ta.selectionEnd };
  });
  log(`after final "middle": value=${JSON.stringify(after.value)} caret=${after.selStart}`);

  // Expectations:
  //   - "middle" appears between "before" and "after" (insertion site
  //     was offset 7).
  //   - "before" stays at the start (no leak from the prefix we typed).
  //   - "after" stays at the end (no overwrite of the suffix).
  //   - caret has advanced past "middle" — sits at the end of the
  //     committed segment so the user's next keystroke lands there.
  assert(
    after.value.startsWith('before'),
    `final should preserve prefix "before"; got ${JSON.stringify(after.value)}`,
  );
  assert(
    after.value.endsWith(' after'),
    `final should preserve suffix " after"; got ${JSON.stringify(after.value)}`,
  );
  assert(
    after.value.includes('middle'),
    `final should contain the dictated word "middle"; got ${JSON.stringify(after.value)}`,
  );
  // Caret should be inside the inserted span (between "before" + " after"),
  // not at position 0 (start) or value.length (end).
  assert(
    after.selStart > CARET_AT && after.selStart < after.value.length,
    `caret should advance past inserted text + sit before suffix; was ${after.selStart} in ${JSON.stringify(after.value)}`,
  );
  log(`cursor-aware injection landed "middle" between "before" and "after" with caret at ${after.selStart} ✓`);

  // Tear down.
  await page.evaluate(async () => {
    const dictate = await import('/build/audio/realtime/dictate.mjs');
    await dictate.stop();
    delete window.__dictateMock;
  });
}
