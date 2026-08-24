import {
  isUnusable,
  labelExtractionSchema,
  mealEstimationSchema,
  requiresReview,
} from '../schemas';

/**
 * The wire contract is the app's only defence against a model that returns
 * something plausible-looking and wrong. These tests are about what it
 * *refuses*, not what it accepts — an over-permissive schema is a schema that
 * lets a hallucination become a database row.
 */

const label = {
  status: 'success',
  confidence: 'high',
  productName: 'Rolled oats',
  brand: null,
  servingSize: { amount: 40, unit: 'g' },
  servingsPerContainer: 12,
  basis: 'per_100g',
  nutrients: {
    energy: { kcal: 379, kj: 1586 },
    protein_g: 13.2,
    carbohydrates_g: 67.7,
    sugars_g: 1,
    fiber_g: 10.1,
    fat_g: 6.5,
    saturated_fat_g: 1.1,
    sodium_mg: 6,
    salt_g: null,
  },
  barcode: '5000108000000',
  warnings: [],
};

describe('labelExtractionSchema', () => {
  it('accepts a complete, well-formed reading', () => {
    expect(labelExtractionSchema.safeParse(label).success).toBe(true);
  });

  it('keeps a missing nutrient as null rather than coercing it', () => {
    const parsed = labelExtractionSchema.parse({
      ...label,
      nutrients: { ...label.nutrients, fiber_g: null },
    });

    expect(parsed.nutrients.fiber_g).toBeNull();
    // The distinction the whole pipeline rests on.
    expect(parsed.nutrients.fiber_g).not.toBe(0);
  });

  it('rejects a negative nutrient', () => {
    const result = labelExtractionSchema.safeParse({
      ...label,
      nutrients: { ...label.nutrients, protein_g: -1 },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a nutrient sent as a string', () => {
    const result = labelExtractionSchema.safeParse({
      ...label,
      nutrients: { ...label.nutrients, protein_g: '13.2' },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a missing field rather than filling it in', () => {
    const { confidence: _confidence, ...withoutConfidence } = label;
    expect(labelExtractionSchema.safeParse(withoutConfidence).success).toBe(false);
  });

  it('rejects an invented status', () => {
    const result = labelExtractionSchema.safeParse({ ...label, status: 'probably_fine' });
    expect(result.success).toBe(false);
  });

  it('rejects a barcode that is not digits', () => {
    expect(
      labelExtractionSchema.safeParse({ ...label, barcode: '50001O8000000' }).success,
    ).toBe(false);
  });

  it('rejects a zero or negative serving size', () => {
    expect(
      labelExtractionSchema.safeParse({
        ...label,
        servingSize: { amount: 0, unit: 'g' },
      }).success,
    ).toBe(false);
  });

  it('caps the number of warnings so a response cannot be unbounded', () => {
    const result = labelExtractionSchema.safeParse({
      ...label,
      warnings: Array.from({ length: 11 }, (_, index) => `warning ${index}`),
    });

    expect(result.success).toBe(false);
  });
});

describe('mealEstimationSchema', () => {
  const item = {
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

  it('accepts an empty item list, which is how "I cannot tell" is expressed', () => {
    const parsed = mealEstimationSchema.parse({
      status: 'unable_to_determine',
      confidence: 'low',
      items: [],
      warnings: ['The plate is out of frame.'],
    });

    expect(parsed.items).toHaveLength(0);
  });

  it('accepts several items with independent confidences', () => {
    const parsed = mealEstimationSchema.parse({
      status: 'success',
      confidence: 'medium',
      items: [item, { ...item, name: 'Rice', confidence: 'low' }],
      warnings: [],
    });

    expect(parsed.items.map((entry) => entry.confidence)).toEqual(['high', 'low']);
  });

  it('rejects a zero portion, which cannot be scaled', () => {
    const result = mealEstimationSchema.safeParse({
      status: 'success',
      confidence: 'high',
      items: [{ ...item, estimatedQuantity: 0 }],
      warnings: [],
    });

    expect(result.success).toBe(false);
  });

  it('caps the item count', () => {
    const result = mealEstimationSchema.safeParse({
      status: 'success',
      confidence: 'high',
      items: Array.from({ length: 13 }, () => item),
      warnings: [],
    });

    expect(result.success).toBe(false);
  });
});

describe('requiresReview / isUnusable', () => {
  it('treats low confidence as needing review even when the status is success', () => {
    expect(requiresReview({ status: 'success', confidence: 'low' })).toBe(true);
  });

  it('treats needs_review as needing review at any confidence', () => {
    expect(requiresReview({ status: 'needs_review', confidence: 'high' })).toBe(true);
  });

  it('does not flag a clean, confident result', () => {
    expect(requiresReview({ status: 'success', confidence: 'high' })).toBe(false);
  });

  it('recognises both unusable statuses', () => {
    expect(isUnusable({ status: 'unable_to_extract' })).toBe(true);
    expect(isUnusable({ status: 'unable_to_determine' })).toBe(true);
    expect(isUnusable({ status: 'needs_review' })).toBe(false);
  });
});
