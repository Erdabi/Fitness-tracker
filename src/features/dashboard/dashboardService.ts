import { dayTotals, type DayTotals } from '@/db/repositories/foodLogs';
import { goalForDate } from '@/db/repositories/goals';
import { waterDay, type WaterDay } from '@/db/repositories/water';
import { latestWeight, weightOn } from '@/db/repositories/weight';
import type { NutritionGoalRow, WeightEntryRow } from '@/db/schema';
import type { SqlDatabase } from '@/db/types';
import { addDays, type LocalDay } from '@/lib/date';
import { goalProgress, type GoalProgress } from '@/lib/energy';

/**
 * Everything the dashboard renders, in one pass.
 *
 * The dashboard is a SUMMARY, not a source of truth. Every figure here comes
 * from the repository that owns it — diary totals from `dayTotals`, water from
 * `waterDay`, the calorie goal from `goalForDate` — and nothing is recomputed
 * locally. A second implementation of "calories today" would eventually
 * disagree with the diary, and the diary is the one people would trust.
 *
 * Composed as one function rather than a hook per card so the number of
 * database round trips is a property of this file and can be measured. Six
 * reads, whatever the day contains:
 *
 *   1. the day's food totals, grouped by meal   (dayTotals)
 *   2. the calorie/macro goal for that day      (goalForDate)
 *   3. the day's water total                    (waterDay)
 *   4. the water goal for that day              (waterDay)
 *   5. the latest weight                        (latestWeight)
 *   6. the weight a month before                (weightOn)
 *
 * A card-per-hook arrangement would have multiplied that by re-resolving the
 * day, the goal and the profile in each one.
 */

export interface WeightTrend {
  readonly current: WeightEntryRow | null;
  /** The comparison point, roughly a month back. Null when there isn't one. */
  readonly previous: WeightEntryRow | null;
  /** Signed kilograms. Negative is a loss. Null when there is nothing to compare. */
  readonly changeKg: number | null;
  readonly overDays: number;
}

export interface DashboardSummary {
  readonly day: LocalDay;
  readonly food: DayTotals;
  readonly calorieGoal: NutritionGoalRow | null;
  readonly calories: GoalProgress | null;
  readonly water: WaterDay;
  readonly weight: WeightTrend;
}

/** How far back the weight card compares. A month reads as progress; a week reads as noise. */
export const WEIGHT_TREND_DAYS = 30;

export function loadDashboard(
  userId: string,
  day: LocalDay,
  db: SqlDatabase,
): DashboardSummary {
  const food = dayTotals(userId, day, db);
  const calorieGoal = goalForDate(userId, day, db) ?? null;
  const water = waterDay(userId, day, db);

  const current = latestWeight(userId, db) ?? null;
  const comparisonDay = addDays(day, -WEIGHT_TREND_DAYS);
  const earlier = weightOn(userId, comparisonDay, db) ?? null;

  /*
   * Only a genuinely earlier reading counts as a comparison. `weightOn` carries
   * the last known weight forward, so for somebody who has weighed themselves
   * once it returns that same row — and "0.0 kg change" over a month they never
   * measured would be an invented fact.
   */
  const previous = earlier && current && earlier.id !== current.id ? earlier : null;

  return {
    day,
    food,
    calorieGoal,
    calories: calorieGoal
      ? goalProgress(food.total.calories, calorieGoal.calorie_target)
      : null,
    water,
    weight: {
      current,
      previous,
      changeKg:
        current && previous ? round1(current.weight_kg - previous.weight_kg) : null,
      overDays: WEIGHT_TREND_DAYS,
    },
  };
}

/** Scales are accurate to about 100 g; more decimals would be false precision. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Progress against a macro target, or null when no goal is set. */
export function macroProgress(
  consumed: number | null,
  target: number | undefined,
): GoalProgress | null {
  if (target === undefined || consumed === null) return null;
  return goalProgress(consumed, target);
}
