import { getDatabase } from '../client';
import type { WaterGoalRow, WaterLogRow, WaterGoalSource } from '../schema';
import type { SqlDatabase } from '../types';
import {
  addDays,
  asLocalDay,
  localDayFor,
  middayOfLocalDay,
  type LocalDay,
} from '@/lib/date';
import { newId } from '@/lib/id';
import { recommendedWaterMl, waterProgress } from '@/lib/water';
import type { GoalProgress } from '@/lib/energy';
import { withOutbox } from '@/sync/outbox';
import { resyncPeriodChain } from './periods';

/**
 * Water logs and water goals.
 *
 * One logging service, used by every quick-add button, the custom amount and
 * anything added later — the buttons differ by the number they pass and by
 * nothing else.
 *
 * Reads never touch the network: the dashboard's water card is answered from
 * SQLite, so it renders with the radio off and a glass logged on a plane is in
 * the total immediately.
 */

/* ------------------------------------------------------------------- logs */

export interface LogWaterInput {
  readonly userId: string;
  readonly amountMl: number;
  readonly timeZone: string;
  /** The day to log onto. Defaults to the day `at` falls on. */
  readonly localDate?: LocalDay;
  /** Epoch ms. Defaults to now. */
  readonly at?: number;
  readonly note?: string | null;
}

export function logWater(
  input: LogWaterInput,
  db: SqlDatabase = getDatabase(),
): WaterLogRow {
  const amount = Math.round(input.amountMl);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Cannot log ${input.amountMl} ml of water: expected a positive amount`);
  }

  const now = input.at ?? Date.now();
  const { consumedAt, localDate } = resolveInstant(
    now,
    input.timeZone,
    input.localDate ?? null,
  );

  const row: WaterLogRow = {
    id: newId(),
    user_id: input.userId,
    amount_ml: amount,
    consumed_at: consumedAt,
    time_zone: input.timeZone,
    local_date: localDate,
    note: input.note ?? null,
    created_at: now,
    updated_at: now,
    server_updated_at: null,
    deleted_at: null,
  };

  withOutbox(db, { table: 'water_logs', rowId: row.id, operation: 'upsert' }, () => {
    const columns = Object.keys(row);
    db.run(
      `INSERT INTO water_logs (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map((column) => (row as unknown as Record<string, unknown>)[column] ?? null),
    );
  });

  return row;
}

export interface EditWaterInput {
  readonly amountMl?: number;
  readonly note?: string | null;
  /** Moves the entry to another day; its instant moves with it. */
  readonly localDate?: LocalDay;
  readonly timeZone?: string;
  readonly at?: number;
}

export function editWaterLog(
  id: string,
  patch: EditWaterInput,
  db: SqlDatabase = getDatabase(),
): WaterLogRow {
  const existing = db.get<WaterLogRow>('SELECT * FROM water_logs WHERE id = ?', [id]);
  if (!existing) throw new Error(`Cannot edit water log ${id}: it does not exist`);

  const now = patch.at ?? Date.now();
  const amount =
    patch.amountMl === undefined ? existing.amount_ml : Math.round(patch.amountMl);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Cannot set a water entry to ${patch.amountMl} ml`);
  }

  const timeZone = patch.timeZone ?? existing.time_zone;
  const { consumedAt, localDate } =
    patch.localDate || patch.timeZone
      ? resolveInstant(existing.consumed_at, timeZone, patch.localDate ?? null)
      : { consumedAt: existing.consumed_at, localDate: existing.local_date };

  const next: WaterLogRow = {
    ...existing,
    amount_ml: amount,
    consumed_at: consumedAt,
    time_zone: timeZone,
    local_date: localDate,
    note: patch.note !== undefined ? patch.note : existing.note,
    updated_at: now,
  };

  withOutbox(db, { table: 'water_logs', rowId: id, operation: 'upsert' }, () => {
    db.run(
      `UPDATE water_logs
          SET amount_ml = ?, consumed_at = ?, time_zone = ?, local_date = ?,
              note = ?, updated_at = ?
        WHERE id = ?`,
      [
        next.amount_ml,
        next.consumed_at,
        next.time_zone,
        next.local_date,
        next.note,
        next.updated_at,
        id,
      ],
    );
  });

  return next;
}

/**
 * Removes an entry.
 *
 * Soft, like every other deletion here: a hard delete cannot be synchronised,
 * and the other device would push the row straight back. It leaves the day's
 * total immediately, because every read filters `deleted_at IS NULL`.
 */
export function deleteWaterLog(
  id: string,
  db: SqlDatabase = getDatabase(),
  at: number = Date.now(),
): void {
  withOutbox(db, { table: 'water_logs', rowId: id, operation: 'delete' }, () => {
    db.run('UPDATE water_logs SET deleted_at = ?, updated_at = ? WHERE id = ?', [
      at,
      at,
      id,
    ]);
  });
}

/** One day's entries, in the order they were drunk. */
export function listWaterDay(
  userId: string,
  day: LocalDay,
  db: SqlDatabase = getDatabase(),
): WaterLogRow[] {
  return db.all<WaterLogRow>(
    `SELECT * FROM water_logs
      WHERE user_id = ? AND local_date = ? AND deleted_at IS NULL
      ORDER BY consumed_at, id`,
    [userId, day],
  );
}

export function getWaterLog(
  id: string,
  db: SqlDatabase = getDatabase(),
): WaterLogRow | undefined {
  return db.get<WaterLogRow>(
    'SELECT * FROM water_logs WHERE id = ? AND deleted_at IS NULL',
    [id],
  );
}

/* ------------------------------------------------------------------ goals */

export interface OpenWaterGoalInput {
  readonly userId: string;
  readonly effectiveFrom: LocalDay;
  readonly targetMl: number;
  /** What the app recommended, when it recommended anything. */
  readonly recommendedMl?: number | null;
  readonly basisWeightKg?: number | null;
  readonly note?: string | null;
  readonly at?: number;
}

/**
 * Opens a water goal period.
 *
 * Not an update. A recalculation after a weight change starts a new period and
 * leaves every earlier one exactly as it was, which is what keeps a historical
 * day's goal attached to that day.
 *
 * `source` is derived from the numbers rather than passed in, so it cannot
 * contradict them — the database enforces the same rule.
 */
export function openWaterGoal(
  input: OpenWaterGoalInput,
  db: SqlDatabase = getDatabase(),
): WaterGoalRow {
  const now = input.at ?? Date.now();
  const target = Math.round(input.targetMl);
  const recommended =
    input.recommendedMl === undefined || input.recommendedMl === null
      ? null
      : Math.round(input.recommendedMl);

  const source: WaterGoalSource =
    recommended !== null && recommended === target ? 'calculated' : 'manual';

  const row: WaterGoalRow = {
    id: newId(),
    user_id: input.userId,
    effective_from: input.effectiveFrom,
    effective_to: null,
    target_ml: target,
    source,
    calculated_ml: recommended,
    basis_weight_kg: input.basisWeightKg ?? null,
    note: input.note ?? null,
    created_at: now,
    updated_at: now,
    server_updated_at: null,
    deleted_at: null,
  };

  withOutbox(db, { table: 'water_goals', rowId: row.id, operation: 'upsert' }, () => {
    const columns = Object.keys(row);
    db.run(
      `INSERT INTO water_goals (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map((column) => (row as unknown as Record<string, unknown>)[column] ?? null),
    );
  });

  resyncWaterGoalPeriods(input.userId, db);

  return {
    ...row,
    effective_to:
      db.get<{ effective_to: string | null }>(
        'SELECT effective_to FROM water_goals WHERE id = ?',
        [row.id],
      )?.effective_to ?? null,
  };
}

export function deleteWaterGoal(
  id: string,
  db: SqlDatabase = getDatabase(),
  at: number = Date.now(),
): void {
  const existing = db.get<{ user_id: string }>(
    'SELECT user_id FROM water_goals WHERE id = ?',
    [id],
  );
  if (!existing) return;

  withOutbox(db, { table: 'water_goals', rowId: id, operation: 'delete' }, () => {
    db.run('UPDATE water_goals SET deleted_at = ?, updated_at = ? WHERE id = ?', [
      at,
      at,
      id,
    ]);
  });

  resyncWaterGoalPeriods(existing.user_id, db);
}

/**
 * The water goal in force on a given day.
 *
 * The latest period starting on or before the date, breaking a same-day tie by
 * creation — identical to how nutrition goals resolve, and mirroring
 * `water_goal_for_date()` on the server. It never consults the profile, so a
 * historical day keeps its own target however much the user's weight has
 * changed since.
 */
export function waterGoalForDate(
  userId: string,
  day: LocalDay,
  db: SqlDatabase = getDatabase(),
): WaterGoalRow | undefined {
  return db.get<WaterGoalRow>(
    `SELECT * FROM water_goals
      WHERE user_id = ? AND deleted_at IS NULL AND effective_from <= ?
      ORDER BY effective_from DESC, created_at DESC, id DESC
      LIMIT 1`,
    [userId, day],
  );
}

export function listWaterGoalPeriods(
  userId: string,
  db: SqlDatabase = getDatabase(),
  limit = 50,
): WaterGoalRow[] {
  return db.all<WaterGoalRow>(
    `SELECT * FROM water_goals
      WHERE user_id = ? AND deleted_at IS NULL
      ORDER BY effective_from DESC, created_at DESC
      LIMIT ?`,
    [userId, limit],
  );
}

/** Mirrors `resync_period_chain` on the server. See `resyncPeriodChain`. */
export function resyncWaterGoalPeriods(
  userId: string,
  db: SqlDatabase = getDatabase(),
): void {
  resyncPeriodChain('water_goals', userId, db);
}

/* ------------------------------------------------------------ aggregation */

export interface WaterDay {
  readonly day: LocalDay;
  readonly consumedMl: number;
  readonly entryCount: number;
  /** The target in force on that day, or null if none was ever set. */
  readonly targetMl: number | null;
  /** Null when there is no target to measure against. */
  readonly progress: GoalProgress | null;
}

/**
 * A day's water, against the goal that applied on that day.
 *
 * Two reads, not two hundred: one SUM over the covering index and one goal
 * lookup. The dashboard and the history screen both go through here, so
 * "total, goal, remaining" is computed in exactly one place.
 */
export function waterDay(
  userId: string,
  day: LocalDay,
  db: SqlDatabase = getDatabase(),
): WaterDay {
  const totals = db.get<{ total: number | null; entries: number }>(
    `SELECT SUM(amount_ml) AS total, COUNT(*) AS entries
       FROM water_logs
      WHERE user_id = ? AND local_date = ? AND deleted_at IS NULL`,
    [userId, day],
  );

  const consumedMl = Number(totals?.total ?? 0);
  const goal = waterGoalForDate(userId, day, db);
  const targetMl = goal?.target_ml ?? null;

  return {
    day,
    consumedMl,
    entryCount: Number(totals?.entries ?? 0),
    targetMl,
    progress: targetMl === null ? null : waterProgress(consumedMl, targetMl),
  };
}

/**
 * Daily totals across a range, each against its own day's goal.
 *
 * One pass over the logs and one over the goals, joined in memory — rather
 * than a goal lookup per day, which is what turns a week view into eight
 * queries and a year view into three hundred and sixty-six.
 *
 * Days with no entries are included with a zero total, because a water history
 * needs to show the days somebody drank nothing.
 */
export function waterHistory(
  userId: string,
  options: { from: LocalDay; to: LocalDay },
  db: SqlDatabase = getDatabase(),
): WaterDay[] {
  const totals = new Map<string, { total: number; entries: number }>();

  for (const row of db.all<{ local_date: string; total: number; entries: number }>(
    `SELECT local_date, SUM(amount_ml) AS total, COUNT(*) AS entries
       FROM water_logs
      WHERE user_id = ? AND deleted_at IS NULL AND local_date BETWEEN ? AND ?
      GROUP BY local_date`,
    [userId, options.from, options.to],
  )) {
    totals.set(row.local_date, {
      total: Number(row.total ?? 0),
      entries: Number(row.entries ?? 0),
    });
  }

  // Every period that could cover any day in the range: the ones starting
  // inside it, plus the one already running when it began.
  const periods = db.all<WaterGoalRow>(
    `SELECT * FROM water_goals
      WHERE user_id = ? AND deleted_at IS NULL AND effective_from <= ?
      ORDER BY effective_from DESC, created_at DESC, id DESC`,
    [userId, options.to],
  );

  const goalFor = (day: LocalDay): number | null =>
    periods.find((period) => period.effective_from <= day)?.target_ml ?? null;

  const days: WaterDay[] = [];
  for (let day = options.from; day <= options.to; day = addDays(day, 1)) {
    const totalled = totals.get(day);
    const consumedMl = totalled?.total ?? 0;
    const targetMl = goalFor(day);

    days.push({
      day,
      consumedMl,
      entryCount: totalled?.entries ?? 0,
      targetMl,
      progress: targetMl === null ? null : waterProgress(consumedMl, targetMl),
    });
  }

  return days;
}

export interface WaterSummary {
  readonly daysInRange: number;
  readonly daysLogged: number;
  readonly daysGoalMet: number;
  /** Mean over days that have a target, so untargeted days do not skew it. */
  readonly averageMl: number;
  readonly totalMl: number;
}

/**
 * A window of water, summarised for the progress screen.
 *
 * `averageMl` divides by days in the range rather than by days logged: a week
 * with two 2 L days and five blank ones averages 570 ml, not 2 L. The second
 * figure flatters; the first is the one that reflects the habit.
 */
export function summariseWater(days: readonly WaterDay[]): WaterSummary {
  const totalMl = days.reduce((sum, day) => sum + day.consumedMl, 0);

  return {
    daysInRange: days.length,
    daysLogged: days.filter((day) => day.entryCount > 0).length,
    daysGoalMet: days.filter(
      (day) => day.targetMl !== null && day.consumedMl >= day.targetMl,
    ).length,
    averageMl: days.length === 0 ? 0 : Math.round(totalMl / days.length),
    totalMl,
  };
}

/**
 * The target to suggest, from the user's most recent weight.
 *
 * Exposed here so the goal screen and the dashboard's first-run prompt agree
 * on the number, rather than each computing its own.
 */
export function suggestedTargetMl(weightKg: number | null): number {
  return recommendedWaterMl(weightKg);
}

/* --------------------------------------------------------------- internals */

/**
 * Settles the instant and the day so they agree.
 *
 * The same rule the diary uses, and checked here for the same reason: a
 * mismatch surfaces with a useful message rather than as a constraint
 * violation during a background sync.
 */
function resolveInstant(
  at: number,
  timeZone: string,
  requestedDay: LocalDay | null,
): { consumedAt: number; localDate: LocalDay } {
  const naturalDay = localDayFor(new Date(at), timeZone);

  if (!requestedDay || requestedDay === naturalDay) {
    return { consumedAt: at, localDate: naturalDay };
  }

  const moved = middayOfLocalDay(requestedDay, timeZone);
  const settled = localDayFor(moved, timeZone);

  if (settled !== requestedDay) {
    throw new Error(
      `Could not place a water entry on ${requestedDay} in ${timeZone}: ` +
        `midday there resolves to ${settled}.`,
    );
  }

  return { consumedAt: moved.getTime(), localDate: requestedDay };
}

export { asLocalDay };
