/**
 * @fileoverview In-app notification banner for non-viewed chats.
 *
 * When a notification envelope arrives while sidekick is open and the
 * user is viewing a DIFFERENT chat, surface a top-of-viewport toast
 * with the cron emoji + chat label + body preview + an open-button.
 * Tap → switches into the source chat and scrolls to the notification
 * row via the same data-message-id machinery pin-drawer-jump uses.
 *
 * Auto-dismiss after 6s. New notifications replace the previous one
 * (single visible banner — stacked toasts on mobile get noisy fast).
 * The badge++ side effect still fires upstream so the chat-row in the
 * drawer also lights up — banner is the "right now, glance at me"
 * channel; badge is the "next time you scan the drawer" persistence.
 */

import { log } from '../util/log.ts';

const AUTO_DISMISS_MS = 6_000;

let bannerEl: HTMLElement | null = null;
let dismissTimer: ReturnType<typeof setTimeout> | null = null;
let onOpenCb: ((chatId: string, msgId: string | null) => void) | null = null;

interface ShowArgs {
  chatId: string;
  kind: string;
  content: string;
  sidekickId: string | null;
  chatLabel?: string;
}

/** Wire the banner once at boot. `onOpen` is called when the user
 *  taps the banner — main.ts should drill into the chat + scroll to
 *  the notification row. */
export function init(opts: {
  onOpen: (chatId: string, msgId: string | null) => void;
}): void {
  onOpenCb = opts.onOpen;
}

/** Show a notification banner. If one is already visible, replace it
 *  with the new envelope (the most recent notification is the one the
 *  user wants to act on; stacked toasts crowd the viewport). */
export function show(args: ShowArgs): void {
  ensureMounted();
  if (!bannerEl) return;
  const { kind, content, chatLabel } = args;
  const emoji = kind === 'cron' ? '⏰' : '🔔';
  // Strip the scheduler boilerplate for the preview — same logic the
  // proxy push formatter + history renderer use. Banner has even less
  // visible space than a push body, so the agent-content lead is
  // critical.
  let body = content || '';
  if (kind === 'cron') {
    const headerRe = /^Cronjob Response:\s*(.+?)\s*\n\(job_id:\s*([^)]+)\)\s*\n-+\s*\n+([\s\S]*?)(?:\n+To stop or manage this job[^\n]*\.?\s*)?$/;
    const m = headerRe.exec(body);
    if (m) {
      // Lead with task name then body so the title-area carries the
      // scannable label.
      body = `${m[1].trim()}: ${m[3].trim()}`;
    }
  }
  const preview = body.length > 120 ? body.slice(0, 117) + '…' : body;
  const label = chatLabel || args.chatId.replace(/^sidekick:/, '').slice(0, 12);

  bannerEl.innerHTML = `
    <div class="iab-emoji" aria-hidden="true">${emoji}</div>
    <div class="iab-content">
      <div class="iab-title">${escapeHtml(label)}</div>
      <div class="iab-preview">${escapeHtml(preview)}</div>
    </div>
    <button class="iab-dismiss" aria-label="Dismiss">×</button>
  `;
  bannerEl.classList.add('visible');

  // Tap anywhere except the explicit × → open the chat. The dismiss
  // button stops propagation so it ONLY dismisses, doesn't drill.
  bannerEl.onclick = () => {
    hide();
    if (onOpenCb) onOpenCb(args.chatId, args.sidekickId);
  };
  const dismissBtn = bannerEl.querySelector('.iab-dismiss') as HTMLElement | null;
  if (dismissBtn) {
    dismissBtn.onclick = (e: MouseEvent) => {
      e.stopPropagation();
      hide();
    };
  }

  if (dismissTimer) clearTimeout(dismissTimer);
  dismissTimer = setTimeout(hide, AUTO_DISMISS_MS);
  log(`[in-app-banner] show chat=${args.chatId} kind=${kind}`);
}

function hide(): void {
  if (!bannerEl) return;
  bannerEl.classList.remove('visible');
  if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
}

function ensureMounted(): void {
  if (bannerEl) return;
  bannerEl = document.getElementById('in-app-banner');
  if (bannerEl) return;
  // Self-mount if the host page didn't pre-declare the element.
  bannerEl = document.createElement('div');
  bannerEl.id = 'in-app-banner';
  bannerEl.className = 'in-app-banner';
  bannerEl.setAttribute('role', 'status');
  bannerEl.setAttribute('aria-live', 'polite');
  document.body.appendChild(bannerEl);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
