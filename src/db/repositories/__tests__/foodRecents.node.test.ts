import { createTestDatabase } from '@/db/__tests__/testDb';
import { migrate } from '@/db/migrator';
import type { SqlDatabase } from '@/db/types';
import type { FoodSearchResult } from '@/features/food/types';
import { countPending } from '@/sync/outbox';
import {
  cacheFood,
  countCachedFoods,
  FOOD_CACHE_LIMIT,
  getCachedFood,
  getCachedServings,
  listLocalRecents,
  recordFoodUse,
} from '../foodRecents';

jest.mock('@/api/supabase', () => ({ supabase: {} }));

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function result(overrides: Partial<FoodSearchResult> = {}): FoodSearchResult {
  return {
    foodId: 'food-1',
    name: 'Apple',
    brandName: null,
    sourceId: 'usda',
    isVerified: true,
    isOwn: false,
    baseUnit: 'g',
    baseAmount: 100,
    calories: 52,
    protein_g: 0.3,
    carbohydrates_g: 13.8,
    fat_g: 0.2,
    defaultServing: null,
    matchKind: 'exact_name',
    score: 700,
    ...overrides,
  };
}

describe('food cache and recents', () => {
  let db: SqlDatabase & { close: () => void };

  beforeEach(() => {
    db = createTestDatabase();
    migrate(db);
    db.run(
      `INSERT INTO profiles (id, unit_system, time_zone, created_at, updated_at)
       VALUES (?, 'metric', 'Europe/Zurich', 1, 1)`,
      [USER],
    );
  });

  afterEach(() => db.close());

  /* -------------------------------------------------------------- caching */

  it('caches a food with its servings', () => {
    cacheFood(result(), [{ label: '1 medium', amount: 182, unit: 'g' }], db);

    const cached = getCachedFood('food-1', db);
    expect(cached?.name).toBe('Apple');
    expect(cached?.calories).toBe(52);
    expect(cached?.is_verified).toBe(1);
    expect(getCachedServings('food-1', db)).toHaveLength(1);
  });

  it('updates rather than duplicating on re-cache', () => {
    cacheFood(result(), [], db);
    cacheFood(result({ name: 'Apple, raw' }), [], db);

    expect(countCachedFoods(db)).toBe(1);
    expect(getCachedFood('food-1', db)?.name).toBe('Apple, raw');
  });

  /**
   * Servings are replaced wholesale: a source revision may have removed a
   * portion, and a stale one would offer something the label no longer has.
   */
  it('replaces servings rather than accumulating them', () => {
    cacheFood(result(), [{ label: '1 medium', amount: 182, unit: 'g' }], db);
    cacheFood(result(), [{ label: '1 large', amount: 223, unit: 'g' }], db);

    const servings = getCachedServings('food-1', db);
    expect(servings).toHaveLength(1);
    expect(servings[0]?.label).toBe('1 large');
  });

  /**
   * The cache must never drift toward being a copy of the global catalogue,
   * which is the thing that has to stay on the server.
   */
  it('evicts the least recently cached entries beyond the limit', () => {
    for (let i = 0; i < FOOD_CACHE_LIMIT + 25; i += 1) {
      cacheFood(result({ foodId: `food-${i}`, name: `Food ${i}` }), [], db);
    }

    expect(countCachedFoods(db)).toBeLessThanOrEqual(FOOD_CACHE_LIMIT);
    // The most recent survives; the oldest is gone.
    expect(getCachedFood(`food-${FOOD_CACHE_LIMIT + 24}`, db)).toBeDefined();
    expect(getCachedFood('food-0', db)).toBeUndefined();
  });

  it('cascades servings when a cached food is evicted', () => {
    cacheFood(result({ foodId: 'doomed' }), [{ label: '1 cup', amount: 80, unit: 'g' }], db);
    db.run('DELETE FROM food_cache WHERE food_id = ?', ['doomed']);

    expect(getCachedServings('doomed', db)).toHaveLength(0);
  });

  /* -------------------------------------------------------------- recents */

  it('records a first use and queues it for sync', () => {
    recordFoodUse({ userId: USER, foodId: 'food-1' }, db);

    const row = db.get<{ use_count: number }>(
      'SELECT use_count FROM food_recents WHERE user_id = ? AND food_id = ?',
      [USER, 'food-1'],
    );
    expect(row?.use_count).toBe(1);
    expect(countPending(db)).toBe(1);
  });

  /**
   * "Do not create duplicate recent entries." A repeat use is an update, and
   * the unique index makes that structural rather than a rule to remember.
   */
  it('increments rather than duplicating on a repeat use', () => {
    recordFoodUse({ userId: USER, foodId: 'food-1', at: 1000 }, db);
    recordFoodUse({ userId: USER, foodId: 'food-1', at: 2000 }, db);
    recordFoodUse({ userId: USER, foodId: 'food-1', at: 3000 }, db);

    const rows = db.all<{ use_count: number; last_used_at: number }>(
      'SELECT use_count, last_used_at FROM food_recents WHERE user_id = ?',
      [USER],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.use_count).toBe(3);
    expect(rows[0]?.last_used_at).toBe(3000);
  });

  it('keeps different users’ recents separate', () => {
    db.run(
      `INSERT INTO profiles (id, unit_system, time_zone, created_at, updated_at)
       VALUES (?, 'metric', 'UTC', 1, 1)`,
      [OTHER],
    );
    recordFoodUse({ userId: USER, foodId: 'food-1' }, db);
    recordFoodUse({ userId: OTHER, foodId: 'food-2' }, db);

    expect(
      db.all('SELECT 1 FROM food_recents WHERE user_id = ?', [USER]),
    ).toHaveLength(1);
  });

  /* ------------------------------------------------------ offline listing */

  /**
   * The offline guarantee: recents render from the device alone, with no
   * network call anywhere in this path.
   */
  it('lists recents entirely from local data', () => {
    cacheFood(result({ foodId: 'a', name: 'Apple' }), [], db);
    cacheFood(result({ foodId: 'b', name: 'Banana', calories: 89 }), [], db);

    recordFoodUse({ userId: USER, foodId: 'a', at: 1000 }, db);
    recordFoodUse({ userId: USER, foodId: 'b', at: 2000 }, db);

    const recents = listLocalRecents(USER, 'recent', 10, db);

    expect(recents.map((r) => r.name)).toEqual(['Banana', 'Apple']);
    expect(recents[0]?.calories).toBe(89);
    expect(recents[0]?.matchKind).toBe('recent');
  });

  it('orders by use count when asked for frequent', () => {
    cacheFood(result({ foodId: 'a', name: 'Apple' }), [], db);
    cacheFood(result({ foodId: 'b', name: 'Banana' }), [], db);

    recordFoodUse({ userId: USER, foodId: 'a', at: 1000 }, db);
    recordFoodUse({ userId: USER, foodId: 'a', at: 1100 }, db);
    recordFoodUse({ userId: USER, foodId: 'a', at: 1200 }, db);
    recordFoodUse({ userId: USER, foodId: 'b', at: 5000 }, db);

    const frequent = listLocalRecents(USER, 'frequent', 10, db);
    expect(frequent[0]?.name).toBe('Apple');

    // The same data ordered by recency puts Banana first.
    expect(listLocalRecents(USER, 'recent', 10, db)[0]?.name).toBe('Banana');
  });

  /**
   * A recent whose food was never cached cannot be rendered or logged offline,
   * so it is omitted rather than shown as a broken row.
   */
  it('omits recents whose food is not cached', () => {
    recordFoodUse({ userId: USER, foodId: 'never-cached' }, db);
    expect(listLocalRecents(USER, 'recent', 10, db)).toHaveLength(0);
  });

  it('returns a cached food’s default serving for the picker', () => {
    cacheFood(result({ foodId: 'a' }), [{ label: '1 medium', amount: 182, unit: 'g' }], db);
    recordFoodUse({ userId: USER, foodId: 'a' }, db);

    expect(listLocalRecents(USER, 'recent', 10, db)[0]?.defaultServing).toEqual({
      label: '1 medium',
      amount: 182,
      unit: 'g',
    });
  });

  it('honours the requested limit', () => {
    for (let i = 0; i < 10; i += 1) {
      cacheFood(result({ foodId: `f${i}` }), [], db);
      recordFoodUse({ userId: USER, foodId: `f${i}`, at: 1000 + i }, db);
    }

    expect(listLocalRecents(USER, 'recent', 3, db)).toHaveLength(3);
  });

  it('returns nothing for a user with no history', () => {
    expect(listLocalRecents(USER, 'recent', 10, db)).toEqual([]);
  });
});
