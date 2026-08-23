import { rangeTotals } from '@/db/repositories/foodLogs';
import { goalForDate } from '@/db/repositories/goals';
import { summariseWater, waterHistory, type WaterDay, type WaterSummary } from '@/db/repositories/water';
import { weightHistory } from '@/db/repositories/weight';
import type { WeightEntryRow } from '@/db/schema';
import type { SqlDatabase } from '@/db/types';
import { addDays, type LocalDay } from '@/lib/date';

/**
 * The progress screen's data.
 *
 * Everything is computed locally from rows the device already holds — there is
 * no analytics backend, and this milestone deliberately does not start one.
 * Three windows over three tables, composed once so the screen has one loading
 * state and a countable number of reads.
 */

export interface WeightProgress {
  readonly entries: readonly WeightEntryRow[];
  readonly current: WeightEntryRow | null;
  readonly starting: WeightEntryRow | null;
  readonly changeKg: number | null;
  /** Kilograms per week, over the days the readings actually span. */
  readonly weeklyRateKg: number | null;
}

export interface CalorieProgress {
  readonly daysInRange: number;
  readonly daysLogged: number;
  readonly averageKcal: number;
  /** Days whose intake was within `ADHERENCE_TOLERANCE` of that day's goal. */
  readonly daysOnTarget: number;
  /** Days that had a goal at all — the denominator for adherence. */
  readonly daysWithGoal: number;
}

export interface ProgressSummary {
  readonly from: LocalDay;
  readonly to: LocalDay;
  readonly weight: WeightProgress;
  readonly calories: CalorieProgress;
  readonly water: WaterSummary;
  readonly waterDays: readonly WaterDay[];
}

/**
 * How close to the day's calorie goal still counts as on target.
 *
 * A single number, because "adherence" needs a definition and an undefined one
 * would be decided differently by each screen. 10% is roughly 200 kcal on a
 * 2,000 kcal goal — inside the noise of portion estimation, which is the
 * point: this measures whether somebody roughly followed their plan, not
 * whether they weighed their lunch.
 */
export const ADHERENCE_TOLERANCE = 0.1;

export function loadProgress(
  userId: string,
  to: LocalDay,
  days: number,
  db: SqlDatabase,
): ProgressSummary {
  const from = addDays(to, -(days - 1));

  const entries = weightHistory(userId, { from, to, days }, db);
  const dayTotals = rangeTotals(userId, from, to, db);
  const waterDays = waterHistory(userId, { from, to }, db);

  return {
    from,
    to,
    weight: summariseWeight(entries),
    calories: summariseCalories(userId, dayTotals, days, db),
    water: summariseWater(waterDays),
    waterDays,
  };
}

function summariseWeight(entries: readonly WeightEntryRow[]): WeightProgress {
  const starting = entries[0] ?? null;
  const current = entries[entries.length - 1] ?? null;

  /*
   * A single reading is a measurement, not a trend. Reporting "0.0 kg change"
   * for it would state a fact nobody established.
   */
  if (!starting || !current || starting.id === current.id) {
    return { entries, current, starting, changeKg: null, weeklyRateKg: null };
  }

  const changeKg = round1(current.weight_kg - starting.weight_kg);

  /*
   * Rate over the days the readings actually span, not over the window. Two
   * readings a week apart inside a 90-day window describe a weekly rate, and
   * dividing by 90 would understate it by an order of magnitude.
   */
  const spanned = Math.max(1, daysBetweenIso(starting.measured_on, current.measured_on));

  return {
    entries,
    current,
    starting,
    changeKg,
    weeklyRateKg: round2((changeKg / spanned) * 7),
  };
}

function summariseCalories(
  userId: string,
  totals: ReturnType<typeof rangeTotals>,
  days: number,
  db: SqlDatabase,
): CalorieProgress {
  let daysWithGoal = 0;
  let daysOnTarget = 0;

  for (const day of totals) {
    // The goal that applied on THAT day, never today's.
    const goal = goalForDate(userId, day.day, db);
    if (!goal) continue;

    daysWithGoal += 1;
    const tolerance = goal.calorie_target * ADHERENCE_TOLERANCE;
    if (Math.abs(day.total.calories - goal.calorie_target) <= tolerance) {
      daysOnTarget += 1;
    }
  }

  const totalKcal = totals.reduce((sum, day) => sum + day.total.calories, 0);

  return {
    daysInRange: days,
    daysLogged: totals.length,
    /*
     * Averaged over days actually logged, unlike water. A blank food day means
     * "not recorded" — nobody ate nothing — so averaging zeros in would
     * misrepresent it. A blank water day genuinely is zero water.
     */
    averageKcal: totals.length === 0 ? 0 : Math.round(totalKcal / totals.length),
    daysOnTarget,
    daysWithGoal,
  };
}

function daysBetweenIso(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
