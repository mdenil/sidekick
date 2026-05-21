// Right-side drawer host bootstrap. Individual drawer tabs live in
// src/rightDrawer/modules/* so adding another first-party tab follows a
// clear pattern: create a module, register it below, and listen for its
// store-change event here.

import { totalPinCount } from './store.ts';
import { log } from '../util/log.ts';
import { createRightDrawerHost, type RightDrawerHost } from '../rightDrawer/host.ts';
import { hydrate as hydrateActivity, unresolvedApprovalCount, unreadActivityCount } from '../notifications/activityStore.ts';
import { createActivityModule, type ActivityOpenHandler, type ApprovalActionHandler } from '../rightDrawer/modules/activity.ts';
import { createPinsModule, type PinClickHandler } from '../rightDrawer/modules/pins.ts';

let drawerEl: HTMLElement | null = null;
let pinPanelEl: HTMLElement | null = null;
let activityPanelEl: HTMLElement | null = null;
let countBanners: HTMLElement[] = [];
let activityCountBanners: HTMLElement[] = [];
let clearBtn: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let statusTimer: number | null = null;
let drawerHost: RightDrawerHost | null = null;
let activePanel: 'pins' | 'activity' = 'pins';

function isOpen(): boolean { return !!drawerHost?.isOpen(); }
function openDrawer(): void { drawerHost?.open(); }

function refreshCountBanner(): void {
  const n = totalPinCount();
  const txt = n > 99 ? '99+' : String(n);
  for (const banner of countBanners) {
    if (n === 0) { banner.hidden = true; banner.textContent = '0'; }
    else { banner.hidden = false; banner.textContent = txt; }
  }
}

function refreshActivityCountBanner(): void {
  const urgent = unresolvedApprovalCount();
  const unread = unreadActivityCount();
  const n = urgent || unread;
  const txt = n > 99 ? '99+' : String(n);
  for (const banner of activityCountBanners) {
    if (n === 0) { banner.hidden = true; banner.textContent = '0'; }
    else { banner.hidden = false; banner.textContent = txt; banner.classList.toggle('urgent', urgent > 0); }
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

export function initPinDrawer(opts: {
  onPinClick: PinClickHandler;
  onActivityOpen?: ActivityOpenHandler;
  onApprovalAction?: ApprovalActionHandler;
}): void {
  if (drawerEl) return;
  drawerEl = document.getElementById('pin-drawer');
  const listEl = document.getElementById('pin-drawer-list');
  pinPanelEl = document.getElementById('pin-drawer-panel');
  activityPanelEl = document.getElementById('activity-drawer-panel');
  const activityListEl = document.getElementById('activity-drawer-list');
  const activityEmptyEl = document.getElementById('activity-drawer-empty');
  const emptyEl = document.getElementById('pin-drawer-empty');
  statusEl = document.getElementById('pin-drawer-status');
  titleEl = document.getElementById('right-drawer-title');
  clearBtn = document.getElementById('pin-drawer-clear');
  countBanners = [document.getElementById('pin-drawer-count'), document.getElementById('pin-drawer-count-rail')]
    .filter((el): el is HTMLElement => el !== null);
  activityCountBanners = [document.getElementById('activity-drawer-count'), document.getElementById('activity-drawer-count-rail')]
    .filter((el): el is HTMLElement => el !== null);

  if (!drawerEl || !listEl || !emptyEl || !pinPanelEl || !activityPanelEl || !activityListEl || !activityEmptyEl) {
    log('[pin-drawer] required DOM elements missing — drawer disabled');
    return;
  }
  hydrateActivity();

  drawerHost = createRightDrawerHost({
    drawerId: 'pin-drawer',
    titleEl,
    clearButton: clearBtn,
    defaultModuleId: activePanel,
    modules: [
      createActivityModule({
        panel: activityPanelEl,
        list: activityListEl,
        empty: activityEmptyEl,
        onOpen: opts.onActivityOpen ?? null,
        onApprovalAction: opts.onApprovalAction ?? null,
        onSelect: () => { activePanel = 'activity'; },
      }),
      createPinsModule({
        panel: pinPanelEl,
        list: listEl,
        empty: emptyEl,
        onPinClick: opts.onPinClick,
        onSelect: () => { activePanel = 'pins'; },
      }),
    ],
    bodyClass: 'pin-drawer-open',
    prefKey: 'sidekick.pin-drawer.expanded',
    excludeSwipeWhenTargetIn: ['#sidebar'],
    resizer: {
      handleId: 'pin-drawer-resizer',
      cssVar: '--pin-drawer-width',
      widthPrefKey: 'sidekick.pinDrawerWidth',
      defaultWidthPx: 360,
      minWidthPx: 260,
      maxWidthPx: 600,
    },
  });

  window.addEventListener('sidekick:pins-changed', () => {
    refreshCountBanner();
    if (isOpen() && activePanel === 'pins') drawerHost?.render();
  });
  window.addEventListener('sidekick:activity-changed', () => {
    refreshActivityCountBanner();
    if (isOpen() && activePanel === 'activity') drawerHost?.render();
  });
  window.addEventListener('sidekick:pin-error', (ev) => {
    const detail = (ev as CustomEvent<{ message?: string }>).detail;
    showPinStatus(detail?.message || 'Could not update pinned messages.');
  });

  refreshCountBanner();
  refreshActivityCountBanner();
  log('[pin-drawer] initialized');
}
