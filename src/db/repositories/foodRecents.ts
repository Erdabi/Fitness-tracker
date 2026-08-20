import { getDatabase } from '../client';
import type { FoodCacheRow, FoodCacheServingRow, FoodRecentRow } from '../schema';
import type { SqlDatabase } from '../types';
import type { FoodSearchResult } from '@/features/food/types';
import type { Serving } from '@/lib/nutrition';
import { newId } from '@/lib/id';
import { withOutbox } from '@/sync/outbox';

/**
 * Recently used foods, and the local cache that makes them usable offline.
 *
 * Two different kinds of data live here and are treated differently:
 *
 *   • `food_recents` is USER-OWNED. It syncs, it goes through the outbox, and
 *     it survives a reinstall via the server.
 *   • `food_cache` is a local COPY OF SERVER DATA. It never syncs and never
 *     pushes; it exists only so a recent food can be rendered and logged
 *     without a connection. It is safe to clear at any moment.
 *
 * Recording a use must never touch the shared catalogue.
 */

/**
 * How many cached foods to keep.
 *
 * Bounded on purpose: the global catalogue stays on the server, and an
 * unbounded cache would drift toward being a partial copy of it. A few hundred
 * covers everything a person actually eats.
 */
export const FOOD_CACHE_LIMIT = 500;

/** How many recents to show. Beyond this the list stops being a shortcut. */
export const RECENT_LIMIT = 50;

/* ------------------------------------------------------------------ cache */

/**
 * Stores a food locally so it can be shown and logged offline.
 *
 * Called when a user picks a food, not when they merely see it in results —
 * caching every search result would fill the device with foods nobody chose.
 */
export function cacheFood(
  result: FoodSearchResult,
  servings: readonly Serving[],
  db: SqlDatabase = getDatabase(),
): void {
  const now = Date.now();

  db.transaction(() => {
    db.run(
      `INSERT INTO food_cache
         (food_id, name, brand_name, source_id, is_verified, is_own,
          base_unit, base_amount, calories, protein_g, carbohydrates_g, fat_g,
          cached_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(food_id) DO UPDATE SET
         name = excluded.name,
         brand_name = excluded.brand_name,
         source_id = excluded.source_id,
         is_verified = excluded.is_verified,
         is_own = excluded.is_own,
         base_unit = excluded.base_unit,
         base_amount = excluded.base_amount,
         calories = excluded.calories,
         protein_g = excluded.protein_g,
         carbohydrates_g = excluded.carbohydrates_g,
         fat_g = excluded.fat_g,
         cached_at = excluded.cached_at`,
      [
        result.foodId,
        result.name,
        result.brandName,
        result.sourceId,
        result.isVerified ? 1 : 0,
        result.isOwn ? 1 : 0,
        result.baseUnit,
        result.baseAmount,
        result.calories,
        result.protein_g,
        result.carbohydrates_g,
        result.fat_g,
        now,
      ],
    );

    // Replace the servings wholesale: a food's portions may have changed
    // server-side, and a stale one would offer a portion that no longer exists.
    db.run('DELETE FROM food_cache_servings WHERE food_id = ?', [result.foodId]);

    servings.forEach((serving, index) => {
      db.run(
        `INSERT INTO food_cache_servings
           (id, food_id, label, amount, unit, is_default, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(),
          result.foodId,
          serving.label,
          serving.amount,
          serving.unit,
          index === 0 ? 1 : 0,
          index,
        ],
      );
    });

    trimCache(db);
  });
}

/** Evicts the least recently touched entries beyond the limit. */
function trimCache(db: SqlDatabase): void {
  db.run(
    `DELETE FROM food_cache
      WHERE food_id IN (
        SELECT food_id FROM food_cache
         ORDER BY cached_at DESC
         LIMIT -1 OFFSET ?
      )`,
    [FOOD_CACHE_LIMIT],
  );
}

export function getCachedFood(
  foodId: string,
  db: SqlDatabase = getDatabase(),
): FoodCacheRow | undefined {
  return db.get<FoodCacheRow>('SELECT * FROM food_cache WHERE food_id = ?', [foodId]);
}

export function getCachedServings(
  foodId: string,
  db: SqlDatabase = getDatabase(),
): FoodCacheServingRow[] {
  return db.all<FoodCacheServingRow>(
    'SELECT * FROM food_cache_servings WHERE food_id = ? ORDER BY sort_order',
    [foodId],
  );
}

export function countCachedFoods(db: SqlDatabase = getDatabase()): number {
  return db.get<{ count: number }>('SELECT COUNT(*) AS count FROM food_cache')?.count ?? 0;
}

/* ---------------------------------------------------------------- recents */

/**
 * Records that a food was used.
 *
 * A repeat use is an UPDATE, never a second row — that is what keeps the list
 * free of duplicates, and it is enforced by a unique index rather than left to
 * the caller to remember.
 */
export function recordFoodUse(
  params: { userId: string; foodId: string; at?: number },
  db: SqlDatabase = getDatabase(),
): void {
  const now = params.at ?? Date.now();

  const existing = db.get<FoodRecentRow>(
    'SELECT * FROM food_recents WHERE user_id = ? AND food_id = ?',
    [params.userId, params.foodId],
  );

  const rowId = existing?.id ?? newId();

  withOutbox(db, { table: 'food_recents', rowId, operation: 'upsert' }, () => {
    if (existing) {
      db.run(
        `UPDATE food_recents
            SET last_used_at = ?, use_count = use_count + 1,
                updated_at = ?, deleted_at = NULL
          WHERE id = ?`,
        [now, now, rowId],
      );
    } else {
      db.run(
        `INSERT INTO food_recents
           (id, user_id, food_id, last_used_at, use_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [rowId, params.userId, params.foodId, now, now, now],
      );
    }
  });
}

export type RecentOrder = 'recent' | 'frequent';

/**
 * Recent or frequent foods, read entirely from the device.
 *
 * Joins the local cache, so this is exactly the set that can be rendered and
 * logged offline. A recent whose food was never cached is omitted rather than
 * shown as an unusable row.
 */
export function listLocalRecents(
  userId: string,
  order: RecentOrder = 'recent',
  limit = 20,
  db: SqlDatabase = getDatabase(),
): FoodSearchResult[] {
  const orderClause =
    order === 'frequent'
      ? 'r.use_count DESC, r.last_used_at DESC'
      : 'r.last_used_at DESC';

  const rows = db.all<FoodCacheRow & { use_count: number; last_used_at: number }>(
    `SELECT c.*, r.use_count, r.last_used_at
       FROM food_recents r
       JOIN food_cache c ON c.food_id = r.food_id
      WHERE r.user_id = ? AND r.deleted_at IS NULL
      ORDER BY ${orderClause}
      LIMIT ?`,
    [userId, Math.min(limit, RECENT_LIMIT)],
  );

  return rows.map((row) => ({
    foodId: row.food_id,
    name: row.name,
    brandName: row.brand_name,
    sourceId: row.source_id as FoodSearchResult['sourceId'],
    isVerified: row.is_verified === 1,
    isOwn: row.is_own === 1,
    baseUnit: row.base_unit,
    baseAmount: row.base_amount,
    calories: row.calories,
    protein_g: row.protein_g,
    carbohydrates_g: row.carbohydrates_g,
    fat_g: row.fat_g,
    defaultServing: defaultServingFor(row.food_id, db),
    matchKind: order,
    score: order === 'frequent' ? row.use_count : row.last_used_at,
  }));
}

function defaultServingFor(
  foodId: string,
  db: SqlDatabase,
): FoodSearchResult['defaultServing'] {
  const serving = db.get<FoodCacheServingRow>(
    `SELECT * FROM food_cache_servings
      WHERE food_id = ?
      ORDER BY is_default DESC, sort_order
      LIMIT 1`,
    [foodId],
  );

  return serving
    ? { label: serving.label, amount: serving.amount, unit: serving.unit }
    : null;
}
