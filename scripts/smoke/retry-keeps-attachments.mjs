// Field bug #224 (2026-06-12), part 2: when a send with an attachment
// fails ("Send failed." on bad cafe wifi), the Retry button restores
// the composer TEXT but silently drops the attachment (main.ts retry
// handler ignores pendingSend.attachments) — the user re-sends a
// text-only message without noticing.
//
// Fix under test: the retry handler re-attaches inline (data:) echo
// attachments from the pending send before restoring the text, so a
// second Send carries the same attachment.
//
// Test plan (mocked):
//   1. Attach a tiny PNG; fill text; send. The first POST to
//      /api/sidekick/messages is aborted at the network layer.
//   2. Wait for the "Send failed." row; click Retry.
//   3. Assert composer text is restored AND the attachment chip is
//      back (FAILS pre-fix: chip count 0).
//   4. Send again; assert the second POST carries the inline
//      data:image attachment.

import { waitForReady, openSettingsSection, assert } from './lib.mjs';

export const NAME = 'retry-keeps-attachments';
export const DESCRIPTION = 'Retry after a failed send restores the attachment, not just the text — re-send carries the same inline image';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export function MOCK_SETUP(mock) {
  mock.setSettingsSchema([
    {
      id: 'model',
      label: 'Model',
      description: 'LLM used for replies',
      category: 'Agent',
      type: 'enum',
      value: 'vendor/vision',
      options: [{ value: 'vendor/vision', label: 'Vision' }],
    },
  ]);
}

export default async function run({ page, log }) {
  await page.route('**/api/sidekick/auxiliary-models', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ vision: null }),
    });
  });
  await page.route('**/api/sidekick/model-capabilities*', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        provider: 'mock', model: 'vendor/vision', known: true,
        supports_vision: true, accepts_pdf: false,
        supports_tools: true, supports_reasoning: false,
        context_window: 200000, max_output_tokens: 8192, model_family: 'mock',
      }),
    });
  });

  let msgPosts = 0;
  await page.route('**/api/sidekick/messages', async (route) => {
    if (route.request().method() !== 'POST') { await route.fallback(); return; }
    msgPosts += 1;
    if (msgPosts === 1) { await route.abort('failed'); return; }
    await route.fallback();
  });

  await waitForReady(page);
  await openSettingsSection(page, 'agent');
  await page.waitForFunction(
    () => { const b = document.getElementById('btn-attach'); return b && !b.disabled; },
    null, { timeout: 5_000 },
  );

  // 1. Attach + send into the aborted POST.
  await page.setInputFiles('#attach-input', {
    name: 'receipt.png', mimeType: 'image/png', buffer: TINY_PNG,
  });
  await page.waitForSelector('#composer-attachments .attachment-chip', { timeout: 10_000 });
  await page.fill('#composer-input', 'expense this receipt please');
  await page.evaluate(() => document.getElementById('composer-send')?.click());

  // 2. Failure row appears; click Retry.
  await page.waitForSelector('.send-failed-row button', { timeout: 15_000 });
  log('send failed as staged ✓');
  // evaluate-click: the settings panel left open for model-caps gating
  // overlays the transcript and intercepts real pointer events.
  await page.evaluate(() => {
    const btn = document.querySelector('.send-failed-row button');
    if (btn instanceof HTMLElement) btn.click();
  });

  // 3. Text AND attachment must be restored.
  await page.waitForFunction(
    () => document.getElementById('composer-input')?.value === 'expense this receipt please',
    null, { timeout: 5_000 },
  );
  const chipRestored = await page
    .waitForSelector('#composer-attachments .attachment-chip', { timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  assert(chipRestored,
    'Retry must restore the attachment chip, not just the text (field bug: silent text-only re-send)');
  log('retry restored text + chip ✓');

  // 4. Re-send; the second POST must carry the inline image.
  // The first (aborted) POST is long done — a fresh waitForRequest only
  // sees the re-send.
  const secondReqP = page.waitForRequest(
    (req) => req.url().includes('/api/sidekick/messages') && req.method() === 'POST',
    { timeout: 15_000 },
  );
  await page.evaluate(() => document.getElementById('composer-send')?.click());
  const req2 = await secondReqP;
  const body2 = JSON.parse(req2.postData() || '{}');
  assert(Array.isArray(body2.attachments) && body2.attachments.length === 1,
    'retried send must carry exactly one attachment');
  assert(typeof body2.attachments[0].content === 'string'
    && body2.attachments[0].content.startsWith('data:image/'),
    'retried attachment must be the inline data:image payload');
  log('re-send carried the attachment inline ✓');
}
