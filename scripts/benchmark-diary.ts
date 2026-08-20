/**
 * Diary aggregation benchmark.
 *
 * The day view's totals are computed on the device, by SQLite, from entries
 * the device already holds. That makes the interactive cost a local one, and
 * this measures it against the real migrations and the real repository — not a
 * hand-written approximation of them.
 *
 * Usage:
 *   npx tsx --tsconfig scripts/tsconfig.bench.json scripts/benchmark-diary.ts
 */

import Database from 'better-sqlite3';

import { migrate } from '../src/db/migrator';
import {
  createFoodLog,
  dayTotals,
  frequentFoods,
  listDay,
  rangeTotals,
} from '../src/db/repositories/foodLogs';
import type { SqlDatabase } from '../src/db/types';
import { addDays, asLocalDay, type LocalDay } from '../src/lib/date';
import type { MealSlot } from '../src/db/schema';

const USER = '11111111-1111-4111-8111-111111111111';
const ZONE = 'Europe/Zurich';
const TODAY = asLocalDay('2026-06-15');
const MEALS: MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack'];

/** Entry counts to measure. The last is several years of real logging. */
const SIZES = [100, 1_000, 10_000];

function openDatabase(): SqlDatabase & { close: () => void } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return {
    exec: (sql) => {
      db.exec(sql);
    },
    run: (sql, params = []) => {
      db.prepare(sql).run(...(params as unknown[]));
    },
    all: <T>(sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).all(...(params as unknown[])) as T[],
    get: <T>(sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).get(...(params as unknown[])) as T | undefined,
    transaction: (fn) => {
      db.transaction(fn)();
    },
    close: () => db.close(),
  };
}

/**
 * Fills a diary with `count` entries spread over as many days as a real one
 * would be — roughly five a day, which is what the index has to cope with.
 * Every entry is clearly synthetic; no nutrition is invented for a real food.
 */
function seed(db: SqlDatabase, count: number): void {
  const days = Math.max(1, Math.ceil(count / 5));

  db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const day: LocalDay = addDays(TODAY, -Math.floor(index / 5));
      createFoodLog(
        {
          userId: USER,
          meal: MEALS[index % MEALS.length]!,
          food: {
            foodId: `bench-food-${index % 300}`,
            name: `Benchmark food ${index % 300}`,
            brandName: index % 3 === 0 ? `Benchmark brand ${index % 40}` : null,
            sourceId: 'usda',
            isVerified: true,
            baseUnit: 'g',
            baseAmount: 100,
          },
          nutrition: {
            calories: 50 + (index % 300),
            protein_g: index % 25,
            carbohydrates_g: index % 60,
            fat_g: index % 15,
            fiber_g: index % 4 === 0 ? null : index % 8,
            sugar_g: index % 20,
            saturated_fat_g: index % 5,
            sodium_mg: index % 400,
          },
          quantity: 50 + (index % 200),
          serving: null,
          timeZone: ZONE,
          diaryDate: day,
        },
        db,
      );
    }

    // The outbox is drained by sync in the app; leaving thousands of entries
    // in it would measure something the diary screen never touches.
    db.run('DELETE FROM sync_outbox');
  });

  void days;
}

function time(label: string, iterations: number, run: () => void): void {
  // One warm pass so the measurement is of the query, not of statement
  // preparation.
  run();

  const started = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) run();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  console.log(`   ${label.padEnd(34)} ${(elapsedMs / iterations).toFixed(3)} ms`);
}

for (const size of SIZES) {
  const db = openDatabase();
  migrate(db);

  const seedStarted = process.hrtime.bigint();
  seed(db, size);
  const seedMs = Number(process.hrtime.bigint() - seedStarted) / 1e6;

  const rows =
    db.get<{ count: number }>('SELECT COUNT(*) AS count FROM food_logs')?.count ?? 0;

  console.log(
    `\n── ${size.toLocaleString()} entries  (seeded in ${seedMs.toFixed(0)} ms, ${rows} rows)`,
  );

  time("one day's entries", 200, () => {
    listDay(USER, TODAY, db);
  });
  time("one day's totals, by meal", 200, () => {
    dayTotals(USER, TODAY, db);
  });
  time('30-day rollup', 100, () => {
    rangeTotals(USER, addDays(TODAY, -29), TODAY, db);
  });
  time('365-day rollup', 50, () => {
    rangeTotals(USER, addDays(TODAY, -364), TODAY, db);
  });
  time('frequent foods (90-day window)', 50, () => {
    frequentFoods(USER, { today: TODAY, timeZone: ZONE }, db);
  });

  db.close();
}

console.log('');
