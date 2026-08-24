import { validateNutrients, type NutrientProblem } from '@/features/ai/normalize';
import type { Confidence, MealEstimation, PhotoItem } from '@/features/ai/schemas';
import type { BaseUnit, NutritionPerBase } from '@/lib/nutrition';
import { cleanName } from '@/lib/search';
import { round } from '@/lib/units';
import {
  EMPTY_NUTRIENT_DRAFT,
  nutrientText,
  parseNutrientText,
  type NutrientDraft,
  type NutrientKey,
} from './nutrientFields';

/**
 * The editable form behind a food-photo review.
 *
 * Different from a label in one way that shapes everything here: the model
 * estimates *this portion*, not a per-100 g panel. So the figures shown and
 * edited are the ones for what is on the plate — "roughly 180 g of rice, about
 * 230 kcal" — because that is the only form a person can sanity-check by
 * looking at their dinner. The per-100 basis the catalogue and the diary
 * snapshot need is derived at the end, in `resolvePhotoDraft`.
 *
 * Items are independent. A plate is usually one confident item and one guess,
 * and treating the plate as a single result would force the user to accept the
 * guess to keep the confident part.
 */

export interface PhotoItemDraft {
  /** Stable across edits, so React keys survive a rename. */
  readonly key: string;
  /** Excluded items are kept visible but never logged. */
  readonly include: boolean;
  readonly name: string;
  readonly quantity: string;
  readonly unit: BaseUnit;
  /**
   * The quantity `nutrients` currently describes.
   *
   * Held separately from `quantity`, which is text and is briefly meaningless
   * while it is being retyped. Scaling from this rather than from the previous
   * text is what makes clearing the box and typing a new number behave the
   * same as editing it in place — otherwise the nutrition would silently stay
   * at whatever the last portion was.
   */
  readonly basisQuantity: number;
  /** Nutrition for the whole portion, as estimated or as corrected. */
  readonly nutrients: NutrientDraft;
  readonly confidence: Confidence;
}

/**
 * One draft per estimated item.
 *
 * Low-confidence items start excluded. The model saying "I am not sure this is
 * chicken" and the app logging it anyway unless the user notices is precisely
 * the automatic-logging failure this milestone is meant to make impossible;
 * making the user opt in costs one tap and makes the decision explicit.
 */
export function draftsFromMeal(meal: MealEstimation): PhotoItemDraft[] {
  return meal.items.map((item, index) => draftFromItem(item, index));
}

export function draftFromItem(item: PhotoItem, index: number): PhotoItemDraft {
  const nutrients: NutrientDraft = {
    ...EMPTY_NUTRIENT_DRAFT,
    calories: nutrientText(item.calories),
    protein_g: nutrientText(item.protein_g),
    carbohydrates_g: nutrientText(item.carbohydrates_g),
    fat_g: nutrientText(item.fat_g),
    fiber_g: nutrientText(item.fiber_g),
    sugar_g: nutrientText(item.sugars_g),
    // A photograph cannot show saturated fat or sodium, and the model is told
    // not to invent them. They stay blank and editable.
  };

  return {
    key: `${index}:${item.name}`,
    include: item.confidence !== 'low',
    name: item.name,
    quantity: nutrientText(item.estimatedQuantity),
    basisQuantity: item.estimatedQuantity,
    unit: item.unit,
    nutrients,
    confidence: item.confidence,
  };
}

/**
 * Rescales a portion's nutrition when its quantity changes.
 *
 * "That was 250 g, not 150" should move the calories with it — the model's
 * estimate of what the food *is* survives, only how much of it changes. The
 * alternative, leaving the numbers alone, would silently turn a correction
 * into a fabrication.
 *
 * Only applied when both the old and the new quantity are usable numbers, so
 * clearing the field to retype it does not wipe the nutrition on the way past.
 */
export function changeQuantity(
  draft: PhotoItemDraft,
  nextQuantity: string,
): PhotoItemDraft {
  const next = parseNutrientText(nextQuantity);

  // Blank or unparseable: hold the numbers and wait for a real one.
  if (next === undefined || next === null || next <= 0 || draft.basisQuantity <= 0) {
    return { ...draft, quantity: nextQuantity };
  }

  const factor = next / draft.basisQuantity;
  const nutrients = { ...draft.nutrients };

  for (const key of Object.keys(nutrients) as NutrientKey[]) {
    const value = parseNutrientText(nutrients[key]);
    // Blank stays blank; unparseable text is left for the user to fix rather
    // than being replaced by a number derived from nothing.
    if (value === undefined || value === null) continue;
    nutrients[key] = nutrientText(round(value * factor, 3));
  }

  return { ...draft, quantity: nextQuantity, basisQuantity: next, nutrients };
}

/**
 * Edits one nutrient of the portion.
 *
 * Rebases the draft onto the quantity currently in the box, because a figure
 * the user just typed describes the portion they are looking at. Without this,
 * a later quantity change would scale the new number from a stale basis.
 */
export function editNutrient(
  draft: PhotoItemDraft,
  key: NutrientKey,
  value: string,
): PhotoItemDraft {
  const quantity = parseNutrientText(draft.quantity);

  return {
    ...draft,
    basisQuantity:
      quantity === undefined || quantity === null || quantity <= 0
        ? draft.basisQuantity
        : quantity,
    nutrients: { ...draft.nutrients, [key]: value },
  };
}

export interface PhotoItemResolution {
  readonly candidate: PhotoItemCandidate | null;
  readonly fieldErrors: Readonly<Partial<Record<NutrientKey | 'name' | 'quantity', string>>>;
  readonly problems: readonly NutrientProblem[];
}

export interface PhotoItemCandidate {
  readonly name: string;
  readonly quantity: number;
  readonly unit: BaseUnit;
  /** 100 for g and ml, 1 for a countable item. */
  readonly baseAmount: number;
  /** Per `baseAmount` — what the catalogue stores and the diary snapshots. */
  readonly nutrition: NutritionPerBase;
  /** The whole portion, as confirmed. Shown back to the user. */
  readonly portion: NutritionPerBase;
  readonly confidence: Confidence;
}

/**
 * Turns one confirmed item into something loggable.
 *
 * The division back to a per-100 basis is the mirror of `normalizePhotoItem`,
 * and it is done here rather than there because the user may have changed both
 * the portion and its nutrition since. Deriving from the confirmed figures
 * means what is stored is what was on screen when the user pressed the button.
 *
 * Unlike a label, missing macros are treated as 0 rather than as a blocking
 * error: an estimate that omits fibre is normal, and the required macros are
 * always estimated. A blank one still has to be filled — the same rule as
 * everywhere else — which `resolveNutrientDraft` enforces via the shared field
 * list.
 */
export function resolvePhotoDraft(draft: PhotoItemDraft): PhotoItemResolution {
  const fieldErrors: Partial<Record<NutrientKey | 'name' | 'quantity', string>> = {};

  const name = cleanName(draft.name);
  if (!name) fieldErrors.name = 'Give this item a name.';

  const quantity = parseNutrientText(draft.quantity);
  if (quantity === undefined) {
    fieldErrors.quantity = 'Enter a number.';
  } else if (quantity === null || quantity <= 0) {
    fieldErrors.quantity = 'How much of this was there?';
  }

  const portionValues: Partial<Record<NutrientKey, number | null>> = {};
  for (const key of Object.keys(draft.nutrients) as NutrientKey[]) {
    const parsed = parseNutrientText(draft.nutrients[key]);
    if (parsed === undefined) {
      fieldErrors[key] = 'Enter a number, or leave it empty.';
      continue;
    }
    if (parsed === null && isRequired(key)) {
      fieldErrors[key] = 'Needed. Enter 0 if there is none.';
      continue;
    }
    portionValues[key] = parsed;
  }

  if (Object.keys(fieldErrors).length > 0 || quantity == null) {
    return { candidate: null, fieldErrors, problems: [] };
  }

  const portion: NutritionPerBase = {
    calories: portionValues.calories as number,
    protein_g: portionValues.protein_g as number,
    carbohydrates_g: portionValues.carbohydrates_g as number,
    fat_g: portionValues.fat_g as number,
    fiber_g: portionValues.fiber_g ?? null,
    sugar_g: portionValues.sugar_g ?? null,
    saturated_fat_g: portionValues.saturated_fat_g ?? null,
    sodium_mg: portionValues.sodium_mg ?? null,
  };

  const baseAmount = draft.unit === 'item' ? 1 : 100;
  const factor = baseAmount / quantity;
  const scale = (value: number | null): number | null =>
    value === null ? null : round(value * factor, 3);

  const nutrition: NutritionPerBase = {
    calories: round(portion.calories * factor, 3),
    protein_g: round(portion.protein_g * factor, 3),
    carbohydrates_g: round(portion.carbohydrates_g * factor, 3),
    fat_g: round(portion.fat_g * factor, 3),
    fiber_g: scale(portion.fiber_g),
    sugar_g: scale(portion.sugar_g),
    saturated_fat_g: scale(portion.saturated_fat_g),
    sodium_mg: scale(portion.sodium_mg),
  };

  /*
   * Validated on the per-100 basis, which is the only basis the limits are
   * expressed in. A countable item is exempt: a whole pizza legitimately
   * exceeds 1,000 kcal "per 1 item", and applying a per-100-g ceiling to it
   * would reject correct data.
   */
  const problems = draft.unit === 'item' ? [] : validateNutrients(nutrition);

  if (problems.length > 0) return { candidate: null, fieldErrors, problems };

  return {
    candidate: {
      name,
      quantity,
      unit: draft.unit,
      baseAmount,
      nutrition,
      portion,
      confidence: draft.confidence,
    },
    fieldErrors,
    problems,
  };
}

function isRequired(key: NutrientKey): boolean {
  return (
    key === 'calories' ||
    key === 'protein_g' ||
    key === 'carbohydrates_g' ||
    key === 'fat_g'
  );
}
