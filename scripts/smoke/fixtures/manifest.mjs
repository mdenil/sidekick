// Ground-truth manifest for the versioned audio fixtures.
//
// Every WAV here was synthesized once via Deepgram Aura and then
// transcribed back through Deepgram nova-2 to capture the EXACT text
// the STT pipe emits for it. Versioning the transcript next to the
// audio buys us two things:
//
//   1. Real-audio smokes (BACKEND='real') can assert on a known
//      substring without spec-fighting model drift.
//   2. Mocked smokes (BACKEND='mocked') can inject the SAME WAV through
//      the real getUserMedia → MediaRecorder channel but stub
//      /transcribe to return `transcript` — exercising the audio
//      channel + frontend turn/playback wiring with NO Deepgram key or
//      quota. This is what lets the turn-mode-TTS and barge channel
//      bugs be caught in the always-green default suite.
//
// `reply-tts.wav` is a real Aura-synthesized 16-bit PCM WAV used by
// mocked smokes to stub /tts with genuine, DECODABLE audio bytes, so
// the <audio> element actually reports duration>0 and advances
// currentTime rather than choking on a fake/empty blob. WAV (not the
// production mp3) because Playwright's open-source Chromium lacks the
// proprietary mp3 codec — PCM always decodes.
//
// Regenerate with scripts/smoke/fixtures/README.md.

export const FIXTURES = {
  'hello-sidekick.wav': {
    transcript: 'Hello. Sidekick.',
    expect: 'sidekick',
    note: 'Short greeting. Used by audio-transcribe-roundtrip.',
  },
  'turn-prompt.wav': {
    transcript: 'Tell me a short fun fact about the ocean.',
    expect: 'ocean',
    note: 'A spoken question that elicits a plain-text agent reply (no tool call). Drives the spoken-turn smokes.',
  },
  'barge-speech.wav': {
    transcript: '12 3456789101112131415.',
    sustained: true,
    note: 'Sustained ~8s of continuous speech (counting). Content is irrelevant — used to trigger VAD speech-active for barge-in.',
  },
};

/** Real Aura 16-bit PCM WAV — stubbed into /tts by mocked playback
 *  smokes (PCM so Playwright's Chromium decodes it; mp3 may not). */
export const REPLY_TTS_WAV = 'reply-tts.wav';
