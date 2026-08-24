import { confirmScannedFood, type ScanCandidate } from '../confirmScan';

jest.mock('@/api/supabase', () => ({ supabase: {} }));

/**
 * Turning a confirmed scan into something the diary can log.
 *
 * The behaviour under test is the one that makes scanning work offline: a
 * diary entry does not depend on a catalogue row, so a failed or skipped
 * catalogue save leaves a complete entry rather than nothing at all.
 */

const candidate: ScanCandidate = {
  name: 'Rolled oats',
  brandName: 'Own brand',
  baseUnit: 'g',
  baseAmount: 100,
  nutrition: {
    calories: 379,
    protein_g: 13.2,
    carbohydrates_g: 67.7,
    fat_g: 6.5,
    fiber_g: 10.1,
    sugar_g: 1,
    saturated_fat_g: 1.1,
    sodium_mg: 6,
  },
  serving: { label: '1 serving (40 g)', amount: 40, unit: 'g' },
  barcode: '5449000000996',
};

/** A client that reports a signed-in user and accepts every insert. */
function workingClient() {
  const inserts: { table: string; values: unknown }[] = [];

  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }) },
    from: (table: string) => ({
      insert: (values: unknown) => {
        inserts.push({ table, values });
        return {
          select: () => ({
            single: async () => ({ data: { id: 'food-created' }, error: null }),
          }),
          then: (resolve: (value: { error: null }) => unknown) => resolve({ error: null }),
        };
      },
      select: () => ({
        eq: () => ({
          eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: null }) }) }),
        }),
      }),
    }),
  } as never;

  return { client, inserts };
}

/** A client that cannot reach the server. */
const failingClient = {
  auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }) },
  from: () => {
    throw new Error('Network request failed');
  },
} as never;

describe('confirmScannedFood', () => {
  it('produces a loggable food with no catalogue row when asked not to save', async () => {
    const outcome = await confirmScannedFood(
      { candidate, source: 'user', saveToCatalogue: false },
      failingClient,
    );

    expect(outcome.food.foodId).toBeNull();
    expect(outcome.food.name).toBe('Rolled oats');
    expect(outcome.catalogueError).toBeNull();
  });

  it('never marks a scanned food as verified', async () => {
    const outcome = await confirmScannedFood(
      { candidate, source: 'user', saveToCatalogue: false },
      failingClient,
    );

    expect(outcome.food.isVerified).toBe(false);
  });

  it('marks an AI-derived food as estimated, never as catalogue data', async () => {
    const outcome = await confirmScannedFood(
      { candidate, source: 'ai_estimated', saveToCatalogue: false },
      failingClient,
    );

    expect(outcome.food.sourceId).toBe('ai_estimated');
    expect(outcome.food.sourceId).not.toBe('usda');
    expect(outcome.food.sourceId).not.toBe('openfoodfacts');
  });

  it('attaches the created food when the catalogue save works', async () => {
    const { client, inserts } = workingClient();

    const outcome = await confirmScannedFood(
      { candidate, source: 'user', saveToCatalogue: true },
      client,
    );

    expect(outcome.food.foodId).toBe('food-created');
    expect(outcome.catalogueError).toBeNull();
    expect(inserts.map((entry) => entry.table)).toContain('foods');
    expect(inserts.map((entry) => entry.table)).toContain('food_nutrition');
  });

  it('still produces a loggable food when the catalogue save fails', async () => {
    // The diary entry is what the user asked for. Losing it because a
    // convenience feature failed would be the wrong trade.
    const outcome = await confirmScannedFood(
      { candidate, source: 'user', saveToCatalogue: true },
      failingClient,
    );

    expect(outcome.food.foodId).toBeNull();
    expect(outcome.food.name).toBe('Rolled oats');
    expect(outcome.catalogueError).not.toBeNull();
    expect(outcome.catalogueError?.retryable).toBe(true);
  });

  it('carries the basis the diary will snapshot', async () => {
    const outcome = await confirmScannedFood(
      { candidate, source: 'user', saveToCatalogue: false },
      failingClient,
    );

    expect(outcome.food.baseUnit).toBe('g');
    expect(outcome.food.baseAmount).toBe(100);
  });
});
