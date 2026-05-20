// Settings → Notifications panel: every checkbox label must be
// distinct. Field bug 2026-05-13 (Jonathan): two separate toggles
// both labeled "Push notifications" — one drove
// pushManager.subscribe (master) and one drove the per-kind filter
// for `notification`-class envelopes. Visually identical, no way
// to tell which one Jonathan was clicking, and a confused
// off→on toggle of the wrong one looked like "push notifications
// stopped working" because the master ended up off.
//
// This is a pure-DOM gate. Walks every <label> inside the
// notifications settings group, asserts no two share the same
// trimmed text. Cheap, fast, catches any future drift where
// someone adds a third toggle with a too-generic label.
//
// Also asserts the master-toggle `for=` points at `#set-push`
// (the subscribe toggle) — the other anchor would be a per-kind
// filter, which would silently flip the wrong control under the
// "Push notifications" header.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'notifications-settings-labels-distinct';
export const DESCRIPTION = 'Settings → Notifications panel: every toggle label is unique (no duplicate "Push notifications" rows)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export function MOCK_SETUP(_mock) { /* defaults */ }

export default async function run({ page, log }) {
  await waitForReady(page);

  // Make sure the notifications group is in the DOM. The panel
  // gates visibility with `hidden`; the labels we want to read
  // are present regardless of hidden state.
  const labelData = await page.evaluate(() => {
    const group = document.querySelector('.settings-group[data-section="notifications"]');
    if (!group) return { missing: true, labels: [] };
    const labels = Array.from(group.querySelectorAll('label'))
      .map((el) => ({
        text: (el.textContent || '').trim(),
        forId: el.getAttribute('for') || '',
      }))
      // Skip empty / pure-icon labels — the rule is about
      // human-readable text. (Today every label has text but be
      // defensive against future helpers that add icon-only ones.)
      .filter((l) => l.text);
    return { missing: false, labels };
  });
  assert(!labelData.missing,
    'notifications settings group missing from DOM — selector drift?');
  assert(labelData.labels.length >= 3,
    `expected ≥3 labels in notifications group, got ${labelData.labels.length}`);
  log(`notifications panel has ${labelData.labels.length} labels`);

  // Build a frequency map of label texts.
  const counts = new Map();
  for (const l of labelData.labels) {
    counts.set(l.text, (counts.get(l.text) || 0) + 1);
  }
  const dupes = Array.from(counts.entries()).filter(([, n]) => n > 1);
  assert(dupes.length === 0,
    `BUG (field bug 2026-05-13): duplicate labels in notifications panel: ${
      dupes.map(([text, n]) => `${JSON.stringify(text)}×${n}`).join(', ')
    }. Each toggle must have a distinct, scannable label so the user can tell what each one does.`);
  log(`all labels distinct ✓`);

  // Specifically: the master subscribe toggle (#set-push) must be
  // labeled clearly. If somebody renames it to something generic
  // and the per-kind filter ends up named "Push notifications",
  // the dupe check catches it — but only if both labels collide.
  // Pin the master label's TARGET explicitly so a rename that
  // moves the dupe to a different anchor still flags here.
  const masterAnchor = labelData.labels.find((l) => l.forId === 'set-push');
  assert(masterAnchor,
    `master push toggle label (for="set-push") not found`);
  log(`master toggle label: "${masterAnchor.text}" ✓`);

  for (const expected of ['Agent replies', 'Cron output', 'Approvals']) {
    const found = labelData.labels.find((l) => l.text.includes(expected));
    assert(found, `per-kind label ${JSON.stringify(expected)} not found`);
    assert(found.text !== masterAnchor.text,
      `BUG: per-kind label "${found.text}" matches master "${masterAnchor.text}"`);
  }
  log('per-kind labels present and distinct from master ✓');
}
