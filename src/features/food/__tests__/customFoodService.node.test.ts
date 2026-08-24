import { createCustomFood } from '../customFoodService';

jest.mock('@/api/supabase', () => ({ supabase: {} }));

/**
 * Creating a food the user owns.
 *
 * The provenance rules are the point: an owned food is never verified, an
 * AI-derived one is never labelled as USDA or Open Food Facts data, and the
 * pieces that are only convenience — a portion, a barcode — do not take the
 * food down with them when they fail.
 */

const nutrition = {
  calories: 379,
  protein_g: 13.2,
  carbohydrates_g: 67.7,
  fat_g: 6.5,
  fiber_g: 10.1,
  sugar_g: 1,
  saturated_fat_g: 1.1,
  sodium_mg: 6,
};

interface Recorded {
  readonly table: string;
  readonly values: Record<string, unknown>;
}

function client(options: { failOn?: string; signedIn?: boolean } = {}) {
  const recorded: Recorded[] = [];
  const signedIn = options.signedIn ?? true;

  const stub = {
    auth: {
      getSession: async () => ({
        data: { session: signedIn ? { user: { id: 'user-1' } } : null },
      }),
    },
    from: (table: string) => ({
      insert: (values: Record<string, unknown>) => {
        recorded.push({ table, values });
        const error = options.failOn === table ? { message: `${table} refused` } : null;

        return {
          select: () => ({
            single: async () =>
              error ? { data: null, error } : { data: { id: 'food-1' }, error: null },
          }),
          then: (resolve: (value: { error: unknown }) => unknown) => resolve({ error }),
        };
      },
      select: () => ({
        eq: () => ({
          eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: null }) }) }),
        }),
      }),
    }),
  } as never;

  return { stub, recorded };
}

const find = (recorded: Recorded[], table: string) =>
  recorded.find((entry) => entry.table === table);

describe('createCustomFood', () => {
  it('writes the food, its nutrition, its portion and its barcode', async () => {
    const { stub, recorded } = client();

    const result = await createCustomFood(
      {
        name: 'Rolled oats',
        brandName: 'Own brand',
        baseUnit: 'g',
        baseAmount: 100,
        nutrition,
        servings: [{ label: '1 serving (40 g)', amount: 40, unit: 'g' }],
        barcode: '5449000000996',
        source: 'user',
      },
      stub,
    );

    expect(result.ok).toBe(true);
    expect(recorded.map((entry) => entry.table)).toEqual(
      expect.arrayContaining(['foods', 'food_nutrition', 'food_servings', 'food_barcodes']),
    );
  });

  it('marks an owned food as unverified and owned', async () => {
    const { stub, recorded } = client();

    await createCustomFood(
      { name: 'Rolled oats', baseUnit: 'g', baseAmount: 100, nutrition, source: 'user' },
      stub,
    );

    const food = find(recorded, 'foods')!.values;
    expect(food.is_verified).toBe(false);
    expect(food.owner_id).toBe('user-1');
    expect(food.source_id).toBe('user');
  });

  it('records an AI-derived food as estimated, never as catalogue data', async () => {
    const { stub, recorded } = client();

    await createCustomFood(
      {
        name: 'Grilled chicken breast',
        baseUnit: 'g',
        baseAmount: 100,
        nutrition,
        source: 'ai_estimated',
      },
      stub,
    );

    expect(find(recorded, 'foods')!.values.source_id).toBe('ai_estimated');
    expect(find(recorded, 'foods')!.values.is_verified).toBe(false);
    expect(find(recorded, 'food_nutrition')!.values.source_id).toBe('ai_estimated');
  });

  it('keeps a null nutrient null on the way to the database', async () => {
    const { stub, recorded } = client();

    await createCustomFood(
      {
        name: 'Rolled oats',
        baseUnit: 'g',
        baseAmount: 100,
        nutrition: { ...nutrition, fiber_g: null, sodium_mg: null },
        source: 'user',
      },
      stub,
    );

    const written = find(recorded, 'food_nutrition')!.values;
    expect(written.fiber_g).toBeNull();
    expect(written.sodium_mg).toBeNull();
  });

  it('refuses a nameless food before touching the network', async () => {
    const { stub, recorded } = client();

    const result = await createCustomFood(
      { name: '   ', baseUnit: 'g', baseAmount: 100, nutrition, source: 'user' },
      stub,
    );

    expect(result.ok).toBe(false);
    expect(recorded).toEqual([]);
  });

  it('refuses when nobody is signed in', async () => {
    const { stub } = client({ signedIn: false });

    const result = await createCustomFood(
      { name: 'Rolled oats', baseUnit: 'g', baseAmount: 100, nutrition, source: 'user' },
      stub,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('auth');
  });

  it('fails the whole save when the nutrition cannot be written', async () => {
    // A food with no nutrition is not a food; it would show as an empty row in
    // search forever.
    const { stub } = client({ failOn: 'food_nutrition' });

    const result = await createCustomFood(
      { name: 'Rolled oats', baseUnit: 'g', baseAmount: 100, nutrition, source: 'user' },
      stub,
    );

    expect(result.ok).toBe(false);
  });

  it('still saves the food when only its portion fails', async () => {
    // A missing portion costs convenience: the food is loggable in grams.
    const { stub } = client({ failOn: 'food_servings' });

    const result = await createCustomFood(
      {
        name: 'Rolled oats',
        baseUnit: 'g',
        baseAmount: 100,
        nutrition,
        servings: [{ label: '1 serving (40 g)', amount: 40, unit: 'g' }],
        source: 'user',
      },
      stub,
    );

    expect(result.ok).toBe(true);
  });

  it('still saves the food when its barcode collides', async () => {
    const { stub } = client({ failOn: 'food_barcodes' });

    const result = await createCustomFood(
      {
        name: 'Rolled oats',
        baseUnit: 'g',
        baseAmount: 100,
        nutrition,
        barcode: '5449000000996',
        source: 'user',
      },
      stub,
    );

    expect(result.ok).toBe(true);
  });

  it('returns a result shaped like a search hit, so every screen can use it', async () => {
    const { stub } = client();

    const result = await createCustomFood(
      {
        name: 'Rolled oats',
        brandName: 'Own brand',
        baseUnit: 'g',
        baseAmount: 100,
        nutrition,
        source: 'user',
      },
      stub,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        foodId: 'food-1',
        name: 'Rolled oats',
        isOwn: true,
        isVerified: false,
        baseUnit: 'g',
        baseAmount: 100,
        calories: 379,
      });
    }
  });
});
