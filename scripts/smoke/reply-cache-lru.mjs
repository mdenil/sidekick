// Scenario: playReplyTts memoizes (text, voice) → Blob in an LRU cache.
// Calling it twice with the same arguments fires /tts ONCE; the LRU
// caps at 10 entries.
//
// Mocks:
//   - /tts: returns a tiny WAV. Counts the number of POSTs received.
//
// Asserts:
//   1. Two playReplyTts calls with the same (text, voice) → 1 /tts POST.
//   2. After 11 distinct calls, /tts was POSTed 11 times AND the FIRST
//      one is no longer cached (re-firing it makes a 12th POST).

export const NAME = 'reply-cache-lru';
export const DESCRIPTION = 'LRU reply cache short-circuits repeated /tts fetches';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log, fail, url }) {
  let ttsCount = 0;
  await page.route('**/tts', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    ttsCount++;
    const wav = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
      0x66, 0x6d, 0x74, 0x20, 0x10, 0, 0, 0, 0x01, 0, 0x01, 0,
      0x40, 0x1f, 0, 0, 0x80, 0x3e, 0, 0, 0x02, 0, 0x10, 0,
      0x64, 0x61, 0x74, 0x61, 0, 0, 0, 0,
    ]);
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
  });

  await page.goto(`${url}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });

  // Drive playReplyTts via a small page-context bridge.
  await page.evaluate(async () => {
    const mod = await import('/build/audio/text-tts.mjs');
    (window).__playTts = mod.playReplyTts;
  });

  // Same text twice → one /tts.
  await page.evaluate(() => (window).__playTts('hello there', 'aura-2-thalia-en'));
  await page.evaluate(() => (window).__playTts('hello there', 'aura-2-thalia-en'));
  await page.waitForTimeout(200);
  if (ttsCount !== 1) fail(`expected ttsCount=1 after two identical calls, got ${ttsCount}`);
  log(`identical reply hit cache (ttsCount=${ttsCount})`);

  // 10 distinct → 11 total POSTs.
  for (let i = 0; i < 10; i++) {
    await page.evaluate((idx) => (window).__playTts(`reply ${idx}`, 'aura-2-thalia-en'), i);
  }
  await page.waitForTimeout(300);
  if (ttsCount !== 11) fail(`expected ttsCount=11 after 10 distinct, got ${ttsCount}`);
  log(`distinct replies all fetched (ttsCount=${ttsCount})`);

  // 11th distinct evicts the oldest (the original "hello there" was
  // promoted on the second call, but "reply 0" is now the oldest).
  await page.evaluate(() => (window).__playTts('reply 10', 'aura-2-thalia-en'));
  await page.waitForTimeout(200);
  // 11 entries cached + 1 just-arrived → cap of 10 evicts the head.
  // Re-fire "reply 0" → should hit /tts (12 total).
  await page.evaluate(() => (window).__playTts('reply 0', 'aura-2-thalia-en'));
  await page.waitForTimeout(200);
  if (ttsCount < 13) fail(`expected ttsCount>=13 after eviction + re-fetch, got ${ttsCount}`);
  log(`eviction working (ttsCount=${ttsCount})`);
}
