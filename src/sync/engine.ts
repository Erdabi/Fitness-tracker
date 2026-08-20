import type { SqlDatabase } from '@/db/types';
import { logger } from '@/lib/logger';
import { advanceCursor, resolve } from './merge';
import {
  claimReady,
  hasPendingChange,
  markFailed,
  markSucceeded,
  readCursor,
  writeCursor,
} from './outbox';
import { SYNC_REGISTRY } from './registry';
import type { RemoteAdapter } from './remote';
import type { AnyRow, OutboxEntry, SyncContext, TableDescriptor } from './types';

/**
 * Bidirectional sync between the local SQLite database and Supabase.
 *
 * Push drains the outbox in insertion order so a create always precedes the
 * update that follows it. Pull fetches only rows newer than the stored cursor.
 * Neither half blocks the UI — every read in the app is served from SQLite.
 */

/** Rows per pull request. Bounded so a large backlog cannot exhaust memory. */
const PULL_PAGE_SIZE = 500;

/** Pages per table per cycle, so one huge backlog cannot stall the others. */
const MAX_PULL_PAGES = 20;

/**
 * How far the pull cursor is rewound before querying. See `overlapFrom`.
 * Generous enough to cover a slow commit, small enough that the re-fetched
 * window stays trivial.
 */
export const SYNC_CURSOR_LAG_MS = 5_000;

let inFlight: Promise<SyncOutcome> | null = null;

export interface SyncOutcome {
  readonly pushed: number;
  readonly pulled: number;
  readonly abandoned: number;
  readonly error: string | null;
}

/**
 * Runs a full sync cycle.
 *
 * Calls that arrive while a cycle is running join the existing one rather than
 * starting a second — the triggers (foreground, reconnect, post-mutation) fire
 * close together and overlapping cycles would race on the same outbox rows.
 */
export function sync(context: SyncContext): Promise<SyncOutcome> {
  if (inFlight) return inFlight;

  inFlight = runCycle(context).finally(() => {
    inFlight = null;
  });

  return inFlight;
}

async function runCycle(context: SyncContext): Promise<SyncOutcome> {
  let pushed = 0;
  let pulled = 0;
  let abandoned = 0;

  try {
    const pushResult = await push(context);
    pushed = pushResult.sent;
    abandoned = pushResult.abandoned;

    pulled = await pull(context);

    return { pushed, pulled, abandoned, error: null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Sync failed';
    // Sync failures are expected offline and must never surface as a crash.
    logger.warn('Sync cycle failed', { reason: message });
    return { pushed, pulled, abandoned, error: message };
  }
}

/* ------------------------------------------------------------------ push -- */

async function push(context: SyncContext): Promise<{ sent: number; abandoned: number }> {
  const { db, remote } = context;
  let sent = 0;
  let abandoned = 0;

  for (const entry of claimReady(db)) {
    const descriptor = descriptorFor(entry.table_name);
    if (!descriptor) {
      // Table no longer syncs (removed in a later build). Drop the entry
      // rather than retrying something nothing can handle.
      markSucceeded(db, entry.id);
      continue;
    }

    const failure = await sendEntry(remote, entry, descriptor);

    if (failure === null) {
      markSucceeded(db, entry.id);
      sent += 1;
      continue;
    }

    if (markFailed(db, entry, failure)) {
      abandoned += 1;
      logger.error('Abandoned outbox entry after repeated failures', {
        table: entry.table_name,
        attempts: entry.attempts + 1,
      });
    }
  }

  return { sent, abandoned };
}

/** Returns null on success, or the failure reason. */
async function sendEntry(
  remote: RemoteAdapter,
  entry: OutboxEntry,
  descriptor: TableDescriptor,
): Promise<string | null> {
  if (entry.operation === 'delete') {
    return remote.softDelete(descriptor.remoteTable, entry.row_id);
  }

  const localRow = safeParse(entry.payload);
  if (!localRow) return 'Malformed outbox payload';

  // The outbox stores the full local row; the descriptor converts it to the
  // server's representation here. Doing it at send time rather than at enqueue
  // time is what keeps type coercions (SQLite 0/1 -> Postgres boolean, epoch
  // millis -> timestamptz) in exactly one place.
  return remote.upsert(descriptor.remoteTable, descriptor.toRemote(localRow));
}

/* ------------------------------------------------------------------ pull -- */

async function pull(context: SyncContext): Promise<number> {
  let total = 0;
  for (const descriptor of SYNC_REGISTRY) {
    total += await pullTable(context, descriptor);
  }
  return total;
}

async function pullTable(
  context: SyncContext,
  descriptor: TableDescriptor,
): Promise<number> {
  const { db, userId, remote } = context;
  const startingCursor = readCursor(db, descriptor.table);

  let cursor = startingCursor;
  let applied = 0;

  // Pages until the server returns a short page. Without the loop a backlog
  // larger than one page would need as many sync cycles as it has pages.
  for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
    // A null cursor means "first sync" — take everything the user owns.
    const rows = await remote.fetchChanged({
      table: descriptor.remoteTable,
      userColumn: descriptor.userColumn,
      userId,
      since: overlapFrom(cursor),
      limit: PULL_PAGE_SIZE,
    });

    if (rows.length === 0) break;

    db.transaction(() => {
      for (const remoteRow of rows) {
        if (applyRemoteRow(db, descriptor, remoteRow)) applied += 1;
      }

      cursor = advanceCursor(
        cursor,
        rows.map((row) => (typeof row.updated_at === 'string' ? row.updated_at : null)),
      );
      writeCursor(db, descriptor.table, cursor);
    });

    if (rows.length < PULL_PAGE_SIZE) break;

    // A full page whose newest row does not move the cursor means more rows
    // share that exact timestamp than fit in a page. Paging again would
    // re-fetch the same rows forever, so stop and let the next cycle try.
    if (cursor === startingCursor) break;
  }

  /*
   * Let the table rebuild anything it derives rather than receives.
   *
   * Only when something actually landed: the hook is idempotent, but running
   * it on every quiet cycle would be work for nothing.
   */
  if (applied > 0 && descriptor.afterPull) {
    descriptor.afterPull(db, userId);
  }

  return applied;
}

/**
 * Rewinds the cursor by a small window before querying.
 *
 * Two failure modes make an exact `> cursor` unsafe:
 *
 *   • Commit ordering. A row's `updated_at` is stamped before its transaction
 *     commits, so a slow transaction can land a row whose timestamp is already
 *     behind a cursor a previous pull advanced past. That row would never be
 *     seen again.
 *
 *   • Page boundaries. Rows sharing an identical timestamp can straddle the
 *     end of a page; a strict `>` would skip the remainder permanently.
 *
 * Re-fetching a few seconds of overlap costs one small page and is harmless:
 * applying a row is idempotent, and `resolve()` discards anything not newer
 * than what is already local.
 */
function overlapFrom(cursor: string | null): string | null {
  if (!cursor) return null;
  const ms = Date.parse(cursor);
  if (Number.isNaN(ms)) return null;
  return new Date(ms - SYNC_CURSOR_LAG_MS).toISOString();
}

/** Returns true when the local row was changed. */
function applyRemoteRow(
  db: SqlDatabase,
  descriptor: TableDescriptor,
  remoteRow: AnyRow,
): boolean {
  const local = descriptor.fromRemote(remoteRow);
  const rowId = String(local.id);

  const existing = db.get<{ updated_at: number }>(
    `SELECT updated_at FROM ${descriptor.table} WHERE id = ?`,
    [rowId],
  );

  const decision = resolve({
    localUpdatedAt: existing?.updated_at ?? null,
    remoteUpdatedAt: Number(local.updated_at),
    hasPendingLocalChange: hasPendingChange(db, descriptor.table, rowId),
  });

  if (decision === 'keep-local') return false;

  const columns = Object.keys(local);
  const placeholders = columns.map(() => '?').join(', ');
  const assignments = columns
    .filter((column) => column !== 'id')
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');

  db.run(
    `INSERT INTO ${descriptor.table} (${columns.join(', ')})
     VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${assignments}`,
    columns.map((column) => local[column] ?? null),
  );

  return true;
}

/* ----------------------------------------------------------------- utils -- */

function descriptorFor(table: string): TableDescriptor | undefined {
  return SYNC_REGISTRY.find((entry) => entry.table === table);
}

function safeParse(json: string): AnyRow | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? (parsed as AnyRow) : null;
  } catch {
    return null;
  }
}
