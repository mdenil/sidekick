/**
 * @fileoverview Ambient clock + weather widget — floats in the lower-
 * right of the desktop viewport. Two states:
 *   - compact  (default): thin pill with time + current temp/icon
 *   - expanded (on click): rounded card with big clock, current weather
 *     detail, and a 3-day forecast strip. Click the card itself to
 *     collapse. Stays expanded otherwise — lets the HUD persist while
 *     the user chats.
 *
 * Hidden on mobile via CSS media query. Weather fetches the gateway's
 * /weather passthrough (Open-Meteo) with 15-min caching.
 */

import { escapeHtml } from './util/dom.ts';
import { log } from './util/log.ts';

const WEATHER_TTL_MS = 15 * 60 * 1000;

/** WMO → [emoji, description]. Used in both compact + expanded states. */
const WMO = {
  0: ['☀️', 'clear'],
  1: ['🌤', 'mainly clear'], 2: ['⛅', 'partly cloudy'], 3: ['☁️', 'overcast'],
  45: ['🌫', 'fog'], 48: ['🌫', 'rime fog'],
  51: ['🌦', 'light drizzle'], 53: ['🌦', 'drizzle'], 55: ['🌧', 'heavy drizzle'],
  56: ['🌧', 'freezing drizzle'], 57: ['🌧', 'freezing drizzle'],
  61: ['🌦', 'light rain'], 63: ['🌧', 'rain'], 65: ['🌧', 'heavy rain'],
  66: ['🌧', 'freezing rain'], 67: ['🌧', 'freezing rain'],
  71: ['🌨', 'light snow'], 73: ['🌨', 'snow'], 75: ['❄️', 'heavy snow'],
  77: ['🌨', 'snow grains'],
  80: ['🌦', 'rain showers'], 81: ['🌦', 'rain showers'], 82: ['🌧', 'violent showers'],
  85: ['🌨', 'snow showers'], 86: ['🌨', 'heavy snow showers'],
  95: ['⛈', 'thunderstorm'], 96: ['⛈', 'thunder + hail'], 99: ['⛈', 'thunder + hail'],
};

let weatherCache = null;
let weatherFetchedAt = 0;
/** @type {HTMLElement|null} */
let rootEl = null;
let tickTimer = null;

/** External callbacks injected at init time. When `isExpandedRef` is
 *  supplied the widget reads expand state from there (instead of its
 *  own localStorage var) and clicks call `onClick` instead of mutating
 *  local state. This is how the right-side pin drawer integrates the
 *  widget — clicking the clock expands the DRAWER, not just the widget.
 *  Both refs are optional so the legacy floating-pill mode keeps
 *  working for hosts that don't supply them. */
let isExpandedRef: (() => boolean) | null = null;
let onClickRef: (() => void) | null = null;

/** Expanded state persisted to localStorage — used only when no
 *  external isExpandedRef is supplied (legacy floating-widget mode).
 *  Same pattern the sidebar uses for its own collapsed-pref. */
const AMBIENT_PREF_KEY = 'sidekick.ambient.expanded';
let localExpanded = (() => {
  try { return localStorage.getItem(AMBIENT_PREF_KEY) === '1'; } catch { return false; }
})();
function isExpanded(): boolean {
  return isExpandedRef ? isExpandedRef() : localExpanded;
}

async function loadWeather() {
  const now = Date.now();
  if (weatherCache && (now - weatherFetchedAt) < WEATHER_TTL_MS) return weatherCache;
  try {
    const { fetchWithTimeout } = await import('./util/fetchWithTimeout.ts');
    const r = await fetchWithTimeout('/weather', { timeoutMs: 10_000 });
    weatherCache = await r.json();
    weatherFetchedAt = now;
  } catch (e) {
    log('ambient weather fetch failed:', e.message);
    weatherCache = null;
  }
  return weatherCache;
}

/** Initialize the ambient HUD.
 *
 *  Two modes (controlled by `opts`):
 *    - Legacy floating pill: omit opts. The widget mounts as a fixed
 *      element on document.body and owns its own expand state.
 *    - In-drawer: pass `mount` + `isExpanded` + `onClick`. The widget
 *      renders into `mount`, reads expand state from `isExpanded()`
 *      (so the parent drawer's open/closed state drives the visual),
 *      and clicks invoke `onClick()` (so the parent drawer can
 *      toggle itself). */
export function init(opts?: {
  mount?: HTMLElement;
  isExpanded?: () => boolean;
  onClick?: () => void;
}) {
  if (rootEl) return;
  rootEl = document.createElement('div');
  rootEl.className = 'ambient-widget';
  if (opts?.mount) rootEl.classList.add('ambient-in-drawer');
  isExpandedRef = opts?.isExpanded || null;
  onClickRef = opts?.onClick || null;
  rootEl.addEventListener('click', () => {
    if (onClickRef) {
      onClickRef();
    } else {
      localExpanded = !localExpanded;
      try { localStorage.setItem(AMBIENT_PREF_KEY, localExpanded ? '1' : '0'); } catch {}
    }
    void render();
  });
  (opts?.mount || document.body).appendChild(rootEl);
  void render();
  tickTimer = setInterval(render, 60_000);
  // In-drawer mode reads `isExpanded()` from the parent drawer's
  // body class (e.g. `pin-drawer-open`). When the user toggles the
  // drawer the body class flips immediately but the widget's render
  // doesn't refire until the next 1-minute tick — leaving the
  // compact (48px rail) layout visible inside the now-expanded
  // 360px drawer column. Watch the body's class attribute and
  // re-render on every change so the widget swaps to its expanded
  // 3-day-forecast layout the moment the drawer opens (and back to
  // compact the moment it closes). Cheap: the observer fires only
  // on class mutations, not every attribute change.
  if (opts?.mount && typeof MutationObserver !== 'undefined') {
    const bodyObserver = new MutationObserver(() => { void render(); });
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
}

/** Re-render on demand — used by the parent drawer when its open/close
 *  state changes so the widget can switch between compact + expanded
 *  layouts without waiting for the 1-minute tick. */
export function repaint(): void {
  void render();
}

async function render() {
  if (!rootEl) return;
  const exp = isExpanded();
  rootEl.classList.toggle('expanded', exp);
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const w = await loadWeather();
  if (!rootEl) return;  // disposed during fetch
  rootEl.innerHTML = exp
    ? renderExpanded(hh, mm, now, w)
    : renderCompact(hh, mm, w);
}

function renderCompact(hh, mm, w) {
  const code = w?.current?.weather_code;
  const [icon] = code != null ? (WMO[code] || ['', '']) : ['', ''];
  const temp = w?.current?.temperature_2m;
  const tempStr = temp != null ? `${Math.round(temp)}°` : '';
  const weatherHtml = icon || tempStr
    ? `<span class="ambient-weather">${icon}<span class="ambient-temp">${escapeHtml(tempStr)}</span></span>`
    : '';
  return `<span class="ambient-time">${hh}:${mm}</span>${weatherHtml}`;
}

function renderExpanded(hh, mm, dateObj, w) {
  const dateStr = dateObj.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const cur = w?.current;
  const daily = w?.daily;
  const code = cur?.weather_code;
  const [icon, desc] = code != null ? (WMO[code] || ['❔', 'weather']) : ['❔', 'weather'];
  const temp = cur?.temperature_2m != null ? Math.round(cur.temperature_2m) : null;
  const hi = daily?.temperature_2m_max?.[0] != null ? Math.round(daily.temperature_2m_max[0]) : null;
  const lo = daily?.temperature_2m_min?.[0] != null ? Math.round(daily.temperature_2m_min[0]) : null;

  const currentRow = temp != null ? `
    <div class="amb-current">
      <span class="amb-icon">${icon}</span>
      <div class="amb-cur-meta">
        <div class="amb-cur-temp">${temp}°</div>
        <div class="amb-cur-desc">${escapeHtml(desc)}${hi != null && lo != null ? ` · h${hi}° l${lo}°` : ''}</div>
      </div>
    </div>` : '';

  // Forecast strip — tomorrow onwards. /weather returns 4 days total,
  // so we slice [1..4).
  let forecastHtml = '';
  if (daily?.time?.length > 1) {
    const rows = [];
    for (let i = 1; i < Math.min(daily.time.length, 4); i++) {
      const d = new Date(daily.time[i] + 'T00:00');
      const wd = d.toLocaleDateString(undefined, { weekday: 'short' });
      const [fi] = WMO[daily.weather_code?.[i]] || ['❔', ''];
      const fhi = daily.temperature_2m_max?.[i] != null ? Math.round(daily.temperature_2m_max[i]) : '—';
      const flo = daily.temperature_2m_min?.[i] != null ? Math.round(daily.temperature_2m_min[i]) : '—';
      rows.push(`
        <div class="amb-forecast-row">
          <span class="amb-fc-day">${escapeHtml(wd)}</span>
          <span class="amb-fc-icon">${fi}</span>
          <span class="amb-fc-temps">${fhi}° <span class="amb-fc-lo">${flo}°</span></span>
        </div>`);
    }
    forecastHtml = `<div class="amb-forecast">${rows.join('')}</div>`;
  }

  return `
    <div class="amb-clock">${hh}:${mm}</div>
    <div class="amb-date">${escapeHtml(dateStr)}</div>
    ${currentRow}
    ${forecastHtml}
  `;
}

export function dispose() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (rootEl) { rootEl.remove(); rootEl = null; }
}
