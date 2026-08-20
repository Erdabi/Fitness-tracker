import {
  cleanName,
  hasValidCheckDigit,
  isPlausibleEnergy,
  isPlausibleMacros,
  normalizeBarcode,
  normalizeForSearch,
  parseBaseUnit,
  rescale,
  saltGramsToSodiumMg,
  toKcal,
  toOptionalNumber,
} from '../normalize';
import type {
  CanonicalBarcode,
  CanonicalServing,
  ParseResult,
  SourceAdapter,
} from '../types';

/**
 * Open Food Facts adapter.
 *
 * OFF is crowd-sourced, so it is messier than USDA and the defensive handling
 * here is not paranoia: energy arrives in kJ as often as kcal, sodium is
 * usually reported as salt, quantities carry their unit inside the string,
 * and a large share of products have no usable nutrition at all.
 *
 * Licence: ODbL-1.0. **Attribution is required** and share-alike applies to
 * derived databases — see docs/food-data-sources.md. `food_sources` carries
 * the attribution text so the obligation travels with the rows.
 */

export interface OffProduct {
  code?: string;
  product_name?: string;
  product_name_en?: string;
  brands?: string;
  quantity?: string;
  serving_size?: string;
  serving_quantity?: unknown;
  last_modified_t?: number | string;
  nutriments?: Record<string, unknown>;
}

/**
 * Pulls a nutriment, preferring the explicitly-per-100g key.
 *
 * OFF exposes both `x_100g` and a bare `x`; the bare key's basis is not
 * guaranteed, so it is only a fallback.
 */
function per100(nutriments: Record<string, unknown>, key: string): number | null {
  return (
    toOptionalNumber(nutriments[`${key}_100g`]) ?? toOptionalNumber(nutriments[key])
  );
}

/** Parses "500 ml" / "1 L" / "250g" into an amount and a base unit. */
export function parseQuantity(
  raw: string | undefined,
): { amount: number; unit: 'g' | 'ml' } | null {
  if (!raw) return null;

  const match = /([\d.,]+)\s*([a-zA-Z]+)/.exec(raw.trim());
  if (!match) return null;

  const amount = Number(match[1]!.replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unitToken = match[2]!.toLowerCase();
  const unit = parseBaseUnit(unitToken);
  if (unit !== 'g' && unit !== 'ml') return null;

  // Litres were folded to ml by parseBaseUnit; scale the number to match.
  const scaled = ['l', 'liter', 'litre'].includes(unitToken) ? amount * 1000 : amount;

  return { amount: scaled, unit };
}

export const openFoodFactsAdapter: SourceAdapter<OffProduct> = {
  sourceId: 'openfoodfacts',
  label: 'Open Food Facts',

  parse(raw): ParseResult {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, reason: 'malformed_record' };
    }

    // In OFF the product code *is* the barcode and the primary key.
    const code = String(raw.code ?? '').trim();
    if (!code) return { ok: false, reason: 'missing_id' };

    const name = cleanName(raw.product_name_en || raw.product_name || '');
    if (!name) return { ok: false, reason: 'missing_name', detail: code };

    const nutriments = raw.nutriments ?? {};

    // Energy: kcal if given, otherwise convert from kJ.
    const kcal = per100(nutriments, 'energy-kcal');
    const kj = per100(nutriments, 'energy-kj') ?? per100(nutriments, 'energy');
    const calories = kcal ?? (kj === null ? null : toKcal(kj, 'kJ'));

    if (calories === null) {
      return { ok: false, reason: 'missing_nutrition', detail: code };
    }
    if (!isPlausibleEnergy(calories)) {
      return { ok: false, reason: 'implausible_nutrition', detail: code };
    }

    const protein_g = per100(nutriments, 'proteins') ?? 0;
    const carbohydrates_g = per100(nutriments, 'carbohydrates') ?? 0;
    const fat_g = per100(nutriments, 'fat') ?? 0;

    if (!isPlausibleMacros({ protein_g, carbohydrates_g, fat_g })) {
      return { ok: false, reason: 'implausible_nutrition', detail: code };
    }

    // Sodium may be given directly (grams) or, more often, as salt.
    const sodiumG = per100(nutriments, 'sodium');
    const saltG = per100(nutriments, 'salt');
    const sodium_mg =
      sodiumG !== null
        ? sodiumG * 1000
        : saltG !== null
          ? saltGramsToSodiumMg(saltG)
          : null;

    // A drink's nutrition is per 100 ml, a solid's per 100 g. Getting this
    // wrong would silently misreport every liquid.
    const quantity = parseQuantity(raw.quantity);
    const baseUnit = quantity?.unit ?? 'g';

    const servings: CanonicalServing[] = [];
    const servingAmount =
      toOptionalNumber(raw.serving_quantity) ?? parseQuantity(raw.serving_size)?.amount;

    if (servingAmount && servingAmount > 0 && raw.serving_size) {
      servings.push({
        label: cleanName(raw.serving_size),
        amount: servingAmount,
        unit: baseUnit,
        isDefault: true,
      });
    }

    // The whole package, when the label states it.
    if (quantity && quantity.amount > 0 && raw.quantity) {
      servings.push({
        label: `Whole package (${cleanName(raw.quantity)})`,
        amount: quantity.amount,
        unit: baseUnit,
        isDefault: servings.length === 0,
      });
    }

    // A bad check digit means a typo or a corrupted export. Storing it would
    // occupy the real product's number while never matching a scan.
    const barcodes: CanonicalBarcode[] = [];
    const normalized = normalizeBarcode(code);
    if (normalized && hasValidCheckDigit(normalized.barcode)) {
      barcodes.push(normalized);
    }

    const brandName = cleanName((raw.brands ?? '').split(',')[0] ?? '');

    const micronutrients: Record<string, number> = {};
    for (const [key, target] of Object.entries({
      calcium: 'calcium_mg',
      iron: 'iron_mg',
      potassium: 'potassium_mg',
      'vitamin-c': 'vitamin_c_mg',
      cholesterol: 'cholesterol_mg',
    })) {
      const value = per100(nutriments, key);
      // OFF reports these in grams; the app stores milligrams.
      if (value !== null) micronutrients[target] = value * 1000;
    }

    return {
      ok: true,
      food: {
        sourceId: 'openfoodfacts',
        externalId: code,
        name,
        normalizedName: normalizeForSearch(name),
        brand: brandName
          ? { name: brandName, normalizedName: normalizeForSearch(brandName) }
          : null,
        kind: 'packaged',
        baseUnit,
        baseAmount: 100,
        nutrition: {
          calories: rescale(calories, 100, 100),
          protein_g,
          carbohydrates_g,
          fat_g,
          fiber_g: per100(nutriments, 'fiber'),
          sugar_g: per100(nutriments, 'sugars'),
          saturated_fat_g: per100(nutriments, 'saturated-fat'),
          sodium_mg,
          micronutrients,
        },
        servings,
        barcodes,
        sourceUrl: `https://world.openfoodfacts.org/product/${code}`,
        sourceUpdatedAt: toEpochIso(raw.last_modified_t),
      },
    };
  },
};

function toEpochIso(value: unknown): string | null {
  const seconds = toOptionalNumber(value);
  if (seconds === null || seconds === 0) return null;
  return new Date(seconds * 1000).toISOString();
}
