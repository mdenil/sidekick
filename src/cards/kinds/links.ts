/**
 * @fileoverview Link-list card kind. Renders with OG-enriched previews,
 * inline iframes for frameable sites, and Google Maps embeds.
 *
 * @typedef {import('../../types.js').LinksPayload} LinksPayload
 * @typedef {import('../../types.js').CanvasCard} CanvasCard
 */

import { escapeHtml, escapeAttr } from '../../util/dom.ts';
import { getConfig } from '../../config.ts';

/** @type {import('../../types.js').CardKindModule} */
export default {
  kind: 'links',
  icon: '⎘',
  label: 'Links',

  validate(payload) {
    const errors = [];
    if (!Array.isArray(payload.links) || payload.links.length === 0) {
      errors.push('links must be a non-empty array');
    } else {
      for (const l of payload.links) {
        if (typeof l.url !== 'string' || !l.url) errors.push('link missing url');
      }
    }
    return errors;
  },

  render(card, container) {
    const p = /** @type {LinksPayload} */ (card.payload);
    const div = document.createElement('div');
    div.className = 'card-links';

    // tryIframe (for the link-preview decorate path) is single-link-only
    // because link-iframe-wrap is meant to be the dominant visual; doing
    // it 10 times for a 10-link card would be visually overwhelming. The
    // maps embed below is per-link though — every maps URL gets its own
    // interactive map because the iframe is the entire useful payload
    // (the equivalent of the "preview screenshot + meta" otherwise).
    const tryIframe = p.links.length === 1;

    for (const link of p.links) {
      const host = safeHost(link.url);

      // Google Maps → use Embed API (interactive map, not a static
      // preview). Per-link, not gated on tryIframe — multi-link cards
      // with multiple maps URLs get one embed per URL.
      const mapsEmbed = buildMapsEmbed(link.url);
      if (mapsEmbed) {
        const frame = document.createElement('div');
        frame.className = 'link-iframe-wrap maps';
        frame.innerHTML = `<iframe src="${escapeAttr(mapsEmbed)}" allowfullscreen loading="lazy" referrerpolicy="no-referrer"></iframe>`;
        div.appendChild(frame);
        // Still show a small link below for "open in Google Maps"
        const a = document.createElement('a');
        a.href = link.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.className = 'open-ext';
        a.textContent = 'open in google maps ↗';
        div.appendChild(a);
        continue;
      }

      const a = document.createElement('a');
      a.href = link.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'link-preview';
      a.innerHTML = renderPreviewBody(link, host);
      div.appendChild(a);
      fetchAndDecorate(a, link.url, host, tryIframe, div);
    }

    container.appendChild(div);
  },
};

// ── Google Maps Embed ─────────────────────────────────────────────────────

/**
 * Detect Google Maps URLs and convert to Embed API format.
 * Returns embed URL or null if not a maps link.
 */
// Exported for the test suite — internal helper otherwise.
// `keyOverride` lets tests pass a key directly without going through
// the runtime config singleton.
export function buildMapsEmbed(url, keyOverride?: string) {
  let key = keyOverride;
  if (!key) {
    try { key = getConfig().mapsEmbedKey; } catch { return null; }
  }
  if (!key) return null;

  // Directions — TWO accepted URL shapes (Google emits both, agents
  // produce either, both should render the route inline):
  //
  //   1. Path-style:    /maps/dir/ORIGIN/DESTINATION
  //                     (classic; what /maps/dir/ permalinks use)
  //   2. Query-style:   /maps/dir/?api=1&origin=X&destination=Y
  //                     (modern share format the Maps "Share" button emits;
  //                     also what most LLM agents naturally produce)
  //
  // Try query-style first since it carries unambiguous origin / destination
  // params; path-style is the fallback for permalinks.
  try {
    const u = new URL(url);
    const isMapsHost = /(^|\.)google\.[a-z.]+$/i.test(u.hostname);
    const isMapsPath = u.pathname === '/maps' || u.pathname.startsWith('/maps/');
    if (isMapsHost && isMapsPath) {
      const origin = u.searchParams.get('origin');
      const destination = u.searchParams.get('destination');
      if (origin && destination) {
        const mode = u.searchParams.get('travelmode');
        const modeParam = mode ? `&mode=${encodeURIComponent(mode)}` : '';
        return `https://www.google.com/maps/embed/v1/directions?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}${modeParam}&key=${key}`;
      }
    }
  } catch { /* not a parseable URL — fall through to regex fallbacks */ }

  // Path-style fallback: /maps/dir/ORIGIN/DESTINATION
  // Real URLs often trail with /@lat,lng,zoomz/data=!3m1!4b1!... — those
  // segments are NOT destinations and break the Embed API if passed through.
  const dirMatch = url.match(/google\.com\/maps\/dir\/([^?]+)/i);
  if (dirMatch) {
    const parts = dirMatch[1]
      .split('/')
      .filter(p => p && !isNonPlaceSegment(p))
      .map(decodeURIComponent);
    if (parts.length >= 2) {
      const origin = encodeURIComponent(parts[0].replace(/\+/g, ' '));
      const dest = encodeURIComponent(parts[parts.length - 1].replace(/\+/g, ' '));
      return `https://www.google.com/maps/embed/v1/directions?origin=${origin}&destination=${dest}&key=${key}`;
    }
  }

  // Place: google.com/maps/place/PLACE or google.com/maps?q=QUERY
  const placeMatch = url.match(/google\.com\/maps\/place\/([^/?]+)/i);
  if (placeMatch && !isNonPlaceSegment(placeMatch[1])) {
    const q = encodeURIComponent(decodeURIComponent(placeMatch[1]).replace(/\+/g, ' '));
    return `https://www.google.com/maps/embed/v1/place?q=${q}&key=${key}`;
  }

  // Search query: google.com/maps/search/QUERY or google.com/maps?q=QUERY
  const searchMatch = url.match(/google\.com\/maps\/search\/([^/?]+)/i) ||
                      url.match(/google\.com\/maps\?.*q=([^&]+)/i);
  if (searchMatch) {
    const q = encodeURIComponent(decodeURIComponent(searchMatch[1]).replace(/\+/g, ' '));
    return `https://www.google.com/maps/embed/v1/search?q=${q}&key=${key}`;
  }

  // Generic maps URL with coordinates: /@LAT,LNG,ZOOM
  const coordMatch = url.match(/google\.com\/maps.*\/@([-\d.]+),([-\d.]+),([\d.]+)z/i);
  if (coordMatch) {
    return `https://www.google.com/maps/embed/v1/view?center=${coordMatch[1]},${coordMatch[2]}&zoom=${coordMatch[3]}&key=${key}`;
  }

  return null;
}

/**
 * A Google Maps URL path segment that is NOT a place name:
 *   • `@37.12,-122.12,15z` — coordinate + zoom (prefixed with `@`)
 *   • `data=!3m1!4b1!4m5...` — Maps' opaque protobuf-in-URL data blob
 *     (anything containing `=` is param-like, never a place)
 */
function isNonPlaceSegment(seg) {
  return seg.startsWith('@') || seg.includes('=');
}

// ── OG Preview ────────────────────────────────────────────────────────────

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

function renderPreviewBody(link, host) {
  const img = link.image
    ? `<img class="preview-image" src="${escapeAttr(link.image)}" alt="" loading="lazy" onerror="this.remove()">`
    : '';
  return `${img}
    <div class="preview-body">
      <div class="preview-host">
        <img src="https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(host)}" alt="">
        <span>${escapeHtml(link.site_name || host)}</span>
      </div>
      <div class="preview-title">${escapeHtml(link.title || link.url)}</div>
      ${link.description ? `<div class="preview-desc">${escapeHtml(link.description)}</div>` : ''}
    </div>`;
}

async function fetchAndDecorate(anchor, url, host, tryIframe, container) {
  try {
    const { fetchWithTimeout } = await import('../../util/fetchWithTimeout.ts');
    const r = await fetchWithTimeout(`/link-preview?url=${encodeURIComponent(url)}`, { timeoutMs: 10_000 });
    const og = await r.json();

    // Use OG image if available; fall back to Chromium screenshot for sites
    // with no OG data (paywalled/JS-rendered like NYT)
    let image = og.image;
    if (!image && !og.description) {
      image = `/screenshot?url=${encodeURIComponent(url)}`;
    }
    const enriched = {
      url, title: og.title, description: og.description,
      image, site_name: og.siteName,
    };
    anchor.innerHTML = renderPreviewBody(enriched, host);

    if (tryIframe && og.frameable) {
      const frame = document.createElement('div');
      frame.className = 'link-iframe-wrap';
      frame.innerHTML = `
        <iframe src="${escapeAttr(url)}"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          loading="lazy" referrerpolicy="no-referrer"></iframe>`;
      container.insertBefore(frame, anchor);
    }
  } catch { /* keep skeleton */ }
}
