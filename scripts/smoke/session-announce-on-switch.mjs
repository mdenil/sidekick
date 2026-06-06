// Per-session identity (#150) — announce-on-switch. Switching INTO a
// session that has a nickname shows a brief bottom-center toast and speaks
// the bare nickname (in that session's voice). The cue MUST fire only on a
// user-initiated drawer switch — never on cold-open boot or programmatic
// resume — so rapidly browsing or reloading doesn't blurt names.
//
// What this proves:
//   1. USER SWITCH — tapping a row whose session has a nickname shows the
//      `.session-announce-toast` with that nickname AND POSTs /tts with the
//      bare nickname as the text.
//   2. NO COLD-OPEN ANNOUNCE — reloading onto a session that has a
//      nickname does NOT show the toast or speak (the arm is per-gesture
//      and resets on reload).

import { waitForReady, openSidebar, resetServerSettings, assert } from './lib.mjs';

export const NAME = 'session-announce-on-switch';
export const DESCRIPTION = 'User switch into a nicknamed session announces (toast + spoken nickname); cold-open does not';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const LABELS = ['alpha', 'beta'];
const ID = (label) => `mock-chat-${label}`;

export function MOCK_SETUP(mock) {
  // alpha newest → it's the cold-open landing chat; beta is the switch
  // target.
  for (let i = 0; i < LABELS.length; i++) {
    const label = LABELS[i];
    const tSec = Date.now() / 1000 - i * 60;
    mock.addChat(ID(label), {
      title: `Chat ${label}`,
      messages: [
        { role: 'user', content: `marker-${label}`, timestamp: tSec },
        { role: 'assistant', content: `Reply ${label}`, timestamp: tSec + 1 },
      ],
      lastActiveAt: Date.now() - i * 60_000,
    });
  }
}

async function rowMenuAction(page, chatId, label) {
  await page.click(`#sessions-list li[data-chat-id="${chatId}"] .sess-menu-btn`);
  await page.locator('.sess-menu button', { hasText: label }).first().click();
}

async function setNickname(page, chatId, nickname) {
  await rowMenuAction(page, chatId, 'Name & voice');
  await page.waitForSelector('.session-identity-dialog .ident-nickname', { timeout: 5_000 });
  await page.fill('.session-identity-dialog .ident-nickname', nickname);
  await page.click('.session-identity-dialog .ident-save');
  await page.waitForFunction(
    (id) => {
      const li = document.querySelector(`#sessions-list li[data-chat-id="${id}"]`);
      return !!li?.querySelector('.sess-nickname');
    },
    chatId, { timeout: 5_000, polling: 50 },
  );
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await resetServerSettings(page, { streamingEngine: 'server', tts: true });
  await openSidebar(page);
  await page.waitForSelector(`#sessions-list li[data-chat-id="${ID('beta')}"]`, { timeout: 5_000 });

  // Capture spoken text from /tts (the announce speaks the bare nickname).
  const ttsTexts = [];
  await page.route('**/tts', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    try { ttsTexts.push(JSON.parse(route.request().postData() || '{}')?.text); } catch {}
    const wav = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
      0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
      0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00,
      0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
    ]);
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
  });

  // Give both sessions nicknames; alpha is the active/landing chat.
  await setNickname(page, ID('beta'), 'Beta Persona');
  await setNickname(page, ID('alpha'), 'Alpha Persona');
  log('setup ✓ both sessions nicknamed; alpha active');

  // ── 1. USER SWITCH alpha → beta announces ──────────────────────────
  await page.click(`#sessions-list li[data-chat-id="${ID('beta')}"]`);
  await page.waitForSelector('.session-announce-toast.visible', { timeout: 5_000 });
  const toastText = await page.evaluate(
    () => document.querySelector('.session-announce-toast')?.textContent ?? null);
  assert(toastText === 'Beta Persona',
    `toast should show the switched-to nickname; got ${JSON.stringify(toastText)}`);
  await page.waitForFunction(
    () => true, null, { timeout: 50 });
  await page.waitForTimeout(400);
  assert(ttsTexts.includes('Beta Persona'),
    `announce should speak the bare nickname; /tts texts were ${JSON.stringify(ttsTexts)}`);
  log('switch ✓ toast + spoken nickname fired on user switch to beta');

  // ── 2. NO COLD-OPEN ANNOUNCE — reload onto a nicknamed chat ─────────
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForReady(page);
  // Re-register the /tts route (page reload drops routes) so a stray
  // announce would be caught.
  ttsTexts.length = 0;
  await page.route('**/tts', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    try { ttsTexts.push(JSON.parse(route.request().postData() || '{}')?.text); } catch {}
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: Buffer.from([0x52, 0x49, 0x46, 0x46]) });
  });
  // Let the boot resume settle.
  await page.waitForTimeout(1500);
  const toastVisible = await page.evaluate(
    () => !!document.querySelector('.session-announce-toast.visible'));
  assert(!toastVisible, 'cold-open boot must NOT show the announce toast');
  assert(ttsTexts.length === 0,
    `cold-open boot must NOT speak a nickname; /tts texts were ${JSON.stringify(ttsTexts)}`);
  log('cold-open ✓ no toast, no spoken nickname on boot');

  log('PASS: announce fires on user switch only, not on cold-open boot');
}
