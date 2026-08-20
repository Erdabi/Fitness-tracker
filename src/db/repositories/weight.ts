import { getDatabase } from '../client';
import type { WeightEntryRow } from '../schema';
import type { SqlDatabase } from '../types';
import { addDays, type LocalDay } from '@/lib/date';
import { newId } from '@/lib/id';
import { withOutbox } from '@/sync/outbox';

/**
 * Weight history.
 *
 * A table rather than a column on the profile. A single mutable `weight_kg`
 * would lose every previous measurement the first time somebody stepped on a
 * scale — and the calculator needs a current weight anyway, so the history
 * costs one table and buys progress tracking outright.
 */

export interface RecordWeightInput {
  readonly userId: string;
  readonly measuredOn: LocalDay;
  readonly weightKg: number;
  readonly note?: string | null;
  /** Epoch ms, for tests. */
  readonly at?: number;
}

/**
 * Records a weigh-in.
 *
 * Re-recording the same day updates that day's entry rather than appending a
 * second one — correcting a typo should not leave two readings behind. Two
 * *devices* recording the same morning offline is different: each creates its
 * own row, both survive the sync, and the later one reads back. Rejecting the
 * second would mean losing a real measurement to a constraint.
 */
export function recordWeight(
  input: RecordWeightInput,
  db: SqlDatabase = getDatabase(),
): WeightEntryRow {
  const now = input.at ?? Date.now();

  const existing = db.get<WeightEntryRow>(
    `SELECT * FROM weight_entries
      WHERE user_id = ? AND measured_on = ? AND deleted_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [input.userId, input.measuredOn],
  );

  const row: WeightEntryRow = {
    id: existing?.id ?? newId(),
    user_id: input.userId,
    measured_on: input.measuredOn,
    weight_kg: input.weightKg,
    note: input.note ?? existing?.note ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    server_updated_at: existing?.server_updated_at ?? null,
    deleted_at: null,
  };

  withOutbox(db, { table: 'weight_entries', rowId: row.id, operation: 'upsert' }, () => {
    if (existing) {
      db.run(
        `UPDATE weight_entries
            SET weight_kg = ?, note = ?, updated_at = ?, deleted_at = NULL
          WHERE id = ?`,
        [row.weight_kg, row.note, row.updated_at, row.id],
      );
    } else {
      db.run(
        `INSERT INTO weight_entries
           (id, user_id, measured_on, weight_kg, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.user_id,
          row.measured_on,
          row.weight_kg,
          row.note,
          row.created_at,
          row.updated_at,
        ],
      );
    }
  });

  return row;
}

export function deleteWeightEntry(
  id: string,
  db: SqlDatabase = getDatabase(),
  at: number = Date.now(),
): void {
  withOutbox(db, { table: 'weight_entries', rowId: id, operation: 'delete' }, () => {
    db.run('UPDATE weight_entries SET deleted_at = ?, updated_at = ? WHERE id = ?', [
      at,
      at,
      id,
    ]);
  });
}

/**
 * The weight to use for a given day: the most recent reading on or before it.
 *
 * Carrying the last known weight forward is the only defensible answer — a
 * person who did not weigh themselves on Tuesday still had a weight on
 * Tuesday. Interpolating between readings would invent measurements that were
 * never taken.
 */
export function weightOn(
  userId: string,
  day: LocalDay,
  db: SqlDatabase = getDatabase(),
): WeightEntryRow | undefined {
  return db.get<WeightEntryRow>(
    `SELECT * FROM weight_entries
      WHERE user_id = ? AND deleted_at IS NULL AND measured_on <= ?
      ORDER BY measured_on DESC, created_at DESC, id DESC
      LIMIT 1`,
    [userId, day],
  );
}

/** The latest reading, whenever it was taken. Prefills the calculator. */
export function latestWeight(
  userId: string,
  db: SqlDatabase = getDatabase(),
): WeightEntryRow | undefined {
  return db.get<WeightEntryRow>(
    `SELECT * FROM weight_entries
      WHERE user_id = ? AND deleted_at IS NULL
      ORDER BY measured_on DESC, created_at DESC, id DESC
      LIMIT 1`,
    [userId],
  );
}

/**
 * Readings over a window, oldest first.
 *
 * One row per day — the latest reading for each — so a corrected entry does
 * not appear twice on a chart.
 */
export function weightHistory(
  userId: string,
  options: { from?: LocalDay; to: LocalDay; days?: number },
  db: SqlDatabase = getDatabase(),
): WeightEntryRow[] {
  const from = options.from ?? addDays(options.to, -(options.days ?? 90));

  return db.all<WeightEntryRow>(
    `SELECT * FROM weight_entries w
      WHERE w.user_id = ?
        AND w.deleted_at IS NULL
        AND w.measured_on BETWEEN ? AND ?
        AND w.id = (
          SELECT id FROM weight_entries
           WHERE user_id = w.user_id
             AND measured_on = w.measured_on
             AND deleted_at IS NULL
           ORDER BY created_at DESC, id DESC
           LIMIT 1
        )
      ORDER BY w.measured_on ASC`,
    [userId, from, options.to],
  );
}
