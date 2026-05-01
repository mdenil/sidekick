// Pin the b011aa4 feature: switching the model in the settings panel
// surfaces a system line in the chat listing the freshly-selected
// model's input modalities, so the user knows immediately whether
// image / pdf / audio attachments will work.
//
// Behaviour:
//   - Reads from /api/sidekick/model-modalities (proxy-served snapshot
//     of the OpenRouter catalog) when the model is in the map.
//   - Falls back to a "(heuristic)" hint via isVisionCapableModel when
//     the model is local-only (not in OpenRouter).
//
// Test plan (mocked):
//   1. Mock /api/sidekick/model-modalities with two known entries.
//   2. setSettingsSchema with a model enum carrying both ids + a
//      third local-only id that the regex would call vision-capable.
//   3. Open settings → trigger schema load.
//   4. Flip the model select to entry A; assert a `.line.system`
//      appears with text matching `Model: <id> — accepts <inputs>`
//      where <inputs> equals the joined modalities.
//   5. Flip to entry B (different modalities); assert another system
//      line lands with the new model's modalities.
//   6. Flip to the heuristic-fallback id; assert the line says
//      `(heuristic)` since it's not in the modalities map.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'model-switch-system-line';
export const DESCRIPTION = 'Model switch surfaces a system line listing accepted input modalities';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

// Two ids in the modalities map + one that isn't (forcing the regex
// fallback path). The fallback id starts with `claude-` so the
// isVisionCapableModel regex returns true → "(heuristic)" hint with
// 'text, image' as inputs.
const MOCK_MODALITIES = {
  fetched_at: '2026-05-01T00:00:00Z',
  modalities: {
    'mock/multi-everything': ['text', 'image', 'file', 'audio'],
    'mock/text-only': ['text'],
  },
};

export function MOCK_SETUP(mock) {
  mock.setSettingsSchema([
    {
      id: 'model',
      label: 'Model',
      description: 'LLM used for replies',
      category: 'Agent',
      type: 'enum',
      value: 'mock/multi-everything',
      options: [
        { value: 'mock/multi-everything', label: 'Multi-modal mock' },
        { value: 'mock/text-only', label: 'Text-only mock' },
        { value: 'local/claude-fake-vision', label: 'Local heuristic-vision' },
      ],
    },
  ]);
}

async function setModelTo(page, value) {
  await page.evaluate((v) => {
    const sel = document.querySelector('[data-agent-setting="model"] select');
    if (!sel) throw new Error('model select not found');
    sel.value = v;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function waitForSystemLine(page, predicate, timeout = 4_000) {
  await page.waitForFunction(
    (pred) => {
      // page.evaluate stringifies, so re-build the predicate on the
      // page side. Caller passes a substring or regex source; we
      // accept either.
      const lines = Array.from(document.querySelectorAll('#transcript .line.system'));
      const re = new RegExp(pred);
      return lines.some((l) => re.test(l.textContent || ''));
    },
    predicate,
    { timeout, polling: 50 },
  );
}

export default async function run({ page, log }) {
  await page.route('**/api/sidekick/model-modalities', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_MODALITIES),
    });
  });

  await waitForReady(page);

  // Open settings panel → triggers agentSettings.load → schema fetch
  // → model select rendered.
  await page.click('#sb-settings');
  await page.waitForFunction(
    () => document.getElementById('settings')?.classList.contains('on'),
    null,
    { timeout: 2_000 },
  );
  await page.waitForSelector('[data-agent-setting="model"] select', { timeout: 3_000 });
  log('settings panel opened, model select rendered');

  // Switch to text-only — agent-setting-changed fires, addSystemLine runs.
  await setModelTo(page, 'mock/text-only');
  await waitForSystemLine(
    page,
    'Model: mock/text-only — accepts text(?!,)',
  );
  log('text-only model: system line shows "accepts text" ✓');

  // Switch to multi-everything — system line lists all 4 modalities.
  await setModelTo(page, 'mock/multi-everything');
  await waitForSystemLine(
    page,
    'Model: mock/multi-everything — accepts text, image, file, audio',
  );
  log('multi-modal model: system line lists all 4 modalities ✓');

  // Switch to the local-only id → heuristic fallback (regex matches
  // "claude" prefix → "text, image (heuristic)").
  await setModelTo(page, 'local/claude-fake-vision');
  await waitForSystemLine(
    page,
    'Model: local/claude-fake-vision — accepts text, image \\(heuristic\\)',
  );
  log('local model: system line shows heuristic-fallback ✓');

  // Final assertion: at least 3 system lines for the 3 model switches.
  const systemLineCount = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('#transcript .line.system'));
    return lines.filter((l) => /^Model:/.test(l.textContent || '')).length;
  });
  assert(
    systemLineCount >= 3,
    `expected ≥3 "Model:" system lines (one per switch), got ${systemLineCount}`,
  );
  log(`${systemLineCount} model-switch system lines rendered ✓`);
}
