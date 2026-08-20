import { createTestDatabase } from '@/db/__tests__/testDb';
import { migrate } from '@/db/migrator';
import { createFoodLog, dayTotals } from '@/db/repositories/foodLogs';
import { goalForDate, openGoalPeriod } from '@/db/repositories/goals';
import type { SqlDatabase } from '@/db/types';
import { asLocalDay, middayOfLocalDay, type LocalDay } from '@/lib/date';
import { goalProgress } from '@/lib/energy';
import type { NutritionPerBase } from '@/lib/nutrition';

/**
 * The diary read against its own day's goal.
 *
 * The failure this guards against is the one that looks fine for a week: the
 * diary reads the *current* goal for every date, so opening last month shows
 * last month's food against this month's target. Every assertion below pairs a
 * historical day's totals with a historical day's goal.
 */

const USER = 'user-alice';
const ZURICH = 'Europe/Zurich';
const MACROS = { protein_g: 144, carbohydrates_g: 200, fat_g: 63 };

const BASIS = {
  bmr: 1780,
  tdee: 2759,
  activity: 'moderate' as const,
  direction: 'lose' as const,
  weightKg: 80,
  heightCm: 180,
  ageYears: 30,
  sex: 'male' as const,
};

const FOOD: NutritionPerBase = {
  calories: 100,
  protein_g: 10,
  carbohydrates_g: 10,
  fat_g: 2,
  fiber_g: null,
  sugar_g: null,
  saturated_fat_g: null,
  sodium_mg: null,
};

function openGoal(db: SqlDatabase, from: string, calories: number, at: number) {
  return openGoalPeriod(
    {
      userId: USER,
      effectiveFrom: asLocalDay(from),
      targets: { calorieTarget: calories, macros: MACROS },
      recommendation: { calorieTarget: calories, macros: MACROS },
      basis: BASIS,
      at,
    },
    db,
  );
}

/** Logs `grams` of a 100 kcal/100 g food onto `day`. */
function logOn(db: SqlDatabase, day: LocalDay, grams: number) {
  return createFoodLog(
    {
      userId: USER,
      meal: 'lunch',
      food: {
        foodId: 'food-test',
        name: 'Test food',
        brandName: null,
        sourceId: 'usda',
        isVerified: true,
        baseUnit: 'g',
        baseAmount: 100,
      },
      nutrition: FOOD,
      quantity: grams,
      serving: null,
      timeZone: ZURICH,
      diaryDate: day,
      at: middayOfLocalDay(day, ZURICH).getTime(),
    },
    db,
  );
}

describe('the diary against its own day goal', () => {
  let db: SqlDatabase & { close: () => void };

  beforeEach(() => {
    db = createTestDatabase();
    migrate(db);

    // The specification's example: 2,000 kcal to 10 August, then 2,200.
    openGoal(db, '2026-08-01', 2000, 1000);
    openGoal(db, '2026-08-11', 2200, 2000);
  });

  afterEach(() => db.close());

  it('compares an old day against the target that was in force then', () => {
    const day = asLocalDay('2026-08-05');
    logOn(db, day, 1800);

    const totals = dayTotals(USER, day, db);
    const goal = goalForDate(USER, day, db)!;
    const progress = goalProgress(totals.total.calories, goal.calorie_target);

    expect(goal.calorie_target).toBe(2000);
    expect(totals.total.calories).toBe(1800);
    expect(progress.remaining).toBe(200);
    expect(progress.isOver).toBe(false);
  });

  it('compares a newer day against the newer target', () => {
    const day = asLocalDay('2026-08-15');
    logOn(db, day, 1800);

    const goal = goalForDate(USER, day, db)!;
    const progress = goalProgress(
      dayTotals(USER, day, db).total.calories,
      goal.calorie_target,
    );

    expect(goal.calorie_target).toBe(2200);
    expect(progress.remaining).toBe(400);
  });

  /**
   * The same intake on two days, either side of a goal change: one is under
   * and one is over. If the diary used today's goal for both, they would read
   * identically and one of them would be a lie.
   */
  it('gives the same intake different verdicts either side of a goal change', () => {
    const before = asLocalDay('2026-08-05');
    const after = asLocalDay('2026-08-15');

    logOn(db, before, 2100);
    logOn(db, after, 2100);

    const verdictBefore = goalProgress(
      dayTotals(USER, before, db).total.calories,
      goalForDate(USER, before, db)!.calorie_target,
    );
    const verdictAfter = goalProgress(
      dayTotals(USER, after, db).total.calories,
      goalForDate(USER, after, db)!.calorie_target,
    );

    expect(verdictBefore.isOver).toBe(true);
    expect(verdictBefore.overBy).toBe(100);
    expect(verdictAfter.isOver).toBe(false);
    expect(verdictAfter.remaining).toBe(100);
  });

  it('does not re-read a historical day when a new goal is opened today', () => {
    const day = asLocalDay('2026-08-05');
    logOn(db, day, 1800);

    const before = goalForDate(USER, day, db)!.calorie_target;
    openGoal(db, '2026-09-01', 2600, 3000);
    const after = goalForDate(USER, day, db)!.calorie_target;

    expect(before).toBe(2000);
    expect(after).toBe(2000);
  });

  it('has no goal to compare against before the first period', () => {
    const day = asLocalDay('2026-07-20');
    logOn(db, day, 1800);

    expect(dayTotals(USER, day, db).total.calories).toBe(1800);
    expect(goalForDate(USER, day, db)).toBeUndefined();
  });

  it('compares macros against the same day targets', () => {
    const day = asLocalDay('2026-08-05');
    logOn(db, day, 1000);

    const totals = dayTotals(USER, day, db);
    const goal = goalForDate(USER, day, db)!;

    expect(totals.total.protein_g).toBe(100);
    expect(goal.protein_target_g).toBe(144);
    expect(goalProgress(totals.total.protein_g, goal.protein_target_g).remaining).toBe(44);
  });

  it('reports an overage rather than a negative allowance', () => {
    const day = asLocalDay('2026-08-05');
    logOn(db, day, 2400);

    const progress = goalProgress(
      dayTotals(USER, day, db).total.calories,
      goalForDate(USER, day, db)!.calorie_target,
    );

    expect(progress.isOver).toBe(true);
    expect(progress.overBy).toBe(400);
    expect(progress.remaining).toBeLessThan(0);
    expect(progress.fraction).toBe(1);
  });
});
