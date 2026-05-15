// Inspect the ambient widget layout against live sidekick.
import { chromium } from 'playwright-core';

const CHROME = '/home/jscholz/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
const URL = 'http://127.0.0.1:3001';

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
});
const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('PAGE ERR:', m.text());
});
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForSelector('#transcript', { timeout: 8000 });

// Force-open the pin drawer (set body class + drawer state without
// going through the rail-click flow).
await page.evaluate(() => {
  document.body.classList.add('pin-drawer-open');
  const d = document.getElementById('pin-drawer');
  d?.classList.remove('collapsed');
});
await page.waitForTimeout(800);

// Make sure the ambient widget is mounted + expanded class is applied.
await page.evaluate(() => {
  const w = document.querySelector('.ambient-widget.ambient-in-drawer');
  if (w && !w.classList.contains('expanded')) w.classList.add('expanded');
});
// Wait for the 60s tick OR force a re-render via the body class
// MutationObserver. Easiest: pause briefly so the observer fires.
await page.waitForTimeout(400);

const info = await page.evaluate(() => {
  const w = document.querySelector('.ambient-widget.ambient-in-drawer');
  const f = document.querySelector('.ambient-widget.ambient-in-drawer .amb-forecast');
  const cols = Array.from(document.querySelectorAll('.ambient-widget.ambient-in-drawer .amb-forecast-col'));
  const csOf = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      display: cs.display,
      gridTemplateColumns: cs.gridTemplateColumns,
      gridTemplateRows: cs.gridTemplateRows,
      gridColumn: cs.gridColumn,
      gridRow: cs.gridRow,
      flexDirection: cs.flexDirection,
      justifyContent: cs.justifyContent,
      width: r.width,
      height: r.height,
      x: r.x,
      y: r.y,
    };
  };
  return {
    widget: csOf(w),
    widgetInner: w?.innerHTML?.slice(0, 200),
    widgetClasses: w?.className,
    forecast: csOf(f),
    cols: cols.map(c => ({ ...csOf(c), text: c.textContent.replace(/\s+/g, ' ').slice(0, 50) })),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
