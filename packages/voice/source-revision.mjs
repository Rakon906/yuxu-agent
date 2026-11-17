/** Freshness belongs to one conversation, even when capture serves many groups. */
export function voiceSourceRevision(db, accountId, groupId) {
  if (!db) return 0;
  return db.prepare(`SELECT COALESCE(MAX(rowid),0) n FROM inbox
    WHERE json_extract(message,'$.accountId')=? AND json_extract(message,'$.groupId')=?`)
    .get(accountId, groupId).n;
}
