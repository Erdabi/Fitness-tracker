import {
  cleanName,
  isPlausibleEnergy,
  isPlausibleMacros,
  normalizeForSearch,
  rescale,
  toKcal,
  toOptionalNumber,
} from '../normalize';
import type { CanonicalServing, ParseResult, SourceAdapter } from '../types';

/**
 * USDA FoodData Central adapter.
 *
 * Reads the shape of the public FDC JSON export. Values there are already per
 * 100 g, and nutrients arrive as a list keyed by USDA's own numeric ids.
 *
 * Licence: public domain (a U.S. Government work). No attribution required,
 * though `docs/food-data-sources.md` records the courtesy citation.
 */

/** USDA nutrient numbers for the values we store as typed columns. */
const NUTRIENT_NUMBERS = {
  energyKcal: '208',
  energyKj: '268',
  protein: '203',
  fat: '204',
  carbohydrate: '205',
  fiber: '291',
  sugar: '269',
  saturatedFat: '606',
  sodium: '307',
} as const;

/** Micronutrients kept in the jsonb column rather than as typed columns. */
const MICRONUTRIENT_NUMBERS: Readonly<Record<string, string>> = {
  '301': 'calcium_mg',
  '303': 'iron_mg',
  '306': 'potassium_mg',
  '401': 'vitamin_c_mg',
  '318': 'vitamin_a_iu',
  '328': 'vitamin_d_mcg',
  '304': 'magnesium_mg',
  '309': 'zinc_mg',
  '601': 'cholesterol_mg',
};

interface UsdaNutrient {
  nutrient?: { number?: string; unitName?: string };
  amount?: unknown;
}

interface UsdaPortion {
  modifier?: string;
  portionDescription?: string;
  gramWeight?: unknown;
  amount?: unknown;
  measureUnit?: { name?: string };
}

export interface UsdaFood {
  fdcId?: number | string;
  description?: string;
  dataType?: string;
  publicationDate?: string;
  brandOwner?: string;
  brandName?: string;
  foodNutrients?: UsdaNutrient[];
  foodPortions?: UsdaPortion[];
}

function nutrientAmount(
  nutrients: UsdaNutrient[],
  number: string,
): { amount: number; unit: string } | null {
  const match = nutrients.find((entry) => entry.nutrient?.number === number);
  if (!match) return null;

  const amount = toOptionalNumber(match.amount);
  if (amount === null) return null;

  return { amount, unit: match.nutrient?.unitName ?? '' };
}

export const usdaAdapter: SourceAdapter<UsdaFood> = {
  sourceId: 'usda',
  label: 'USDA FoodData Central',

  parse(raw): ParseResult {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, reason: 'malformed_record' };
    }

    const externalId = raw.fdcId === undefined ? '' : String(raw.fdcId).trim();
    if (!externalId) return { ok: false, reason: 'missing_id' };

    const name = cleanName(raw.description ?? '');
    if (!name) return { ok: false, reason: 'missing_name', detail: externalId };

    const nutrients = raw.foodNutrients ?? [];

    // Energy may be reported in kcal or only in kJ.
    const kcalEntry = nutrientAmount(nutrients, NUTRIENT_NUMBERS.energyKcal);
    const kjEntry = nutrientAmount(nutrients, NUTRIENT_NUMBERS.energyKj);

    const calories =
      kcalEntry !== null
        ? toKcal(kcalEntry.amount, kcalEntry.unit || 'kcal')
        : kjEntry !== null
          ? toKcal(kjEntry.amount, kjEntry.unit || 'kJ')
          : null;

    if (calories === null) {
      return { ok: false, reason: 'missing_nutrition', detail: externalId };
    }
    if (!isPlausibleEnergy(calories)) {
      return { ok: false, reason: 'implausible_nutrition', detail: externalId };
    }

    const protein_g = nutrientAmount(nutrients, NUTRIENT_NUMBERS.protein)?.amount ?? 0;
    const fat_g = nutrientAmount(nutrients, NUTRIENT_NUMBERS.fat)?.amount ?? 0;
    const carbohydrates_g =
      nutrientAmount(nutrients, NUTRIENT_NUMBERS.carbohydrate)?.amount ?? 0;

    if (!isPlausibleMacros({ protein_g, carbohydrates_g, fat_g })) {
      return { ok: false, reason: 'implausible_nutrition', detail: externalId };
    }

    const micronutrients: Record<string, number> = {};
    for (const [number, key] of Object.entries(MICRONUTRIENT_NUMBERS)) {
      const entry = nutrientAmount(nutrients, number);
      if (entry !== null) micronutrients[key] = entry.amount;
    }

    // Portions with no gram weight cannot be converted, so they are dropped
    // rather than assigned an invented weight.
    const servings: CanonicalServing[] = (raw.foodPortions ?? [])
      .map((portion): CanonicalServing | null => {
        const grams = toOptionalNumber(portion.gramWeight);
        if (grams === null || grams <= 0) return null;

        const label = cleanName(
          portion.portionDescription ??
            [portion.amount, portion.measureUnit?.name, portion.modifier]
              .filter(Boolean)
              .join(' '),
        );
        if (!label) return null;

        return { label, amount: grams, unit: 'g', isDefault: false };
      })
      .filter((serving): serving is CanonicalServing => serving !== null);

    const brandName = cleanName(raw.brandName ?? raw.brandOwner ?? '');

    return {
      ok: true,
      food: {
        sourceId: 'usda',
        externalId,
        name,
        normalizedName: normalizeForSearch(name),
        brand: brandName
          ? { name: brandName, normalizedName: normalizeForSearch(brandName) }
          : null,
        kind: brandName ? 'branded' : 'generic',
        baseUnit: 'g',
        baseAmount: 100,
        nutrition: {
          // USDA reports per 100 g already; rescale keeps the intent explicit
          // and survives a future export that changes basis.
          calories: rescale(calories, 100, 100),
          protein_g,
          carbohydrates_g,
          fat_g,
          fiber_g: nutrientAmount(nutrients, NUTRIENT_NUMBERS.fiber)?.amount ?? null,
          sugar_g: nutrientAmount(nutrients, NUTRIENT_NUMBERS.sugar)?.amount ?? null,
          saturated_fat_g:
            nutrientAmount(nutrients, NUTRIENT_NUMBERS.saturatedFat)?.amount ?? null,
          sodium_mg: nutrientAmount(nutrients, NUTRIENT_NUMBERS.sodium)?.amount ?? null,
          micronutrients,
        },
        servings,
        barcodes: [],
        sourceUrl: `https://fdc.nal.usda.gov/food-details/${externalId}/nutrients`,
        sourceUpdatedAt: raw.publicationDate ?? null,
      },
    };
  },
};
