import { normalizeLabel } from '@/features/ai/normalize';
import type { LabelExtraction } from '@/features/ai/schemas';
import {
  EMPTY_LABEL_DRAFT,
  draftFromLabel,
  resolveLabelDraft,
} from '../labelDraft';

/**
 * The editable form behind a label review, and the manual entry screen.
 *
 * The rules under test are the ones the user's own corrections have to pass:
 * a blank required field is not a zero, an impossible number is refused
 * whoever typed it, and a barcode is only kept if it actually is one.
 */

function extraction(overrides: Partial<LabelExtraction> = {}): LabelExtraction {
  return {
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
    barcode: null,
    warnings: [],
    ...overrides,
  };
}

const draftOf = (overrides: Partial<LabelExtraction> = {}, barcode?: string) =>
  draftFromLabel(normalizeLabel(extraction(overrides)), barcode ?? null);

describe('draftFromLabel', () => {
  it('prefills every value that was read', () => {
    const draft = draftOf();

    expect(draft.name).toBe('Rolled oats');
    expect(draft.brand).toBe('Own brand');
    expect(draft.nutrients.calories).toBe('379');
    expect(draft.nutrients.protein_g).toBe('13.2');
    expect(draft.servingAmount).toBe('40');
  });

  it('leaves an unreadable nutrient blank rather than showing a zero', () => {
    const draft = draftOf({
      nutrients: { ...extraction().nutrients, fiber_g: null, sodium_mg: null, salt_g: null },
    });

    expect(draft.nutrients.fiber_g).toBe('');
    expect(draft.nutrients.sodium_mg).toBe('');
    // The one thing this pipeline must never do.
    expect(draft.nutrients.fiber_g).not.toBe('0');
  });

  it('leaves an unreadable required macro blank too', () => {
    const draft = draftOf({
      nutrients: { ...extraction().nutrients, protein_g: null },
    });

    expect(draft.nutrients.protein_g).toBe('');
  });

  it('prefers a scanned barcode over one read off the packet in the photo', () => {
    // The scanned one came from a decoder with a check digit; the other from
    // pixels.
    const draft = draftOf({ barcode: '9999999999999' }, '5449000000996');
    expect(draft.barcode).toBe('5449000000996');
  });

  it('carries a barcode read off the packet when nothing was scanned', () => {
    expect(draftOf({ barcode: '5449000000996' }).barcode).toBe('5449000000996');
  });
});

describe('resolveLabelDraft', () => {
  it('produces a saveable candidate from a clean read', () => {
    const { candidate, problems } = resolveLabelDraft(draftOf());

    expect(problems).toEqual([]);
    expect(candidate).not.toBeNull();
    expect(candidate?.name).toBe('Rolled oats');
    expect(candidate?.baseAmount).toBe(100);
    expect(candidate?.nutrition.calories).toBe(379);
    expect(candidate?.serving).toEqual({
      label: '1 serving (40 g)',
      amount: 40,
      unit: 'g',
    });
  });

  it('refuses to save while a required field is blank', () => {
    const draft = draftOf({ nutrients: { ...extraction().nutrients, protein_g: null } });
    const { candidate, fieldErrors } = resolveLabelDraft(draft);

    expect(candidate).toBeNull();
    expect(fieldErrors.protein_g).toMatch(/0 if there is none/i);
  });

  it('accepts a real zero the user typed', () => {
    const draft = draftOf({ nutrients: { ...extraction().nutrients, protein_g: null } });
    const filled = {
      ...draft,
      nutrients: { ...draft.nutrients, protein_g: '0' },
    };

    const { candidate } = resolveLabelDraft(filled);
    expect(candidate?.nutrition.protein_g).toBe(0);
  });

  it('keeps a deliberately empty optional nutrient null', () => {
    const draft = draftOf({
      nutrients: { ...extraction().nutrients, fiber_g: null, sodium_mg: null, salt_g: null },
    });

    const { candidate } = resolveLabelDraft(draft);
    expect(candidate?.nutrition.fiber_g).toBeNull();
    expect(candidate?.nutrition.sodium_mg).toBeNull();
  });

  it('accepts a comma as a decimal separator', () => {
    const draft = draftOf();
    const { candidate } = resolveLabelDraft({
      ...draft,
      nutrients: { ...draft.nutrients, fat_g: '6,5' },
    });

    expect(candidate?.nutrition.fat_g).toBe(6.5);
  });

  it('rejects text typed into a number field', () => {
    const draft = draftOf();
    const { candidate, fieldErrors } = resolveLabelDraft({
      ...draft,
      nutrients: { ...draft.nutrients, fat_g: 'about six' },
    });

    expect(candidate).toBeNull();
    expect(fieldErrors.fat_g).toBeDefined();
  });

  it('requires a name', () => {
    const { candidate, fieldErrors } = resolveLabelDraft({
      ...draftOf(),
      name: '   ',
    });

    expect(candidate).toBeNull();
    expect(fieldErrors.name).toBeDefined();
  });

  it('applies the same impossibility check to a value the user typed', () => {
    // A hand-typed misplaced decimal point is refused exactly as a misread one
    // would be. The check is about physics, not about who supplied the number.
    const draft = draftOf();
    const { candidate, problems } = resolveLabelDraft({
      ...draft,
      nutrients: { ...draft.nutrients, calories: '3790' },
    });

    expect(candidate).toBeNull();
    expect(problems.map((problem) => problem.field)).toContain('calories');
  });

  it('refuses a serving with an amount but no sensible size', () => {
    const { candidate, fieldErrors } = resolveLabelDraft({
      ...draftOf(),
      servingAmount: '0',
    });

    expect(candidate).toBeNull();
    expect(fieldErrors.servingAmount).toBeDefined();
  });

  it('refuses a serving name with no size to scale it by', () => {
    const { candidate, fieldErrors } = resolveLabelDraft({
      ...draftOf(),
      servingAmount: '',
      servingLabel: '1 biscuit',
    });

    expect(candidate).toBeNull();
    expect(fieldErrors.servingAmount).toBeDefined();
  });

  it('allows no serving at all', () => {
    const { candidate } = resolveLabelDraft({
      ...draftOf(),
      servingAmount: '',
      servingLabel: '',
    });

    expect(candidate?.serving).toBeNull();
  });

  it('rejects a barcode whose check digit is wrong', () => {
    const { candidate, fieldErrors } = resolveLabelDraft({
      ...draftOf(),
      barcode: '5449000000997',
    });

    expect(candidate).toBeNull();
    expect(fieldErrors.barcode).toBeDefined();
  });

  it('keeps a valid barcode and normalises UPC-A to EAN-13', () => {
    const { candidate } = resolveLabelDraft({ ...draftOf(), barcode: '012000001291' });
    expect(candidate?.barcode).toBe('0012000001291');
  });

  it('treats a blank barcode as no barcode rather than an error', () => {
    const { candidate } = resolveLabelDraft({ ...draftOf(), barcode: '  ' });
    expect(candidate?.barcode).toBeNull();
  });

  it('uses a base amount of 1 for a countable food entered by hand', () => {
    const { candidate } = resolveLabelDraft({
      ...EMPTY_LABEL_DRAFT,
      name: 'Protein bar',
      baseUnit: 'item',
      nutrients: {
        ...EMPTY_LABEL_DRAFT.nutrients,
        calories: '204',
        protein_g: '20',
        carbohydrates_g: '21',
        fat_g: '6',
      },
    });

    expect(candidate?.baseAmount).toBe(1);
    expect(candidate?.baseUnit).toBe('item');
  });

  it('does not apply per-100 g limits to a countable food', () => {
    // A whole pizza legitimately exceeds 1,000 kcal "per 1 item".
    const { candidate } = resolveLabelDraft({
      ...EMPTY_LABEL_DRAFT,
      name: 'Whole pizza',
      baseUnit: 'item',
      nutrients: {
        ...EMPTY_LABEL_DRAFT.nutrients,
        calories: '2100',
        protein_g: '90',
        carbohydrates_g: '240',
        fat_g: '85',
      },
    });

    expect(candidate).not.toBeNull();
  });

  it('produces nothing at all from an empty form', () => {
    const { candidate } = resolveLabelDraft(EMPTY_LABEL_DRAFT);
    expect(candidate).toBeNull();
  });
});
