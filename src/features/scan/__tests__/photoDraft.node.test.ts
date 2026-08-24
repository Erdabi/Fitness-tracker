import type { MealEstimation, PhotoItem } from '@/features/ai/schemas';
import {
  changeQuantity,
  draftFromItem,
  draftsFromMeal,
  editNutrient,
  resolvePhotoDraft,
} from '../photoDraft';

/**
 * The editable form behind a food-photo review.
 *
 * The behaviours that matter here are about consent and about arithmetic:
 * nothing the model is unsure of is selected by default, and correcting a
 * portion moves its nutrition with it instead of leaving a figure that no
 * longer describes anything.
 */

function item(overrides: Partial<PhotoItem> = {}): PhotoItem {
  return {
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
    ...overrides,
  };
}

const meal = (items: PhotoItem[]): MealEstimation => ({
  status: 'success',
  confidence: 'medium',
  items,
  warnings: [],
});

describe('draftsFromMeal', () => {
  it('makes one independent draft per item', () => {
    const drafts = draftsFromMeal(meal([item(), item({ name: 'Rice' })]));

    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.key).not.toBe(drafts[1]!.key);
  });

  it('selects confident items by default', () => {
    const drafts = draftsFromMeal(meal([item({ confidence: 'high' })]));
    expect(drafts[0]!.include).toBe(true);
  });

  it('leaves a low-confidence item switched off', () => {
    // The model saying "this might be chicken" must not become a diary entry
    // unless the user actively agrees.
    const drafts = draftsFromMeal(meal([item({ confidence: 'low' })]));
    expect(drafts[0]!.include).toBe(false);
  });

  it('keeps a medium-confidence item selected but marked', () => {
    const drafts = draftsFromMeal(meal([item({ confidence: 'medium' })]));
    expect(drafts[0]!.include).toBe(true);
    expect(drafts[0]!.confidence).toBe('medium');
  });

  it('shows the estimate for the portion, not per 100 g', () => {
    const draft = draftFromItem(item(), 0);

    expect(draft.quantity).toBe('150');
    expect(draft.nutrients.calories).toBe('248');
  });

  it('leaves what a photo cannot show blank', () => {
    const draft = draftFromItem(item(), 0);

    expect(draft.nutrients.saturated_fat_g).toBe('');
    expect(draft.nutrients.sodium_mg).toBe('');
    expect(draft.nutrients.fiber_g).toBe('');
  });

  it('produces no drafts from an empty estimate', () => {
    expect(draftsFromMeal(meal([]))).toEqual([]);
  });
});

describe('changeQuantity', () => {
  it('scales the nutrition with the corrected portion', () => {
    const draft = changeQuantity(draftFromItem(item(), 0), '300');

    expect(draft.quantity).toBe('300');
    expect(draft.nutrients.calories).toBe('496');
    expect(draft.nutrients.protein_g).toBe('93');
  });

  it('scales down as well as up', () => {
    const draft = changeQuantity(draftFromItem(item(), 0), '75');
    expect(draft.nutrients.calories).toBe('124');
  });

  it('leaves blank fields blank instead of inventing a scaled value', () => {
    const draft = changeQuantity(draftFromItem(item(), 0), '300');
    expect(draft.nutrients.fiber_g).toBe('');
  });

  it('scales correctly when the field is cleared and retyped', () => {
    // Clearing the box to type a new number must neither zero the nutrition
    // on the way past nor lose the portion it was scaled from.
    const cleared = changeQuantity(draftFromItem(item(), 0), '');

    expect(cleared.quantity).toBe('');
    expect(cleared.nutrients.calories).toBe('248');

    const retyped = changeQuantity(cleared, '300');
    // Scaled from 150 g, the portion the numbers describe — not from the
    // blank the field passed through.
    expect(retyped.nutrients.calories).toBe('496');
  });

  it('scales from the portion a hand-typed figure described', () => {
    const draft = draftFromItem(item(), 0);
    // "At 150 g that is 300 kcal" — then "actually it was 300 g".
    const corrected = editNutrient(draft, 'calories', '300');
    const rescaled = changeQuantity(corrected, '300');

    expect(rescaled.nutrients.calories).toBe('600');
  });

  it('ignores a quantity of zero rather than dividing by it', () => {
    const draft = changeQuantity(draftFromItem(item(), 0), '0');
    expect(draft.nutrients.calories).toBe('248');
    expect(Number.isFinite(Number(draft.nutrients.calories))).toBe(true);
  });
});

describe('resolvePhotoDraft', () => {
  it('derives the per-100 basis the diary snapshot needs', () => {
    const { candidate } = resolvePhotoDraft(draftFromItem(item(), 0));

    expect(candidate?.baseAmount).toBe(100);
    expect(candidate?.quantity).toBe(150);
    expect(candidate?.nutrition.calories).toBeCloseTo(165.333, 2);
    // What the user actually confirmed is kept too, so it can be shown back.
    expect(candidate?.portion.calories).toBe(248);
  });

  it('derives per-one for a countable item', () => {
    const { candidate } = resolvePhotoDraft(
      draftFromItem(
        item({ name: 'Boiled egg', unit: 'item', estimatedQuantity: 2, calories: 156 }),
        0,
      ),
    );

    expect(candidate?.baseAmount).toBe(1);
    expect(candidate?.nutrition.calories).toBe(78);
  });

  it('carries a user correction through to what would be stored', () => {
    const corrected = changeQuantity(draftFromItem(item(), 0), '300');
    const { candidate } = resolvePhotoDraft(corrected);

    expect(candidate?.quantity).toBe(300);
    expect(candidate?.portion.calories).toBe(496);
    // Same food, so the per-100 basis is unchanged by the portion correction.
    expect(candidate?.nutrition.calories).toBeCloseTo(165.333, 2);
  });

  it('honours a nutrition correction at the same portion', () => {
    const draft = draftFromItem(item(), 0);
    const { candidate } = resolvePhotoDraft({
      ...draft,
      nutrients: { ...draft.nutrients, calories: '300' },
    });

    expect(candidate?.portion.calories).toBe(300);
    expect(candidate?.nutrition.calories).toBe(200);
  });

  it('refuses a portion of nothing', () => {
    const draft = draftFromItem(item(), 0);
    const { candidate, fieldErrors } = resolvePhotoDraft({ ...draft, quantity: '0' });

    expect(candidate).toBeNull();
    expect(fieldErrors.quantity).toBeDefined();
  });

  it('requires a name', () => {
    const draft = draftFromItem(item(), 0);
    const { candidate, fieldErrors } = resolvePhotoDraft({ ...draft, name: '  ' });

    expect(candidate).toBeNull();
    expect(fieldErrors.name).toBeDefined();
  });

  it('rejects an edit that makes the food physically impossible', () => {
    const draft = draftFromItem(item(), 0);
    const { candidate, problems } = resolvePhotoDraft({
      ...draft,
      // 2,480 kcal in 150 g is over 1,600 kcal per 100 g.
      nutrients: { ...draft.nutrients, calories: '2480' },
    });

    expect(candidate).toBeNull();
    expect(problems.length).toBeGreaterThan(0);
  });

  it('keeps an optional nutrient null all the way through', () => {
    const { candidate } = resolvePhotoDraft(draftFromItem(item(), 0));

    expect(candidate?.nutrition.fiber_g).toBeNull();
    expect(candidate?.nutrition.sodium_mg).toBeNull();
  });

  it('keeps the item confidence on the candidate', () => {
    const { candidate } = resolvePhotoDraft(
      draftFromItem(item({ confidence: 'low' }), 0),
    );

    expect(candidate?.confidence).toBe('low');
  });
});
