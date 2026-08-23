import { createTestDatabase } from '@/db/__tests__/testDb';
import { migrate } from '@/db/migrator';
import { createFoodLog } from '@/db/repositories/foodLogs';
import { openGoalPeriod } from '@/db/repositories/goals';
import { logWater, openWaterGoal } from '@/db/repositories/water';
import { recordWeight } from '@/db/repositories/weight';
import type { SqlDatabase } from '@/db/types';
import { addDays, asLocalDay, middayOfLocalDay, type LocalDay } from '@/lib/date';
import type { NutritionPerBase } from '@/lib/nutrition';
import { WEIGHT_TREND_DAYS, loadDashboard } from '../dashboardService';

/**
 * The dashboard summary.
 *
 * Two things are being checked. First, that every figure matches what the
 * owning repository says — the dashboard must not become a second source of
 * truth for calories the diary already totalled. Second, that rendering it
 * costs a bounded, countable number of database reads.
 */

const USER = 'user-alice';
const OTHER = 'user-bob';
const ZURICH = 'Europe/Zurich';
const TODAY = asLocalDay('2026-06-15');

const FOOD: NutritionPerBase = {
  calories: 100,
  protein_g: 10,
  carbohydrates_g: 12,
  fat_g: 3,
  fiber_g: 2,
  sugar_g: null,
  saturated_fat_g: null,
  sodium_mg: null,
};

/**
 * Wraps a database so every read can be counted.
 *
 * The measurement the spec asks for: a dashboard that quietly grows a query
 * per card is one that gets slower with every feature, and the only way to
 * notice is to count.
 */
function counting(db: SqlDatabase): SqlDatabase & { readonly reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    exec: (sql) => db.exec(sql),
    run: (sql, params) => db.run(sql, params),
    all: <T,>(sql: string, params?: readonly unknown[]) => {
      reads.push(sql);
      return db.all<T>(sql, params);
    },
    get: <T,>(sql: string, params?: readonly unknown[]) => {
      reads.push(sql);
      return db.get<T>(sql, params);
    },
    transaction: (fn) => db.transaction(fn),
  };
}

function logFood(db: SqlDatabase, day: LocalDay, grams: number, at: number) {
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
      at: at ?? middayOfLocalDay(day, ZURICH).getTime(),
    },
    db,
  );
}

describe('loadDashboard', () => {
  let db: SqlDatabase & { close: () => void };

  beforeEach(() => {
    db = createTestDatabase();
    migrate(db);
  });

  afterEach(() => db.close());

  describe('an empty day', () => {
    it('reports zeros rather than failing', () => {
      const summary = loadDashboard(USER, TODAY, db);

      expect(summary.food.entryCount).toBe(0);
      expect(summary.food.total.calories).toBe(0);
      expect(summary.water.consumedMl).toBe(0);
      expect(summary.water.entryCount).toBe(0);
      expect(summary.weight.current).toBeNull();
    });

    it('has no progress to report without goals', () => {
      const summary = loadDashboard(USER, TODAY, db);

      expect(summary.calorieGoal).toBeNull();
      expect(summary.calories).toBeNull();
      expect(summary.water.targetMl).toBeNull();
      expect(summary.water.progress).toBeNull();
    });

    /**
     * A single reading is a measurement, not a trend. "0.0 kg over 30 days"
     * for somebody who weighed themselves once states a fact nobody
     * established.
     */
    it('reports no change from a single weight reading', () => {
      recordWeight(
        { userId: USER, measuredOn: TODAY, weightKg: 78.4, at: 1000 },
        db,
      );

      const summary = loadDashboard(USER, TODAY, db);
      expect(summary.weight.current?.weight_kg).toBe(78.4);
      expect(summary.weight.previous).toBeNull();
      expect(summary.weight.changeKg).toBeNull();
    });
  });

  describe('a populated day', () => {
    beforeEach(() => {
      openGoalPeriod(
        {
          userId: USER,
          effectiveFrom: asLocalDay('2026-06-01'),
          targets: {
            calorieTarget: 2100,
            macros: { protein_g: 150, carbohydrates_g: 220, fat_g: 70 },
          },
          recommendation: null,
          at: 1000,
        },
        db,
      );
      openWaterGoal(
        { userId: USER, effectiveFrom: asLocalDay('2026-06-01'), targetMl: 2500, at: 1000 },
        db,
      );

      logFood(db, TODAY, 1620, 10_000);
      logWater({ userId: USER, amountMl: 1750, timeZone: ZURICH, localDate: TODAY, at: 11_000 }, db);

      recordWeight(
        { userId: USER, measuredOn: addDays(TODAY, -WEIGHT_TREND_DAYS), weightKg: 79.2, at: 2000 },
        db,
      );
      recordWeight({ userId: USER, measuredOn: TODAY, weightKg: 78.4, at: 3000 }, db);
    });

    it('reports calories against the day goal', () => {
      const summary = loadDashboard(USER, TODAY, db);

      expect(summary.food.total.calories).toBe(1620);
      expect(summary.calorieGoal?.calorie_target).toBe(2100);
      expect(summary.calories?.remaining).toBe(480);
      expect(summary.calories?.isOver).toBe(false);
    });

    it('reports macros from the diary aggregation, not its own', () => {
      const summary = loadDashboard(USER, TODAY, db);

      // 1620 g of a food with 10 g protein per 100 g.
      expect(summary.food.total.protein_g).toBeCloseTo(162, 5);
      expect(summary.calorieGoal?.protein_target_g).toBe(150);
    });

    it('reports water against the day goal', () => {
      const summary = loadDashboard(USER, TODAY, db);

      expect(summary.water.consumedMl).toBe(1750);
      expect(summary.water.targetMl).toBe(2500);
      expect(summary.water.progress?.remaining).toBe(750);
    });

    it('reports the weight trend over the documented window', () => {
      const summary = loadDashboard(USER, TODAY, db);

      expect(summary.weight.current?.weight_kg).toBe(78.4);
      expect(summary.weight.previous?.weight_kg).toBe(79.2);
      expect(summary.weight.changeKg).toBe(-0.8);
      expect(summary.weight.overDays).toBe(WEIGHT_TREND_DAYS);
    });

    it('reports an overage as an overage, never as a negative remainder', () => {
      logFood(db, TODAY, 700, 12_000);

      const summary = loadDashboard(USER, TODAY, db);
      expect(summary.food.total.calories).toBe(2320);
      expect(summary.calories?.isOver).toBe(true);
      expect(summary.calories?.overBy).toBe(220);
      expect(summary.calories?.fraction).toBe(1);
    });

    it('never counts another user toward this one', () => {
      logWater({ userId: OTHER, amountMl: 3000, timeZone: ZURICH, localDate: TODAY, at: 13_000 }, db);
      recordWeight({ userId: OTHER, measuredOn: TODAY, weightKg: 120, at: 14_000 }, db);

      const summary = loadDashboard(USER, TODAY, db);
      expect(summary.water.consumedMl).toBe(1750);
      expect(summary.weight.current?.weight_kg).toBe(78.4);
    });
  });

  describe('historical days keep their own goals', () => {
    beforeEach(() => {
      openGoalPeriod(
        {
          userId: USER,
          effectiveFrom: asLocalDay('2026-06-01'),
          targets: {
            calorieTarget: 2000,
            macros: { protein_g: 140, carbohydrates_g: 200, fat_g: 60 },
          },
          recommendation: null,
          at: 1000,
        },
        db,
      );
      openWaterGoal(
        { userId: USER, effectiveFrom: asLocalDay('2026-06-01'), targetMl: 2000, at: 1000 },
        db,
      );
      openGoalPeriod(
        {
          userId: USER,
          effectiveFrom: asLocalDay('2026-06-11'),
          targets: {
            calorieTarget: 2400,
            macros: { protein_g: 160, carbohydrates_g: 240, fat_g: 75 },
          },
          recommendation: null,
          at: 2000,
        },
        db,
      );
      openWaterGoal(
        { userId: USER, effectiveFrom: asLocalDay('2026-06-11'), targetMl: 2800, at: 2000 },
        db,
      );
    });

    it('measures an older day against the goals in force then', () => {
      const older = asLocalDay('2026-06-05');
      logFood(db, older, 1800, 10_000);
      logWater({ userId: USER, amountMl: 1800, timeZone: ZURICH, localDate: older, at: 11_000 }, db);

      const summary = loadDashboard(USER, older, db);
      expect(summary.calorieGoal?.calorie_target).toBe(2000);
      expect(summary.water.targetMl).toBe(2000);
      expect(summary.calories?.remaining).toBe(200);
      expect(summary.water.progress?.remaining).toBe(200);
    });

    it('measures a newer day against the newer goals', () => {
      logFood(db, TODAY, 1800, 12_000);
      logWater({ userId: USER, amountMl: 1800, timeZone: ZURICH, localDate: TODAY, at: 13_000 }, db);

      const summary = loadDashboard(USER, TODAY, db);
      expect(summary.calorieGoal?.calorie_target).toBe(2400);
      expect(summary.water.targetMl).toBe(2800);
    });

    /**
     * The same intake either side of a goal change reads differently. A
     * dashboard using today's goal for an older day would call them identical,
     * and one of those readings would be wrong.
     */
    it('gives the same intake different verdicts across a goal change', () => {
      const older = asLocalDay('2026-06-05');
      logFood(db, older, 2200, 10_000);
      logFood(db, TODAY, 2200, 11_000);

      expect(loadDashboard(USER, older, db).calories?.isOver).toBe(true);
      expect(loadDashboard(USER, TODAY, db).calories?.isOver).toBe(false);
    });
  });

  describe('cost', () => {
    beforeEach(() => {
      openGoalPeriod(
        {
          userId: USER,
          effectiveFrom: asLocalDay('2026-06-01'),
          targets: {
            calorieTarget: 2100,
            macros: { protein_g: 150, carbohydrates_g: 220, fat_g: 70 },
          },
          recommendation: null,
          at: 1000,
        },
        db,
      );
      openWaterGoal(
        { userId: USER, effectiveFrom: asLocalDay('2026-06-01'), targetMl: 2500, at: 1000 },
        db,
      );
      recordWeight({ userId: USER, measuredOn: TODAY, weightKg: 78.4, at: 2000 }, db);
    });

    /**
     * The measurement the specification asks for. Six reads: diary totals, the
     * calorie goal, the water total, the water goal, the latest weight, and the
     * weight a month back.
     *
     * Pinned exactly rather than loosely, because the failure mode is gradual:
     * a card added later that fetches its own goal would take this to seven and
     * nobody would notice until the list was long.
     */
    it('renders from exactly six database reads', () => {
      const tracked = counting(db);
      loadDashboard(USER, TODAY, tracked);

      expect(tracked.reads).toHaveLength(6);
    });

    it('costs the same however much is logged that day', () => {
      for (let index = 0; index < 40; index += 1) {
        logFood(db, TODAY, 100, 10_000 + index);
        logWater(
          { userId: USER, amountMl: 250, timeZone: ZURICH, localDate: TODAY, at: 20_000 + index },
          db,
        );
      }

      const tracked = counting(db);
      loadDashboard(USER, TODAY, tracked);

      // Aggregation happens in SQLite, so eighty rows cost the same as none.
      expect(tracked.reads).toHaveLength(6);
    });

    it('costs the same however long the history is', () => {
      for (let back = 1; back <= 120; back += 1) {
        const day = addDays(TODAY, -back);
        logFood(db, day, 500, 30_000 + back);
        logWater(
          { userId: USER, amountMl: 500, timeZone: ZURICH, localDate: day, at: 40_000 + back },
          db,
        );
      }

      const tracked = counting(db);
      loadDashboard(USER, TODAY, tracked);

      expect(tracked.reads).toHaveLength(6);
    });

    it('stays fast with a long history behind it', () => {
      for (let back = 1; back <= 365; back += 1) {
        const day = addDays(TODAY, -back);
        logFood(db, day, 500, 50_000 + back);
      }

      const started = process.hrtime.bigint();
      for (let index = 0; index < 50; index += 1) loadDashboard(USER, TODAY, db);
      const perRender = Number(process.hrtime.bigint() - started) / 1e6 / 50;

      // Generous: the point is that it is a fraction of a frame, not a number
      // to tune. A regression here would be orders of magnitude, not percent.
      expect(perRender).toBeLessThan(10);
    });
  });
});
