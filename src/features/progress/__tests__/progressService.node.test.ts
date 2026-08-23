import { createTestDatabase } from '@/db/__tests__/testDb';
import { migrate } from '@/db/migrator';
import { createFoodLog } from '@/db/repositories/foodLogs';
import { openGoalPeriod } from '@/db/repositories/goals';
import { logWater, openWaterGoal } from '@/db/repositories/water';
import { recordWeight } from '@/db/repositories/weight';
import { loadDashboard } from '@/features/dashboard/dashboardService';
import type { SqlDatabase } from '@/db/types';
import { addDays, asLocalDay, middayOfLocalDay, type LocalDay } from '@/lib/date';
import type { NutritionPerBase } from '@/lib/nutrition';
import { ADHERENCE_TOLERANCE, loadProgress } from '../progressService';

/**
 * The progress summaries, and the local-date boundaries they depend on.
 *
 * The timezone cases matter most: a dashboard or progress query that resolved
 * days in UTC would look correct for anyone in western Europe and be wrong by
 * a day for half the world, in a way nobody notices until they compare two
 * devices.
 */

const USER = 'user-alice';
const TODAY = asLocalDay('2026-06-15');

const FOOD: NutritionPerBase = {
  calories: 100,
  protein_g: 10,
  carbohydrates_g: 12,
  fat_g: 3,
  fiber_g: null,
  sugar_g: null,
  saturated_fat_g: null,
  sodium_mg: null,
};

function logFood(db: SqlDatabase, day: LocalDay, grams: number, at: number, zone = 'Europe/Zurich') {
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
      timeZone: zone,
      diaryDate: day,
      at: at ?? middayOfLocalDay(day, zone).getTime(),
    },
    db,
  );
}

describe('loadProgress', () => {
  let db: SqlDatabase & { close: () => void };

  beforeEach(() => {
    db = createTestDatabase();
    migrate(db);
  });

  afterEach(() => db.close());

  describe('an empty window', () => {
    it('reports nothing rather than failing', () => {
      const progress = loadProgress(USER, TODAY, 30, db);

      expect(progress.weight.current).toBeNull();
      expect(progress.weight.changeKg).toBeNull();
      expect(progress.calories.daysLogged).toBe(0);
      expect(progress.calories.averageKcal).toBe(0);
      expect(progress.water.daysLogged).toBe(0);
      expect(progress.water.averageMl).toBe(0);
    });

    it('spans the requested window', () => {
      const progress = loadProgress(USER, TODAY, 30, db);
      expect(progress.to).toBe(TODAY);
      expect(progress.from).toBe(addDays(TODAY, -29));
      expect(progress.waterDays).toHaveLength(30);
    });
  });

  describe('weight', () => {
    it('reports the change between the first and last readings', () => {
      recordWeight({ userId: USER, measuredOn: addDays(TODAY, -28), weightKg: 81.0, at: 1000 }, db);
      recordWeight({ userId: USER, measuredOn: addDays(TODAY, -14), weightKg: 79.8, at: 2000 }, db);
      recordWeight({ userId: USER, measuredOn: TODAY, weightKg: 78.4, at: 3000 }, db);

      const { weight } = loadProgress(USER, TODAY, 30, db);

      expect(weight.starting?.weight_kg).toBe(81.0);
      expect(weight.current?.weight_kg).toBe(78.4);
      expect(weight.changeKg).toBe(-2.6);
      expect(weight.entries).toHaveLength(3);
    });

    /**
     * Two readings a week apart inside a 90-day window describe a weekly rate.
     * Dividing by the window rather than by the span would understate it by an
     * order of magnitude.
     */
    it('rates the change over the days the readings span, not the window', () => {
      recordWeight({ userId: USER, measuredOn: addDays(TODAY, -7), weightKg: 80.0, at: 1000 }, db);
      recordWeight({ userId: USER, measuredOn: TODAY, weightKg: 79.3, at: 2000 }, db);

      const { weight } = loadProgress(USER, TODAY, 90, db);

      expect(weight.changeKg).toBe(-0.7);
      expect(weight.weeklyRateKg).toBe(-0.7);
    });

    it('reports no trend from a single reading', () => {
      recordWeight({ userId: USER, measuredOn: TODAY, weightKg: 78.4, at: 1000 }, db);

      const { weight } = loadProgress(USER, TODAY, 30, db);
      expect(weight.current?.weight_kg).toBe(78.4);
      expect(weight.changeKg).toBeNull();
      expect(weight.weeklyRateKg).toBeNull();
    });

    it('shows one row per day even when a day was corrected', () => {
      recordWeight({ userId: USER, measuredOn: TODAY, weightKg: 88.4, at: 1000 }, db);
      recordWeight({ userId: USER, measuredOn: TODAY, weightKg: 78.4, at: 2000 }, db);

      const { weight } = loadProgress(USER, TODAY, 30, db);
      expect(weight.entries).toHaveLength(1);
      expect(weight.current?.weight_kg).toBe(78.4);
    });
  });

  describe('calories', () => {
    beforeEach(() => {
      openGoalPeriod(
        {
          userId: USER,
          effectiveFrom: addDays(TODAY, -29),
          targets: {
            calorieTarget: 2000,
            macros: { protein_g: 140, carbohydrates_g: 200, fat_g: 60 },
          },
          recommendation: null,
          at: 1000,
        },
        db,
      );
    });

    it('averages over the days actually logged', () => {
      logFood(db, addDays(TODAY, -2), 1800, 10_000);
      logFood(db, addDays(TODAY, -1), 2200, 11_000);

      const { calories } = loadProgress(USER, TODAY, 30, db);

      expect(calories.daysLogged).toBe(2);
      expect(calories.averageKcal).toBe(2000);
      expect(calories.daysInRange).toBe(30);
    });

    it('counts a day within the tolerance as on target', () => {
      // 2,000 kcal goal, 10% tolerance → anything from 1,800 to 2,200.
      logFood(db, addDays(TODAY, -3), 1850, 10_000);
      logFood(db, addDays(TODAY, -2), 2150, 11_000);
      logFood(db, addDays(TODAY, -1), 2600, 12_000);

      const { calories } = loadProgress(USER, TODAY, 30, db);

      expect(calories.daysWithGoal).toBe(3);
      expect(calories.daysOnTarget).toBe(2);
    });

    it('uses the documented tolerance', () => {
      const justInside = 2000 * (1 + ADHERENCE_TOLERANCE) - 10;
      logFood(db, addDays(TODAY, -1), justInside / 100 * 100, 10_000);

      const { calories } = loadProgress(USER, TODAY, 30, db);
      expect(calories.daysOnTarget).toBe(1);
    });

    /**
     * Each day is measured against the goal that applied that day. Using
     * today's goal throughout would rewrite the meaning of every past day
     * whenever somebody changed their target.
     */
    it('measures each day against its own goal', () => {
      openGoalPeriod(
        {
          userId: USER,
          effectiveFrom: addDays(TODAY, -1),
          targets: {
            calorieTarget: 2600,
            macros: { protein_g: 170, carbohydrates_g: 260, fat_g: 80 },
          },
          recommendation: null,
          at: 2000,
        },
        db,
      );

      // 2,000 kcal: on target under the old goal, well under the new one.
      logFood(db, addDays(TODAY, -5), 2000, 10_000);
      // 2,600 kcal: on target under the new goal only.
      logFood(db, TODAY, 2600, 11_000);

      const { calories } = loadProgress(USER, TODAY, 30, db);
      expect(calories.daysOnTarget).toBe(2);
    });

    it('does not count days that had no goal', () => {
      // Before the goal period began.
      logFood(db, addDays(TODAY, -60), 2000, 10_000);

      const { calories } = loadProgress(USER, TODAY, 90, db);
      expect(calories.daysLogged).toBe(1);
      expect(calories.daysWithGoal).toBe(0);
      expect(calories.daysOnTarget).toBe(0);
    });
  });

  describe('water', () => {
    beforeEach(() => {
      openWaterGoal(
        { userId: USER, effectiveFrom: addDays(TODAY, -29), targetMl: 2500, at: 1000 },
        db,
      );
    });

    it('averages over the whole window, counting blank days as zero', () => {
      logWater(
        { userId: USER, amountMl: 2000, timeZone: 'Europe/Zurich', localDate: addDays(TODAY, -1), at: 10_000 },
        db,
      );
      logWater(
        { userId: USER, amountMl: 3000, timeZone: 'Europe/Zurich', localDate: TODAY, at: 11_000 },
        db,
      );

      const { water } = loadProgress(USER, TODAY, 30, db);

      expect(water.totalMl).toBe(5000);
      expect(water.daysLogged).toBe(2);
      // A day with nothing recorded genuinely is a day of no water, unlike
      // food, where a blank day means "not tracked".
      expect(water.averageMl).toBe(Math.round(5000 / 30));
    });

    it('counts the days the goal was met', () => {
      logWater(
        { userId: USER, amountMl: 2500, timeZone: 'Europe/Zurich', localDate: addDays(TODAY, -1), at: 10_000 },
        db,
      );
      logWater(
        { userId: USER, amountMl: 1000, timeZone: 'Europe/Zurich', localDate: TODAY, at: 11_000 },
        db,
      );

      const { water } = loadProgress(USER, TODAY, 30, db);
      expect(water.daysGoalMet).toBe(1);
    });
  });
});

/**
 * The boundary cases from the specification.
 *
 * An entry at 23:30 local must belong to that local day whichever side of UTC
 * the user is on. These go through the dashboard and progress readers rather
 * than the repositories directly, because the question is whether the SCREENS
 * resolve days correctly — the repositories are already covered.
 */
describe('local-date boundaries', () => {
  let db: SqlDatabase & { close: () => void };

  beforeEach(() => {
    db = createTestDatabase();
    migrate(db);
  });

  afterEach(() => db.close());

  it('UTC+12: a 23:30 entry belongs to that local day, not the UTC one', () => {
    // 2026-06-15 23:30 in Auckland is 2026-06-15 11:30 UTC.
    const at = Date.parse('2026-06-15T11:30:00.000Z');
    logWater({ userId: USER, amountMl: 500, timeZone: 'Pacific/Auckland', at }, db);
    logFood(db, asLocalDay('2026-06-15'), 500, at, 'Pacific/Auckland');

    const summary = loadDashboard(USER, asLocalDay('2026-06-15'), db);
    expect(summary.water.consumedMl).toBe(500);
    expect(summary.food.total.calories).toBe(500);

    // And nothing lands on the neighbouring day.
    expect(loadDashboard(USER, asLocalDay('2026-06-16'), db).water.consumedMl).toBe(0);
  });

  it('UTC+12: an entry whose UTC day is yesterday still reads as today', () => {
    // 2026-06-15 11:00 in Auckland is 2026-06-14 23:00 UTC.
    const at = Date.parse('2026-06-14T23:00:00.000Z');
    logWater({ userId: USER, amountMl: 750, timeZone: 'Pacific/Auckland', at }, db);

    expect(loadDashboard(USER, asLocalDay('2026-06-15'), db).water.consumedMl).toBe(750);
    expect(loadDashboard(USER, asLocalDay('2026-06-14'), db).water.consumedMl).toBe(0);
  });

  it('UTC-10: an entry whose UTC day is tomorrow still reads as today', () => {
    // 2026-06-14 22:00 in Honolulu is 2026-06-15 08:00 UTC.
    const at = Date.parse('2026-06-15T08:00:00.000Z');
    logWater({ userId: USER, amountMl: 600, timeZone: 'Pacific/Honolulu', at }, db);
    logFood(db, asLocalDay('2026-06-14'), 600, at, 'Pacific/Honolulu');

    const summary = loadDashboard(USER, asLocalDay('2026-06-14'), db);
    expect(summary.water.consumedMl).toBe(600);
    expect(summary.food.total.calories).toBe(600);

    expect(loadDashboard(USER, asLocalDay('2026-06-15'), db).water.consumedMl).toBe(0);
  });

  /**
   * The explicit contrast. A UTC truncation would agree with the local answer
   * for anything logged mid-afternoon, so this uses instants where the two
   * genuinely differ.
   */
  it('disagrees with a UTC truncation in both directions', () => {
    const ahead = Date.parse('2026-06-14T23:00:00.000Z'); // Auckland: the 15th
    const behind = Date.parse('2026-06-15T08:00:00.000Z'); // Honolulu: the 14th

    expect(new Date(ahead).toISOString().slice(0, 10)).toBe('2026-06-14');
    expect(new Date(behind).toISOString().slice(0, 10)).toBe('2026-06-15');

    logWater({ userId: USER, amountMl: 100, timeZone: 'Pacific/Auckland', at: ahead }, db);
    logWater({ userId: USER, amountMl: 200, timeZone: 'Pacific/Honolulu', at: behind }, db);

    // The local answers are the opposite of the UTC ones in both cases.
    expect(loadDashboard(USER, asLocalDay('2026-06-15'), db).water.consumedMl).toBe(100);
    expect(loadDashboard(USER, asLocalDay('2026-06-14'), db).water.consumedMl).toBe(200);
  });

  it('keeps a travelling user history where it was written', () => {
    const home = Date.parse('2026-06-15T11:30:00.000Z');
    logWater({ userId: USER, amountMl: 500, timeZone: 'Pacific/Auckland', at: home }, db);

    // The same person, later, in Honolulu.
    const away = Date.parse('2026-06-20T08:00:00.000Z');
    logWater({ userId: USER, amountMl: 300, timeZone: 'Pacific/Honolulu', at: away }, db);

    expect(loadDashboard(USER, asLocalDay('2026-06-15'), db).water.consumedMl).toBe(500);
    expect(loadDashboard(USER, asLocalDay('2026-06-19'), db).water.consumedMl).toBe(300);
  });
});
