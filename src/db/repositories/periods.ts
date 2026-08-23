import { addDays, asLocalDay } from '@/lib/date';
import type { SqlDatabase } from '../types';

/**
 * Goal period chains.
 *
 * Mirrors `resync_period_chain()` in Postgres, and exists for the same reason
 * the server version does: nutrition goals and water goals have identical
 * period semantics, and the semantics are subtle enough that two copies would
 * drift. One of them would eventually get same-day supersession wrong, and the
 * symptom — two periods claiming one day — is invisible until a historical
 * date reads the wrong target.
 *
 * The rule: every live period ends the day before the next one starts, the
 * newest stays open, and periods sharing a start date are ordered by creation
 * with all but the last given an empty range.
 */

/** Tables whose rows form a period chain. */
export type PeriodTable = 'nutrition_goals' | 'water_goals';

interface PeriodRow {
  id: string;
  effective_from: string;
  effective_to: string | null;
}

/**
 * Recomputes every period's end date for one user.
 *
 * Deliberately outside the outbox, and deliberately not touching
 * `updated_at`: `effective_to` is derived on both sides, the sync descriptors
 * omit it on push, and bumping `updated_at` here would make a purely local
 * recomputation look like a user edit to the conflict resolver — which would
 * push it straight back to the server.
 *
 * Idempotent, so the engine's `afterPull` hook can call it on every cycle that
 * lands rows.
 */
export function resyncPeriodChain(
  table: PeriodTable,
  userId: string,
  db: SqlDatabase,
): void {
  const periods = db.all<PeriodRow>(
    `SELECT id, effective_from, effective_to FROM ${table}
      WHERE user_id = ? AND deleted_at IS NULL
      ORDER BY effective_from ASC, created_at ASC, id ASC`,
    [userId],
  );

  db.transaction(() => {
    periods.forEach((period, index) => {
      const next = periods[index + 1];
      const from = asLocalDay(period.effective_from);

      const effectiveTo =
        next === undefined
          ? null
          : // A same-day successor means this period never applied: it ends
            // the day before it started, an empty range covering nothing.
            next.effective_from <= period.effective_from
            ? addDays(from, -1)
            : addDays(asLocalDay(next.effective_from), -1);

      if (period.effective_to !== effectiveTo) {
        db.run(`UPDATE ${table} SET effective_to = ? WHERE id = ?`, [
          effectiveTo,
          period.id,
        ]);
      }
    });
  });
}
