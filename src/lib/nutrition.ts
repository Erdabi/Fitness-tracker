/**
 * Nutrition arithmetic.
 *
 * Every nutrition number the user sees is computed here from the canonical
 * stored values. Nothing downstream — no screen, no diary row, no recipe —
 * may carry a precomputed figure of its own, because two sources of the same
 * number drift and the one on screen is the one people trust.
 *
 * The model: a food stores its nutrients for `baseAmount` of `baseUnit`
 * (100 g, 100 ml, or 1 item). A serving is a label plus its equivalent in
 * that same base unit. Logging resolves to a base quantity first, then scales
 * once.
 */

export type BaseUnit = 'g' | 'ml' | 'item';

/** Nutrients per `baseAmount` of `baseUnit`. Null means "not reported". */
export interface NutritionPerBase {
  readonly calories: number;
  readonly protein_g: number;
  readonly carbohydrates_g: number;
  readonly fat_g: number;
  readonly fiber_g: number | null;
  readonly sugar_g: number | null;
  readonly saturated_fat_g: number | null;
  readonly sodium_mg: number | null;
}

/** The same shape, scaled to an actual portion. */
export type ScaledNutrition = NutritionPerBase;

export interface FoodBasis {
  readonly baseUnit: BaseUnit;
  readonly baseAmount: number;
}

export interface Serving {
  readonly id?: string;
  readonly label: string;
  /** The serving's size expressed in the food's base unit. */
  readonly amount: number;
  readonly unit: BaseUnit;
}

/**
 * The quantity actually logged, resolved to the food's base unit.
 *
 * `quantity` is what the user chose (2 slices, 150 g); `amountInBase` is that
 * expressed in the base unit, and is the only number the arithmetic uses.
 */
export interface ResolvedQuantity {
  readonly quantity: number;
  readonly serving: Serving | null;
  readonly amountInBase: number;
  readonly baseUnit: BaseUnit;
}

/**
 * Resolves "2 × 1 slice" or "150 g" into a base quantity.
 *
 * A serving is only usable when it carries its equivalent in the base unit —
 * the schema requires one for exactly this reason. "1 slice" means nothing
 * arithmetically without the grams that go with it, and guessing would
 * fabricate data.
 */
export function resolveQuantity(
  food: FoodBasis,
  quantity: number,
  serving: Serving | null,
): ResolvedQuantity {
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error(`Quantity must be a non-negative number, got ${quantity}`);
  }

  if (serving) {
    if (serving.unit !== food.baseUnit) {
      // g and ml are not interchangeable without a density we do not have.
      throw new Error(
        `Serving "${serving.label}" is measured in ${serving.unit} but the food ` +
          `is measured in ${food.baseUnit}; there is no safe conversion.`,
      );
    }
    return {
      quantity,
      serving,
      amountInBase: quantity * serving.amount,
      baseUnit: food.baseUnit,
    };
  }

  // No serving: the quantity is already in base units (150 g of apple).
  return { quantity, serving: null, amountInBase: quantity, baseUnit: food.baseUnit };
}

/**
 * Scales nutrition to a resolved quantity.
 *
 * The single multiplication the whole feature rests on: if 100 g of apple is
 * 52 kcal, 150 g is 78 kcal. Null nutrients stay null — a food with no
 * reported fibre does not gain a fibre figure by being scaled.
 */
export function scaleNutrition(
  nutrition: NutritionPerBase,
  food: FoodBasis,
  resolved: ResolvedQuantity,
): ScaledNutrition {
  if (food.baseAmount <= 0) {
    throw new Error('Food baseAmount must be positive');
  }

  const factor = resolved.amountInBase / food.baseAmount;
  const scale = (value: number | null): number | null =>
    value === null ? null : value * factor;

  return {
    calories: nutrition.calories * factor,
    protein_g: nutrition.protein_g * factor,
    carbohydrates_g: nutrition.carbohydrates_g * factor,
    fat_g: nutrition.fat_g * factor,
    fiber_g: scale(nutrition.fiber_g),
    sugar_g: scale(nutrition.sugar_g),
    saturated_fat_g: scale(nutrition.saturated_fat_g),
    sodium_mg: scale(nutrition.sodium_mg),
  };
}

/** Convenience: resolve and scale in one step. */
export function nutritionFor(
  nutrition: NutritionPerBase,
  food: FoodBasis,
  quantity: number,
  serving: Serving | null,
): { resolved: ResolvedQuantity; scaled: ScaledNutrition } {
  const resolved = resolveQuantity(food, quantity, serving);
  return { resolved, scaled: scaleNutrition(nutrition, food, resolved) };
}

/**
 * Sums scaled nutrition, for a meal, a day or a recipe.
 *
 * A nutrient is null in the total only when *no* contributor reported it.
 * Treating one missing value as zero would understate the total while looking
 * precise, so a partially-known nutrient reports what is known.
 */
export function sumNutrition(entries: readonly ScaledNutrition[]): ScaledNutrition {
  if (entries.length === 0) {
    return {
      calories: 0,
      protein_g: 0,
      carbohydrates_g: 0,
      fat_g: 0,
      fiber_g: null,
      sugar_g: null,
      saturated_fat_g: null,
      sodium_mg: null,
    };
  }

  const addOptional = (
    key: 'fiber_g' | 'sugar_g' | 'saturated_fat_g' | 'sodium_mg',
  ): number | null => {
    const reported = entries.filter((entry) => entry[key] !== null);
    if (reported.length === 0) return null;
    return reported.reduce((total, entry) => total + (entry[key] ?? 0), 0);
  };

  return {
    calories: entries.reduce((total, entry) => total + entry.calories, 0),
    protein_g: entries.reduce((total, entry) => total + entry.protein_g, 0),
    carbohydrates_g: entries.reduce((total, entry) => total + entry.carbohydrates_g, 0),
    fat_g: entries.reduce((total, entry) => total + entry.fat_g, 0),
    fiber_g: addOptional('fiber_g'),
    sugar_g: addOptional('sugar_g'),
    saturated_fat_g: addOptional('saturated_fat_g'),
    sodium_mg: addOptional('sodium_mg'),
  };
}

/**
 * The portion options offered for a food.
 *
 * Always includes a base-unit option (100 g / 100 ml), because a user who
 * weighed their food should never be forced through a named portion. Countable
 * foods get "1 item" instead, since "100 eggs" is not a portion anyone means.
 */
export function servingOptions(
  food: FoodBasis,
  servings: readonly Serving[],
): Serving[] {
  const canonical: Serving =
    food.baseUnit === 'item'
      ? { label: '1 item', amount: 1, unit: 'item' }
      : { label: `${food.baseAmount} ${food.baseUnit}`, amount: food.baseAmount, unit: food.baseUnit };

  const named = servings.filter((serving) => serving.unit === food.baseUnit);
  return [canonical, ...named];
}

/** Rounds for display without letting a rounded value re-enter the arithmetic. */
export function displayEnergy(kcal: number): number {
  return Math.round(kcal);
}

export function displayMacro(grams: number | null): number | null {
  return grams === null ? null : Math.round(grams * 10) / 10;
}
