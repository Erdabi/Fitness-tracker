import { createTestDatabase } from '@/db/__tests__/testDb';
import { migrate } from '@/db/migrator';
import type { SqlDatabase } from '@/db/types';
import {
  createFoodLog,
  dayTotals,
  deleteFoodLog,
  editFoodLog,
  frequentFoods,
  listDay,
  rangeTotals,
  repeatFoodLog,
  type LogFoodInput,
} from '../foodLogs';
import { asLocalDay, localDayFor } from '@/lib/date';
import type { NutritionPerBase } from '@/lib/nutrition';

/**
 * The diary store.
 *
 * Three properties get the weight here, because they are the three that fail
 * quietly and are discovered months later in somebody's history: the snapshot
 * does not follow the catalogue, an edit re-derives from the basis it was
 * written with, and the diary day is the user's day.
 */

const USER = 'user-alice';
const ZURICH = 'Europe/Zurich';

/** 52 kcal per 100 g, with fibre reported. */
const APPLE: NutritionPerBase = {
  calories: 52,
  protein_g: 0.26,
  carbohydrates_g: 13.81,
  fat_g: 0.17,
  fiber_g: 2.4,
  sugar_g: 10.39,
  saturated_fat_g: 0.03,
  sodium_mg: 1,
};

/** 42 kcal per 100 ml, with fibre genuinely unreported. */
const MILK: NutritionPerBase = {
  calories: 42,
  protein_g: 3.4,
  carbohydrates_g: 5,
  fat_g: 1,
  fiber_g: null,
  sugar_g: 5,
  saturated_fat_g: 0.6,
  sodium_mg: 44,
};

function log(
  db: SqlDatabase,
  overrides: Partial<LogFoodInput> & Pick<LogFoodInput, 'at'>,
) {
  return createFoodLog(
    {
      userId: USER,
      meal: 'breakfast',
      food: {
        foodId: 'food-apple',
        name: 'Apple, raw',
        brandName: null,
        sourceId: 'usda',
        isVerified: true,
        baseUnit: 'g',
        baseAmount: 100,
      },
      nutrition: APPLE,
      quantity: 200,
      serving: null,
      timeZone: ZURICH,
      ...overrides,
    },
    db,
  );
}

/** 2026-06-15 08:00 Zurich. */
const MORNING = Date.parse('2026-06-15T06:00:00.000Z');

describe('the food diary', () => {
  let db: SqlDatabase & { close: () => void };

  beforeEach(() => {
    db = createTestDatabase();
    migrate(db);
  });

  afterEach(() => db.close());

  describe('logging', () => {
    it('scales the nutrition to the quantity logged', () => {
      const row = log(db, { at: MORNING });

      expect(row.calories).toBe(104);
      expect(row.amount_in_base).toBe(200);
      expect(row.carbohydrates_g).toBeCloseTo(27.62, 5);
      expect(row.fiber_g).toBeCloseTo(4.8, 5);
    });

    it('snapshots what the food was, not a reference to it', () => {
      const row = log(db, { at: MORNING });

      expect(row.food_name).toBe('Apple, raw');
      expect(row.food_source_id).toBe('usda');
      expect(row.food_is_verified).toBe(1);
      expect(row.basis_calories).toBe(52);
      expect(row.basis_amount).toBe(100);
      expect(row.basis_unit).toBe('g');
    });

    it('stores a raw quantity as a portion of one, so there is one code path', () => {
      const row = log(db, { at: MORNING, quantity: 150 });

      expect(row.serving_label).toBe('g');
      expect(row.serving_amount).toBe(1);
      expect(row.amount_in_base).toBe(150);
    });

    it('resolves a named portion to the base unit', () => {
      const row = log(db, {
        at: MORNING,
        quantity: 2,
        serving: { label: '1 slice', amount: 30, unit: 'g' },
      });

      expect(row.amount_in_base).toBe(60);
      expect(row.calories).toBeCloseTo(31.2, 5);
    });

    it('keeps an unreported nutrient unreported rather than zero', () => {
      const row = log(db, {
        at: MORNING,
        food: {
          foodId: 'food-milk',
          name: 'Milk',
          brandName: null,
          sourceId: 'usda',
          isVerified: true,
          baseUnit: 'ml',
          baseAmount: 100,
        },
        nutrition: MILK,
        quantity: 250,
      });

      expect(row.fiber_g).toBeNull();
      expect(row.calories).toBeCloseTo(105, 5);
    });

    it('refuses a quantity that cannot mean anything', () => {
      expect(() => log(db, { at: MORNING, quantity: -1 })).toThrow(/non-negative/);
      expect(() => log(db, { at: MORNING, quantity: Number.NaN })).toThrow();
    });

    it('refuses a portion measured in a unit the food is not', () => {
      expect(() =>
        log(db, {
          at: MORNING,
          serving: { label: '1 cup', amount: 240, unit: 'ml' },
        }),
      ).toThrow(/no safe conversion/);
    });

    it('queues the entry for sync in the same transaction as the write', () => {
      const row = log(db, { at: MORNING });

      const queued = db.all<{ row_id: string; operation: string; payload: string }>(
        'SELECT row_id, operation, payload FROM sync_outbox',
      );

      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ row_id: row.id, operation: 'upsert' });
      // The payload is the full row, not the caller's input.
      expect(JSON.parse(queued[0]!.payload)).toMatchObject({
        basis_calories: 52,
        calories: 104,
      });
    });
  });

  describe('the snapshot does not follow the catalogue', () => {
    it('re-derives an edit from the basis the entry was written with', () => {
      const row = log(db, { at: MORNING, quantity: 200 });
      expect(row.calories).toBe(104);

      /*
       * The catalogue is corrected to 60 kcal/100 g between logging and
       * editing. There is nowhere for that number to enter: `editFoodLog`
       * takes no nutrition at all, and reads the basis off the row. 300 g must
       * be 156 kcal, not the 180 today's food would give.
       */
      const edited = editFoodLog(row.id, { quantity: 300, at: MORNING + 60_000 }, db);

      expect(edited.calories).toBe(156);
      expect(edited.basis_calories).toBe(52);
      expect(edited.amount_in_base).toBe(300);
    });

    it('rescales from the same basis when the portion changes', () => {
      const row = log(db, { at: MORNING, quantity: 200 });

      const edited = editFoodLog(
        row.id,
        { quantity: 1, serving: { label: '1 medium apple', amount: 182, unit: 'g' } },
        db,
      );

      expect(edited.calories).toBeCloseTo(94.64, 5);
      expect(edited.serving_label).toBe('1 medium apple');
      expect(edited.amount_in_base).toBe(182);
    });

    it('round-trips back to raw base units', () => {
      const row = log(db, {
        at: MORNING,
        quantity: 2,
        serving: { label: '1 slice', amount: 30, unit: 'g' },
      });

      const edited = editFoodLog(row.id, { quantity: 150, serving: null }, db);

      expect(edited.serving_amount).toBe(1);
      expect(edited.amount_in_base).toBe(150);
      expect(edited.calories).toBeCloseTo(78, 5);
    });

    it('keeps the portion when an edit does not mention it', () => {
      const row = log(db, {
        at: MORNING,
        quantity: 2,
        serving: { label: '1 slice', amount: 30, unit: 'g' },
      });

      const edited = editFoodLog(row.id, { meal: 'snack' }, db);

      expect(edited.serving_label).toBe('1 slice');
      expect(edited.serving_amount).toBe(30);
      expect(edited.amount_in_base).toBe(60);
    });

    it('leaves the identity snapshot alone across every edit', () => {
      const row = log(db, { at: MORNING });
      const edited = editFoodLog(
        row.id,
        { quantity: 300, meal: 'dinner', note: 'late' },
        db,
      );

      expect(edited.food_name).toBe(row.food_name);
      expect(edited.food_id).toBe(row.food_id);
      expect(edited.basis_amount).toBe(row.basis_amount);
      expect(edited.food_is_verified).toBe(row.food_is_verified);
    });
  });

  describe('the diary day is the user day', () => {
    const dayOf = (row: { diary_date: string }) => row.diary_date;

    it('puts a late-evening entry on that evening, not the next morning', () => {
      // 23:30 in Zurich on the 15th.
      const row = log(db, { at: Date.parse('2026-06-15T21:30:00.000Z') });
      expect(dayOf(row)).toBe('2026-06-15');
    });

    it('puts an after-midnight entry on the new local day', () => {
      // 00:30 in Zurich on the 16th, which is still the 15th in UTC.
      const row = log(db, { at: Date.parse('2026-06-15T22:30:00.000Z') });
      expect(dayOf(row)).toBe('2026-06-16');
    });

    it('follows a zone that is behind UTC', () => {
      // 22:00 on the 14th in Honolulu; the UTC day is the 15th.
      const row = log(db, {
        at: Date.parse('2026-06-15T08:00:00.000Z'),
        timeZone: 'Pacific/Honolulu',
      });

      expect(dayOf(row)).toBe('2026-06-14');
      expect(new Date(row.logged_at).toISOString().slice(0, 10)).toBe('2026-06-15');
    });

    it('follows a zone that is ahead of UTC', () => {
      // 11:00 on the 15th in Auckland; the UTC day is the 14th.
      const row = log(db, {
        at: Date.parse('2026-06-14T23:00:00.000Z'),
        timeZone: 'Pacific/Auckland',
      });

      expect(dayOf(row)).toBe('2026-06-15');
    });

    it('resolves one diary day on both sides of a daylight-saving change', () => {
      // Zurich falls back at 03:00 on 2026-10-25; both instants read 02:30.
      const first = log(db, { at: Date.parse('2026-10-25T00:30:00.000Z') });
      const second = log(db, { at: Date.parse('2026-10-25T01:30:00.000Z') });

      expect(dayOf(first)).toBe('2026-10-25');
      expect(dayOf(second)).toBe('2026-10-25');
    });

    it('moves the instant with the entry when logging onto another day', () => {
      const row = log(db, { at: MORNING, diaryDate: asLocalDay('2026-06-13') });

      expect(dayOf(row)).toBe('2026-06-13');
      // The stored instant genuinely falls on that day in the user's zone —
      // the invariant Postgres re-checks on the way in.
      expect(localDayFor(new Date(row.logged_at), ZURICH)).toBe('2026-06-13');
    });

    it('lands inside the day even when that day loses an hour', () => {
      // Zurich springs forward at 02:00 on 2026-03-29: a 23-hour day.
      const row = log(db, {
        at: Date.parse('2026-04-02T10:00:00.000Z'),
        diaryDate: asLocalDay('2026-03-29'),
      });

      expect(dayOf(row)).toBe('2026-03-29');
      expect(localDayFor(new Date(row.logged_at), ZURICH)).toBe('2026-03-29');
    });

    it('leaves historical dates exactly where they were when the user travels', () => {
      const home = log(db, { at: MORNING });
      expect(dayOf(home)).toBe('2026-06-15');

      // Same person, five days later, now in Tokyo.
      const abroad = log(db, {
        at: Date.parse('2026-06-20T16:00:00.000Z'),
        timeZone: 'Asia/Tokyo',
      });
      expect(dayOf(abroad)).toBe('2026-06-21');

      const unchanged = db.get<{ diary_date: string; time_zone: string }>(
        'SELECT diary_date, time_zone FROM food_logs WHERE id = ?',
        [home.id],
      );
      expect(unchanged).toEqual({ diary_date: '2026-06-15', time_zone: ZURICH });
    });

    it('re-dates an entry only by moving it', () => {
      const row = log(db, { at: MORNING });
      const moved = editFoodLog(row.id, { diaryDate: asLocalDay('2026-06-10') }, db);

      expect(moved.diary_date).toBe('2026-06-10');
      expect(localDayFor(new Date(moved.logged_at), ZURICH)).toBe('2026-06-10');
      expect(listDay(USER, asLocalDay('2026-06-15'), db)).toHaveLength(0);
      expect(listDay(USER, asLocalDay('2026-06-10'), db)).toHaveLength(1);
    });
  });

  describe('deleting', () => {
    it('removes the entry from the diary immediately, with no network', () => {
      const row = log(db, { at: MORNING });
      expect(listDay(USER, asLocalDay('2026-06-15'), db)).toHaveLength(1);

      deleteFoodLog(row.id, db, MORNING + 1000);

      expect(listDay(USER, asLocalDay('2026-06-15'), db)).toHaveLength(0);
      expect(dayTotals(USER, asLocalDay('2026-06-15'), db).total.calories).toBe(0);
    });

    it('records the deletion as a fact to be synchronised', () => {
      const row = log(db, { at: MORNING });
      deleteFoodLog(row.id, db, MORNING + 1000);

      const operations = db
        .all<{ operation: string }>(
          'SELECT operation FROM sync_outbox WHERE row_id = ? ORDER BY id',
          [row.id],
        )
        .map((entry) => entry.operation);

      expect(operations).toEqual(['upsert', 'delete']);

      // The row itself survives locally, marked, so a pull cannot mistake its
      // absence for "never existed" and recreate it.
      const stored = db.get<{ deleted_at: number | null }>(
        'SELECT deleted_at FROM food_logs WHERE id = ?',
        [row.id],
      );
      expect(stored?.deleted_at).toBe(MORNING + 1000);
    });
  });

  describe('daily totals', () => {
    beforeEach(() => {
      log(db, { at: MORNING, meal: 'breakfast', quantity: 200 }); // 104 kcal
      log(db, {
        at: MORNING + 60_000,
        meal: 'breakfast',
        quantity: 250,
        food: {
          foodId: 'food-milk',
          name: 'Milk',
          brandName: null,
          sourceId: 'usda',
          isVerified: true,
          baseUnit: 'ml',
          baseAmount: 100,
        },
        nutrition: MILK,
      }); // 105 kcal, no fibre
      log(db, { at: MORNING + 6 * 3_600_000, meal: 'lunch', quantity: 100 }); // 52 kcal
    });

    it('sums the day and splits it by meal', () => {
      const totals = dayTotals(USER, asLocalDay('2026-06-15'), db);

      expect(totals.entryCount).toBe(3);
      expect(totals.total.calories).toBeCloseTo(261, 5);
      expect(totals.byMeal.breakfast.entryCount).toBe(2);
      expect(totals.byMeal.breakfast.total.calories).toBeCloseTo(209, 5);
      expect(totals.byMeal.lunch.total.calories).toBeCloseTo(52, 5);
      expect(totals.byMeal.dinner.entryCount).toBe(0);
      expect(totals.byMeal.dinner.total.calories).toBe(0);
    });

    it('totals a partially reported nutrient from what was reported', () => {
      const totals = dayTotals(USER, asLocalDay('2026-06-15'), db);
      // Apple reports fibre (4.8 + 2.4); milk does not. The day is 7.2, not
      // "unknown", and not 7.2 pretending milk contributed zero.
      expect(totals.total.fiber_g).toBeCloseTo(7.2, 5);
    });

    it('reports null for a nutrient nobody reported', () => {
      const empty = createTestDatabase();
      migrate(empty);
      createFoodLog(
        {
          userId: USER,
          meal: 'lunch',
          food: {
            foodId: 'food-milk',
            name: 'Milk',
            brandName: null,
            sourceId: 'usda',
            isVerified: true,
            baseUnit: 'ml',
            baseAmount: 100,
          },
          nutrition: MILK,
          quantity: 250,
          serving: null,
          timeZone: ZURICH,
          at: MORNING,
        },
        empty,
      );

      expect(dayTotals(USER, asLocalDay('2026-06-15'), empty).total.fiber_g).toBeNull();
      empty.close();
    });

    it('is zero, not null, for a day with nothing in it', () => {
      const totals = dayTotals(USER, asLocalDay('2026-06-14'), db);

      expect(totals.entryCount).toBe(0);
      expect(totals.total.calories).toBe(0);
      expect(totals.total.fiber_g).toBeNull();
    });

    it('excludes deleted entries from every total', () => {
      const [first] = listDay(USER, asLocalDay('2026-06-15'), db);
      deleteFoodLog(first!.id, db, MORNING + 10_000);

      const totals = dayTotals(USER, asLocalDay('2026-06-15'), db);
      expect(totals.entryCount).toBe(2);
      expect(totals.total.calories).toBeCloseTo(157, 5);
    });

    it('never counts another user toward this one', () => {
      createFoodLog(
        {
          userId: 'user-bob',
          meal: 'dinner',
          food: {
            foodId: 'food-apple',
            name: 'Apple, raw',
            brandName: null,
            sourceId: 'usda',
            isVerified: true,
            baseUnit: 'g',
            baseAmount: 100,
          },
          nutrition: APPLE,
          quantity: 1000,
          serving: null,
          timeZone: ZURICH,
          at: MORNING,
        },
        db,
      );

      expect(dayTotals(USER, asLocalDay('2026-06-15'), db).total.calories).toBeCloseTo(
        261,
        5,
      );
    });

    it('rolls a range up by day, and reports only days that have entries', () => {
      log(db, { at: MORNING, diaryDate: asLocalDay('2026-06-13'), quantity: 100 });

      const range = rangeTotals(
        USER,
        asLocalDay('2026-06-10'),
        asLocalDay('2026-06-16'),
        db,
      );

      expect(range.map((day) => day.day)).toEqual(['2026-06-13', '2026-06-15']);
      expect(range[0]!.total.calories).toBeCloseTo(52, 5);
      expect(range[1]!.entryCount).toBe(3);
    });
  });

  describe('frequent foods', () => {
    it('counts what was actually logged, inside the window', () => {
      const today = asLocalDay('2026-06-15');

      // Oats three times recently, apple once, and a food eaten daily long ago.
      for (const day of ['2026-06-15', '2026-06-14', '2026-06-13']) {
        log(db, {
          at: MORNING,
          diaryDate: asLocalDay(day),
          food: {
            foodId: 'food-oats',
            name: 'Rolled Oats',
            brandName: null,
            sourceId: 'usda',
            isVerified: true,
            baseUnit: 'g',
            baseAmount: 100,
          },
          nutrition: APPLE,
          quantity: 50,
        });
      }
      log(db, { at: MORNING, diaryDate: asLocalDay('2026-06-12') });

      for (const day of ['2025-01-01', '2025-01-02', '2025-01-03', '2025-01-04']) {
        log(db, {
          at: MORNING,
          diaryDate: asLocalDay(day),
          food: {
            foodId: 'food-old',
            name: 'A former habit',
            brandName: null,
            sourceId: 'usda',
            isVerified: true,
            baseUnit: 'g',
            baseAmount: 100,
          },
          nutrition: APPLE,
          quantity: 50,
        });
      }

      const frequent = frequentFoods(USER, { today, timeZone: ZURICH }, db);

      expect(frequent.map((food) => food.foodId)).toEqual(['food-oats', 'food-apple']);
      expect(frequent[0]!).toMatchObject({
        name: 'Rolled Oats',
        logCount: 3,
        lastLoggedOn: '2026-06-15',
      });
      // The all-time tally would have put "A former habit" at the top with 4.
      expect(frequent.some((food) => food.foodId === 'food-old')).toBe(false);
    });

    it('ignores deleted entries', () => {
      const row = log(db, { at: MORNING });
      deleteFoodLog(row.id, db, MORNING + 1000);

      expect(
        frequentFoods(USER, { today: asLocalDay('2026-06-15'), timeZone: ZURICH }, db),
      ).toEqual([]);
    });

    it('reports the name from the latest entry, not the alphabetical one', () => {
      log(db, { at: MORNING, diaryDate: asLocalDay('2026-06-10') });
      const latest = createFoodLog(
        {
          userId: USER,
          meal: 'lunch',
          food: {
            foodId: 'food-apple',
            name: 'Zzz apple, revised label',
            brandName: 'Later brand',
            sourceId: 'usda',
            isVerified: true,
            baseUnit: 'g',
            baseAmount: 100,
          },
          nutrition: APPLE,
          quantity: 100,
          serving: null,
          timeZone: ZURICH,
          at: MORNING,
        },
        db,
      );

      const [frequent] = frequentFoods(
        USER,
        { today: asLocalDay('2026-06-15'), timeZone: ZURICH },
        db,
      );

      expect(frequent!.name).toBe('Zzz apple, revised label');
      expect(frequent!.lastLogId).toBe(latest.id);
      expect(frequent!.logCount).toBe(2);
    });
  });

  describe('logging something again', () => {
    it('copies the snapshot rather than looking the food up', () => {
      const original = log(db, { at: MORNING, quantity: 200 });

      const repeat = repeatFoodLog(
        original.id,
        { diaryDate: asLocalDay('2026-06-16'), meal: 'dinner' },
        db,
      );

      expect(repeat.id).not.toBe(original.id);
      expect(repeat.diary_date).toBe('2026-06-16');
      expect(repeat.meal).toBe('dinner');
      expect(repeat.basis_calories).toBe(52);
      expect(repeat.calories).toBe(104);
      expect(repeat.food_name).toBe('Apple, raw');
    });

    it('carries the portion, not just the amount', () => {
      const original = log(db, {
        at: MORNING,
        quantity: 2,
        serving: { label: '1 slice', amount: 30, unit: 'g' },
      });

      const repeat = repeatFoodLog(original.id, {}, db);

      expect(repeat.serving_label).toBe('1 slice');
      expect(repeat.serving_amount).toBe(30);
      expect(repeat.amount_in_base).toBe(60);
    });

    it('leaves the original alone when the copy is edited', () => {
      const original = log(db, { at: MORNING, quantity: 200 });
      const repeat = repeatFoodLog(original.id, {}, db);

      editFoodLog(repeat.id, { quantity: 500 }, db);

      const stored = db.get<{ quantity: number; calories: number }>(
        'SELECT quantity, calories FROM food_logs WHERE id = ?',
        [original.id],
      );
      expect(stored).toEqual({ quantity: 200, calories: 104 });
    });
  });
});
