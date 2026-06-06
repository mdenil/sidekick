// Announce-on-switch — when the user switches INTO a session that has a
// per-session identity nickname, show a brief toast and speak the bare
// nickname in that session's voice. The point is a quick "you're now
// talking to <X>" cue that reinforces the per-session voice identity.
//
// Fires ONLY on user-initiated drawer switches, never on cold-open boot
// or service-worker resume. The gesture site (sessionDrawer row tap)
// calls arm(); the central switch renderer (sessionResume) calls
// consume() at the END of a different-session render — after
// replyNavigator.reset() has already cancelled prior TTS, so the spoken
// nickname isn't immediately superseded.

import * as sessionIdentity from './sessionIdentity.ts';
import * as settings from './settings.ts';
import { DEFAULT_VOICE } from './voices.ts';

const TOAST_MS = 2500;
// An armed switch is only honored briefly — guards against a stale arm
// (e.g. a resume that errored before rendering) firing on a much later
// unrelated render.
const ARM_TTL_MS = 8000;

let armedId: string | null = null;
let armedAt = 0;
let toastEl: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** Record that the user just tapped a row to switch to `id`. */
export function arm(id: string): void {
  armedId = id || null;
  armedAt = Date.now();
}

/** Called at the end of a different-session render. Announces only if the
 *  render corresponds to the armed user gesture (and it isn't stale). */
export function consume(id: string, sameSession: boolean): void {
  const armed = armedId;
  armedId = null;
  if (sameSession) return;
  if (!armed || armed !== id) return;
  if (Date.now() - armedAt > ARM_TTL_MS) return;
  const nickname = sessionIdentity.nicknameFor(id);
  if (!nickname) return;
  showToast(nickname);
  void speak(id, nickname);
}

function showToast(nickname: string): void {
  ensureToast();
  if (!toastEl) return;
  toastEl.textContent = nickname;
  toastEl.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl?.classList.remove('visible'), TOAST_MS);
}

function ensureToast(): void {
  if (toastEl) return;
  if (typeof document === 'undefined') return;
  toastEl = document.getElementById('session-announce-toast');
  if (toastEl) return;
  toastEl = document.createElement('div');
  toastEl.id = 'session-announce-toast';
  toastEl.className = 'session-announce-toast';
  toastEl.setAttribute('role', 'status');
  toastEl.setAttribute('aria-live', 'polite');
  document.body.appendChild(toastEl);
}

async function speak(id: string, nickname: string): Promise<void> {
  try {
    const voice = sessionIdentity.voiceFor(id) || settings.get().voice || DEFAULT_VOICE;
    const tts = await import('./audio/turn-based/tts.ts');
    await tts.playReplyTts(nickname, voice);
  } catch { /* TTS unavailable — toast still shown */ }
}
