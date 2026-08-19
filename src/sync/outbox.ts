import type { SqlDatabase } from '@/db/types';
import { isExhausted, retryDelayMs } from './merge';
import type { OutboxEntry, OutboxOperation, SyncableTable } from './types';

/**
 * The outbox: durable record of local writes that have not reached the server.
 *
 * Enqueueing must happen in the *same transaction* as the local row write.
 * Splitting them opens a window where the app can die between the two and
 * silently lose the change — see `withOutbox` below.
 */

export function enqueue(
  db: SqlDatabase,
  entry: {
    table: SyncableTable;
    rowId: string;
    operation: OutboxOperation;
    payload: Record<string, unknown>;
  },
): void {
  db.run(
    `INSERT INTO sync_outbox
       (table_name, row_id, operation, payload, created_at, attempts, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, 0, 0)`,
    [
      entry.table,
      entry.rowId,
      entry.operation,
      JSON.stringify(entry.payload),
      Date.now(),
    ],
  );
}

/**
 * Runs a local write and its outbox entry atomically.
 *
 * Every mutation in the app goes through this. If `write` throws, nothing is
 * queued; if the process dies after commit, the entry is already durable.
 *
 * The queued payload is the **full local row, read back after the write** —
 * not the caller's patch. Two reasons:
 *
 *   • The server representation is produced by `descriptor.toRemote` at send
 *     time, and that mapping needs every column. A partial patch would map
 *     absent fields to null and wipe server data.
 *
 *   • Consecutive edits collapse correctly: whichever entry sends last carries
 *     a complete, self-consistent row rather than a fragment.
 */
export function withOutbox(
  db: SqlDatabase,
  entry: {
    table: SyncableTable;
    rowId: string;
    operation: OutboxOperation;
  },
  write: () => void,
): void {
  db.transaction(() => {
    write();

    if (entry.operation === 'delete') {
      enqueue(db, { ...entry, payload: { id: entry.rowId } });
      return;
    }

    const row = db.get<Record<string, unknown>>(
      `SELECT * FROM ${entry.table} WHERE id = ?`,
      [entry.rowId],
    );

    if (!row) {
      throw new Error(
        `Cannot queue ${entry.table}/${entry.rowId} for sync: the row does not ` +
          'exist after the write.',
      );
    }

    enqueue(db, { ...entry, payload: row });
  });
}

/** Entries ready to send now, oldest first. */
export function claimReady(db: SqlDatabase, limit = 50): OutboxEntry[] {
  return db.all<OutboxEntry>(
    `SELECT * FROM sync_outbox
      WHERE next_attempt_at <= ?
      ORDER BY id ASC
      LIMIT ?`,
    [Date.now(), limit],
  );
}

export function countPending(db: SqlDatabase): number {
  const row = db.get<{ count: number }>('SELECT COUNT(*) AS count FROM sync_outbox');
  return row?.count ?? 0;
}

/**
 * Whether a row has unsent local writes.
 *
 * The pull path consults this before overwriting anything — it is the guard
 * that keeps a background sync from discarding what the user just typed.
 */
export function hasPendingChange(
  db: SqlDatabase,
  table: SyncableTable,
  rowId: string,
): boolean {
  const row = db.get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM sync_outbox WHERE table_name = ? AND row_id = ?',
    [table, rowId],
  );
  return (row?.count ?? 0) > 0;
}

export function markSucceeded(db: SqlDatabase, id: number): void {
  db.run('DELETE FROM sync_outbox WHERE id = ?', [id]);
}

/**
 * Records a failure and schedules the retry.
 *
 * Returns `true` when the entry was abandoned. An entry that keeps failing is
 * rejected rather than transiently broken, and leaving it in place would block
 * every write queued behind it.
 */
export function markFailed(db: SqlDatabase, entry: OutboxEntry, reason: string): boolean {
  const attempts = entry.attempts + 1;

  if (isExhausted(attempts)) {
    db.run('DELETE FROM sync_outbox WHERE id = ?', [entry.id]);
    return true;
  }

  db.run(
    `UPDATE sync_outbox
        SET attempts = ?, next_attempt_at = ?, last_error = ?
      WHERE id = ?`,
    [attempts, Date.now() + retryDelayMs(attempts), reason.slice(0, 500), entry.id],
  );
  return false;
}

/* ----------------------------------------------------------- sync cursor -- */

export function readCursor(db: SqlDatabase, table: SyncableTable): string | null {
  const row = db.get<{ cursor: string | null }>(
    'SELECT cursor FROM sync_state WHERE table_name = ?',
    [table],
  );
  return row?.cursor ?? null;
}

export function writeCursor(
  db: SqlDatabase,
  table: SyncableTable,
  cursor: string | null,
): void {
  db.run(
    `INSERT INTO sync_state (table_name, cursor, last_pulled_at)
     VALUES (?, ?, ?)
     ON CONFLICT(table_name) DO UPDATE
       SET cursor = excluded.cursor, last_pulled_at = excluded.last_pulled_at`,
    [table, cursor, Date.now()],
  );
}
