// Regression: an unrelated incoming assistant/status reply while Listen is
// armed must not start auto-TTS, discard the current capture/draft, or move
// Listen into playing/cooldown. Only replies to a Listen-committed user turn
// are allowed to own Listen playback.

import { resetServerSettings } from './lib.mjs';

export const NAME = 'listen-incoming-reply-preserves-capture';
export const DESCRIPTION = 'incoming replies do not corrupt active Listen capture/draft';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-listen-incoming-reply';
const DRAFT = 'in flight dictation draft should survive';
const REPLY = 'UNRELATED_REPLY_WHILE_LISTENING';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Listen Incoming Reply',
    messages: [{ role: 'user', content: 'seed', timestamp: Date.now() / 1000 }],
    lastActiveAt: Date.now(),
  });
}

async function tapCall(page) {
  await page.evaluate(() => {
    const btn = document.getElementById('btn-call');
    if (!btn) throw new Error('btn-call missing');
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, isPrimary: true, pointerId: 1 }));
  });
}

export default async function run({ page, log, fail, url, mock }) {
  await resetServerSettings(page, { realtime: false, tts: true, streamingEngine: 'server' });
  await page.goto(`${url}/?listen_mock_mic=1&silence_sec=60`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });
  await page.waitForFunction(() => /Connected/.test(document.body.innerText), null, {
    timeout: 15_000,
    polling: 250,
  });

  await page.evaluate((chatId) => {
    const row = document.querySelector(`#sessions-list li[data-chat-id="${CSS.escape(chatId)}"]`);
    if (!row) throw new Error(`chat row not found: ${chatId}`);
    row.click();
  }, CHAT_ID);

  await tapCall(page);
  await page.waitForFunction(() => window.__listen?.state === 'armed', null, {
    timeout: 10_000,
    polling: 100,
  });

  await page.fill('#composer-input', DRAFT);
  mock.pushReply(CHAT_ID, REPLY, 'listen-unrelated-reply-1');
  await page.waitForFunction(
    (text) => (document.getElementById('transcript')?.textContent || '').includes(text),
    REPLY,
    { timeout: 3_000, polling: 100 },
  );
  await page.waitForTimeout(300);

  const state = await page.evaluate(() => window.__listen?.state);
  const draft = await page.locator('#composer-input').inputValue();
  if (state !== 'armed') fail(`expected Listen to remain armed, got ${state}`);
  if (draft !== DRAFT) fail(`expected composer draft to survive, got ${JSON.stringify(draft)}`);

  log('incoming reply rendered without stealing Listen capture or draft');
}
