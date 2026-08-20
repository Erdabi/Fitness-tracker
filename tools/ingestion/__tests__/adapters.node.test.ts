import { openFoodFactsAdapter, parseQuantity, type OffProduct } from '../sources/openfoodfacts';
import { usdaAdapter, type UsdaFood } from '../sources/usda';

/** Builds a USDA record with the nutrient list shape the export uses. */
function usdaRecord(overrides: Partial<UsdaFood> = {}): UsdaFood {
  return {
    fdcId: 169705,
    description: 'Oats, rolled',
    publicationDate: '2026-01-15',
    foodNutrients: [
      { nutrient: { number: '208', unitName: 'KCAL' }, amount: 379 },
      { nutrient: { number: '203', unitName: 'G' }, amount: 13.2 },
      { nutrient: { number: '205', unitName: 'G' }, amount: 67.7 },
      { nutrient: { number: '204', unitName: 'G' }, amount: 6.5 },
      { nutrient: { number: '291', unitName: 'G' }, amount: 10.1 },
      { nutrient: { number: '307', unitName: 'MG' }, amount: 6 },
      { nutrient: { number: '303', unitName: 'MG' }, amount: 4.7 },
    ],
    ...overrides,
  };
}

describe('usdaAdapter', () => {
  it('parses a well-formed record', () => {
    const result = usdaAdapter.parse(usdaRecord());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.food.externalId).toBe('169705');
    expect(result.food.name).toBe('Oats, rolled');
    expect(result.food.normalizedName).toBe('oats rolled');
    expect(result.food.baseUnit).toBe('g');
    expect(result.food.baseAmount).toBe(100);
    expect(result.food.nutrition.calories).toBe(379);
    expect(result.food.nutrition.protein_g).toBe(13.2);
    expect(result.food.nutrition.fiber_g).toBe(10.1);
    expect(result.food.sourceUpdatedAt).toBe('2026-01-15');
  });

  it('keeps unrecognised nutrients as micronutrients rather than dropping them', () => {
    const result = usdaAdapter.parse(usdaRecord());
    if (!result.ok) throw new Error('expected a parse');

    expect(result.food.nutrition.micronutrients).toEqual({ iron_mg: 4.7 });
  });

  it('converts a kJ-only record', () => {
    const result = usdaAdapter.parse(
      usdaRecord({
        foodNutrients: [
          { nutrient: { number: '268', unitName: 'kJ' }, amount: 1585 },
          { nutrient: { number: '203' }, amount: 13 },
          { nutrient: { number: '205' }, amount: 68 },
          { nutrient: { number: '204' }, amount: 7 },
        ],
      }),
    );

    if (!result.ok) throw new Error('expected a parse');
    expect(result.food.nutrition.calories).toBeCloseTo(378.8, 1);
  });

  /**
   * Absent is not zero. Reporting 0 g fibre for a food whose source never
   * measured it would be fabricated data on the user's dashboard.
   */
  it('leaves unreported nutrients null rather than zero', () => {
    const result = usdaAdapter.parse(
      usdaRecord({
        foodNutrients: [
          { nutrient: { number: '208', unitName: 'KCAL' }, amount: 100 },
          { nutrient: { number: '203' }, amount: 5 },
          { nutrient: { number: '205' }, amount: 10 },
          { nutrient: { number: '204' }, amount: 2 },
        ],
      }),
    );

    if (!result.ok) throw new Error('expected a parse');
    expect(result.food.nutrition.fiber_g).toBeNull();
    expect(result.food.nutrition.sugar_g).toBeNull();
    expect(result.food.nutrition.sodium_mg).toBeNull();
  });

  it('keeps only portions that carry a gram weight', () => {
    const result = usdaAdapter.parse(
      usdaRecord({
        foodPortions: [
          { portionDescription: '1 cup', gramWeight: 81 },
          // No weight: cannot be converted, so must not be invented.
          { portionDescription: '1 handful' },
          { portionDescription: '1 serving', gramWeight: 0 },
        ],
      }),
    );

    if (!result.ok) throw new Error('expected a parse');
    expect(result.food.servings).toEqual([
      { label: '1 cup', amount: 81, unit: 'g', isDefault: false },
    ]);
  });

  it('marks a food branded when the record names a brand', () => {
    const result = usdaAdapter.parse(usdaRecord({ brandName: "Bob's Red Mill" }));

    if (!result.ok) throw new Error('expected a parse');
    expect(result.food.kind).toBe('branded');
    expect(result.food.brand).toEqual({
      name: "Bob's Red Mill",
      normalizedName: 'bob s red mill',
    });
  });

  it.each([
    ['missing id', { fdcId: undefined }, 'missing_id'],
    ['missing name', { description: '' }, 'missing_name'],
    ['no nutrients', { foodNutrients: [] }, 'missing_nutrition'],
  ])('rejects a record with %s', (_label, overrides, reason) => {
    const result = usdaAdapter.parse(usdaRecord(overrides as Partial<UsdaFood>));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(reason);
  });

  /** kJ recorded in a kcal field — a factor-of-four error on the dashboard. */
  it('rejects implausible energy', () => {
    const result = usdaAdapter.parse(
      usdaRecord({
        foodNutrients: [{ nutrient: { number: '208', unitName: 'KCAL' }, amount: 1585 }],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('implausible_nutrition');
  });

  it('rejects macros that exceed the mass described', () => {
    const result = usdaAdapter.parse(
      usdaRecord({
        foodNutrients: [
          { nutrient: { number: '208', unitName: 'KCAL' }, amount: 400 },
          { nutrient: { number: '203' }, amount: 60 },
          { nutrient: { number: '205' }, amount: 60 },
          { nutrient: { number: '204' }, amount: 60 },
        ],
      }),
    );

    expect(result.ok).toBe(false);
  });

  it.each([null, undefined, 'a string', 42])('survives %p as input', (raw) => {
    const result = usdaAdapter.parse(raw as unknown as UsdaFood);
    expect(result.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------- OFF -- */

function offRecord(overrides: Partial<OffProduct> = {}): OffProduct {
  return {
    code: '5000159484695',
    product_name: 'Snickers',
    brands: 'Mars',
    quantity: '50 g',
    serving_size: '50 g',
    serving_quantity: 50,
    last_modified_t: 1767225600,
    nutriments: {
      'energy-kcal_100g': 484,
      proteins_100g: 8.2,
      carbohydrates_100g: 59.4,
      fat_100g: 23.6,
      sugars_100g: 50.9,
      'saturated-fat_100g': 8.7,
      salt_100g: 0.55,
      fiber_100g: 1.4,
    },
    ...overrides,
  };
}

describe('openFoodFactsAdapter', () => {
  it('parses a well-formed product', () => {
    const result = openFoodFactsAdapter.parse(offRecord());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.food.externalId).toBe('5000159484695');
    expect(result.food.name).toBe('Snickers');
    expect(result.food.kind).toBe('packaged');
    expect(result.food.nutrition.calories).toBe(484);
    expect(result.food.brand?.name).toBe('Mars');
    expect(result.food.sourceUpdatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  /** OFF reports salt; the schema stores sodium. */
  it('converts salt to sodium', () => {
    const result = openFoodFactsAdapter.parse(offRecord());
    if (!result.ok) throw new Error('expected a parse');

    expect(result.food.nutrition.sodium_mg).toBeCloseTo(220, 5);
  });

  it('prefers a directly reported sodium figure', () => {
    const result = openFoodFactsAdapter.parse(
      offRecord({
        nutriments: { ...offRecord().nutriments, sodium_100g: 0.3, salt_100g: 0.55 },
      }),
    );

    if (!result.ok) throw new Error('expected a parse');
    expect(result.food.nutrition.sodium_mg).toBe(300);
  });

  it('converts a kJ-only product', () => {
    const result = openFoodFactsAdapter.parse(
      offRecord({
        nutriments: {
          energy_100g: 2024,
          proteins_100g: 8,
          carbohydrates_100g: 59,
          fat_100g: 24,
        },
      }),
    );

    if (!result.ok) throw new Error('expected a parse');
    expect(result.food.nutrition.calories).toBeCloseTo(483.7, 1);
  });

  /** A drink's values are per 100 ml; treating them as grams misreports it. */
  it('uses millilitres as the base for a liquid', () => {
    const result = openFoodFactsAdapter.parse(
      offRecord({ quantity: '330 ml', serving_size: '330 ml', serving_quantity: 330 }),
    );

    if (!result.ok) throw new Error('expected a parse');
    expect(result.food.baseUnit).toBe('ml');
    expect(result.food.servings[0]?.unit).toBe('ml');
  });

  it('records the product code as a barcode', () => {
    const result = openFoodFactsAdapter.parse(offRecord());
    if (!result.ok) throw new Error('expected a parse');

    expect(result.food.barcodes).toEqual([
      { barcode: '5000159484695', format: 'ean13' },
    ]);
  });

  /** A bad check digit is a typo; storing it blocks the real product. */
  it('drops a barcode with an invalid check digit', () => {
    const result = openFoodFactsAdapter.parse(offRecord({ code: '5000159484694' }));

    if (!result.ok) throw new Error('expected a parse');
    expect(result.food.barcodes).toEqual([]);
    // The product is still imported — only the unusable barcode is dropped.
    expect(result.food.externalId).toBe('5000159484694');
  });

  it('takes only the first brand from a comma-separated list', () => {
    const result = openFoodFactsAdapter.parse(offRecord({ brands: 'Mars, Mars Inc, MARS' }));

    if (!result.ok) throw new Error('expected a parse');
    expect(result.food.brand?.name).toBe('Mars');
  });

  it('prefers the English name when both are present', () => {
    const result = openFoodFactsAdapter.parse(
      offRecord({ product_name: 'Schokoriegel', product_name_en: 'Chocolate Bar' }),
    );

    if (!result.ok) throw new Error('expected a parse');
    expect(result.food.name).toBe('Chocolate Bar');
  });

  it.each([
    ['no code', { code: '' }, 'missing_id'],
    ['no name', { product_name: '', product_name_en: '' }, 'missing_name'],
    ['no nutriments', { nutriments: {} }, 'missing_nutrition'],
  ])('rejects a product with %s', (_label, overrides, reason) => {
    const result = openFoodFactsAdapter.parse(offRecord(overrides as Partial<OffProduct>));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(reason);
  });

  it('converts micronutrients from grams to milligrams', () => {
    const result = openFoodFactsAdapter.parse(
      offRecord({ nutriments: { ...offRecord().nutriments, calcium_100g: 0.12 } }),
    );

    if (!result.ok) throw new Error('expected a parse');
    expect(result.food.nutrition.micronutrients.calcium_mg).toBeCloseTo(120, 5);
  });
});

describe('parseQuantity', () => {
  it.each([
    ['500 ml', { amount: 500, unit: 'ml' }],
    ['250g', { amount: 250, unit: 'g' }],
    ['1 L', { amount: 1000, unit: 'ml' }],
    ['1,5 L', { amount: 1500, unit: 'ml' }],
  ])('parses %p', (input, expected) => {
    expect(parseQuantity(input)).toEqual(expected);
  });

  it.each([undefined, '', 'family size', '12 pieces'])(
    'returns null for %p rather than guessing',
    (input) => {
      expect(parseQuantity(input)).toBeNull();
    },
  );
});
