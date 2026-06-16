// TEMPORARY diagnostic harness for the "scroll jumps for ~10s after a
// session switch" field report (2026-06-16). Inert unless the user opts
// in with `localStorage.setItem('sk-scroll-diag','1')` and reloads. It
// records a timestamped timeline of every scroll-affecting event on
// #transcript — scroll position changes, DOM mutations (rows added/
// removed), size changes, late image loads — plus a marker on each
// drawer click so the timeline is anchored to the switch the user made.
//
// Reproduce: enable the flag, reload, switch into the chat that jumps,
// let it settle (~10s), then run `__scrollDiagDump()` in the console and
// paste the result. REMOVE this module + its init call once diagnosed.

type DiagEntry = {
  t: number;          // ms since the last switch marker
  ev: string;         // event kind
  top: number;        // scrollTop at the moment
  height: number;     // scrollHeight
  client: number;     // clientHeight
  note?: string;      // extra context (added/removed counts, label, etc.)
};

const FLAG_KEY = 'sk-scroll-diag';

export function initScrollDiag(): void {
  let enabled = false;
  try { enabled = localStorage.getItem(FLAG_KEY) === '1'; } catch { /* private mode */ }
  if (!enabled) return;

  const w = window as unknown as {
    __scrollDiag?: DiagEntry[];
    __scrollDiagDump?: () => string;
    __scrollDiagMark?: (label: string) => void;
    __scrollDiagClear?: () => void;
  };

  const buf: DiagEntry[] = [];
  w.__scrollDiag = buf;
  let t0 = performance.now();

  const el = () => document.getElementById('transcript');

  const push = (ev: string, note?: string) => {
    const t = el();
    buf.push({
      t: Math.round(performance.now() - t0),
      ev,
      top: t ? Math.round(t.scrollTop) : -1,
      height: t ? Math.round(t.scrollHeight) : -1,
      client: t ? Math.round(t.clientHeight) : -1,
      note,
    });
    // Cap so a long session can't grow unbounded.
    if (buf.length > 4000) buf.splice(0, buf.length - 4000);
  };

  const mark = (label: string) => { t0 = performance.now(); buf.push({ t: 0, ev: 'MARK', top: -1, height: -1, client: -1, note: label }); };
  w.__scrollDiagMark = mark;
  w.__scrollDiagClear = () => { buf.length = 0; };
  w.__scrollDiagDump = () => {
    // eslint-disable-next-line no-console
    console.table(buf);
    const json = JSON.stringify(buf);
    try { (navigator as unknown as { clipboard?: { writeText: (s: string) => void } }).clipboard?.writeText(json); } catch { /* no clipboard */ }
    return json;
  };

  // Anchor the timeline to the switch the user makes: any click inside the
  // sidebar/drawer re-baselines t and drops a marker (capture phase so we
  // see it before the app's own handler runs).
  document.addEventListener('click', (e) => {
    const tgt = e.target as HTMLElement | null;
    if (!tgt) return;
    if (tgt.closest('#sidebar, .session-row, .pin-row, [data-chat-id]')) {
      const label = (tgt.closest('[data-chat-id]') as HTMLElement | null)?.getAttribute('data-chat-id')
        || tgt.textContent?.trim().slice(0, 40)
        || 'drawer-click';
      mark(`switch:${label}`);
    }
  }, true);

  let scrollRaf = 0;
  const wire = (t: HTMLElement) => {
    t.addEventListener('scroll', () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; push('scroll'); });
    }, { passive: true });

    new MutationObserver((muts) => {
      let added = 0, removed = 0, imgs = 0;
      for (const m of muts) {
        added += m.addedNodes.length;
        removed += m.removedNodes.length;
        m.addedNodes.forEach((n) => {
          if (n instanceof HTMLElement) {
            const found = n.tagName === 'IMG' ? [n] : Array.from(n.querySelectorAll('img'));
            for (const im of found) {
              const img = im as HTMLImageElement;
              imgs++;
              if (!img.complete) {
                img.addEventListener('load', () => push('img-load'), { once: true });
                img.addEventListener('error', () => push('img-error'), { once: true });
              }
            }
          }
        });
      }
      push('mutation', `+${added}/-${removed}${imgs ? ` imgs:${imgs}` : ''}`);
    }).observe(t, { childList: true, subtree: true });

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => push('resize')).observe(t);
    }
    push('wired');
  };

  // #transcript may not exist yet at boot; poll briefly until it does.
  const tNow = el();
  if (tNow) { wire(tNow); }
  else {
    let tries = 0;
    const iv = setInterval(() => {
      const t = el();
      if (t) { clearInterval(iv); wire(t); }
      else if (++tries > 100) clearInterval(iv);
    }, 100);
  }

  // eslint-disable-next-line no-console
  console.log('[scroll-diag] armed — switch into the jumpy chat, let it settle, then run __scrollDiagDump()');
}
