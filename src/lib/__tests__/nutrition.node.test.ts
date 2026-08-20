import {
  displayEnergy,
  displayMacro,
  nutritionFor,
  resolveQuantity,
  scaleNutrition,
  servingOptions,
  sumNutrition,
  type FoodBasis,
  type NutritionPerBase,
  type Serving,
} from '../nutrition';

/** Apple: 52 kcal per 100 g, the worked example from the spec. */
const apple: FoodBasis = { baseUnit: 'g', baseAmount: 100 };
const appleNutrition: NutritionPerBase = {
  calories: 52,
  protein_g: 0.3,
  carbohydrates_g: 13.8,
  fat_g: 0.2,
  fiber_g: 2.4,
  sugar_g: 10.4,
  saturated_fat_g: null,
  sodium_mg: 1,
};

const mediumApple: Serving = { label: '1 medium', amount: 182, unit: 'g' };

describe('resolveQuantity', () => {
  it('treats a bare quantity as base units', () => {
    const resolved = resolveQuantity(apple, 150, null);
    expect(resolved.amountInBase).toBe(150);
    expect(resolved.baseUnit).toBe('g');
  });

  it('multiplies a serving by its gram equivalent', () => {
    expect(resolveQuantity(apple, 2, mediumApple).amountInBase).toBe(364);
  });

  it('handles fractional servings', () => {
    expect(resolveQuantity(apple, 0.5, mediumApple).amountInBase).toBe(91);
  });

  it('allows zero', () => {
    expect(resolveQuantity(apple, 0, mediumApple).amountInBase).toBe(0);
  });

  it('rejects a negative quantity', () => {
    expect(() => resolveQuantity(apple, -1, null)).toThrow();
  });

  it('rejects a non-finite quantity', () => {
    expect(() => resolveQuantity(apple, Number.NaN, null)).toThrow();
  });

  /**
   * g and ml are not interchangeable without a density the catalogue does not
   * store. Guessing one would silently misreport every liquid.
   */
  it('refuses to convert between mass and volume', () => {
    const drink: FoodBasis = { baseUnit: 'ml', baseAmount: 100 };
    const gramServing: Serving = { label: '1 scoop', amount: 30, unit: 'g' };

    expect(() => resolveQuantity(drink, 1, gramServing)).toThrow(/no safe conversion/i);
  });
});

describe('scaleNutrition', () => {
  /** The worked example: 100 g is 52 kcal, so 150 g must be 78 kcal. */
  it('scales 100 g of apple at 52 kcal to 78 kcal for 150 g', () => {
    const { scaled } = nutritionFor(appleNutrition, apple, 150, null);
    expect(scaled.calories).toBeCloseTo(78, 10);
  });

  it('scales every reported macro by the same factor', () => {
    const { scaled } = nutritionFor(appleNutrition, apple, 200, null);

    expect(scaled.calories).toBeCloseTo(104, 10);
    expect(scaled.protein_g).toBeCloseTo(0.6, 10);
    expect(scaled.carbohydrates_g).toBeCloseTo(27.6, 10);
    expect(scaled.fat_g).toBeCloseTo(0.4, 10);
    expect(scaled.fiber_g).toBeCloseTo(4.8, 10);
  });

  it('scales through a named serving', () => {
    const { scaled } = nutritionFor(appleNutrition, apple, 1, mediumApple);
    // 182 g at 0.52 kcal/g.
    expect(scaled.calories).toBeCloseTo(94.64, 6);
  });

  /**
   * A food whose source never reported saturated fat must not acquire a
   * figure by being scaled — 0.0 g looks like a measurement.
   */
  it('keeps unreported nutrients null rather than inventing zero', () => {
    const { scaled } = nutritionFor(appleNutrition, apple, 150, null);
    expect(scaled.saturated_fat_g).toBeNull();
  });

  it('returns zeros for a zero quantity', () => {
    const { scaled } = nutritionFor(appleNutrition, apple, 0, null);
    expect(scaled.calories).toBe(0);
    expect(scaled.protein_g).toBe(0);
  });

  it('handles a per-item food', () => {
    const egg: FoodBasis = { baseUnit: 'item', baseAmount: 1 };
    const eggNutrition: NutritionPerBase = {
      ...appleNutrition,
      calories: 78,
      protein_g: 6.3,
    };

    const { scaled } = nutritionFor(eggNutrition, egg, 3, null);
    expect(scaled.calories).toBeCloseTo(234, 10);
    expect(scaled.protein_g).toBeCloseTo(18.9, 10);
  });

  it('handles a per-100-ml food', () => {
    const milk: FoodBasis = { baseUnit: 'ml', baseAmount: 100 };
    const milkNutrition: NutritionPerBase = { ...appleNutrition, calories: 64 };

    const { scaled } = nutritionFor(milkNutrition, milk, 250, null);
    expect(scaled.calories).toBeCloseTo(160, 10);
  });

  it('rejects a non-positive base amount', () => {
    expect(() =>
      scaleNutrition(appleNutrition, { baseUnit: 'g', baseAmount: 0 }, {
        quantity: 1,
        serving: null,
        amountInBase: 100,
        baseUnit: 'g',
      }),
    ).toThrow();
  });

  it('round-trips: scaling to the base amount returns the base values', () => {
    const { scaled } = nutritionFor(appleNutrition, apple, 100, null);
    expect(scaled.calories).toBeCloseTo(appleNutrition.calories, 10);
    expect(scaled.carbohydrates_g).toBeCloseTo(appleNutrition.carbohydrates_g, 10);
  });
});

describe('sumNutrition', () => {
  const first = { ...appleNutrition, calories: 100, fiber_g: 2, sodium_mg: null };
  const second = { ...appleNutrition, calories: 50, fiber_g: null, sodium_mg: null };

  it('sums an empty list to zero', () => {
    expect(sumNutrition([]).calories).toBe(0);
  });

  it('sums required macros', () => {
    expect(sumNutrition([first, second]).calories).toBe(150);
  });

  /**
   * A partially-reported nutrient reports what is known. Treating the missing
   * contributor as zero would understate the total while looking exact.
   */
  it('sums the reported values when only some contributors have a nutrient', () => {
    expect(sumNutrition([first, second]).fiber_g).toBe(2);
  });

  it('stays null when no contributor reported a nutrient', () => {
    expect(sumNutrition([first, second]).sodium_mg).toBeNull();
  });
});

describe('servingOptions', () => {
  /**
   * Someone who weighed their food must never be forced through a named
   * portion, so a base-unit option is always offered.
   */
  it('always offers the base unit first', () => {
    const options = servingOptions(apple, [mediumApple]);
    expect(options[0]).toEqual({ label: '100 g', amount: 100, unit: 'g' });
    expect(options[1]).toEqual(mediumApple);
  });

  it('offers "1 item" for countable foods rather than 100 of them', () => {
    const egg: FoodBasis = { baseUnit: 'item', baseAmount: 1 };
    expect(servingOptions(egg, [])[0]).toEqual({
      label: '1 item',
      amount: 1,
      unit: 'item',
    });
  });

  it('offers millilitres for a liquid', () => {
    const drink: FoodBasis = { baseUnit: 'ml', baseAmount: 100 };
    expect(servingOptions(drink, [])[0]?.label).toBe('100 ml');
  });

  /** A serving in the wrong unit cannot be converted, so it is not offered. */
  it('drops servings measured in a different unit', () => {
    const options = servingOptions(apple, [
      mediumApple,
      { label: '1 splash', amount: 10, unit: 'ml' },
    ]);
    expect(options).toHaveLength(2);
    expect(options.every((option) => option.unit === 'g')).toBe(true);
  });
});

describe('display rounding', () => {
  it('rounds energy to whole kcal', () => {
    expect(displayEnergy(78.4)).toBe(78);
    expect(displayEnergy(78.6)).toBe(79);
  });

  it('rounds macros to one decimal', () => {
    expect(displayMacro(13.84)).toBe(13.8);
    expect(displayMacro(null)).toBeNull();
  });

  /**
   * Rounding is for display only — the rounded number must never be fed back
   * into the arithmetic, or a day's total drifts by the accumulated error.
   */
  it('does not affect the underlying calculation', () => {
    const { scaled } = nutritionFor(appleNutrition, apple, 33, null);
    expect(displayEnergy(scaled.calories)).toBe(17);
    expect(scaled.calories).toBeCloseTo(17.16, 6);
  });
});
