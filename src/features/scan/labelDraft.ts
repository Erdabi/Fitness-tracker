import type { NormalizedLabel, NutrientProblem } from '@/features/ai/normalize';
import { validateNutrients } from '@/features/ai/normalize';
import type { BaseUnit, NutritionPerBase, Serving } from '@/lib/nutrition';
import { cleanName, hasValidCheckDigit, normalizeBarcode } from '@/lib/search';
import {
  EMPTY_NUTRIENT_DRAFT,
  nutrientText,
  parseNutrientText,
  resolveNutrientDraft,
  type NutrientDraft,
  type NutrientKey,
} from './nutrientFields';

/**
 * The editable form behind a label review.
 *
 * Pure, and separate from the screen for the same reason the calorie
 * calculator is: this is where the rules live about what a scanned label may
 * become, and rules that live inside a component cannot be tested against the
 * cases that matter — a partial read, a missing serving size, a misplaced
 * decimal point.
 *
 * Everything is held as text, because that is what a `TextInput` produces and
 * because parsing on every keystroke would fight the user mid-number ("1." is
 * not yet a number, but it is on its way to being one). Nothing is parsed
 * until `resolveLabelDraft`.
 *
 * Nothing is saved from here either. This module produces a *candidate*; the
 * screen shows it, the user confirms it, and only then does anything reach the
 * diary or the catalogue.
 */

export interface LabelDraft {
  readonly name: string;
  readonly brand: string;
  readonly baseUnit: BaseUnit;
  readonly barcode: string;
  readonly nutrients: NutrientDraft;
  /** Blank when the label stated no serving; never guessed. */
  readonly servingAmount: string;
  readonly servingLabel: string;
}

export const EMPTY_LABEL_DRAFT: LabelDraft = {
  name: '',
  brand: '',
  baseUnit: 'g',
  barcode: '',
  nutrients: EMPTY_NUTRIENT_DRAFT,
  servingAmount: '',
  servingLabel: '',
};

/**
 * Prefills the form from a read label.
 *
 * A nutrient the model could not read is rendered blank rather than as the
 * catalogue's 0 fallback — see `NormalizedLabel.missing`. A blank field asks
 * to be filled; a 0 looks like an answer.
 *
 * `barcodeHint` carries the code across from a barcode scan that found nothing
 * in the catalogue, so a user who scanned the packet and then photographed its
 * panel does not have to type the digits they already scanned.
 */
export function draftFromLabel(
  label: NormalizedLabel,
  barcodeHint?: string | null,
): LabelDraft {
  const missing = new Set<NutrientKey>(label.missing);

  const nutrients = { ...EMPTY_NUTRIENT_DRAFT };
  for (const key of Object.keys(nutrients) as NutrientKey[]) {
    nutrients[key] = missing.has(key) ? '' : nutrientText(label.nutrition[key]);
  }

  return {
    name: label.name ?? '',
    brand: label.brand ?? '',
    baseUnit: label.baseUnit,
    // The scanned code wins over one read off the packet in the photograph:
    // it came from a decoder with a check digit, not from pixels.
    barcode: barcodeHint ?? label.barcode ?? '',
    nutrients,
    servingAmount: label.serving ? nutrientText(label.serving.amount) : '',
    servingLabel: label.serving?.label ?? '',
  };
}

export interface LabelDraftResolution {
  /** Present only when everything parses and validates. */
  readonly candidate: LabelCandidate | null;
  readonly fieldErrors: Readonly<Partial<Record<NutrientKey | 'name' | 'servingAmount' | 'barcode', string>>>;
  /** Cross-field problems, shown together above the save button. */
  readonly problems: readonly NutrientProblem[];
}

export interface LabelCandidate {
  readonly name: string;
  readonly brandName: string | null;
  readonly baseUnit: BaseUnit;
  /** 100 for g and ml; 1 for a countable food entered by hand. */
  readonly baseAmount: number;
  readonly nutrition: NutritionPerBase;
  readonly serving: Serving | null;
  readonly barcode: string | null;
}

/**
 * Validates the form and, if it holds together, produces what would be saved.
 *
 * Runs the same `validateNutrients` gate the model's output went through, so a
 * user who hand-types an impossible number is stopped by exactly the rule that
 * stops the model from returning one. There is no editor override: the check
 * is about physical possibility, not about trusting the source.
 */
export function resolveLabelDraft(draft: LabelDraft): LabelDraftResolution {
  const fieldErrors: Partial<
    Record<NutrientKey | 'name' | 'servingAmount' | 'barcode', string>
  > = {};

  const name = cleanName(draft.name);
  if (!name) fieldErrors.name = 'Give the food a name.';

  const nutrients = resolveNutrientDraft(draft.nutrients);
  Object.assign(fieldErrors, nutrients.fieldErrors);

  /*
   * A serving is optional, but a half-filled one is not: an amount with no
   * label cannot be shown in a picker, and a label with no amount cannot be
   * scaled. Either both or neither.
   */
  let serving: Serving | null = null;
  const servingAmount = parseNutrientText(draft.servingAmount);
  const servingLabel = draft.servingLabel.trim();

  if (servingAmount === undefined) {
    fieldErrors.servingAmount = 'Enter a number, or leave it empty.';
  } else if (servingAmount !== null) {
    if (servingAmount <= 0) {
      fieldErrors.servingAmount = 'A serving has to be larger than zero.';
    } else {
      serving = {
        label: servingLabel || `1 serving (${servingAmount} ${draft.baseUnit})`,
        amount: servingAmount,
        unit: draft.baseUnit,
      };
    }
  } else if (servingLabel) {
    fieldErrors.servingAmount = `Enter how many ${draft.baseUnit} "${servingLabel}" is.`;
  }

  /*
   * A barcode is only attached when it decodes and its check digit is right.
   * A wrong code is worse than none: it makes the next scan of some other
   * product resolve to this food.
   */
  let barcode: string | null = null;
  const typedBarcode = draft.barcode.trim();
  if (typedBarcode) {
    const normalized = normalizeBarcode(typedBarcode);
    if (!normalized || !hasValidCheckDigit(normalized.barcode)) {
      fieldErrors.barcode = 'That is not a valid barcode. Leave it empty to skip it.';
    } else {
      barcode = normalized.barcode;
    }
  }

  /*
   * The limits are expressed per 100 g, so they only apply to a food measured
   * that way. A countable item is exempt: a whole pizza legitimately exceeds
   * 1,000 kcal "per 1 item", and rejecting it would refuse correct data.
   */
  const problems =
    nutrients.nutrition && draft.baseUnit !== 'item'
      ? validateNutrients(nutrients.nutrition)
      : [];

  const hasFieldError = Object.keys(fieldErrors).length > 0;
  if (hasFieldError || problems.length > 0 || !nutrients.nutrition || !name) {
    return { candidate: null, fieldErrors, problems };
  }

  return {
    candidate: {
      name,
      brandName: cleanName(draft.brand) || null,
      baseUnit: draft.baseUnit,
      baseAmount: draft.baseUnit === 'item' ? 1 : 100,
      nutrition: nutrients.nutrition,
      serving,
      barcode,
    },
    fieldErrors,
    problems,
  };
}
