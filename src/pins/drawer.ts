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
import { createDrawer, type DrawerHandle } from '../Drawer.ts';

let drawerEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;
let countBanners: HTMLElement[] = [];       // both #pin-drawer-count + #pin-drawer-count-rail
let clearBtn: HTMLElement | null = null;
let chromeHandle: DrawerHandle | null = null;
let onPinClickCb: ((chatId: string, msgId: string) => void) | null = null;

// Per-item expanded state — keyed by `${chatId}|${msgId}`. Survives
// re-renders from the sidekick:pins-changed listener (which rebuilds
// the <li> children each pass) so an expanded item stays expanded
// after, e.g., a new pin gets added elsewhere. Cleared when the pin
// itself is removed (renderItem just doesn't re-add the .expanded
// class for absent keys).
const expandedKeys = new Set<string>();

function isOpen(): boolean {
  return !!chromeHandle?.isOpen();
}

function openDrawer(): void { chromeHandle?.open(); }
function closeDrawer(): void { chromeHandle?.close(); }

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
  // Click the body to toggle expansion in-place. Multi-line clamp by
  // default (3 lines) keeps the drawer scannable; expanded reveals
  // the full stored text (up to ~1500 chars from pin-time). Per-item
  // state is class-based so it survives re-renders triggered by
  // sidekick:pins-changed (the class is re-evaluated each pass via
  // the per-key expandedKeys set below).
  body.style.cursor = 'pointer';
  body.title = 'Click to expand / collapse';
  body.onclick = (e) => {
    e.stopPropagation();   // don't drill on body-click
    const wasExpanded = li.classList.toggle('expanded');
    const key = `${item.chatId}|${item.msgId}`;
    if (wasExpanded) expandedKeys.add(key);
    else expandedKeys.delete(key);
  };
  // Apply persistent expanded state from the cross-render set.
  if (expandedKeys.has(`${item.chatId}|${item.msgId}`)) {
    li.classList.add('expanded');
  }

  // Footer row: chat label on the left, jump-to-context icon on the
  // right. The icon is the explicit affordance Jonathan asked for —
  // a discoverable "open this in its chat" button (arrow-up-right
  // / external-link iconography). The whole row is ALSO clickable
  // for the common case where the user just taps anywhere on the
  // item; the icon is the cue that this is what happens.
  const footer = document.createElement('div');
  footer.className = 'pin-item-footer';
  const chat = document.createElement('span');
  chat.className = 'pin-item-chat';
  chat.textContent = chatLabelFor(item.chatId);
  const jumpBtn = document.createElement('button');
  jumpBtn.className = 'pin-item-jump-btn';
  jumpBtn.title = 'Open in chat';
  jumpBtn.setAttribute('aria-label', 'Open in chat');
  // Arrow-up-right (open-in-context). Distinct from the bubble's
  // pin icon — this one says "navigate," not "save."
  jumpBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>';
  footer.appendChild(chat);
  footer.appendChild(jumpBtn);

  li.appendChild(meta);
  li.appendChild(body);
  li.appendChild(footer);

  const drill = () => {
    if (onPinClickCb) onPinClickCb(item.chatId, item.msgId);
    // Auto-close ONLY on mobile — on mobile the drawer is a full
    // overlay covering the chat, so it has to dismiss to reveal the
    // drilled-to message. On desktop the drawer sits beside the chat
    // (3-column layout) and Jonathan wants it persistent: pinned
    // messages function as a todo list while the user continues the
    // conversation. Field UX 2026-05-13.
    if (window.innerWidth < 700) closeDrawer();
  };
  li.onclick = drill;
  // Explicit handler on the jump button + stopPropagation so a click
  // doesn't double-fire via the row. Same destination either way,
  // but keeps the event accounting clean (matters for any future
  // alternate row-click action).
  jumpBtn.onclick = (e) => { e.stopPropagation(); drill(); };

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
  countBanners = [
    document.getElementById('pin-drawer-count'),
    document.getElementById('pin-drawer-count-rail'),
  ].filter((el): el is HTMLElement => el !== null);
  clearBtn = document.getElementById('pin-drawer-clear');
  const closeBtn = document.getElementById('pin-drawer-close');
  onPinClickCb = opts.onPinClick;

  if (!drawerEl || !listEl || !emptyEl) {
    log('[pin-drawer] required DOM elements missing — drawer disabled');
    return;
  }

  // Unified drawer chrome — open/close, toggles, swipe, resizer,
  // click-outside, Escape, .front swap, persistence. Same module
  // the left sidebar uses; only side / body class / resizer config
  // differ. Behavior is guaranteed-identical to the sidebar by
  // construction.
  chromeHandle = createDrawer({
    id: 'pin-drawer',
    side: 'right',
    bodyClass: 'pin-drawer-open',
    prefKey: 'sidekick.pin-drawer.expanded',
    toggleIds: ['btn-pin-drawer', 'btn-pin-drawer-rail'],
    excludeSwipeWhenTargetIn: ['#sidebar'],
    resizer: {
      handleId: 'pin-drawer-resizer',
      cssVar: '--pin-drawer-width',
      widthPrefKey: 'sidekick.pinDrawerWidth',
      defaultWidthPx: 360,
      minWidthPx: 260,
      maxWidthPx: 600,
    },
    onOpen: () => render(),  // refresh list when drawer opens
  });

  // Per-row controls — Close (X) + Clear-all. These are pin-drawer-
  // specific UI and stay here, not in the chrome module.
  if (closeBtn) closeBtn.addEventListener('click', () => closeDrawer());
  if (clearBtn) clearBtn.addEventListener('click', () => {
    if (!window.confirm('Clear all pinned messages?')) return;
    void clearAllPins();
  });

  // Repaint on store mutations.
  window.addEventListener('sidekick:pins-changed', () => {
    refreshCountBanner();
    if (isOpen()) render();
  });

  refreshCountBanner();
  log('[pin-drawer] initialized');
}
