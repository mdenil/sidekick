// Virt-path real-backend variant of scroll-real-tool-chats-diag.mjs.
// Sets `localStorage.sidekick.virtualize = '1'` before boot, then does
// the same A→B→A flow on Jonathan's [pitch deck] + [JOAM]. Asserts:
//
//   - first-visible bubble KEY is the SAME before and after the
//     round-trip (not just scrollTop within tolerance)
//   - offset of the anchored bubble drifts ≤ 50px
//
// This is what the default-path diag should have been asserting too —
// scrollTop tolerance lets a different bubble end up at the top of
// viewport, which IS the user-visible bug.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'scroll-real-tool-chats-virt-diag';
export const DESCRIPTION = 'Virt flag on: real backend A↔B↔A on tool-heavy chats — message identity must survive switch';
export const STATUS = 'install-only';
export const BACKEND = 'real';

const CHAT_PITCH = 'sidekick:ae6435b5-53aa-4819-b594-d21652c89397';
const CHAT_JOAM = 'sidekick:4a26d7f6-1902-42af-a348-649e9c5a0bc4';

async function snap(page) {
  return page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (!t) return null;
    const slot = t.querySelector(':scope > .transcript-slot');
    // Walk slot.children (under virt) or transcript children (default).
    const children = slot ? Array.from(slot.children) : Array.from(t.children);
    const viewTop = t.getBoundingClientRect().top;
    let firstVisible = null;
    for (const el of children) {
      const r = el.getBoundingClientRect();
      if (r.bottom > viewTop + 4) {
        firstVisible = {
          key: el.getAttribute('data-key'),
          text: (el.textContent || '').replace(/\s+/g, ' ').slice(0, 120),
          topRelToViewport: Math.round(r.top - viewTop),
        };
        break;
      }
    }
    return {
      scrollTop: Math.round(t.scrollTop),
      scrollHeight: t.scrollHeight,
      clientHeight: t.clientHeight,
      maxTop: t.scrollHeight - t.clientHeight,
      firstVisible,
      virtSlot: !!slot,
    };
  });
}

async function wheelToFraction(page, fromTopFraction) {
  const box = await page.locator('#transcript').boundingBox();
  if (!box) throw new Error('transcript bounding box missing');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await snap(page);
  const targetTop = Math.round(before.maxTop * fromTopFraction);
  const delta = before.scrollTop - targetTop;
  const stepPx = 500;
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / stepPx));
  const sign = delta > 0 ? -1 : 1;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, sign * stepPx);
    await page.waitForTimeout(15);
  }
}

export default async function run({ page, log }) {
  await page.addInitScript(() => {
    try { localStorage.setItem('sidekick.virtualize', '1'); } catch {}
  });

  await waitForReady(page);
  await openSidebar(page);

  log('opening [pitch deck] under virt flag…');
  await clickRow(page, CHAT_PITCH);
  await page.waitForTimeout(3000);

  const s = await snap(page);
  log(`pitch loaded: scrollTop=${s.scrollTop} maxTop=${s.maxTop} virtSlot=${s.virtSlot} firstVisible=${JSON.stringify(s.firstVisible)}`);
  assert(s.virtSlot, 'virt flag must engage — `.transcript-slot` should be a child of #transcript');

  await wheelToFraction(page, 0.5);
  await page.waitForTimeout(800);
  const pitchMid = await snap(page);
  log(`pitch mid: scrollTop=${pitchMid.scrollTop} firstVisible=${JSON.stringify(pitchMid.firstVisible)}`);

  log('switching to [JOAM]…');
  await clickRow(page, CHAT_JOAM);
  await page.waitForTimeout(2500);

  log('switching back to [pitch deck]…');
  await clickRow(page, CHAT_PITCH);
  await page.waitForTimeout(4000);

  const pitchRestored = await snap(page);
  log(`pitch restored: scrollTop=${pitchRestored.scrollTop} firstVisible=${JSON.stringify(pitchRestored.firstVisible)}`);

  log('');
  log('=== summary ===');
  log(`pitch saved scrollTop:    ${pitchMid.scrollTop}`);
  log(`pitch restored scrollTop: ${pitchRestored.scrollTop}`);
  log(`scrollTop drift:          ${pitchRestored.scrollTop - pitchMid.scrollTop}`);
  log(`first-visible BEFORE:     key=${pitchMid.firstVisible?.key} top=${pitchMid.firstVisible?.topRelToViewport}`);
  log(`first-visible AFTER:      key=${pitchRestored.firstVisible?.key} top=${pitchRestored.firstVisible?.topRelToViewport}`);

  assert(pitchMid.firstVisible?.key && pitchRestored.firstVisible?.key,
    `must capture firstVisible at both points (before=${pitchMid.firstVisible?.key} after=${pitchRestored.firstVisible?.key})`);
  assert(pitchMid.firstVisible.key === pitchRestored.firstVisible.key,
    `first-visible bubble must match across switch: ` +
    `before=${pitchMid.firstVisible.key} after=${pitchRestored.firstVisible.key}`);
  const offsetDrift = Math.abs(
    (pitchRestored.firstVisible.topRelToViewport ?? 0) - (pitchMid.firstVisible.topRelToViewport ?? 0)
  );
  assert(offsetDrift <= 50,
    `anchored bubble offset drift exceeds 50px: before=${pitchMid.firstVisible.topRelToViewport} after=${pitchRestored.firstVisible.topRelToViewport}`);
}
