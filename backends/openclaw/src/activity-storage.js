export function listActivityItems(db, { limit = 200 } = {}) {
  return db.prepare(`
    SELECT id, chat_id AS chatId, kind, title, body, created_at AS createdAt,
           urgent, read, message_id AS messageId, resolved
    FROM activity_items
    ORDER BY CASE WHEN kind = 'approval' AND resolved IS NULL THEN 1 ELSE 0 END DESC,
             created_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(Number(limit) || 200, 500))).map(row => ({
    ...row,
    urgent: row.urgent === 1,
    read: row.read === 1,
  }));
}

export function upsertActivityItem(db, item) {
  const now = Date.now() / 1000;
  const created = Number(item.createdAt ?? item.created_at ?? now);
  db.prepare(`
    INSERT INTO activity_items (id, chat_id, kind, title, body, created_at, urgent, read, message_id, resolved)
    VALUES (@id, @chat_id, @kind, @title, @body, @created_at, @urgent, @read, @message_id, @resolved)
    ON CONFLICT(id) DO UPDATE SET
      chat_id = excluded.chat_id,
      kind = excluded.kind,
      title = excluded.title,
      body = excluded.body,
      urgent = excluded.urgent,
      read = excluded.read,
      message_id = excluded.message_id,
      resolved = excluded.resolved
  `).run({
    id: item.id,
    chat_id: item.chat_id ?? item.chatId ?? null,
    kind: item.kind,
    title: item.title,
    body: item.body,
    created_at: created > 10_000_000_000 ? created / 1000 : created,
    urgent: item.urgent === true ? 1 : 0,
    read: item.read === true ? 1 : 0,
    message_id: item.message_id ?? item.messageId ?? null,
    resolved: item.resolved ?? null,
  });
}

export function resolveActivityItem(db, { id, resolution }) {
  const r = db.prepare('UPDATE activity_items SET read = 1, resolved = ? WHERE id = ?').run(resolution, id);
  return { updated: r.changes > 0 };
}

export function markActivitySeen(db, { chatId = null, all = false } = {}) {
  if (all === true) {
    const r = db.prepare('UPDATE activity_items SET read = 1 WHERE read = 0').run();
    return { updated: r.changes };
  }
  if (!chatId) return { updated: 0 };
  const r = db.prepare('UPDATE activity_items SET read = 1 WHERE chat_id = ? AND read = 0').run(chatId);
  return { updated: r.changes };
}

export function deleteActivityItem(db, { id }) {
  const r = db.prepare('DELETE FROM activity_items WHERE id = ?').run(id);
  return { removed: r.changes > 0 };
}

export function clearDismissibleActivityItems(db) {
  const r = db.prepare("DELETE FROM activity_items WHERE NOT (kind = 'approval' AND resolved IS NULL)").run();
  return { removed: r.changes };
}
