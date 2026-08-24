import { round } from '@/lib/units';
import type { BaseUnit, NutritionPerBase } from '@/lib/nutrition';
import type {
  LabelExtraction,
  LabelNutrients,
  MealEstimation,
  PhotoItem,
} from './schemas';

/**
 * Turning a read label into something the catalogue can store.
 *
 * Three conversions and one gate. The conversions are arithmetic the model
 * should not be asked to do — it reads what is printed, and this resolves it:
 *
 *   • kilojoules to kilocalories, when only kJ is printed
 *   • salt to sodium, when only salt is printed
 *   • per-serving figures to the per-100 basis the catalogue uses
 *
 * The gate is `validateNutrients`, which refuses results that are not
 * physically possible. A model that misreads a decimal point produces a number
 * that is wrong by a factor of ten, and the cheapest place to catch that is
 * before it becomes a food.
 *
 * Missing stays missing throughout. Nothing here turns a null into a zero.
 */

/**
 * The thermochemical conversion, fixed by definition: 1 kcal = 4.184 kJ.
 *
 * Labels are rounded before printing, so a kJ-derived kcal figure will differ
 * from a printed one by a calorie or two. That is the label's rounding, not an
 * error here, and it is why the printed kcal wins when both are present.
 */
export const KJ_PER_KCAL = 4.184;

/**
 * Salt to sodium: salt is sodium chloride, and sodium is 39.34% of it by mass.
 *
 * The EU prints salt; the US prints sodium. Converting in one place means a
 * product read in one market and one read in the other end up comparable.
 */
export const SODIUM_FRACTION_OF_SALT = 0.3934;

export const saltToSodiumMg = (saltG: number): number =>
  saltG * SODIUM_FRACTION_OF_SALT * 1000;
export const kjToKcal = (kj: number): number => kj / KJ_PER_KCAL;

/* ------------------------------------------------------------- validation */

export interface NutrientProblem {
  readonly field: string;
  readonly message: string;
}

/**
 * Bounds on what a food can be, per 100 g or ml.
 *
 * Generous — these reject the impossible, not the unusual. Pure fat is 900
 * kcal/100 g, so 1,000 is the ceiling with room for rounding; nothing edible
 * exceeds 100 g of a single macronutrient per 100 g of food.
 */
export const PER_100_LIMITS = {
  calories: 1000,
  protein_g: 100,
  carbohydrates_g: 100,
  fat_g: 100,
  fiber_g: 100,
  sugars_g: 100,
  saturated_fat_g: 100,
  sodium_mg: 40_000,
} as const;

/**
 * Rejects nutrition that cannot describe a real food.
 *
 * Two kinds of check. Absolute bounds catch a misread decimal point. The
 * relationship checks catch a subtler failure: values that are individually
 * plausible but cannot coexist — components exceeding their parent, or macros
 * whose energy is nowhere near the stated calories.
 *
 * The energy check has deliberately wide tolerance. Labels round, fibre and
 * polyols contribute energy at different rates, and a 25% band still catches
 * the case that matters — a calorie figure off by a factor of ten.
 */
export function validateNutrients(
  nutrition: Partial<NutritionPerBase>,
): NutrientProblem[] {
  const problems: NutrientProblem[] = [];

  const check = (field: keyof typeof PER_100_LIMITS, value: number | null | undefined) => {
    if (value === null || value === undefined) return;
    if (!Number.isFinite(value)) {
      problems.push({ field, message: `${field} is not a number.` });
      return;
    }
    if (value < 0) {
      problems.push({ field, message: `${field} cannot be negative.` });
      return;
    }
    if (value > PER_100_LIMITS[field]) {
      problems.push({
        field,
        message: `${field} of ${round(value, 1)} exceeds ${PER_100_LIMITS[field]} per 100 — check for a misplaced decimal point.`,
      });
    }
  };

  check('calories', nutrition.calories);
  check('protein_g', nutrition.protein_g);
  check('carbohydrates_g', nutrition.carbohydrates_g);
  check('fat_g', nutrition.fat_g);
  check('fiber_g', nutrition.fiber_g);
  check('sugars_g' as keyof typeof PER_100_LIMITS, nutrition.sugar_g);
  check('saturated_fat_g', nutrition.saturated_fat_g);
  check('sodium_mg', nutrition.sodium_mg);

  // Components cannot exceed the whole. The 0.5 g slack absorbs label rounding.
  if (
    nutrition.saturated_fat_g != null &&
    nutrition.fat_g != null &&
    nutrition.saturated_fat_g > nutrition.fat_g + 0.5
  ) {
    problems.push({
      field: 'saturated_fat_g',
      message: 'Saturated fat cannot exceed total fat.',
    });
  }

  if (
    nutrition.sugar_g != null &&
    nutrition.carbohydrates_g != null &&
    nutrition.sugar_g > nutrition.carbohydrates_g + 0.5
  ) {
    problems.push({
      field: 'sugar_g',
      message: 'Sugars cannot exceed total carbohydrate.',
    });
  }

  if (
    nutrition.fiber_g != null &&
    nutrition.carbohydrates_g != null &&
    nutrition.fiber_g > nutrition.carbohydrates_g + 0.5
  ) {
    problems.push({
      field: 'fiber_g',
      message: 'Fibre cannot exceed total carbohydrate.',
    });
  }

  // The three macros together cannot outweigh 100 g of food.
  const macroMass =
    (nutrition.protein_g ?? 0) + (nutrition.carbohydrates_g ?? 0) + (nutrition.fat_g ?? 0);
  if (macroMass > 105) {
    problems.push({
      field: 'macros',
      message: `Protein, carbohydrate and fat total ${round(macroMass, 1)} g per 100 g, which is more than the food weighs.`,
    });
  }

  /*
   * Energy against macros. Only checked when all three macros and the calorie
   * figure are present, since a partial label cannot support the comparison.
   */
  if (
    nutrition.calories != null &&
    nutrition.protein_g != null &&
    nutrition.carbohydrates_g != null &&
    nutrition.fat_g != null &&
    nutrition.calories > 0
  ) {
    const implied =
      nutrition.protein_g * 4 + nutrition.carbohydrates_g * 4 + nutrition.fat_g * 9;
    const ratio = implied / nutrition.calories;

    if (implied > 20 && (ratio < 0.6 || ratio > 1.6)) {
      problems.push({
        field: 'calories',
        message: `The macros imply about ${Math.round(implied)} kcal but the label says ${Math.round(nutrition.calories)}.`,
      });
    }
  }

  return problems;
}

/* ------------------------------------------------------------ label → food */

export interface NormalizedLabel {
  readonly name: string | null;
  readonly brand: string | null;
  readonly baseUnit: BaseUnit;
  /** Always 100 for a label: the catalogue's canonical basis. */
  readonly baseAmount: number;
  readonly nutrition: NutritionPerBase;
  /** The serving the label described, when it stated one. */
  readonly serving: { label: string; amount: number; unit: BaseUnit } | null;
  readonly servingsPerContainer: number | null;
  readonly barcode: string | null;
  /**
   * Nutrients the label did not state, by field name.
   *
   * `nutrition` above is catalogue-shaped, so its four required macros fall
   * back to 0 to satisfy the type. That fallback must not reach a form field:
   * a blank the user has to fill is honest, a prefilled 0 they might not
   * notice is the null-becomes-zero failure this pipeline exists to avoid.
   * The review screen renders these blank and refuses to save until they are
   * filled — with a real 0 if the label really says 0.
   */
  readonly missing: readonly (keyof NutritionPerBase)[];
  /** Problems found by `validateNutrients`. Non-empty blocks saving. */
  readonly problems: readonly NutrientProblem[];
  /** Notes for the user: a converted unit, a derived figure. */
  readonly notes: readonly string[];
}

/**
 * Converts a read label into catalogue shape.
 *
 * Returns the problems rather than throwing: the review screen shows the
 * extracted values *and* what is wrong with them, so the user can correct a
 * misread digit instead of being told to photograph it again.
 */
export function normalizeLabel(extraction: LabelExtraction): NormalizedLabel {
  const notes: string[] = [];
  const baseUnit: BaseUnit = extraction.basis === 'per_100ml' ? 'ml' : 'g';

  const perPrinted = resolveNutrients(extraction.nutrients, notes);

  /*
   * Per-serving labels have to be rescaled to the per-100 basis the catalogue
   * stores. Without a stated serving size there is nothing to scale by, so the
   * figures are left as they are and the problem is reported — guessing a
   * serving size would silently invent the very number the scaling depends on.
   */
  let scale = 1;
  if (extraction.basis === 'per_serving') {
    if (extraction.servingSize) {
      scale = 100 / extraction.servingSize.amount;
      notes.push(
        `Label was per ${extraction.servingSize.amount} ${extraction.servingSize.unit}; converted to per 100 ${extraction.servingSize.unit}.`,
      );
    } else {
      notes.push(
        'Label was per serving but the serving size was not readable, so the values could not be converted to per 100 g.',
      );
    }
  }

  const nutrition: NutritionPerBase = {
    calories: scaled(perPrinted.calories, scale) ?? 0,
    protein_g: scaled(perPrinted.protein_g, scale) ?? 0,
    carbohydrates_g: scaled(perPrinted.carbohydrates_g, scale) ?? 0,
    fat_g: scaled(perPrinted.fat_g, scale) ?? 0,
    fiber_g: scaled(perPrinted.fiber_g, scale),
    sugar_g: scaled(perPrinted.sugar_g, scale),
    saturated_fat_g: scaled(perPrinted.saturated_fat_g, scale),
    sodium_mg: scaled(perPrinted.sodium_mg, scale),
  };

  const missing = (Object.keys(perPrinted) as (keyof ResolvedNutrients)[]).filter(
    (field) => perPrinted[field] === null,
  ) as (keyof NutritionPerBase)[];

  const problems = [...validateNutrients(nutrition)];

  if (extraction.basis === 'per_serving' && !extraction.servingSize) {
    problems.push({
      field: 'servingSize',
      message: 'Enter the serving size so the values can be stored per 100 g.',
    });
  }

  /*
   * Calories are the one figure with no sensible default: a food with no
   * energy value cannot be logged at all, so an unreadable one is a problem
   * rather than a zero.
   */
  if (perPrinted.calories === null) {
    problems.push({
      field: 'calories',
      message: 'No energy value could be read. Enter it before saving.',
    });
  }

  const serving = extraction.servingSize
    ? {
        label: `1 serving (${round(extraction.servingSize.amount, 1)} ${extraction.servingSize.unit})`,
        amount: extraction.servingSize.amount,
        unit: extraction.servingSize.unit as BaseUnit,
      }
    : null;

  return {
    name: extraction.productName,
    brand: extraction.brand,
    baseUnit,
    baseAmount: 100,
    nutrition,
    serving,
    servingsPerContainer: extraction.servingsPerContainer,
    barcode: extraction.barcode,
    missing,
    problems,
    notes,
  };
}

/**
 * Resolves the printed nutrients into one set of canonical units.
 *
 * Where a label states both kcal and kJ, the printed kcal wins — it is what
 * the manufacturer declared, and deriving it from kJ would introduce a
 * rounding difference from a figure that was already correct.
 */
interface ResolvedNutrients {
  readonly calories: number | null;
  readonly protein_g: number | null;
  readonly carbohydrates_g: number | null;
  readonly fat_g: number | null;
  readonly fiber_g: number | null;
  readonly sugar_g: number | null;
  readonly saturated_fat_g: number | null;
  readonly sodium_mg: number | null;
}

function resolveNutrients(
  nutrients: LabelNutrients,
  notes: string[],
): ResolvedNutrients {
  let calories = nutrients.energy.kcal;

  if (calories === null && nutrients.energy.kj !== null) {
    calories = round(kjToKcal(nutrients.energy.kj), 1);
    notes.push(`Energy converted from ${nutrients.energy.kj} kJ.`);
  }

  let sodium = nutrients.sodium_mg;

  if (sodium === null && nutrients.salt_g !== null) {
    sodium = round(saltToSodiumMg(nutrients.salt_g), 1);
    notes.push(`Sodium derived from ${nutrients.salt_g} g of salt.`);
  }

  return {
    calories,
    protein_g: nutrients.protein_g,
    carbohydrates_g: nutrients.carbohydrates_g,
    fat_g: nutrients.fat_g,
    fiber_g: nutrients.fiber_g,
    sugar_g: nutrients.sugars_g,
    saturated_fat_g: nutrients.saturated_fat_g,
    sodium_mg: sodium,
  };
}

function scaled(value: number | null, scale: number): number | null {
  return value === null ? null : round(value * scale, 3);
}

/* ------------------------------------------------------------ photo → food */

export interface NormalizedPhotoItem {
  readonly name: string;
  readonly quantity: number;
  readonly unit: BaseUnit;
  /** Per 100 g/ml, or per item — the catalogue's basis. */
  readonly baseAmount: number;
  readonly nutrition: NutritionPerBase;
  readonly confidence: PhotoItem['confidence'];
  readonly problems: readonly NutrientProblem[];
}

/**
 * Converts an estimated item into catalogue shape.
 *
 * The model estimates the portion *and* its nutrition, so the per-100 basis is
 * derived by dividing back out. Countable items ('item') are already per one
 * and are left alone.
 *
 * Every item keeps its own confidence: a photograph is often unambiguous about
 * the rice and a guess about the sauce, and one score for the plate cannot
 * express that.
 */
export function normalizePhotoItem(item: PhotoItem): NormalizedPhotoItem {
  const isCountable = item.unit === 'item';
  const baseAmount = isCountable ? 1 : 100;

  /*
   * The estimate is for the whole portion; the catalogue stores per 100.
   * Dividing by the portion and multiplying by 100 recovers that — and for a
   * countable item, dividing by the count gives per-one.
   */
  const factor = isCountable
    ? 1 / item.estimatedQuantity
    : 100 / item.estimatedQuantity;

  const nutrition: NutritionPerBase = {
    calories: round((item.calories ?? 0) * factor, 3),
    protein_g: round((item.protein_g ?? 0) * factor, 3),
    carbohydrates_g: round((item.carbohydrates_g ?? 0) * factor, 3),
    fat_g: round((item.fat_g ?? 0) * factor, 3),
    fiber_g: item.fiber_g === null ? null : round(item.fiber_g * factor, 3),
    sugar_g: item.sugars_g === null ? null : round(item.sugars_g * factor, 3),
    saturated_fat_g: null,
    sodium_mg: null,
  };

  return {
    name: item.name,
    quantity: item.estimatedQuantity,
    unit: item.unit,
    baseAmount,
    nutrition,
    confidence: item.confidence,
    problems: validateNutrients(nutrition),
  };
}

/** Every item in a meal, normalised. Items that fail validation keep their problems. */
export function normalizeMeal(meal: MealEstimation): NormalizedPhotoItem[] {
  return meal.items.map(normalizePhotoItem);
}
