/**
 * @fileoverview Crack A — DOM reconciler. Walks a BubbleSpec[] and
 * brings the transcript element's children into agreement.
 *
 * Reconciliation contract:
 *   - Each transcript child carries `data-key` (the BubbleSpec.key).
 *   - For each spec in order:
 *       - If a child with that key exists, update it in place AND
 *         move it to the right ordinal position.
 *       - Else, create a fresh node, stamp `data-key`, insert at the
 *         right position.
 *   - After the walk, remove any children whose key wasn't visited.
 *
 * Bubble creation delegates to `chat.addLine` for user/assistant
 * bubbles (so we inherit speaker labels, copy/pin/play/fold buttons,
 * attachments). Activity rows are rendered locally — the legacy
 * activityRow.ts is being deleted.
 *
 * Updates are done in place via DOM manipulation: `.text` span content,
 * `.streaming` / `.pending` classes, `data-text` mirror for replyPlayer.
 * The reconciler never recreates a bubble whose key is already in DOM,
 * so text selection / scroll position / copy-button confirmation states
 * survive.
 */

import * as chat from '../chat.ts';
import { miniMarkdown } from '../util/markdown.ts';
import { escapeHtml } from '../util/dom.ts';
import * as settings from '../settings.ts';
import { getAgentLabel } from '../config.ts';
import type { ActivityRowSpec, ActivityTool, AssistantBubbleSpec, BubbleSpec, NotificationBubbleSpec, UserBubbleSpec } from './types.ts';

const KEY_ATTR = 'data-key';

export function reconcile(transcriptEl: HTMLElement, specs: BubbleSpec[]): void {
  // Snapshot existing keyed children up-front so the move/insert pass
  // can find them in O(1). Children WITHOUT `data-key` are stale —
  // they come from a pre-Crack-A `chat.restoreSnapshot()` DOM-string
  // restore (old wire shape, no data-key attribute) or from any
  // legacy code path that bypassed the reconciler. The reconciler
  // is now the sole owner of transcript content; wipe them so they
  // don't ghost alongside the projection output.
  const existing = new Map<string, HTMLElement>();
  const stale: HTMLElement[] = [];
  for (const child of Array.from(transcriptEl.children) as HTMLElement[]) {
    const key = child.getAttribute(KEY_ATTR);
    if (key) existing.set(key, child);
    else stale.push(child);
  }
  for (const el of stale) el.remove();

  const visited = new Set<string>();
  // Iterate specs in order, building the DOM into the right shape.
  // `cursor` tracks "the element that should be next in DOM" so we
  // can insertBefore the spec's element at the right position.
  let cursor: HTMLElement | null = null;

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    visited.add(spec.key);

    let el = existing.get(spec.key);
    if (!el) {
      el = createForSpec(spec);
      if (!el) continue;
      el.setAttribute(KEY_ATTR, spec.key);
    } else {
      updateForSpec(el, spec);
    }

    // Ensure DOM position: if the child at index i isn't `el`, move it.
    const want = el;
    const have = transcriptEl.children[i] as HTMLElement | undefined;
    if (have !== want) {
      transcriptEl.insertBefore(want, have || null);
    }
    cursor = want;
  }

  // Remove anything that didn't appear in specs.
  for (const [key, el] of existing) {
    if (!visited.has(key)) el.remove();
  }

  // Touch cursor to avoid unused-var lint; the loop above already
  // positions everything correctly.
  void cursor;
}

// ── create ─────────────────────────────────────────────────────────────

function createForSpec(spec: BubbleSpec): HTMLElement | null {
  switch (spec.kind) {
    case 'user':       return createUser(spec);
    case 'assistant':  return createAssistant(spec);
    case 'notification': return createNotification(spec);
    case 'activityRow': return createActivityRow(spec);
  }
}

function createUser(spec: UserBubbleSpec): HTMLElement | null {
  const cls = ['line', 's0'];
  if (spec.pending) cls.push('pending');
  if (spec.failed) cls.push('failed');
  const el = chat.addLine('You', spec.text, cls.slice(1).join(' '), {
    markdown: false,
    timestamp: spec.timestamp,
    attachments: spec.attachments,
    messageId: spec.key,
    source: spec.source,
    pending: spec.pending,
  });
  return el || null;
}

function createAssistant(spec: AssistantBubbleSpec): HTMLElement | null {
  const cls = ['agent'];
  if (spec.streaming) cls.push('streaming');
  const el = chat.addLine(getAgentSpeaker(), spec.text, cls.join(' '), {
    markdown: true,
    timestamp: spec.timestamp,
    messageId: spec.key,
    replyId: spec.key,
  });
  if (!el) return null;
  if (spec.streaming) ensureThinkingDots(el);
  return el;
}

function notificationEmoji(kind: string): string {
  if (kind === 'cron') return '⏰';
  if (kind === 'approval') return '⚠️';
  return '🔔';
}

function applyNotificationKindClass(el: HTMLElement, kind: string): void {
  for (const cls of Array.from(el.classList)) {
    if (cls.startsWith('notification-')) el.classList.remove(cls);
  }
  if (kind) el.classList.add(`notification-${kind}`);
}

function createNotification(spec: NotificationBubbleSpec): HTMLElement | null {
  const emoji = notificationEmoji(spec.notificationKind);
  // Match the legacy handleNotification rendering verbatim: speaker
  // is the raw `kind` string (lowercase as the agent emits it) when
  // present, else "Notification". Smokes pattern-match on lowercase
  // 'cron' / 'reminder' substrings.
  const label = spec.notificationKind && spec.notificationKind !== 'notification'
    ? spec.notificationKind
    : 'Notification';
  const el = chat.addLine(`${emoji} ${label}`, spec.text, 'system notification', {
    markdown: true,
    timestamp: spec.timestamp,
    messageId: spec.key,
  }) || null;
  if (el) applyNotificationKindClass(el, spec.notificationKind || 'notification');
  return el;
}

function createActivityRow(spec: ActivityRowSpec): HTMLElement {
  const row = document.createElement('div');
  row.className = 'activity-row';
  row.dataset.state = spec.complete ? 'complete' : 'in-progress';
  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'activity-row-summary';
  summary.setAttribute('aria-expanded', 'false');
  const full = document.createElement('div');
  full.className = 'activity-row-full';
  full.style.display = 'none';
  row.appendChild(summary);
  row.appendChild(full);

  // Click summary to toggle expansion. Track expansion as a data attr
  // so a re-render re-reads it instead of resetting on every reconcile.
  summary.addEventListener('click', () => {
    const expanded = row.dataset.expanded === 'true';
    row.dataset.expanded = expanded ? 'false' : 'true';
    applyActivityRowView(row, spec);
  });

  renderActivityRowBody(row, spec);
  return row;
}

// ── update ─────────────────────────────────────────────────────────────

function updateForSpec(el: HTMLElement, spec: BubbleSpec): void {
  switch (spec.kind) {
    case 'user':       return updateUser(el, spec);
    case 'assistant':  return updateAssistant(el, spec);
    case 'notification': return updateNotification(el, spec);
    case 'activityRow': return updateActivityRow(el, spec);
  }
}

function updateUser(el: HTMLElement, spec: UserBubbleSpec): void {
  // Pending → finalized class flip.
  if (spec.pending) el.classList.add('pending');
  else el.classList.remove('pending');
  if (spec.failed) {
    el.classList.add('failed');
    ensureRetryRow(el, spec);
  } else {
    el.classList.remove('failed');
    el.querySelector('.send-failed-row')?.remove();
  }
  // Text: only update if changed. User bubbles are usually immutable
  // but the optimistic→echo round-trip can rewrite the text.
  const span = el.querySelector('.text') as HTMLElement | null;
  if (span) {
    const want = escapeHtml(spec.text || '').replace(/\n/g, '<br>');
    if (span.innerHTML !== want) span.innerHTML = want;
  }
  updateTimestamp(el, spec.timestamp);
}

function ensureRetryRow(el: HTMLElement, spec: UserBubbleSpec): void {
  if (el.querySelector('.send-failed-row')) return;
  const row = document.createElement('div');
  row.className = 'send-failed-row';
  const label = document.createElement('span');
  label.textContent = 'Send failed.';
  row.appendChild(label);
  const retry = document.createElement('button');
  retry.textContent = 'Retry';
  retry.onclick = (e) => {
    e.preventDefault();
    el.dispatchEvent(new CustomEvent('sidekick:retry-send', {
      bubbles: true,
      detail: { messageId: spec.key, text: spec.text },
    }));
  };
  row.appendChild(retry);
  el.appendChild(row);
}

function updateAssistant(el: HTMLElement, spec: AssistantBubbleSpec): void {
  // Text — re-render markdown only when content changes.
  const span = el.querySelector('.text') as HTMLElement | null;
  if (span) {
    const rendered = miniMarkdown(spec.text || '');
    if (span.innerHTML !== rendered) {
      span.innerHTML = rendered;
      // Re-stamp anchor target/rel — miniMarkdown emits raw <a>.
      span.querySelectorAll('a').forEach(a => {
        a.target = '_blank';
        (a as HTMLAnchorElement).rel = 'noopener';
      });
    }
  }
  el.dataset.text = spec.text || '';

  // Streaming class.
  if (spec.streaming) {
    el.classList.add('streaming');
    ensureThinkingDots(el);
  } else {
    el.classList.remove('streaming');
    el.querySelector('.thinking-dots')?.remove();
  }
  updateTimestamp(el, spec.timestamp);
}

function updateNotification(el: HTMLElement, spec: NotificationBubbleSpec): void {
  applyNotificationKindClass(el, spec.notificationKind || 'notification');
  const speaker = el.querySelector('.speaker') as HTMLElement | null;
  const label = spec.notificationKind && spec.notificationKind !== 'notification'
    ? spec.notificationKind
    : 'Notification';
  if (speaker) speaker.textContent = `${notificationEmoji(spec.notificationKind)} ${label}`;
  const span = el.querySelector('.text') as HTMLElement | null;
  if (span) {
    const want = escapeHtml(spec.text || '').replace(/\n/g, '<br>');
    if (span.innerHTML !== want) span.innerHTML = want;
  }
  updateTimestamp(el, spec.timestamp);
}

function updateActivityRow(el: HTMLElement, spec: ActivityRowSpec): void {
  el.dataset.state = spec.complete ? 'complete' : 'in-progress';
  renderActivityRowBody(el, spec);
}

function updateTimestamp(el: HTMLElement, timestamp: number): void {
  const tsEl = el.querySelector('.line-ts') as HTMLElement | null;
  if (!tsEl) return;
  const d = new Date(timestamp);
  const text = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  if (tsEl.textContent !== text) tsEl.textContent = text;
  const title = d.toLocaleString();
  if (tsEl.title !== title) tsEl.title = title;
}

// ── activity row helpers ───────────────────────────────────────────────

const ICON_SPINNER = `<svg class="ar-icon ar-icon-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.55"/></svg>`;
const ICON_CHECK = `<svg class="ar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 12 10 18 20 6"/></svg>`;
const ICON_TOOL = `<svg class="ar-icon ar-icon-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>`;

function renderActivityRowBody(row: HTMLElement, spec: ActivityRowSpec): void {
  const summary = row.querySelector('.activity-row-summary') as HTMLElement | null;
  const full = row.querySelector('.activity-row-full') as HTMLElement | null;
  if (!summary || !full) return;

  const n = spec.tools.length;
  const totalMs = spec.tools.reduce((acc, t) => acc + (t.durationMs || 0), 0);
  const inProgress = !spec.complete && spec.tools.some(t => t.result === undefined);
  const icon = inProgress ? ICON_SPINNER : ICON_CHECK;
  const tail = inProgress ? 'running…' : fmtDurationMs(totalMs) || 'done';
  summary.innerHTML = `${icon}<span class="ar-summary-label">${escapeHtml(`${n} tool${n === 1 ? '' : 's'}`)} · ${escapeHtml(tail)}</span>`;

  // Reconcile tool entries by callId.
  const existing = new Map<string, HTMLElement>();
  for (const c of Array.from(full.children) as HTMLElement[]) {
    const id = c.dataset.callId;
    if (id) existing.set(id, c);
  }
  const visited = new Set<string>();
  for (let i = 0; i < spec.tools.length; i++) {
    const t = spec.tools[i];
    visited.add(t.callId);
    let entry = existing.get(t.callId);
    if (!entry) {
      entry = renderToolEntry(t);
      full.appendChild(entry);
    } else {
      updateToolEntry(entry, t);
    }
    if (full.children[i] !== entry) full.insertBefore(entry, full.children[i] || null);
  }
  for (const [id, el] of existing) if (!visited.has(id)) el.remove();

  applyActivityRowView(row, spec);
}

function applyActivityRowView(row: HTMLElement, _spec: ActivityRowSpec): void {
  const full = row.querySelector('.activity-row-full') as HTMLElement | null;
  const summary = row.querySelector('.activity-row-summary') as HTMLElement | null;
  if (!full || !summary) return;
  const mode = settings.get().agentActivity;
  if (mode === 'off') { row.style.display = 'none'; return; }
  row.style.display = '';
  const userLocked = row.dataset.expanded;
  const showFull = userLocked === 'true' ? true
    : userLocked === 'false' ? false
    : mode === 'full';
  full.style.display = showFull ? '' : 'none';
  summary.setAttribute('aria-expanded', showFull ? 'true' : 'false');
  row.classList.toggle('is-expanded', showFull);
}

function renderToolEntry(t: ActivityTool): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'tool-row';
  wrap.dataset.callId = t.callId;
  const details = document.createElement('details');
  details.className = 'tool-row-details';
  const summary = document.createElement('summary');
  summary.className = 'tool-row-summary';
  summary.innerHTML = `${ICON_TOOL}${toolTitleHtml(t)}<span class="tool-row-meta"></span>`;
  details.appendChild(summary);
  const argsBlock = document.createElement('div');
  argsBlock.className = 'tool-args-block';
  argsBlock.innerHTML = `<pre>${escapeHtml(formatArgs(t.args))}</pre>`;
  details.appendChild(argsBlock);
  const resultEl = document.createElement('div');
  resultEl.className = 'tool-result-block';
  resultEl.style.display = 'none';
  details.appendChild(resultEl);
  wrap.appendChild(details);
  if (t.result !== undefined) writeToolResult(wrap, t);
  return wrap;
}

function updateToolEntry(wrap: HTMLElement, t: ActivityTool): void {
  // Tool name (rarely changes, but tool_result can rename '(unknown)'
  // to a real name when call envelope was missed).
  const titleEl = wrap.querySelector('.tool-title') as HTMLElement | null;
  const nextTitle = toolTitleHtml(t);
  if (titleEl && titleEl.outerHTML !== nextTitle) titleEl.outerHTML = nextTitle;
  // Result block appears once t.result is populated.
  if (t.result !== undefined) writeToolResult(wrap, t);
}

function writeToolResult(wrap: HTMLElement, t: ActivityTool): void {
  const resultEl = wrap.querySelector('.tool-result-block') as HTMLElement | null;
  if (!resultEl) return;
  const meta = wrap.querySelector('.tool-row-meta') as HTMLElement | null;
  if (meta) {
    const dur = fmtDurationMs(t.durationMs || 0);
    meta.textContent = dur ? ` · ${dur}` : '';
  }
  if (t.result === null) {
    resultEl.style.display = '';
    resultEl.innerHTML = `<div class="tool-result-empty">no result</div>`;
    return;
  }
  const raw = typeof t.result === 'string' ? t.result : JSON.stringify(t.result);
  const pretty = prettifyMaybeJson(raw);
  const SHOW_LIMIT = 500;
  const isLong = pretty.length > SHOW_LIMIT;
  const shortText = isLong ? pretty.slice(0, SHOW_LIMIT) + '…' : pretty;
  resultEl.style.display = '';
  resultEl.innerHTML = `
    <div class="tool-result-arrow" aria-hidden="true">→</div>
    <pre class="tool-result-text" data-mode="short">${escapeHtml(shortText)}</pre>
  `.trim();
}

function formatArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return args;
  try { return JSON.stringify(args, null, 2); } catch { return String(args); }
}

function toolTitleHtml(t: ActivityTool): string {
  const detail = toolSummaryDetail(t);
  const detailHtml = detail
    ? `<span class="tool-detail" title="${escapeHtml(detail)}">: ${escapeHtml(detail)}</span>`
    : '';
  return `<span class="tool-title"><span class="tool-name">${escapeHtml(t.name)}</span>${detailHtml}</span>`;
}

function toolSummaryDetail(t: ActivityTool): string {
  const args = normalizeToolArgs(t.args);
  if (!args) return '';

  if (t.name === 'skill_view' || t.name === 'skill_edit' || t.name === 'skill_create') {
    return firstString(args, ['name', 'skill', 'skill_name', 'path']);
  }

  return firstString(args, [
    'name',
    'path',
    'file',
    'command',
    'query',
    'q',
    'url',
    'title',
  ]);
}

function normalizeToolArgs(args: unknown): Record<string, unknown> | null {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args !== 'string') return null;
  const trimmed = args.trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function firstString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      return compactToolDetail(value.trim());
    }
  }
  return '';
}

function compactToolDetail(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ');
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine;
}

function prettifyMaybeJson(raw: string): string {
  if (!raw || (raw[0] !== '{' && raw[0] !== '[')) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && typeof (parsed as any).result === 'string') {
      const inner = (parsed as any).result.trim();
      if (inner && (inner[0] === '{' || inner[0] === '[')) {
        try { (parsed as any).result = JSON.parse(inner); } catch { /* leave */ }
      }
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

function fmtDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ensureThinkingDots(el: HTMLElement): void {
  if (el.querySelector('.thinking-dots')) return;
  const dots = document.createElement('span');
  dots.className = 'thinking-dots';
  dots.innerHTML = `<span></span><span></span><span></span>`;
  const text = el.querySelector('.text');
  if (text) text.appendChild(dots);
  else el.appendChild(dots);
}

function getAgentSpeaker(): string {
  try {
    return getAgentLabel() || 'Agent';
  } catch {
    return 'Agent';
  }
}
