// Right-side pin drawer — mirrors the left sidebar's open/close
// machinery but renders pinned messages aggregated across every chat
// instead of session rows. Click a pin item → callback to main.ts to
// drill into that chat and scroll to the message (reuses the existing
// `targetMessageId` plumbing in replaySessionMessages that cmdk search
// hits already use).
//
// Wired ONCE at boot via initPinDrawer({ onPinClick }). The drawer
// listens to `sidekick:pins-changed` and re-renders itself; the toggle
// button banner stays in sync via totalPinCount().

import { listAllPins, totalPinCount, clearAllPins, type PinnedItem } from './store.ts';
import { log } from '../util/log.ts';
import { repaint as repaintAmbient } from '../ambient.ts';

let drawerEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;
let toggleBtns: HTMLElement[] = [];        // [#btn-pin-drawer (mobile), #btn-pin-drawer-rail (desktop)]
let countBanners: HTMLElement[] = [];       // both #pin-drawer-count + #pin-drawer-count-rail
let clearBtn: HTMLElement | null = null;
let onPinClickCb: ((chatId: string, msgId: string) => void) | null = null;

function openDrawer(): void {
  if (!drawerEl) return;
  drawerEl.classList.remove('collapsed');
  drawerEl.setAttribute('aria-expanded', 'true');
  document.body.classList.add('pin-drawer-open');
  render();
  // Tell the ambient widget to re-render in its new (expanded)
  // visual mode now that the drawer is open.
  try { repaintAmbient(); } catch { /* widget may not exist yet */ }
}

function closeDrawer(): void {
  if (!drawerEl) return;
  drawerEl.classList.add('collapsed');
  drawerEl.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('pin-drawer-open');
  try { repaintAmbient(); } catch { /* defensive */ }
}

function isOpen(): boolean {
  return !!drawerEl && !drawerEl.classList.contains('collapsed');
}

/** Re-render the pin list from store state. Cheap — pin counts are
 *  typically small (single-digit to dozens). Called on every
 *  sidekick:pins-changed event and on drawer open. */
function render(): void {
  if (!listEl || !emptyEl) return;
  const pins = listAllPins();
  listEl.innerHTML = '';
  // Clear button visible only when there's something to clear —
  // mirrors the "Mark all read" hint pattern in Settings.
  if (clearBtn) clearBtn.hidden = pins.length === 0;
  if (pins.length === 0) {
    emptyEl.hidden = false;
    listEl.hidden = true;
    return;
  }
  emptyEl.hidden = true;
  listEl.hidden = false;
  for (const item of pins) {
    listEl.appendChild(renderItem(item));
  }
}

function renderItem(item: PinnedItem): HTMLElement {
  const li = document.createElement('li');
  li.className = 'pin-drawer-item';
  li.dataset.chatId = item.chatId;
  li.dataset.msgId = item.msgId;

  const meta = document.createElement('div');
  meta.className = 'pin-item-meta';
  const role = document.createElement('span');
  role.className = 'pin-item-role';
  role.textContent = item.role === 'assistant' ? 'Agent'
    : item.role === 'system' ? 'System'
    : 'You';
  const when = document.createElement('span');
  when.className = 'pin-item-time';
  when.textContent = formatRelativeTime(item.pinnedAt);
  when.title = new Date(item.pinnedAt).toLocaleString();
  meta.appendChild(role);
  meta.appendChild(when);

  const body = document.createElement('div');
  body.className = 'pin-item-body';
  body.textContent = item.text;

  const chat = document.createElement('div');
  chat.className = 'pin-item-chat';
  chat.textContent = chatLabelFor(item.chatId);

  li.appendChild(meta);
  li.appendChild(body);
  li.appendChild(chat);

  li.onclick = () => {
    if (onPinClickCb) onPinClickCb(item.chatId, item.msgId);
    // Close on iOS / mobile — fixed overlay panels feel wrong when
    // they stay open after a navigation. Desktop closes too — the
    // drawer-as-overlay model means a focused chat should claim the
    // screen.
    closeDrawer();
  };

  return li;
}

/** Best-effort label for the chat — sidebar lists sessions with
 *  titles, but cross-referencing from here would require importing
 *  sessionDrawer (circular). For now use a short hash of the chat
 *  id; v2 can resolve via a public sessionDrawer.titleFor() helper. */
function chatLabelFor(chatId: string): string {
  // Strip a `sidekick:` prefix for the common case and truncate the
  // UUID-shape suffix so the label fits one line.
  const stripped = chatId.replace(/^sidekick:/, '');
  return stripped.length > 12 ? stripped.slice(0, 12) + '…' : stripped;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** Update all toggle-button count banners — both the mobile-only
 *  toolbar one and the desktop rail one. Each is hidden when count
 *  is 0 so the button doesn't carry visual weight when there's
 *  nothing pinned. */
function refreshCountBanner(): void {
  const n = totalPinCount();
  const txt = n > 99 ? '99+' : String(n);
  for (const banner of countBanners) {
    if (n === 0) {
      banner.hidden = true;
      banner.textContent = '0';
    } else {
      banner.hidden = false;
      banner.textContent = txt;
    }
  }
}

/** Wire up the drawer DOM elements + listeners. Idempotent — re-calling
 *  is a no-op if init already ran. Pass `onPinClick` to receive
 *  drill-to-chat events from item clicks. */
export function initPinDrawer(opts: {
  onPinClick: (chatId: string, msgId: string) => void;
}): void {
  if (drawerEl) return;  // already wired
  drawerEl = document.getElementById('pin-drawer');
  listEl = document.getElementById('pin-drawer-list');
  emptyEl = document.getElementById('pin-drawer-empty');
  // Two toggle entry points — mobile toolbar button + desktop rail
  // button. Both wire to the same handler.
  toggleBtns = [
    document.getElementById('btn-pin-drawer'),
    document.getElementById('btn-pin-drawer-rail'),
  ].filter((el): el is HTMLElement => el !== null);
  countBanners = [
    document.getElementById('pin-drawer-count'),
    document.getElementById('pin-drawer-count-rail'),
  ].filter((el): el is HTMLElement => el !== null);
  clearBtn = document.getElementById('pin-drawer-clear');
  const closeBtn = document.getElementById('pin-drawer-close');
  onPinClickCb = opts.onPinClick;

  if (!drawerEl || !listEl || !emptyEl || toggleBtns.length === 0) {
    log('[pin-drawer] required DOM elements missing — drawer disabled');
    return;
  }

  for (const btn of toggleBtns) {
    btn.addEventListener('click', () => {
      if (isOpen()) closeDrawer();
      else openDrawer();
    });
  }
  if (closeBtn) closeBtn.addEventListener('click', () => closeDrawer());
  if (clearBtn) clearBtn.addEventListener('click', () => {
    // Confirm before wiping — Clear is a destructive operation and
    // a stray tap on a small button shouldn't lose state. confirm()
    // is the cheapest gate that gives the user an undo opportunity.
    if (!window.confirm('Clear all pinned messages?')) return;
    void clearAllPins();
  });

  // Repaint on store mutations + banner refresh. The render() call is
  // a no-op when the drawer is collapsed (it still walks the list, but
  // nothing visible changes); the banner is the only thing the user
  // sees update while the drawer is closed.
  window.addEventListener('sidekick:pins-changed', () => {
    refreshCountBanner();
    if (isOpen()) render();
  });

  // Esc closes (mirrors the cmdk palette + other modal patterns).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) {
      closeDrawer();
      e.stopPropagation();
    }
  });

  refreshCountBanner();
  log('[pin-drawer] initialized');
}
