import type { NutritionPerBase } from '@/lib/nutrition';

/**
 * The editable nutrient set, in the order a label prints it.
 *
 * One list, used by both review screens and by the manual entry form, so a
 * field cannot be editable in one place and silently absent in another — which
 * is how a nutrient ends up saved as null by a route nobody re-checked.
 */

export type NutrientKey = keyof NutritionPerBase;

export interface NutrientField {
  readonly key: NutrientKey;
  readonly label: string;
  readonly unit: string;
  /**
   * Whether the catalogue requires a number.
   *
   * The four required ones are required by `NutritionPerBase`, not by
   * nutritional judgement — everything downstream (totals, goals, the diary
   * snapshot) reads them unconditionally. A required field left blank is a
   * blocking problem rather than a silent 0; see `resolveNutrientDraft`.
   */
  readonly required: boolean;
}

export const NUTRIENT_FIELDS: readonly NutrientField[] = [
  { key: 'calories', label: 'Energy', unit: 'kcal', required: true },
  { key: 'protein_g', label: 'Protein', unit: 'g', required: true },
  { key: 'carbohydrates_g', label: 'Carbohydrate', unit: 'g', required: true },
  { key: 'sugar_g', label: 'of which sugars', unit: 'g', required: false },
  { key: 'fiber_g', label: 'Fibre', unit: 'g', required: false },
  { key: 'fat_g', label: 'Fat', unit: 'g', required: true },
  { key: 'saturated_fat_g', label: 'of which saturates', unit: 'g', required: false },
  { key: 'sodium_mg', label: 'Sodium', unit: 'mg', required: false },
];

export type NutrientDraft = Record<NutrientKey, string>;

export const EMPTY_NUTRIENT_DRAFT: NutrientDraft = {
  calories: '',
  protein_g: '',
  carbohydrates_g: '',
  fat_g: '',
  fiber_g: '',
  sugar_g: '',
  saturated_fat_g: '',
  sodium_mg: '',
};

/**
 * Parses one typed number.
 *
 * Accepts a comma as the decimal separator, because the phone keyboard in most
 * of Europe offers a comma and typing 12,5 is not a user error. Returns
 * `undefined` for anything that is not a number, which the caller reports —
 * distinct from `null`, which means the field was deliberately left empty.
 */
export function parseNutrientText(text: string): number | null | undefined {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return null;

  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Renders a stored number back into an editable field. Null renders blank. */
export function nutrientText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  // Three decimals is the precision the rest of the pipeline rounds to, and
  // trailing zeros on a form field read as noise.
  return String(Math.round(value * 1000) / 1000);
}

export interface NutrientDraftResolution {
  readonly nutrition: NutritionPerBase | null;
  /** Field-keyed messages, for rendering under the offending input. */
  readonly fieldErrors: Readonly<Partial<Record<NutrientKey, string>>>;
}

/**
 * Turns typed text into nutrition, or explains why it cannot.
 *
 * Blank optional fields become null and stay null — the whole point of the
 * distinction. A blank *required* field is an error rather than a zero,
 * because "the label did not say" and "the label said none" are different
 * facts and only the user knows which one this is.
 */
export function resolveNutrientDraft(draft: NutrientDraft): NutrientDraftResolution {
  const fieldErrors: Partial<Record<NutrientKey, string>> = {};
  const values: Partial<Record<NutrientKey, number | null>> = {};

  for (const field of NUTRIENT_FIELDS) {
    const parsed = parseNutrientText(draft[field.key]);

    if (parsed === undefined) {
      fieldErrors[field.key] = 'Enter a number, or leave it empty.';
      continue;
    }

    if (parsed === null && field.required) {
      fieldErrors[field.key] = `${field.label} is needed. Enter 0 if there is none.`;
      continue;
    }

    values[field.key] = parsed;
  }

  if (Object.keys(fieldErrors).length > 0) return { nutrition: null, fieldErrors };

  return {
    nutrition: {
      calories: values.calories as number,
      protein_g: values.protein_g as number,
      carbohydrates_g: values.carbohydrates_g as number,
      fat_g: values.fat_g as number,
      fiber_g: values.fiber_g ?? null,
      sugar_g: values.sugar_g ?? null,
      saturated_fat_g: values.saturated_fat_g ?? null,
      sodium_mg: values.sodium_mg ?? null,
    },
    fieldErrors,
  };
}
