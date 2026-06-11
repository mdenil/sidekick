// #199 turn-based warmup instrumentation: turnbased.start() logs a
// [listen-timing] phase line at each stage of the tap→chime window —
//
//   ctx             AudioContext resume
//   mic             getMicStream (incl. iOS session prime — the floor)
//   recorder-armed  MediaRecorder constructed + started
//   chime           playFeedback('listening') queued
//
// Jonathan reads these off the device debug relay to see where the
// tap→chime latency actually goes. This smoke pins the contract: all
// four lines fire, in order, with parseable +Xms/(total Yms) values,
// so the instrumentation can't silently rot before a device session.

import { assert } from './lib.mjs';

export const NAME = 'listen-timing-log';
export const DESCRIPTION = 'turn-based start() emits [listen-timing] ctx → mic → recorder-armed → chime with parseable monotonic totals';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const PHASES = ['ctx', 'mic', 'recorder-armed', 'chime'];

export default async function run({ page, log, url }) {
  const timingLines = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[listen-timing]')) timingLines.push(t);
  });

  // Arm Listen on boot — same entry the mic-tap path uses.
  await page.goto(`${url}/?listen=1&silence_sec=2`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });

  const t0 = Date.now();
  while (timingLines.length < PHASES.length && Date.now() - t0 < 10_000) {
    await page.waitForTimeout(100);
  }
  log(`captured: ${JSON.stringify(timingLines)}`);

  const parsed = [];
  for (const line of timingLines) {
    const m = line.match(/\[listen-timing\] (\S+) \+(\d+)ms \(total (\d+)ms\)/);
    if (m) parsed.push({ label: m[1], delta: Number(m[2]), total: Number(m[3]) });
  }

  assert(
    parsed.length >= PHASES.length,
    `expected ${PHASES.length} parseable [listen-timing] lines, got ${parsed.length}: ${JSON.stringify(timingLines)}`,
  );
  const labels = parsed.slice(0, PHASES.length).map((p) => p.label);
  assert(
    JSON.stringify(labels) === JSON.stringify(PHASES),
    `phase order wrong — expected ${PHASES.join(' → ')}, got ${labels.join(' → ')}`,
  );
  let prevTotal = -1;
  for (const p of parsed.slice(0, PHASES.length)) {
    assert(p.total >= prevTotal, `totals not monotonic at ${p.label}: ${p.total} < ${prevTotal}`);
    assert(p.total >= p.delta, `total ${p.total} < delta ${p.delta} at ${p.label}`);
    prevTotal = p.total;
  }
  log(`listen-timing OK: ${parsed.slice(0, PHASES.length).map((p) => `${p.label}=+${p.delta}ms`).join(' ')} (total ${prevTotal}ms)`);
}
