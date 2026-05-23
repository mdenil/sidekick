// Desktop battery regression: hiding a desktop PWA tab must not close the
// primary SSE stream, or replies for the currently viewed chat won't render
// until a manual refresh/session switch. Mobile/Cap still close the stream.

export const NAME = 'desktop-hidden-active-chat-sse';
export const DESCRIPTION = 'desktop hidden visibility keeps SSE live for active-chat replies';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-desktop-hidden-active-chat';
const REPLY = 'DESKTOP_HIDDEN_SSE_REPLY_VISIBLE';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Desktop Hidden SSE',
    messages: [{ role: 'user', content: 'seed', timestamp: Date.now() / 1000 }],
    lastActiveAt: Date.now(),
  });
}

export default async function run({ page, log, fail, url, mock }) {
  await page.goto(`${url}/?debug=1`, { waitUntil: 'domcontentloaded' });
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
  await page.waitForFunction((chatId) => document.querySelector(`#transcript [data-chat-id="${CSS.escape(chatId)}"], #transcript`) !== null, CHAT_ID);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(100);

  mock.pushReply(CHAT_ID, REPLY, 'desktop-hidden-reply-1');

  await page.waitForFunction(
    (text) => (document.getElementById('transcript')?.textContent || '').includes(text),
    REPLY,
    { timeout: 3_000, polling: 100 },
  ).catch(() => fail('reply did not render while desktop document.visibilityState=hidden'));

  log('active chat reply rendered while desktop tab was hidden');
}
