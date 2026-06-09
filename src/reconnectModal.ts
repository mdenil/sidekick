/**
 * @fileoverview Reconnect pop-up for the Capacitor local-asset shell.
 *
 * In the CAP shell the app boots instantly from bundled assets and reaches
 * the backend only over the network (via apiBase). When the saved host is
 * unreachable we DON'T want to bounce the user back to a full-screen host
 * picker — that throws away the locally-cached app they could still poke at
 * (browse cached sessions, dictate a memo into the durable outbox, read
 * notifications). Instead we show a dismissible overlay: keep waiting, keep
 * using the app, or enter a new host and reconnect.
 *
 * Reconnecting reloads the LOCAL app (./app.html) — instant, no network —
 * with the new origin picked up by apiBase. In-progress memos survive the
 * reload because they live in the durable outbox, not in-memory state.
 *
 * Only meaningful in the local shell; in a browser PWA the page is served
 * by the host, so an unreachable host means the page never loaded at all.
 */

import { log } from './util/log.ts';
import { SERVER_URL_KEY, apiOrigin } from './apiBase.ts';

let overlay: HTMLElement | null = null;

function normalize(raw: string): string {
  let s = (raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s.replace(/\/+$/, '');
}

function savedHost(): string {
  try { return localStorage.getItem(SERVER_URL_KEY) || apiOrigin(); }
  catch { return apiOrigin(); }
}

function build(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'reconnect-overlay';
  el.innerHTML = `
    <div class="reconnect-card" role="dialog" aria-modal="false" aria-label="Reconnect to server">
      <h2>Can't reach your server</h2>
      <p class="reconnect-host"></p>
      <p class="reconnect-sub">You can keep using the app offline, or point at a different host.</p>
      <label class="reconnect-label" for="reconnect-url">Server URL</label>
      <input id="reconnect-url" type="url" inputmode="url" autocapitalize="off"
             autocorrect="off" spellcheck="false" placeholder="https://your-host.example.com:3001" />
      <div class="reconnect-status"></div>
      <div class="reconnect-actions">
        <button type="button" class="reconnect-dismiss">Keep waiting</button>
        <button type="button" class="reconnect-go">Reconnect</button>
      </div>
    </div>`;

  const input = el.querySelector('#reconnect-url') as HTMLInputElement;
  const status = el.querySelector('.reconnect-status') as HTMLElement;
  const dismiss = el.querySelector('.reconnect-dismiss') as HTMLButtonElement;
  const go = el.querySelector('.reconnect-go') as HTMLButtonElement;

  const reconnect = () => {
    const url = normalize(input.value);
    if (!url) {
      status.textContent = 'Please enter a URL';
      status.className = 'reconnect-status err';
      return;
    }
    try { localStorage.setItem(SERVER_URL_KEY, url); } catch { /* private mode */ }
    log(`[reconnect] new host saved (${url}) — reloading local app`);
    status.textContent = 'Reconnecting…';
    status.className = 'reconnect-status ok';
    // Reload the LOCAL bundled app; apiBase reads the new host on next call.
    // Dictated memos persist via the durable outbox, so the reload is safe.
    location.reload();
  };

  go.addEventListener('click', reconnect);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') reconnect(); });
  dismiss.addEventListener('click', hideReconnectModal);
  // Backdrop tap (outside the card) dismisses too.
  el.addEventListener('click', (e) => { if (e.target === el) hideReconnectModal(); });

  return el;
}

/** Show the reconnect overlay (idempotent — re-show just refreshes the
 *  host line + re-reveals it). The app stays interactive behind it. */
export function showReconnectModal(): void {
  if (!overlay) {
    overlay = build();
    document.body.appendChild(overlay);
  }
  const host = savedHost();
  const hostEl = overlay.querySelector('.reconnect-host') as HTMLElement;
  const input = overlay.querySelector('#reconnect-url') as HTMLInputElement;
  if (hostEl) hostEl.textContent = host;
  if (input && !input.value) input.value = host;
  overlay.classList.add('on');
}

export function hideReconnectModal(): void {
  overlay?.classList.remove('on');
}
