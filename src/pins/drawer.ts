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

import { listAllPins, totalPinCount, clearAllPins, unpinMessage, type PinnedItem } from './store.ts';
import { log } from '../util/log.ts';
import { createDrawer, type DrawerHandle } from '../Drawer.ts';
import { miniMarkdown } from '../util/markdown.ts';
import {
  clearResolved as clearResolvedActivity,
  dismissActivity,
  hydrate as hydrateActivity,
  listActivity,
  markRead,
  resolveActivity,
  unresolvedApprovalCount,
  unreadActivityCount,
  type ActivityItem,
  type ActivityResolution,
} from '../notifications/activityStore.ts';

let drawerEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let pinPanelEl: HTMLElement | null = null;
let activityPanelEl: HTMLElement | null = null;
let activityListEl: HTMLElement | null = null;
let activityEmptyEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;
let countBanners: HTMLElement[] = [];       // both #pin-drawer-count + #pin-drawer-count-rail
let activityCountBanners: HTMLElement[] = [];
let clearBtn: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let tabButtons: HTMLElement[] = [];
let statusEl: HTMLElement | null = null;
let statusTimer: number | null = null;
let chromeHandle: DrawerHandle | null = null;
let onPinClickCb: ((chatId: string, msgId: string) => void) | null = null;
let onActivityOpenCb: ((chatId: string, msgId: string | null) => void) | null = null;
let onApprovalActionCb: ((chatId: string, action: 'approve' | 'approve_session' | 'deny', msgId: string | null) => void | Promise<void>) | null = null;
let activePanel: 'pins' | 'activity' = 'pins';

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

function selectPanel(panel: 'pins' | 'activity', opts: { open?: boolean } = {}): void {
  activePanel = panel;
  if (titleEl) titleEl.textContent = panel === 'activity' ? 'Activity' : 'Pinned';
  for (const btn of tabButtons) {
    const selected = btn.dataset.rightPanel === panel;
    btn.classList.toggle('active', selected);
    btn.setAttribute('aria-selected', selected ? 'true' : 'false');
  }
  if (pinPanelEl) pinPanelEl.hidden = panel !== 'pins';
  if (activityPanelEl) activityPanelEl.hidden = panel !== 'activity';
  render();
  if (opts.open) openDrawer();
}

/** Re-render the pin list from store state. Cheap — pin counts are
 *  typically small (single-digit to dozens). Called on every
 *  sidekick:pins-changed event and on drawer open. */
function render(): void {
  if (activePanel === 'activity') {
    renderActivity();
    return;
  }
  if (!listEl || !emptyEl) return;
  const pins = listAllPins();
  listEl.innerHTML = '';
  // Clear button visible only when there's something to clear —
  // mirrors the "Mark all read" hint pattern in Settings.
  if (clearBtn) {
    clearBtn.hidden = pins.length === 0;
    clearBtn.textContent = 'Clear';
    clearBtn.setAttribute('aria-label', 'Clear all pinned messages');
    clearBtn.setAttribute('title', 'Clear all pinned messages');
  }
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

function renderActivity(): void {
  if (!activityListEl || !activityEmptyEl) return;
  const items = listActivity();
  activityListEl.innerHTML = '';
  if (clearBtn) {
    clearBtn.hidden = items.length === 0;
    clearBtn.textContent = 'Clear read';
    clearBtn.setAttribute('aria-label', 'Clear read activity');
    clearBtn.setAttribute('title', 'Clear read activity');
  }
  if (items.length === 0) {
    activityEmptyEl.hidden = false;
    activityListEl.hidden = true;
    return;
  }
  activityEmptyEl.hidden = true;
  activityListEl.hidden = false;
  for (const item of items) {
    activityListEl.appendChild(renderActivityItem(item));
  }
}

function renderActivityItem(item: ActivityItem): HTMLElement {
  const li = document.createElement('li');
  li.className = 'activity-drawer-item';
  li.classList.toggle('activity-approval', item.kind === 'approval');
  li.classList.toggle('activity-unread', !item.read && !item.resolved);
  li.classList.toggle('activity-resolved', !!item.resolved);
  li.dataset.activityId = item.id;

  const meta = document.createElement('div');
  meta.className = 'activity-item-meta';
  const title = document.createElement('span');
  title.className = 'activity-item-title';
  title.textContent = item.title;
  const when = document.createElement('span');
  when.className = 'activity-item-time';
  when.textContent = formatRelativeTime(item.createdAt);
  when.title = new Date(item.createdAt).toLocaleString();
  meta.appendChild(title);
  meta.appendChild(when);

  const body = document.createElement('div');
  body.className = 'activity-item-body';
  body.innerHTML = miniMarkdown(activityPreview(item));

  li.appendChild(meta);
  li.appendChild(body);

  if (item.kind === 'approval' && !item.resolved && item.chatId) {
    const actions = document.createElement('div');
    actions.className = 'activity-item-actions';
    for (const [label, action] of [
      ['Approve', 'approve'],
      ['Session', 'approve_session'],
      ['Deny', 'deny'],
    ] as const) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.onclick = (e) => {
        e.stopPropagation();
        const resolution: ActivityResolution =
          action === 'approve' ? 'approved'
          : action === 'approve_session' ? 'approved_session'
          : 'denied';
        resolveActivity(item.id, resolution);
        void onApprovalActionCb?.(item.chatId!, action, item.messageId || null);
      };
      actions.appendChild(btn);
    }
    li.appendChild(actions);
  } else if (item.resolved) {
    const state = document.createElement('div');
    state.className = 'activity-item-state';
    state.textContent = item.resolved.replace('_', ' ');
    li.appendChild(state);
  }

  const footer = document.createElement('div');
  footer.className = 'activity-item-footer';
  const chat = document.createElement('span');
  chat.className = 'pin-item-chat';
  chat.textContent = item.chatId ? chatLabelFor(item.chatId) : 'No chat';
  const dismiss = document.createElement('button');
  dismiss.className = 'pin-item-unpin-btn';
  dismiss.type = 'button';
  dismiss.title = 'Dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss activity');
  dismiss.textContent = '×';
  dismiss.onclick = (e) => {
    e.stopPropagation();
    dismissActivity(item.id);
  };
  footer.appendChild(chat);
  footer.appendChild(dismiss);
  li.appendChild(footer);

  li.onclick = () => {
    markRead(item.id);
    if (item.chatId && onActivityOpenCb) onActivityOpenCb(item.chatId, item.messageId || null);
  };
  return li;
}

function activityPreview(item: ActivityItem): string {
  let body = item.body || '';
  if (item.kind === 'approval') body = approvalPreview(body);
  else if (item.kind === 'cron') {
    const headerRe = /^Cronjob Response:\s*(.+?)\s*\n\(job_id:\s*([^)]+)\)\s*\n-+\s*\n+([\s\S]*?)(?:\n+To stop or manage this job[^\n]*\.?\s*)?$/;
    const m = headerRe.exec(body);
    if (m) body = `${m[1].trim()}: ${m[3].trim()}`;
  }
  return body.length > 500 ? body.slice(0, 497) + '...' : body;
}

function approvalPreview(raw: string): string {
  const text = raw || '';
  const reason = /^Reason:\s*(.+)$/im.exec(text)?.[1]?.trim() || '';
  const lines = text.split('\n');
  const command: string[] = [];
  let inCommand = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/Dangerous command requires approval/i.test(trimmed)) {
      inCommand = true;
      continue;
    }
    if (!inCommand) continue;
    if (!trimmed) {
      if (command.length) command.push('');
      continue;
    }
    if (/^Reason:/i.test(trimmed) || /^Reply\s+\/approve/i.test(trimmed)) break;
    command.push(line.replace(/\s+$/, ''));
  }
  const cmd = command.join('\n').trim().replace(/\n{3,}/g, '\n\n');
  if (reason && cmd) return `${reason}: ${cmd}`;
  return reason || cmd || text;
}

/** Best-effort lookup of the FULL message text for a pinned item.
 *  The store may hold a truncated preview (older pins were capped at
 *  1500 chars before the 2026-05-14 bump to 16000). If the source
 *  bubble is currently rendered in the transcript — i.e. the user is
 *  viewing the chat that owns this pin — its `data-text` (agent) or
 *  `.text` textContent (user) carries the un-truncated original.
 *  Returns the longer of the two so existing truncated pins recover
 *  full text the moment the chat is on screen. */
function fullTextForPin(item: PinnedItem): string {
  const stored = item.text || '';
  try {
    const bubble = document.querySelector(
      `#transcript .line[data-message-id="${CSS.escape(item.msgId)}"]`,
    ) as HTMLElement | null;
    if (!bubble) return stored;
    // Agent path: raw markdown is preserved in dataset.text. User
    // path: textContent of the `.text` span is the originally-sent
    // text (no markdown rendering on user bubbles, just escape + br).
    const live = bubble.dataset.text
      || (bubble.querySelector('.text') as HTMLElement | null)?.textContent
      || '';
    if (!live) return stored;
    // Prefer the live text only if it's strictly longer (avoids
    // overwriting a clean stored copy with a still-streaming or
    // partial DOM read in edge cases).
    return live.length > stored.length ? live : stored;
  } catch {
    return stored;
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
  // Render markdown (bold, italic, code, links, lists) so a pinned
  // bullet list / quoted reply / code snippet reads cleanly instead of
  // raw `**foo**` and `- bar`. Same renderer the transcript uses
  // (chat.addLine markdown:true path); pinned items keep parity.
  // dataset.text holds the raw markdown so copy / future edit paths
  // round-trip losslessly; innerHTML is just the display layer.
  //
  // Source-of-truth fallback: existing pins were stored truncated at
  // 1500 chars (pre 2026-05-14). When the source bubble is in the
  // current chat's DOM, prefer its un-truncated text so old pins
  // recover the moment the user views the chat that owns them.
  const fullText = fullTextForPin(item);
  body.dataset.text = fullText;
  body.innerHTML = miniMarkdown(fullText);
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
    if (wasExpanded) {
      expandedKeys.add(key);
      // Re-check live text on expand — the user may have drilled into
      // the source chat between the initial render and now, making the
      // bubble (and its un-truncated text) available.
      const latest = fullTextForPin(item);
      if (latest.length > (body.dataset.text || '').length) {
        body.dataset.text = latest;
        body.innerHTML = miniMarkdown(latest);
      }
    } else {
      expandedKeys.delete(key);
    }
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
  // Unpin button — filled thumbtack (matches the .pinned state of the
   // bubble's pin button). Clicking removes the entry from the store
   // (which also toggles .pinned off in the source bubble via the
   // sidekick:pins-changed listener).
  const unpinBtn = document.createElement('button');
  unpinBtn.className = 'pin-item-unpin-btn';
  unpinBtn.title = 'Unpin message';
  unpinBtn.setAttribute('aria-label', 'Unpin message');
  unpinBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 17v5" stroke-linecap="round"/><path d="M9 10.76V4h6v6.76l3 1.74v2.5H6v-2.5z"/></svg>';

  const jumpBtn = document.createElement('button');
  jumpBtn.className = 'pin-item-jump-btn';
  jumpBtn.title = 'Open in chat';
  jumpBtn.setAttribute('aria-label', 'Open in chat');
  // Arrow-up-right (open-in-context). Distinct from the bubble's
  // pin icon — this one says "navigate," not "save."
  jumpBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>';
  footer.appendChild(chat);
  footer.appendChild(unpinBtn);
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
  unpinBtn.onclick = (e) => {
    e.stopPropagation();
    // unpinMessage fires sidekick:pins-changed which triggers
    // render() — the item disappears from the list without us
    // needing to remove the DOM node by hand.
    void unpinMessage(item.chatId, item.msgId);
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

function refreshActivityCountBanner(): void {
  const urgent = unresolvedApprovalCount();
  const unread = unreadActivityCount();
  const n = urgent || unread;
  const txt = n > 99 ? '99+' : String(n);
  for (const banner of activityCountBanners) {
    if (n === 0) {
      banner.hidden = true;
      banner.textContent = '0';
    } else {
      banner.hidden = false;
      banner.textContent = txt;
      banner.classList.toggle('urgent', urgent > 0);
    }
  }
}

function showPinStatus(message: string): void {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.hidden = false;
  statusEl.classList.add('visible');
  openDrawer();
  if (statusTimer != null) window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    statusTimer = null;
    if (!statusEl) return;
    statusEl.classList.remove('visible');
    statusEl.hidden = true;
    statusEl.textContent = '';
  }, 5000);
}

/** Wire up the drawer DOM elements + listeners. Idempotent — re-calling
 *  is a no-op if init already ran. Pass `onPinClick` to receive
 *  drill-to-chat events from item clicks. */
export function initPinDrawer(opts: {
  onPinClick: (chatId: string, msgId: string) => void;
  onActivityOpen?: (chatId: string, msgId: string | null) => void;
  onApprovalAction?: (chatId: string, action: 'approve' | 'approve_session' | 'deny', msgId: string | null) => void | Promise<void>;
}): void {
  if (drawerEl) return;  // already wired
  drawerEl = document.getElementById('pin-drawer');
  listEl = document.getElementById('pin-drawer-list');
  pinPanelEl = document.getElementById('pin-drawer-panel');
  activityPanelEl = document.getElementById('activity-drawer-panel');
  activityListEl = document.getElementById('activity-drawer-list');
  activityEmptyEl = document.getElementById('activity-drawer-empty');
  emptyEl = document.getElementById('pin-drawer-empty');
  statusEl = document.getElementById('pin-drawer-status');
  titleEl = document.getElementById('right-drawer-title');
  tabButtons = Array.from(document.querySelectorAll<HTMLElement>('[data-right-panel]'));
  countBanners = [
    document.getElementById('pin-drawer-count'),
    document.getElementById('pin-drawer-count-rail'),
  ].filter((el): el is HTMLElement => el !== null);
  activityCountBanners = [
    document.getElementById('activity-drawer-count'),
    document.getElementById('activity-drawer-count-rail'),
  ].filter((el): el is HTMLElement => el !== null);
  clearBtn = document.getElementById('pin-drawer-clear');
  onPinClickCb = opts.onPinClick;
  onActivityOpenCb = opts.onActivityOpen ?? null;
  onApprovalActionCb = opts.onApprovalAction ?? null;

  if (!drawerEl || !listEl || !emptyEl || !activityListEl || !activityEmptyEl) {
    log('[pin-drawer] required DOM elements missing — drawer disabled');
    return;
  }
  hydrateActivity();

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
    toggleIds: [
      'btn-pin-drawer',
      'btn-pin-drawer-rail',
      'btn-activity-drawer',
      'btn-activity-drawer-rail',
    ],
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

  wirePanelToggle(['btn-activity-drawer', 'btn-activity-drawer-rail'], 'activity');
  wirePanelToggle(['btn-pin-drawer', 'btn-pin-drawer-rail'], 'pins');
  for (const btn of tabButtons) {
    btn.addEventListener('click', () => {
      const panel = btn.dataset.rightPanel === 'activity' ? 'activity' : 'pins';
      selectPanel(panel);
    });
  }

  // Per-row controls — Clear-all only. The X close button was dropped
  // 2026-05-16 (Jonathan: pin/session-drawer symmetry — session drawer
  // closes via the rail toggle / Esc / click-outside / swipe; pin
  // drawer now uses the same affordances, no header X).
  if (clearBtn) clearBtn.addEventListener('click', () => {
    if (activePanel === 'activity') {
      clearResolvedActivity();
      return;
    }
    if (!window.confirm('Clear all pinned messages?')) return;
    void clearAllPins();
  });

  // Repaint on store mutations.
  window.addEventListener('sidekick:pins-changed', () => {
    refreshCountBanner();
    if (isOpen()) render();
  });
  window.addEventListener('sidekick:activity-changed', () => {
    refreshActivityCountBanner();
    if (isOpen() && activePanel === 'activity') renderActivity();
  });
  window.addEventListener('sidekick:pin-error', (ev) => {
    const detail = (ev as CustomEvent<{ message?: string }>).detail;
    showPinStatus(detail?.message || 'Could not update pinned messages.');
  });

  refreshCountBanner();
  refreshActivityCountBanner();
  selectPanel(activePanel);
  log('[pin-drawer] initialized');
}

function wirePanelToggle(ids: string[], panel: 'pins' | 'activity'): void {
  for (const id of ids) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.addEventListener('click', (e) => {
      // Capture-phase override for Drawer.ts's generic toggle listener:
      // the rail now has two module icons. Clicking the active module
      // toggles the drawer; clicking the inactive module switches panels.
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      if (isOpen() && activePanel === panel) {
        closeDrawer();
        return;
      }
      selectPanel(panel, { open: true });
    }, true);
  }
}
