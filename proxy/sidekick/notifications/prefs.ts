// User preferences for push behaviour — quiet hours today, more
// knobs as wave 2 lands the digest + per-kind toggles.
//
// Mirrors storage.ts / mutes.ts shape: JSON-file backed, atomic
// tempfile+rename writes, in-process cache primed at init. Stored
// at <dataDir>/push-prefs.json.
//
// Scope (v1): single global config — applies to every subscription.
// v2 (when needed) would split into per-(subscription, ...) keying
// for true device-scoped prefs.
//
// Time semantics: server-local time, 24h "HH:MM" strings. Jonathan
// + Tom + Luke are all UK so server-local matches device-local. If
// multi-TZ becomes a concern later, add a `tz` field to the prefs
// shape and have the gate localize before comparing.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface QuietHours {
  enabled: boolean;
  /** "HH:MM" — the START of the quiet window. Inclusive. */
  start: string;
  /** "HH:MM" — the END of the quiet window. EXCLUSIVE. */
  end: string;
}

export interface Prefs {
  quiet_hours: QuietHours;
}

const DEFAULT_PREFS: Prefs = {
  quiet_hours: {
    enabled: false,
    start: '22:00',
    end: '07:00',
  },
};

let storePath: string = '';
let cache: Prefs | null = null;

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export async function initPrefs(opts: { dataDir: string }): Promise<void> {
  storePath = path.join(opts.dataDir, 'push-prefs.json');
  try {
    const buf = await fs.readFile(storePath, 'utf8');
    const parsed = JSON.parse(buf);
    cache = mergeWithDefaults(parsed);
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      cache = structuredClone(DEFAULT_PREFS);
    } else {
      console.warn('[notifications] prefs read failed:', e.message);
      cache = structuredClone(DEFAULT_PREFS);
    }
  }
}

/** Deep-merge persisted prefs onto defaults so a missing field never
 *  crashes the gate. Schema-evolution safety: when we add new prefs,
 *  old prefs files load with the new defaults filling the gaps. */
function mergeWithDefaults(parsed: any): Prefs {
  const out: Prefs = structuredClone(DEFAULT_PREFS);
  if (parsed && typeof parsed === 'object' && parsed.quiet_hours) {
    const qh = parsed.quiet_hours;
    if (typeof qh.enabled === 'boolean') out.quiet_hours.enabled = qh.enabled;
    if (typeof qh.start === 'string' && HHMM_RE.test(qh.start)) out.quiet_hours.start = qh.start;
    if (typeof qh.end === 'string' && HHMM_RE.test(qh.end)) out.quiet_hours.end = qh.end;
  }
  return out;
}

async function persist(): Promise<void> {
  if (!storePath) throw new Error('[notifications] prefs store not initialized');
  const tmp = `${storePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(cache ?? DEFAULT_PREFS, null, 2), 'utf8');
  await fs.rename(tmp, storePath);
}

export function getPrefs(): Prefs {
  return cache ? structuredClone(cache) : structuredClone(DEFAULT_PREFS);
}

/** Update prefs. Partial — any field present in `update` overrides,
 *  others stay. Validates HH:MM format on quiet_hours times. */
export async function updatePrefs(update: Partial<Prefs>): Promise<Prefs> {
  if (!cache) throw new Error('[notifications] prefs store not initialized');
  if (update.quiet_hours) {
    const qh = update.quiet_hours;
    if (typeof qh.enabled === 'boolean') cache.quiet_hours.enabled = qh.enabled;
    if (typeof qh.start === 'string') {
      if (!HHMM_RE.test(qh.start)) throw new Error(`invalid quiet_hours.start: ${qh.start} (expect HH:MM)`);
      cache.quiet_hours.start = qh.start;
    }
    if (typeof qh.end === 'string') {
      if (!HHMM_RE.test(qh.end)) throw new Error(`invalid quiet_hours.end: ${qh.end} (expect HH:MM)`);
      cache.quiet_hours.end = qh.end;
    }
  }
  await persist();
  return getPrefs();
}

/** True if the current server-local clock falls inside the user's
 *  configured quiet window AND quiet hours are enabled. Used by the
 *  dispatch gate to suppress non-urgent push during quiet hours.
 *
 *  Window semantics:
 *    start <  end → simple interval, e.g. 13:00-15:00. In quiet if
 *                  start <= now < end.
 *    start >  end → wraps midnight, e.g. 22:00-07:00. In quiet if
 *                  now >= start OR now < end.
 *    start == end → never in quiet (ambiguous; safer = never). */
export function inQuietHours(now: Date = new Date()): boolean {
  const prefs = getPrefs();
  if (!prefs.quiet_hours.enabled) return false;
  const startMin = hhmmToMinutes(prefs.quiet_hours.start);
  const endMin = hhmmToMinutes(prefs.quiet_hours.end);
  if (startMin === endMin) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (startMin < endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  // Wraps midnight.
  return nowMin >= startMin || nowMin < endMin;
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
  return h * 60 + m;
}

/** Test-only seam — clears cache + path so the next test starts fresh. */
export function __resetPrefsForTest(): void {
  cache = null;
  storePath = '';
}
