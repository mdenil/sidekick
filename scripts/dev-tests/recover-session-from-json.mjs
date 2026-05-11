#!/usr/bin/env node
// Recover a hermes session's lost messages from its JSON snapshot into
// state.db. Use when an in-flight turn was killed by a hermes restart
// (or any SIGTERM-during-drain) — upstream bug #19434 means the JSON
// snapshot still has the conversation but state.db doesn't, so the PWA
// drawer renders the session as empty / "shutdown recovery only".
//
// Trigger conditions:
//   - You see `Gateway drain timed out after 60.0s with 1 active
//     agent(s)` in `journalctl --user -u hermes-gateway.service`.
//   - The next `inbound message` line on the same chat_id has
//     `msg=''` (the auto-resume) and the user reports their prior
//     conversation is gone from the PWA.
//
// Find the affected session_id from the journal — it's the one in the
// gateway log lines around the SIGTERM.
//
// Usage:
//   node scripts/dev-tests/recover-session-from-json.mjs <session_id>
//   node scripts/dev-tests/recover-session-from-json.mjs --dry-run <session_id>
//   node scripts/dev-tests/recover-session-from-json.mjs --force <session_id>
//
// Default behavior: refuses to run if state.db already has more than 5
// messages for the session (sanity guard against running on a healthy
// session and creating duplicates). `--force` overrides the guard
// (useful when the recovery messages themselves are noisier than
// expected).
//
// After running: restart hermes-agent so its in-memory session cache
// reloads the recovered rows:
//   systemctl --user restart hermes-gateway.service
// (Or, if it's mid-conversation again — wait first, see
//  feedback_hermes_restart_check_active.md.)
//
// Optional next step: clear the session's title so hermes regenerates
// it on the next compression / titling pass. The script does this by
// default; pass `--keep-title` to skip.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';

const DB_PATH = process.env.HERMES_STATE_DB || join(homedir(), '.hermes/state.db');
const SESSIONS_DIR = process.env.HERMES_SESSIONS_DIR || join(homedir(), '.hermes/sessions');
const SAFETY_MAX_EXISTING = 5; // refuse if more than this many messages already

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const KEEP_TITLE = args.includes('--keep-title');
const sessionId = args.find((a) => !a.startsWith('--'));

if (!sessionId) {
  console.error('usage: recover-session-from-json.mjs [--dry-run] [--force] [--keep-title] <session_id>');
  console.error('  session_id looks like 20260511_154144_ebfe6bb3 — find via:');
  console.error('  journalctl --user -u hermes-gateway.service | grep "active chat" | tail -3');
  process.exit(2);
}

const jsonPath = join(SESSIONS_DIR, `session_${sessionId}.json`);
if (!existsSync(jsonPath)) {
  console.error(`ERROR: no JSON snapshot at ${jsonPath}`);
  console.error('Either the session ID is wrong, or hermes never wrote the snapshot');
  console.error('(possible if the kill happened before the FIRST persist tick — rare).');
  process.exit(1);
}

// Pull session.started_at to back-date the recovered messages so they
// sort BEFORE the post-restart recovery messages in the transcript.
const sql = (q) => execFileSync('sqlite3', [DB_PATH, q], { encoding: 'utf8' }).trim();
const startedAtRaw = sql(`SELECT started_at FROM sessions WHERE id='${sessionId}'`);
if (!startedAtRaw) {
  console.error(`ERROR: no sessions row for id=${sessionId} — session was never persisted at all`);
  console.error('Recovery path needs the session row to exist (so message FK holds).');
  console.error('Insert a sessions row manually first if you really want to recover, then re-run.');
  process.exit(1);
}
const startedAt = parseFloat(startedAtRaw);
const existingCount = parseInt(sql(`SELECT count(*) FROM messages WHERE session_id='${sessionId}'`), 10);
console.log(`session ${sessionId}: started_at=${new Date(startedAt * 1000).toISOString()}, currently ${existingCount} messages in state.db`);
if (existingCount > SAFETY_MAX_EXISTING && !FORCE) {
  console.error(`REFUSING: session has ${existingCount} messages already (> ${SAFETY_MAX_EXISTING}). Use --force if certain.`);
  process.exit(1);
}

const snapshot = JSON.parse(readFileSync(jsonPath, 'utf8'));
const messages = Array.isArray(snapshot) ? snapshot
  : (Array.isArray(snapshot?.messages) ? snapshot.messages : null);
if (!messages) {
  console.error('ERROR: JSON shape unexpected — expected array OR {messages: [...]}');
  process.exit(1);
}
console.log(`JSON has ${messages.length} messages`);

if (DRY_RUN) {
  for (const [i, m] of messages.entries()) {
    const preview = (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).slice(0, 80);
    console.log(`  [${i}] ${m.role.padEnd(10)} ${preview}`);
  }
  console.log('(--dry-run: not modifying state.db)');
  process.exit(0);
}

// Build the INSERT plan. Timestamps: start at session.started_at + 0.001,
// space 3 seconds apart. 27 msgs × 3s = 81s, comfortably within the
// ~90-second pre-SIGTERM conversation window.
//
// Triggers (messages_fts_insert, messages_fts_trigram_insert) fire
// automatically on each INSERT if they exist (post-trigger-repair).
// Verify post-insert that FTS picked them up.
const STEP_SEC = 3.0;
const insertSQL = `
BEGIN IMMEDIATE;
${messages.map((m, i) => {
  const role = m.role;
  const ts = startedAt + 0.001 + i * STEP_SEC;
  const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
  const toolName = role === 'tool' ? (m.name || null) : null;
  const toolCallId = role === 'tool' ? (m.tool_call_id || null) : null;
  const toolCalls = m.tool_calls ? JSON.stringify(m.tool_calls) : null;
  const reasoning = m.reasoning || null;
  const reasoningContent = m.reasoning_content || null;
  const finishReason = m.finish_reason || null;
  // SQL-escape: replace each "'" with "''".
  const q = (s) => s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`;
  return `INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, finish_reason, reasoning, reasoning_content) VALUES (${q(sessionId)}, ${q(role)}, ${q(content)}, ${q(toolCallId)}, ${q(toolCalls)}, ${q(toolName)}, ${ts}, ${q(finishReason)}, ${q(reasoning)}, ${q(reasoningContent)});`;
}).join('\n')}
UPDATE sessions SET message_count = message_count + ${messages.length}${KEEP_TITLE ? '' : ', title = NULL'} WHERE id = ${(() => { const q = (s) => `'${String(s).replace(/'/g, "''")}'`; return q(sessionId); })()};
COMMIT;
`;

// Write to temp file rather than piping (avoids quoting issues with long content).
const fs = await import('node:fs/promises');
const tmpFile = `/tmp/recover-session-${sessionId}-${Date.now()}.sql`;
await fs.writeFile(tmpFile, insertSQL);
try {
  execSync(`sqlite3 "${DB_PATH}" < "${tmpFile}"`, { stdio: 'inherit' });
  console.log(`INSERTED ${messages.length} messages`);
} finally {
  await fs.unlink(tmpFile).catch(() => {});
}

// Verify FTS triggers fired (they should auto-populate messages_fts).
const ftsCount = sql(`SELECT count(*) FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid WHERE m.session_id='${sessionId}'`);
const newCount = sql(`SELECT count(*) FROM messages WHERE session_id='${sessionId}'`);
console.log(`messages_fts has ${ftsCount} rows for this session (state.db has ${newCount})`);
if (parseInt(ftsCount, 10) < parseInt(newCount, 10)) {
  console.warn('WARNING: FTS lags state.db — triggers may be missing. Run /tmp/repair_fts_triggers.sql or see backlog.md "Session search FTS5".');
}

console.log('');
console.log('NEXT: restart hermes-gateway so its in-memory session cache reloads:');
console.log('  systemctl --user restart hermes-gateway.service');
console.log('(but check journalctl first for active chats — see');
console.log(' feedback_hermes_restart_check_active.md in memory)');
