import { getDatabase } from '../client';
import type { FoodLogRow, MealSlot } from '../schema';
import type { SqlDatabase } from '../types';
import {
  asLocalDay,
  addDays,
  localDayFor,
  middayOfLocalDay,
  type LocalDay,
} from '@/lib/date';
import { newId } from '@/lib/id';
import {
  resolveQuantity,
  scaleNutrition,
  type BaseUnit,
  type NutritionPerBase,
  type ScaledNutrition,
  type Serving,
} from '@/lib/nutrition';
import { withOutbox } from '@/sync/outbox';

/**
 * The food diary.
 *
 * Every entry carries its own copy of the food's nutrition, frozen at the
 * moment of logging. Reads never join the catalogue, and the arithmetic never
 * consults it — which is the whole point: correcting a food tomorrow must not
 * rewrite what somebody ate last year.
 *
 * Two invariants are enforced here and again in Postgres, deliberately:
 *
 *   • the totals are derived from the entry's own basis, never from a food;
 *   • the diary day is the local day of the entry's instant, in the zone the
 *     entry was made in.
 *
 * Duplicating them is not redundancy for its own sake. The local copy is what
 * makes the app correct offline, where there is no server to appeal to; the
 * server copy is what makes it correct against any client, including an old
 * build of this one still installed on somebody's phone.
 */

/** The identity a log snapshots. Everything here is copied, not referenced. */
export interface LoggedFood {
  /** The catalogue row, when there is one. Provenance only. */
  readonly foodId: string | null;
  readonly name: string;
  readonly brandName: string | null;
  readonly sourceId: string;
  readonly isVerified: boolean;
  readonly baseUnit: BaseUnit;
  readonly baseAmount: number;
}

export interface LogFoodInput {
  readonly userId: string;
  readonly meal: MealSlot;
  readonly food: LoggedFood;
  /** Per `food.baseAmount` of `food.baseUnit`. Snapshotted as the basis. */
  readonly nutrition: NutritionPerBase;
  readonly quantity: number;
  /** The chosen portion, or null to log raw base units. */
  readonly serving: Serving | null;
  /** The catalogue serving row, when the portion came from one. */
  readonly servingId?: string | null;
  readonly timeZone: string;
  /** The day to log onto. Defaults to the day `at` falls on. */
  readonly diaryDate?: LocalDay;
  /** Epoch ms. Defaults to now. */
  readonly at?: number;
  readonly note?: string | null;
}

export function createFoodLog(
  input: LogFoodInput,
  db: SqlDatabase = getDatabase(),
): FoodLogRow {
  const now = input.at ?? Date.now();
  const { loggedAt, diaryDate } = resolveInstant(
    now,
    input.timeZone,
    input.diaryDate ?? null,
  );

  const resolved = resolveQuantity(
    { baseUnit: input.food.baseUnit, baseAmount: input.food.baseAmount },
    input.quantity,
    input.serving,
  );
  const scaled = scaleNutrition(
    input.nutrition,
    { baseUnit: input.food.baseUnit, baseAmount: input.food.baseAmount },
    resolved,
  );

  const row: FoodLogRow = {
    id: newId(),
    user_id: input.userId,
    food_id: input.food.foodId,
    serving_id: input.servingId ?? null,
    meal: input.meal,

    logged_at: loggedAt,
    time_zone: input.timeZone,
    diary_date: diaryDate,

    quantity: input.quantity,
    // A raw base-unit quantity is the same shape with a portion of one, so
    // there is exactly one code path from here on.
    serving_label: input.serving?.label ?? input.food.baseUnit,
    serving_amount: input.serving?.amount ?? 1,
    amount_in_base: resolved.amountInBase,

    food_name: input.food.name,
    brand_name: input.food.brandName,
    food_source_id: input.food.sourceId,
    food_is_verified: input.food.isVerified ? 1 : 0,

    basis_unit: input.food.baseUnit,
    basis_amount: input.food.baseAmount,
    basis_calories: input.nutrition.calories,
    basis_protein_g: input.nutrition.protein_g,
    basis_carbohydrates_g: input.nutrition.carbohydrates_g,
    basis_fat_g: input.nutrition.fat_g,
    basis_fiber_g: input.nutrition.fiber_g,
    basis_sugar_g: input.nutrition.sugar_g,
    basis_saturated_fat_g: input.nutrition.saturated_fat_g,
    basis_sodium_mg: input.nutrition.sodium_mg,

    calories: scaled.calories,
    protein_g: scaled.protein_g,
    carbohydrates_g: scaled.carbohydrates_g,
    fat_g: scaled.fat_g,
    fiber_g: scaled.fiber_g,
    sugar_g: scaled.sugar_g,
    saturated_fat_g: scaled.saturated_fat_g,
    sodium_mg: scaled.sodium_mg,

    note: input.note ?? null,
    created_at: now,
    updated_at: now,
    server_updated_at: null,
    deleted_at: null,
  };

  withOutbox(db, { table: 'food_logs', rowId: row.id, operation: 'upsert' }, () => {
    insertRow(db, row);
  });

  return row;
}

/**
 * What an edit may change.
 *
 * Conspicuously absent: the food, its name, and its nutrition. Those are the
 * snapshot, and a Postgres trigger refuses to move them — an edit changes how
 * much was eaten, not what it contained.
 */
export interface EditFoodLogInput {
  readonly quantity?: number;
  /** Pass `null` to switch back to raw base units. */
  readonly serving?: Serving | null;
  readonly servingId?: string | null;
  readonly meal?: MealSlot;
  readonly note?: string | null;
  /** Moves the entry to another day; its instant moves with it. */
  readonly diaryDate?: LocalDay;
  /** Only for an entry being re-dated; defaults to the entry's own zone. */
  readonly timeZone?: string;
  /** Epoch ms, for tests. */
  readonly at?: number;
}

/**
 * Edits an entry, re-deriving its totals from the basis it was WRITTEN with.
 *
 * This is the difference that matters. A food logged at 52 kcal/100 g and
 * later corrected to 60 still scales at 52: changing 200 g to 300 g gives
 * 156 kcal, not 180. The corrected figure applies to what you log from now
 * on, not to what you already ate.
 */
export function editFoodLog(
  id: string,
  patch: EditFoodLogInput,
  db: SqlDatabase = getDatabase(),
): FoodLogRow {
  const existing = db.get<FoodLogRow>('SELECT * FROM food_logs WHERE id = ?', [id]);
  if (!existing) {
    throw new Error(`Cannot edit food log ${id}: it does not exist`);
  }

  const now = patch.at ?? Date.now();
  const basis: NutritionPerBase = basisOf(existing);
  const foodBasis = { baseUnit: existing.basis_unit, baseAmount: existing.basis_amount };

  const serving: Serving | null =
    patch.serving !== undefined
      ? patch.serving
      : servingOf(existing);

  const quantity = patch.quantity ?? existing.quantity;
  const resolved = resolveQuantity(foodBasis, quantity, serving);
  const scaled = scaleNutrition(basis, foodBasis, resolved);

  const timeZone = patch.timeZone ?? existing.time_zone;
  const { loggedAt, diaryDate } =
    patch.diaryDate || patch.timeZone
      ? resolveInstant(existing.logged_at, timeZone, patch.diaryDate ?? null)
      : { loggedAt: existing.logged_at, diaryDate: existing.diary_date };

  const next: FoodLogRow = {
    ...existing,
    meal: patch.meal ?? existing.meal,
    note: patch.note !== undefined ? patch.note : existing.note,
    serving_id: patch.servingId !== undefined ? patch.servingId : existing.serving_id,

    logged_at: loggedAt,
    time_zone: timeZone,
    diary_date: diaryDate,

    quantity,
    serving_label: serving?.label ?? existing.basis_unit,
    serving_amount: serving?.amount ?? 1,
    amount_in_base: resolved.amountInBase,

    calories: scaled.calories,
    protein_g: scaled.protein_g,
    carbohydrates_g: scaled.carbohydrates_g,
    fat_g: scaled.fat_g,
    fiber_g: scaled.fiber_g,
    sugar_g: scaled.sugar_g,
    saturated_fat_g: scaled.saturated_fat_g,
    sodium_mg: scaled.sodium_mg,

    updated_at: now,
  };

  withOutbox(db, { table: 'food_logs', rowId: id, operation: 'upsert' }, () => {
    db.run(
      `UPDATE food_logs SET
         meal = ?, note = ?, serving_id = ?,
         logged_at = ?, time_zone = ?, diary_date = ?,
         quantity = ?, serving_label = ?, serving_amount = ?, amount_in_base = ?,
         calories = ?, protein_g = ?, carbohydrates_g = ?, fat_g = ?,
         fiber_g = ?, sugar_g = ?, saturated_fat_g = ?, sodium_mg = ?,
         updated_at = ?
       WHERE id = ?`,
      [
        next.meal, next.note, next.serving_id,
        next.logged_at, next.time_zone, next.diary_date,
        next.quantity, next.serving_label, next.serving_amount, next.amount_in_base,
        next.calories, next.protein_g, next.carbohydrates_g, next.fat_g,
        next.fiber_g, next.sugar_g, next.saturated_fat_g, next.sodium_mg,
        next.updated_at, id,
      ],
    );
  });

  return next;
}

/**
 * Removes an entry.
 *
 * Soft, always. A hard delete cannot be synchronised: the other device would
 * have nothing to learn from, and its own copy would push the row straight
 * back. Deletion is a fact that has to travel, so it is recorded as one.
 *
 * The row disappears from the diary immediately — before the network is
 * consulted, and whether or not there is a network — because `listDay` and
 * every total filter on `deleted_at IS NULL`.
 */
export function deleteFoodLog(
  id: string,
  db: SqlDatabase = getDatabase(),
  at: number = Date.now(),
): void {
  withOutbox(db, { table: 'food_logs', rowId: id, operation: 'delete' }, () => {
    db.run('UPDATE food_logs SET deleted_at = ?, updated_at = ? WHERE id = ?', [
      at,
      at,
      id,
    ]);
  });
}

/* ------------------------------------------------------------------ reads */

/** One day's entries, in the order the day happened. */
export function listDay(
  userId: string,
  day: LocalDay,
  db: SqlDatabase = getDatabase(),
): FoodLogRow[] {
  return db.all<FoodLogRow>(
    `SELECT * FROM food_logs
      WHERE user_id = ? AND diary_date = ? AND deleted_at IS NULL
      ORDER BY CASE meal
                 WHEN 'breakfast' THEN 0
                 WHEN 'lunch'     THEN 1
                 WHEN 'dinner'    THEN 2
                 ELSE 3
               END,
               logged_at,
               id`,
    [userId, day],
  );
}

export function getFoodLog(
  id: string,
  db: SqlDatabase = getDatabase(),
): FoodLogRow | undefined {
  return db.get<FoodLogRow>(
    'SELECT * FROM food_logs WHERE id = ? AND deleted_at IS NULL',
    [id],
  );
}

export interface DayTotals {
  readonly day: LocalDay;
  readonly entryCount: number;
  readonly total: ScaledNutrition;
  readonly byMeal: Readonly<Record<MealSlot, { entryCount: number; total: ScaledNutrition }>>;
}

/**
 * A day's totals, summed by SQLite rather than in JavaScript.
 *
 * The aggregate runs against the covering index, so a day costs the same
 * whether the device holds a week of history or a decade. Summing in JS would
 * mean reading every row of the day into memory first, which is affordable for
 * one day and not for the ranges the dashboard will want next.
 *
 * `SUM` over a column where every contributing row is null returns null, which
 * is exactly right: a nutrient nobody reported has no total, and reporting one
 * as zero would understate the day while looking precise.
 */
export function dayTotals(
  userId: string,
  day: LocalDay,
  db: SqlDatabase = getDatabase(),
): DayTotals {
  const rows = db.all<{ meal: MealSlot } & Record<string, number | null>>(
    `SELECT meal,
            COUNT(*)              AS entry_count,
            SUM(calories)         AS calories,
            SUM(protein_g)        AS protein_g,
            SUM(carbohydrates_g)  AS carbohydrates_g,
            SUM(fat_g)            AS fat_g,
            SUM(fiber_g)          AS fiber_g,
            SUM(sugar_g)          AS sugar_g,
            SUM(saturated_fat_g)  AS saturated_fat_g,
            SUM(sodium_mg)        AS sodium_mg
       FROM food_logs
      WHERE user_id = ? AND diary_date = ? AND deleted_at IS NULL
      GROUP BY meal`,
    [userId, day],
  );

  const byMeal = {
    breakfast: emptyMealTotal(),
    lunch: emptyMealTotal(),
    dinner: emptyMealTotal(),
    snack: emptyMealTotal(),
  };

  for (const row of rows) {
    byMeal[row.meal] = {
      entryCount: Number(row.entry_count ?? 0),
      total: nutritionFromAggregate(row),
    };
  }

  const meals = Object.values(byMeal);

  return {
    day,
    entryCount: meals.reduce((count, meal) => count + meal.entryCount, 0),
    total: addAcross(meals.map((meal) => meal.total)),
    byMeal,
  };
}

/**
 * Day totals across a range, for streaks, charts and the dashboard.
 *
 * Only days with entries appear. A caller wanting a dense series fills the
 * gaps itself, because "no entries" and "zero calories" are different claims
 * and the store should not decide which one a chart is making.
 */
export function rangeTotals(
  userId: string,
  from: LocalDay,
  to: LocalDay,
  db: SqlDatabase = getDatabase(),
): { day: LocalDay; entryCount: number; total: ScaledNutrition }[] {
  const rows = db.all<{ diary_date: string } & Record<string, number | null>>(
    `SELECT diary_date,
            COUNT(*)             AS entry_count,
            SUM(calories)        AS calories,
            SUM(protein_g)       AS protein_g,
            SUM(carbohydrates_g) AS carbohydrates_g,
            SUM(fat_g)           AS fat_g,
            SUM(fiber_g)         AS fiber_g,
            SUM(sugar_g)         AS sugar_g,
            SUM(saturated_fat_g) AS saturated_fat_g,
            SUM(sodium_mg)       AS sodium_mg
       FROM food_logs
      WHERE user_id = ? AND diary_date BETWEEN ? AND ? AND deleted_at IS NULL
      GROUP BY diary_date
      ORDER BY diary_date`,
    [userId, from, to],
  );

  return rows.map((row) => ({
    day: asLocalDay(row.diary_date),
    entryCount: Number(row.entry_count ?? 0),
    total: nutritionFromAggregate(row),
  }));
}

/** How far back "frequently" looks. Long enough to be stable, short enough to
 * follow a change of diet rather than a change of decade. */
export const FREQUENT_WINDOW_DAYS = 90;

export interface FrequentFood {
  readonly foodId: string;
  readonly name: string;
  readonly brandName: string | null;
  readonly logCount: number;
  readonly lastLoggedOn: LocalDay;
  /** The most recent entry for this food, so it can be logged again as-is. */
  readonly lastLogId: string;
}

/**
 * The foods this user actually logs, over a recent window.
 *
 * This is the real answer to "frequent", and it only became possible with the
 * diary: `food_recents.use_count` is an all-time tally that never forgets, so
 * a food eaten daily two years ago outranks one eaten daily this month. A
 * count over the last 90 days follows the person.
 *
 * Runs locally against the covering index, so it works offline and costs
 * nothing on the server. It reads the *snapshot* name, which means a food
 * deleted from the catalogue still shows up correctly.
 */
export function frequentFoods(
  userId: string,
  options: { limit?: number; days?: number; today?: LocalDay; timeZone?: string } = {},
  db: SqlDatabase = getDatabase(),
): FrequentFood[] {
  const today =
    options.today ??
    localDayFor(new Date(), options.timeZone ?? 'UTC');
  const since = addDays(today, -(options.days ?? FREQUENT_WINDOW_DAYS));

  /*
   * The bare columns — name, brand, day, id — are taken from the row that
   * `MAX(logged_at)` matched. That is a documented SQLite guarantee for a
   * query with exactly one min/max aggregate, and it is what makes this the
   * *latest* name rather than the alphabetically largest one. Adding a second
   * aggregate over those columns would silently break it, so there is only
   * the one.
   */
  const rows = db.all<{
    food_id: string;
    food_name: string;
    brand_name: string | null;
    log_count: number;
    last_logged_on: string;
    last_log_id: string;
  }>(
    `SELECT food_id,
            COUNT(*)        AS log_count,
            MAX(logged_at)  AS last_logged_at,
            diary_date      AS last_logged_on,
            food_name,
            brand_name,
            id              AS last_log_id
       FROM food_logs
      WHERE user_id = ?
        AND deleted_at IS NULL
        AND food_id IS NOT NULL
        AND diary_date >= ?
      GROUP BY food_id
      ORDER BY log_count DESC, last_logged_at DESC, food_id
      LIMIT ?`,
    [userId, since, options.limit ?? 20],
  );

  return rows.map((row) => ({
    foodId: row.food_id,
    name: row.food_name,
    brandName: row.brand_name,
    logCount: Number(row.log_count),
    lastLoggedOn: asLocalDay(row.last_logged_on),
    lastLogId: row.last_log_id,
  }));
}

/**
 * Logs a previous entry again.
 *
 * Copies the snapshot rather than looking the food up, which means it works
 * offline, works for a food that has since been deleted, and — deliberately —
 * repeats the nutrition that entry was written with. That last one is a real
 * choice: someone repeating yesterday's breakfast is saying "the same thing
 * again", and pulling today's possibly-corrected figures would quietly make
 * the two days incomparable.
 *
 * The new entry is independent from the moment it exists; editing or deleting
 * either leaves the other alone.
 */
export function repeatFoodLog(
  sourceId: string,
  target: { meal?: MealSlot; diaryDate?: LocalDay; timeZone?: string; at?: number },
  db: SqlDatabase = getDatabase(),
): FoodLogRow {
  const source = db.get<FoodLogRow>('SELECT * FROM food_logs WHERE id = ?', [sourceId]);
  if (!source) {
    throw new Error(`Cannot repeat food log ${sourceId}: it does not exist`);
  }

  return createFoodLog(
    {
      userId: source.user_id,
      meal: target.meal ?? source.meal,
      food: {
        foodId: source.food_id,
        name: source.food_name,
        brandName: source.brand_name,
        sourceId: source.food_source_id,
        isVerified: source.food_is_verified === 1,
        baseUnit: source.basis_unit,
        baseAmount: source.basis_amount,
      },
      nutrition: basisOf(source),
      quantity: source.quantity,
      serving: servingOf(source),
      servingId: source.serving_id,
      timeZone: target.timeZone ?? source.time_zone,
      diaryDate: target.diaryDate,
      at: target.at,
    },
    db,
  );
}

/* --------------------------------------------------------------- internals */

/**
 * Settles the instant and the day so they agree.
 *
 * Given a day, the instant moves onto it; given no day, the day follows the
 * instant. Either way the stored pair satisfies the same invariant Postgres
 * checks on the way in, so a mismatch is caught here — with a useful message —
 * rather than as a constraint violation during a background sync.
 */
function resolveInstant(
  at: number,
  timeZone: string,
  requestedDay: LocalDay | null,
): { loggedAt: number; diaryDate: LocalDay } {
  const naturalDay = localDayFor(new Date(at), timeZone);

  if (!requestedDay || requestedDay === naturalDay) {
    return { loggedAt: at, diaryDate: naturalDay };
  }

  const moved = middayOfLocalDay(requestedDay, timeZone);
  const settledDay = localDayFor(moved, timeZone);

  if (settledDay !== requestedDay) {
    throw new Error(
      `Could not place a diary entry on ${requestedDay} in ${timeZone}: ` +
        `midday there resolves to ${settledDay}.`,
    );
  }

  return { loggedAt: moved.getTime(), diaryDate: requestedDay };
}

function basisOf(row: FoodLogRow): NutritionPerBase {
  return {
    calories: row.basis_calories,
    protein_g: row.basis_protein_g,
    carbohydrates_g: row.basis_carbohydrates_g,
    fat_g: row.basis_fat_g,
    fiber_g: row.basis_fiber_g,
    sugar_g: row.basis_sugar_g,
    saturated_fat_g: row.basis_saturated_fat_g,
    sodium_mg: row.basis_sodium_mg,
  };
}

/**
 * The portion an entry was logged with.
 *
 * A `serving_amount` of exactly 1 with the base unit as its label is how a raw
 * quantity is stored, and it round-trips to `null` so an edit that does not
 * mention the serving keeps logging raw base units.
 */
function servingOf(row: FoodLogRow): Serving | null {
  if (row.serving_amount === 1 && row.serving_label === row.basis_unit) return null;
  return {
    id: row.serving_id ?? undefined,
    label: row.serving_label,
    amount: row.serving_amount,
    unit: row.basis_unit,
  };
}

function insertRow(db: SqlDatabase, row: FoodLogRow): void {
  const columns = Object.keys(row);
  db.run(
    `INSERT INTO food_logs (${columns.join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((column) => (row as unknown as Record<string, unknown>)[column] ?? null),
  );
}

function emptyMealTotal(): { entryCount: number; total: ScaledNutrition } {
  return { entryCount: 0, total: zeroNutrition() };
}

function zeroNutrition(): ScaledNutrition {
  return {
    calories: 0,
    protein_g: 0,
    carbohydrates_g: 0,
    fat_g: 0,
    fiber_g: null,
    sugar_g: null,
    saturated_fat_g: null,
    sodium_mg: null,
  };
}

function nutritionFromAggregate(row: Record<string, number | null>): ScaledNutrition {
  return {
    calories: Number(row.calories ?? 0),
    protein_g: Number(row.protein_g ?? 0),
    carbohydrates_g: Number(row.carbohydrates_g ?? 0),
    fat_g: Number(row.fat_g ?? 0),
    fiber_g: row.fiber_g === null || row.fiber_g === undefined ? null : Number(row.fiber_g),
    sugar_g: row.sugar_g === null || row.sugar_g === undefined ? null : Number(row.sugar_g),
    saturated_fat_g:
      row.saturated_fat_g === null || row.saturated_fat_g === undefined
        ? null
        : Number(row.saturated_fat_g),
    sodium_mg:
      row.sodium_mg === null || row.sodium_mg === undefined ? null : Number(row.sodium_mg),
  };
}

/**
 * Adds per-meal totals into a day total.
 *
 * Not `sumNutrition`: that treats an all-null nutrient as unreported, and here
 * the inputs are already aggregates in which an empty meal contributes a
 * legitimate null. The distinction survives — a day is null for fibre only
 * when no meal reported any.
 */
function addAcross(totals: readonly ScaledNutrition[]): ScaledNutrition {
  const optional = (
    key: 'fiber_g' | 'sugar_g' | 'saturated_fat_g' | 'sodium_mg',
  ): number | null => {
    const reported = totals.filter((total) => total[key] !== null);
    if (reported.length === 0) return null;
    return reported.reduce((sum, total) => sum + (total[key] ?? 0), 0);
  };

  return {
    calories: totals.reduce((sum, total) => sum + total.calories, 0),
    protein_g: totals.reduce((sum, total) => sum + total.protein_g, 0),
    carbohydrates_g: totals.reduce((sum, total) => sum + total.carbohydrates_g, 0),
    fat_g: totals.reduce((sum, total) => sum + total.fat_g, 0),
    fiber_g: optional('fiber_g'),
    sugar_g: optional('sugar_g'),
    saturated_fat_g: optional('saturated_fat_g'),
    sodium_mg: optional('sodium_mg'),
  };
}
