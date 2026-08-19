import type { SupabaseClient } from '@supabase/supabase-js';

import { supabase } from '@/api/supabase';
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
import type { AnyRow, OutboxEntry, SyncContext, TableDescriptor } from './types';

/**
 * The engine addresses tables by name at runtime, so it cannot use the
 * per-table generated types — those require a literal table name known at the
 * call site. Narrowing to the untyped client once here keeps that concession
 * in a single place instead of a cast on every query.
 *
 * Safety is not lost: the table names come from `RemoteTable`, and every row
 * that crosses this boundary is shaped by a typed descriptor mapping.
 */
const client = supabase as unknown as SupabaseClient;

/**
 * Bidirectional sync between the local SQLite database and Supabase.
 *
 * Push drains the outbox in insertion order so a create always precedes the
 * update that follows it. Pull fetches only rows newer than the stored cursor.
 * Neither half blocks the UI — every read in the app is served from SQLite.
 */

/** Rows per pull request. Bounded so a large backlog cannot exhaust memory. */
const PULL_PAGE_SIZE = 500;

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
  const { db } = context;
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

    const failure = await sendEntry(entry, descriptor);

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
  entry: OutboxEntry,
  descriptor: TableDescriptor,
): Promise<string | null> {
  const payload = safeParse(entry.payload);
  if (!payload) return 'Malformed outbox payload';

  if (entry.operation === 'delete') {
    const { error } = await client
      .from(descriptor.remoteTable)
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', entry.row_id);
    return error?.message ?? null;
  }

  const { error } = await client
    .from(descriptor.remoteTable)
    .upsert(payload, { onConflict: 'id' });
  return error?.message ?? null;
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
  const { db, userId } = context;
  const cursor = readCursor(db, descriptor.table);

  let query = client
    .from(descriptor.remoteTable)
    .select('*')
    .eq(descriptor.userColumn, userId)
    .order('updated_at', { ascending: true })
    .limit(PULL_PAGE_SIZE);

  // A null cursor means "first sync" — take everything the user owns.
  if (cursor) query = query.gt('updated_at', cursor);

  const { data, error } = await query;
  if (error)
    throw new Error(`Pull failed for ${descriptor.remoteTable}: ${error.message}`);
  if (!data || data.length === 0) return 0;

  let applied = 0;

  db.transaction(() => {
    for (const remoteRow of data as AnyRow[]) {
      if (applyRemoteRow(db, descriptor, remoteRow)) applied += 1;
    }

    writeCursor(
      db,
      descriptor.table,
      advanceCursor(
        cursor,
        (data as AnyRow[]).map((row) =>
          typeof row.updated_at === 'string' ? row.updated_at : null,
        ),
      ),
    );
  });

  return applied;
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
