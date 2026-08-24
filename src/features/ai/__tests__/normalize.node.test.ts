import {
  KJ_PER_KCAL,
  SODIUM_FRACTION_OF_SALT,
  kjToKcal,
  normalizeLabel,
  normalizeMeal,
  normalizePhotoItem,
  saltToSodiumMg,
  validateNutrients,
} from '../normalize';
import type { LabelExtraction, PhotoItem } from '../schemas';

/**
 * The conversions and the gate.
 *
 * These are the arithmetic the model is deliberately not asked to do, so they
 * are the arithmetic that has to be right here. The cases are drawn from real
 * label layouts: a UK panel printing kJ and salt, a US panel printing kcal and
 * sodium, and a per-serving panel that has to be rescaled.
 */

function labelWith(overrides: Partial<LabelExtraction> = {}): LabelExtraction {
  return {
    status: 'success',
    confidence: 'high',
    productName: 'Rolled oats',
    brand: 'Own brand',
    servingSize: null,
    servingsPerContainer: null,
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
    barcode: null,
    warnings: [],
    ...overrides,
  };
}

describe('unit conversions', () => {
  it('uses the defined thermochemical ratio', () => {
    expect(KJ_PER_KCAL).toBe(4.184);
    expect(kjToKcal(2000)).toBeCloseTo(478.01, 2);
  });

  it('derives sodium from salt at the mass fraction of sodium in NaCl', () => {
    expect(SODIUM_FRACTION_OF_SALT).toBe(0.3934);
    // A 1.2 g salt label is a 472 mg sodium label.
    expect(saltToSodiumMg(1.2)).toBeCloseTo(472.08, 2);
  });
});

describe('normalizeLabel', () => {
  it('passes a complete per-100 g label through unchanged', () => {
    const result = normalizeLabel(labelWith());

    expect(result.nutrition.calories).toBe(379);
    expect(result.nutrition.protein_g).toBe(13.2);
    expect(result.baseUnit).toBe('g');
    expect(result.baseAmount).toBe(100);
    expect(result.problems).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it('reports a nutrient the label did not state as missing, not as zero', () => {
    const result = normalizeLabel(
      labelWith({
        nutrients: {
          ...labelWith().nutrients,
          fiber_g: null,
          sugars_g: null,
          sodium_mg: null,
          salt_g: null,
        },
      }),
    );

    expect(result.nutrition.fiber_g).toBeNull();
    expect(result.nutrition.sugar_g).toBeNull();
    expect(result.nutrition.sodium_mg).toBeNull();
    expect(result.missing).toEqual(
      expect.arrayContaining(['fiber_g', 'sugar_g', 'sodium_mg']),
    );
  });

  it('converts kilojoules when only kilojoules are printed, and says so', () => {
    const result = normalizeLabel(
      labelWith({
        nutrients: { ...labelWith().nutrients, energy: { kcal: null, kj: 1586 } },
      }),
    );

    expect(result.nutrition.calories).toBeCloseTo(379.1, 1);
    expect(result.notes.join(' ')).toContain('1586 kJ');
  });

  it('prefers the printed kcal over the printed kJ when both are given', () => {
    const result = normalizeLabel(
      labelWith({
        // Deliberately inconsistent: the printed kcal must win, because it is
        // what the manufacturer declared.
        nutrients: { ...labelWith().nutrients, energy: { kcal: 379, kj: 9999 } },
      }),
    );

    expect(result.nutrition.calories).toBe(379);
    expect(result.notes.join(' ')).not.toContain('kJ');
  });

  it('derives sodium from salt when only salt is printed', () => {
    const result = normalizeLabel(
      labelWith({
        nutrients: { ...labelWith().nutrients, sodium_mg: null, salt_g: 1.2 },
      }),
    );

    expect(result.nutrition.sodium_mg).toBeCloseTo(472.1, 1);
    expect(result.notes.join(' ')).toContain('salt');
  });

  it('leaves a printed sodium alone even when salt is also printed', () => {
    const result = normalizeLabel(
      labelWith({ nutrients: { ...labelWith().nutrients, sodium_mg: 6, salt_g: 99 } }),
    );

    expect(result.nutrition.sodium_mg).toBe(6);
  });

  it('rescales a per-serving panel to the per-100 basis', () => {
    const result = normalizeLabel(
      labelWith({
        basis: 'per_serving',
        servingSize: { amount: 40, unit: 'g' },
        nutrients: {
          ...labelWith().nutrients,
          energy: { kcal: 152, kj: null },
          protein_g: 5.3,
          carbohydrates_g: 27.1,
          fat_g: 2.6,
          fiber_g: 4,
          sugars_g: 0.4,
          saturated_fat_g: 0.4,
          sodium_mg: 2.4,
        },
      }),
    );

    // 152 kcal per 40 g is 380 kcal per 100 g.
    expect(result.nutrition.calories).toBe(380);
    expect(result.nutrition.protein_g).toBeCloseTo(13.25, 2);
    expect(result.serving).toEqual({ label: '1 serving (40 g)', amount: 40, unit: 'g' });
    expect(result.problems).toEqual([]);
  });

  it('refuses to guess a serving size it was not given', () => {
    const result = normalizeLabel(
      labelWith({ basis: 'per_serving', servingSize: null }),
    );

    expect(result.problems.map((problem) => problem.field)).toContain('servingSize');
    // Nothing was invented in its place.
    expect(result.serving).toBeNull();
  });

  it('treats a per-100 ml panel as millilitres', () => {
    const result = normalizeLabel(labelWith({ basis: 'per_100ml' }));
    expect(result.baseUnit).toBe('ml');
  });

  it('blocks a label with no readable energy value', () => {
    const result = normalizeLabel(
      labelWith({
        nutrients: { ...labelWith().nutrients, energy: { kcal: null, kj: null } },
      }),
    );

    expect(result.problems.map((problem) => problem.field)).toContain('calories');
  });

  it('carries a barcode read off the packaging', () => {
    const result = normalizeLabel(labelWith({ barcode: '5000108000000' }));
    expect(result.barcode).toBe('5000108000000');
  });
});

describe('validateNutrients', () => {
  const sane = {
    calories: 379,
    protein_g: 13.2,
    carbohydrates_g: 67.7,
    fat_g: 6.5,
    fiber_g: 10.1,
    sugar_g: 1,
    saturated_fat_g: 1.1,
    sodium_mg: 6,
  };

  it('passes a real food', () => {
    expect(validateNutrients(sane)).toEqual([]);
  });

  it('catches a decimal point misread as a factor of ten', () => {
    const problems = validateNutrients({ ...sane, calories: 3790 });
    expect(problems.map((problem) => problem.field)).toContain('calories');
  });

  it('catches saturated fat exceeding total fat', () => {
    const problems = validateNutrients({ ...sane, saturated_fat_g: 9 });
    expect(problems.map((problem) => problem.field)).toContain('saturated_fat_g');
  });

  it('catches sugars exceeding carbohydrate', () => {
    const problems = validateNutrients({ ...sane, sugar_g: 90 });
    expect(problems.map((problem) => problem.field)).toContain('sugar_g');
  });

  it('catches macros that outweigh the food', () => {
    const problems = validateNutrients({
      ...sane,
      protein_g: 50,
      carbohydrates_g: 50,
      fat_g: 40,
    });
    expect(problems.map((problem) => problem.field)).toContain('macros');
  });

  it('catches an energy figure the macros cannot support', () => {
    // Macros imply ~380 kcal; the label claiming 38 is a misread.
    const problems = validateNutrients({ ...sane, calories: 38 });
    expect(problems.map((problem) => problem.field)).toContain('calories');
  });

  it('tolerates ordinary label rounding', () => {
    // Oats: macros imply 381.3 against a printed 379. Well inside tolerance.
    expect(validateNutrients({ ...sane, calories: 379 })).toEqual([]);
  });

  it('ignores relationships it cannot check', () => {
    // No macros at all: nothing to compare the energy against.
    expect(
      validateNutrients({
        calories: 379,
        fiber_g: null,
        sugar_g: null,
        saturated_fat_g: null,
        sodium_mg: null,
      }),
    ).toEqual([]);
  });
});

describe('normalizePhotoItem', () => {
  const item: PhotoItem = {
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
  };

  it('derives the per-100 basis from the estimated portion', () => {
    const result = normalizePhotoItem(item);

    expect(result.baseAmount).toBe(100);
    expect(result.nutrition.calories).toBeCloseTo(165.333, 2);
    expect(result.nutrition.protein_g).toBeCloseTo(31, 2);
  });

  it('keeps an unreported nutrient null through the division', () => {
    expect(normalizePhotoItem(item).nutrition.fiber_g).toBeNull();
  });

  it('treats a countable item as per one', () => {
    const result = normalizePhotoItem({
      ...item,
      name: 'Boiled egg',
      unit: 'item',
      estimatedQuantity: 2,
      calories: 156,
      protein_g: 12.6,
      fat_g: 10.6,
      carbohydrates_g: 1.1,
    });

    expect(result.baseAmount).toBe(1);
    expect(result.nutrition.calories).toBe(78);
  });

  it('keeps the confidence of each item separately', () => {
    const items = normalizeMeal({
      status: 'success',
      confidence: 'medium',
      items: [item, { ...item, name: 'Rice', confidence: 'low' }],
      warnings: [],
    });

    expect(items.map((entry) => entry.confidence)).toEqual(['high', 'low']);
  });

  it('never reports saturated fat or sodium, which a photo cannot show', () => {
    const result = normalizePhotoItem(item);
    expect(result.nutrition.saturated_fat_g).toBeNull();
    expect(result.nutrition.sodium_mg).toBeNull();
  });
});
