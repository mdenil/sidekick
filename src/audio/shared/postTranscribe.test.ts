/**
 * @fileoverview Error-classification matrix for postTranscribe — the
 * decision that either DROPS a queued memo (PermanentTranscribeError:
 * corrupt blob, Deepgram 4xx, unsupported format) or keeps it queued
 * for retry (anything else: 5xx, network, timeout). Misclassifying
 * permanent→transient wedges the outbox in an infinite retry loop;
 * transient→permanent silently deletes the user's audio.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { postTranscribe, PermanentTranscribeError } from './postTranscribe.ts';
import { TimeoutError } from '../../util/fetchWithTimeout.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function respondWith(payload: unknown) {
  globalThis.fetch = (async () => ({ json: async () => payload })) as unknown as typeof fetch;
}

const BODY = new Blob(['x']);
const call = () => postTranscribe('/transcribe', BODY, 'audio/wav', 1000);

async function classify(errorString: string): Promise<'permanent' | 'transient'> {
  respondWith({ ok: false, error: errorString });
  try {
    await call();
  } catch (e) {
    return e instanceof PermanentTranscribeError ? 'permanent' : 'transient';
  }
  throw new Error('expected postTranscribe to throw');
}

describe('postTranscribe success path', () => {
  it('returns the trimmed transcript', async () => {
    respondWith({ ok: true, transcript: '  hello world  ' });
    assert.equal(await call(), 'hello world');
  });

  it('returns empty string when the transcript is missing', async () => {
    respondWith({ ok: true });
    assert.equal(await call(), '');
  });
});

describe('postTranscribe permanent failures (drop from queue)', () => {
  it('deepgram 400 corrupt-or-unsupported (the iOS mic-perm blob case)', async () => {
    assert.equal(await classify('deepgram 400 corrupt or unsupported data'), 'permanent');
  });

  it('any 4xx status in the error string', async () => {
    assert.equal(await classify('HTTP 404'), 'permanent');
    assert.equal(await classify('upstream returned 422'), 'permanent');
  });

  it('corrupt / unsupported / empty body keywords', async () => {
    assert.equal(await classify('corrupt audio stream'), 'permanent');
    assert.equal(await classify('Unsupported media format'), 'permanent');
    assert.equal(await classify('empty body'), 'permanent');
  });
});

describe('postTranscribe transient failures (keep queued, retry)', () => {
  it('5xx stays transient', async () => {
    assert.equal(await classify('HTTP 500'), 'transient');
    assert.equal(await classify('bad gateway 502'), 'transient');
  });

  it('bridge timeout (the #189 proxy error string) stays transient', async () => {
    assert.equal(await classify('bridge timeout'), 'transient');
  });

  it('generic network-ish errors stay transient', async () => {
    assert.equal(await classify('fetch failed: ECONNREFUSED'), 'transient');
    assert.equal(await classify('transcription failed'), 'transient');
  });

  it('a 4xx-looking digit run inside a larger number does NOT match (word boundary)', async () => {
    // "1400" must not classify as a 400 — \b4\d\d\b requires a standalone
    // 3-digit status.
    assert.equal(await classify('received 1400 bytes before disconnect'), 'transient');
  });

  it('missing error string falls back to a transient "transcription failed"', async () => {
    respondWith({ ok: false });
    await assert.rejects(call, (e: Error) => {
      assert.ok(!(e instanceof PermanentTranscribeError));
      assert.equal(e.message, 'transcription failed');
      return true;
    });
  });

  it('a hung request rejects with TimeoutError (transient), not Permanent', async () => {
    globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(init.signal!.reason), { once: true });
      })) as unknown as typeof fetch;
    await assert.rejects(
      postTranscribe('/transcribe', BODY, 'audio/wav', 20),
      (e: Error) => {
        assert.ok(e instanceof TimeoutError, `expected TimeoutError, got ${e?.constructor?.name}`);
        assert.ok(!(e instanceof PermanentTranscribeError));
        return true;
      },
    );
  });

  it('a rejected fetch (network down) propagates as-is', async () => {
    globalThis.fetch = (async () => { throw new TypeError('Load failed'); }) as unknown as typeof fetch;
    await assert.rejects(call, (e: Error) => {
      assert.ok(e instanceof TypeError);
      assert.equal(e.message, 'Load failed');
      return true;
    });
  });
});
