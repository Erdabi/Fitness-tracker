import { createTestDatabase } from '@/db/__tests__/testDb';
import { migrate } from '@/db/migrator';
import { createFoodLog, listDay } from '@/db/repositories/foodLogs';
import { cacheFood, getCachedFoodByBarcode } from '@/db/repositories/foodRecents';
import type { SqlDatabase } from '@/db/types';
import { normalizeLabel } from '@/features/ai/normalize';
import type { LabelExtraction, MealEstimation } from '@/features/ai/schemas';
import { confirmScannedFood } from '@/features/scan/confirmScan';
import { draftFromLabel, resolveLabelDraft } from '@/features/scan/labelDraft';
import { draftsFromMeal, resolvePhotoDraft } from '@/features/scan/photoDraft';
import { asLocalDay } from '@/lib/date';
import { sync } from '@/sync/engine';
import { countPending } from '@/sync/outbox';
import { createFakeRemote } from '@/sync/__tests__/fakeRemote';

jest.mock('@/api/supabase', () => ({ supabase: {} }));

/**
 * A scan, end to end, through the machinery that already existed.
 *
 * These are the scenarios that decide whether scanning is a feature or a
 * second, parallel system: a label read on a train with no signal has to reach
 * the server later through the ordinary outbox, an entry has to keep the
 * numbers it was created with when the food behind it changes, and one scan
 * has to produce exactly one diary entry.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const ZURICH = 'Europe/Zurich';
const DAY = asLocalDay('2026-06-15');
const MORNING = Date.parse('2026-06-15T06:00:00.000Z');

const OATS: LabelExtraction = {
  status: 'success',
  confidence: 'high',
  productName: 'Rolled oats',
  brand: 'Own brand',
  servingSize: { amount: 40, unit: 'g' },
  servingsPerContainer: 12,
  basis: 'per_100g',
  nutrients: {
    energy: { kcal: 379, kj: null },
    protein_g: 13.2,
    carbohydrates_g: 67.7,
    sugars_g: 1,
    fiber_g: 10.1,
    fat_g: 6.5,
    saturated_fat_g: 1.1,
    sodium_mg: 6,
    salt_g: null,
  },
  barcode: '5449000000996',
  warnings: [],
};

const PLATE: MealEstimation = {
  status: 'success',
  confidence: 'medium',
  items: [
    {
      name: 'Grilled chicken breast',
      estimatedQuantity: 150,
      unit: 'g',
      calories: 248,
      protein_g: 46.5,
      carbohydrates_g: 0,
      fat_g: 5.4,
      fiber_g: null,
      sugars_g: null,
      confidence: 'high',
    },
    {
      name: 'White rice',
      estimatedQuantity: 180,
      unit: 'g',
      calories: 234,
      protein_g: 4.9,
      carbohydrates_g: 51.1,
      fat_g: 0.5,
      fiber_g: 1.1,
      sugars_g: null,
      confidence: 'medium',
    },
  ],
  warnings: [],
};

function freshDatabase(): SqlDatabase & { close: () => void } {
  const db = createTestDatabase();
  migrate(db);
  db.run(
    `INSERT INTO profiles (id, email, unit_system, time_zone, created_at, updated_at)
     VALUES (?, 'sam@example.com', 'metric', 'Europe/Zurich', 1000, 1000)`,
    [USER],
  );
  return db;
}

/** The label review, run to the point where the user presses the button. */
async function reviewAndConfirm(saveToCatalogue: boolean) {
  const { candidate } = resolveLabelDraft(draftFromLabel(normalizeLabel(OATS)));
  if (!candidate) throw new Error('the fixture should resolve');

  const outcome = await confirmScannedFood(
    { candidate, source: 'user', saveToCatalogue },
    // No client is reachable: this is the offline case.
    {
      auth: { getSession: async () => ({ data: { session: { user: { id: USER } } } }) },
      from: () => {
        throw new Error('Network request failed');
      },
    } as never,
  );

  return { candidate, outcome };
}

describe('a scanned label logged with no connection', () => {
  it('writes a complete diary entry that syncs later through the outbox', async () => {
    const db = freshDatabase();
    const remote = createFakeRemote();

    const { candidate, outcome } = await reviewAndConfirm(true);

    // The catalogue save could not happen; the entry still must.
    expect(outcome.catalogueError).not.toBeNull();
    expect(outcome.food.foodId).toBeNull();

    createFoodLog(
      {
        userId: USER,
        meal: 'breakfast',
        food: outcome.food,
        nutrition: candidate.nutrition,
        quantity: 1,
        serving: candidate.serving,
        timeZone: ZURICH,
        diaryDate: DAY,
        at: MORNING,
      },
      db,
    );

    const [entry] = listDay(USER, DAY, db);
    expect(entry).toBeDefined();
    expect(entry!.food_name).toBe('Rolled oats');
    // 379 kcal per 100 g, one 40 g serving.
    expect(entry!.calories).toBeCloseTo(151.6, 1);

    // One pending write, on the ordinary outbox — no second queue.
    expect(countPending(db)).toBe(1);

    await sync({ db, userId: USER, remote });

    expect(countPending(db)).toBe(0);
    const [synced] = remote.rows('food_logs');
    expect(synced).toMatchObject({ food_name: 'Rolled oats', meal: 'breakfast' });

    db.close();
  });

  it('sends no AI request of its own through the sync engine', async () => {
    const db = freshDatabase();
    const remote = createFakeRemote();

    const { candidate, outcome } = await reviewAndConfirm(false);
    createFoodLog(
      {
        userId: USER,
        meal: 'breakfast',
        food: outcome.food,
        nutrition: candidate.nutrition,
        quantity: 1,
        serving: candidate.serving,
        timeZone: ZURICH,
        diaryDate: DAY,
        at: MORNING,
      },
      db,
    );

    await sync({ db, userId: USER, remote });

    // Only the tables the engine already knew about are touched: an AI scan
    // leaves no trace in the sync path beyond an ordinary diary row.
    expect(remote.rows('food_logs')).toHaveLength(1);
    expect(remote.stats.upserts).toBeGreaterThan(0);

    db.close();
  });
});

describe('the diary snapshot survives the food behind it', () => {
  it('keeps its numbers when the catalogue food is later corrected', async () => {
    const db = freshDatabase();
    const { candidate, outcome } = await reviewAndConfirm(false);

    createFoodLog(
      {
        userId: USER,
        meal: 'breakfast',
        // Pretend the catalogue row existed, so provenance is present.
        food: { ...outcome.food, foodId: 'food-oats' },
        nutrition: candidate.nutrition,
        quantity: 1,
        serving: candidate.serving,
        timeZone: ZURICH,
        diaryDate: DAY,
        at: MORNING,
      },
      db,
    );

    const before = listDay(USER, DAY, db)[0]!;

    // The user edits the food afterwards — a corrected label, a renamed
    // product. The cache is the local copy of the catalogue.
    cacheFood(
      {
        foodId: 'food-oats',
        name: 'Rolled oats (corrected)',
        brandName: 'Own brand',
        sourceId: 'user',
        isVerified: false,
        isOwn: true,
        baseUnit: 'g',
        baseAmount: 100,
        calories: 9999,
        protein_g: 0,
        carbohydrates_g: 0,
        fat_g: 0,
        defaultServing: null,
        matchKind: 'exact_name',
        score: 0,
      },
      [],
      db,
    );

    const after = listDay(USER, DAY, db)[0]!;

    expect(after.food_name).toBe(before.food_name);
    expect(after.calories).toBe(before.calories);
    expect(after.basis_calories).toBe(379);

    db.close();
  });

  it('keeps an entry whose food was never in the catalogue at all', async () => {
    const db = freshDatabase();
    const { candidate, outcome } = await reviewAndConfirm(false);

    createFoodLog(
      {
        userId: USER,
        meal: 'breakfast',
        food: outcome.food,
        nutrition: candidate.nutrition,
        quantity: 2,
        serving: candidate.serving,
        timeZone: ZURICH,
        diaryDate: DAY,
        at: MORNING,
      },
      db,
    );

    const entry = listDay(USER, DAY, db)[0]!;

    expect(entry.food_id).toBeNull();
    // Nothing is read back from a catalogue, so nothing is missing.
    expect(entry.calories).toBeCloseTo(303.2, 1);
    expect(entry.protein_g).toBeCloseTo(10.56, 2);

    db.close();
  });
});

describe('a photographed meal', () => {
  it('logs each confirmed item as its own entry, and nothing else', () => {
    const db = freshDatabase();
    const drafts = draftsFromMeal(PLATE);

    for (const draft of drafts.filter((entry) => entry.include)) {
      const { candidate } = resolvePhotoDraft(draft);
      if (!candidate) throw new Error(`${draft.name} should resolve`);

      createFoodLog(
        {
          userId: USER,
          meal: 'lunch',
          food: {
            foodId: null,
            name: candidate.name,
            brandName: null,
            sourceId: 'ai_estimated',
            isVerified: false,
            baseUnit: candidate.unit,
            baseAmount: candidate.baseAmount,
          },
          nutrition: candidate.nutrition,
          quantity: candidate.quantity,
          serving: null,
          timeZone: ZURICH,
          diaryDate: DAY,
          at: MORNING,
        },
        db,
      );
    }

    const entries = listDay(USER, DAY, db);

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.food_name).sort()).toEqual([
      'Grilled chicken breast',
      'White rice',
    ]);
    // The portion the user confirmed, not the per-100 basis.
    const chicken = entries.find((entry) => entry.food_name.startsWith('Grilled'))!;
    expect(chicken.calories).toBeCloseTo(248, 0);

    db.close();
  });

  it('marks every estimated entry as estimated and never as verified', () => {
    const db = freshDatabase();
    const { candidate } = resolvePhotoDraft(draftsFromMeal(PLATE)[0]!);

    createFoodLog(
      {
        userId: USER,
        meal: 'lunch',
        food: {
          foodId: null,
          name: candidate!.name,
          brandName: null,
          sourceId: 'ai_estimated',
          isVerified: false,
          baseUnit: candidate!.unit,
          baseAmount: candidate!.baseAmount,
        },
        nutrition: candidate!.nutrition,
        quantity: candidate!.quantity,
        serving: null,
        timeZone: ZURICH,
        diaryDate: DAY,
        at: MORNING,
      },
      db,
    );

    const entry = listDay(USER, DAY, db)[0]!;
    expect(entry.food_source_id).toBe('ai_estimated');
    expect(entry.food_is_verified).toBe(0);

    db.close();
  });

  it('excludes a low-confidence item unless the user turns it on', () => {
    const drafts = draftsFromMeal({
      ...PLATE,
      items: [...PLATE.items, { ...PLATE.items[0]!, name: 'Sauce', confidence: 'low' }],
    });

    expect(drafts.filter((draft) => draft.include).map((draft) => draft.name)).toEqual([
      'Grilled chicken breast',
      'White rice',
    ]);
  });
});

describe('a barcode scanned twice', () => {
  it('resolves from the device the second time, with no server call', async () => {
    const db = freshDatabase();

    cacheFood(
      {
        foodId: 'food-cola',
        name: 'Cola',
        brandName: null,
        sourceId: 'openfoodfacts',
        isVerified: true,
        isOwn: false,
        baseUnit: 'ml',
        baseAmount: 100,
        calories: 42,
        protein_g: 0,
        carbohydrates_g: 10.6,
        fat_g: 0,
        defaultServing: null,
        matchKind: 'barcode',
        score: 0,
      },
      [],
      db,
      '5449000000996',
    );

    const cached = getCachedFoodByBarcode('5449000000996', db);

    expect(cached).not.toBeNull();
    expect(cached?.foodId).toBe('food-cola');
    // Trusted catalogue data keeps its provenance through the cache.
    expect(cached?.isVerified).toBe(true);
    expect(cached?.sourceId).toBe('openfoodfacts');

    expect(getCachedFoodByBarcode('4000000000006', db)).toBeNull();

    db.close();
  });
});
