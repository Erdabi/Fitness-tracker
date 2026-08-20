import type { BaseUnit } from './types';

/**
 * Ingestion-only normalisation: units and plausibility.
 *
 * The name and barcode rules are shared with the app and live in
 * `src/lib/search.ts`; they are re-exported below so importers have a single
 * import site, and so the two sides can never drift apart.
 */

export {
  cleanName,
  normalizeForSearch,
  normalizeBarcode,
  hasValidCheckDigit,
} from '../../src/lib/search';

/* ------------------------------------------------------------------ units */

const KJ_PER_KCAL = 4.184;

/** Energy in kcal, whatever the source reported it in. */
export function toKcal(value: number, unit: string): number | null {
  const normalized = unit.trim().toLowerCase();
  if (normalized === 'kcal' || normalized === 'cal') return value;
  if (normalized === 'kj') return value / KJ_PER_KCAL;
  return null;
}

/**
 * Sodium in mg from a salt figure in grams.
 *
 * Open Food Facts reports salt, as do EU labels. Sodium is 1/2.5 of salt by
 * mass, so grams of salt × 400 gives milligrams of sodium.
 */
export function saltGramsToSodiumMg(saltG: number): number {
  return saltG * 400;
}

/** Recognises the unit a source used for its per-quantity basis. */
export function parseBaseUnit(raw: string | null | undefined): BaseUnit | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (['g', 'gram', 'grams', 'gr'].includes(normalized)) return 'g';
  if (['ml', 'milliliter', 'millilitre', 'millilitres'].includes(normalized)) return 'ml';
  if (['l', 'liter', 'litre'].includes(normalized)) return 'ml';
  if (['item', 'piece', 'each', 'unit'].includes(normalized)) return 'item';
  return null;
}

/**
 * Rescales a value reported per `fromAmount` to per `toAmount`.
 *
 * Sources disagree about basis — USDA is per 100 g, some exports are per
 * serving — and everything must reach the same footing before it is stored.
 */
export function rescale(value: number, fromAmount: number, toAmount: number): number {
  if (fromAmount <= 0) throw new Error('rescale: fromAmount must be positive');
  return (value * toAmount) / fromAmount;
}

/* ------------------------------------------------------------ plausibility */

/**
 * Upper bound on energy density.
 *
 * Pure fat is roughly 900 kcal per 100 g, so anything materially above that is
 * a unit error — usually kJ recorded as kcal — rather than a real food.
 * Rejecting it at import stops one bad row from corrupting a day's totals.
 */
export const MAX_KCAL_PER_100 = 950;

export function isPlausibleEnergy(kcalPer100: number): boolean {
  return Number.isFinite(kcalPer100) && kcalPer100 >= 0 && kcalPer100 <= MAX_KCAL_PER_100;
}

/**
 * Macros must roughly account for the mass they are reported against.
 *
 * Protein, carbohydrate and fat cannot together exceed 100 g per 100 g. A
 * little slack absorbs rounding in the source data.
 */
export function isPlausibleMacros(
  per100: { protein_g: number; carbohydrates_g: number; fat_g: number },
  basis = 100,
): boolean {
  const total = per100.protein_g + per100.carbohydrates_g + per100.fat_g;
  return Number.isFinite(total) && total >= 0 && total <= basis * 1.05;
}

/**
 * Coerces a source value to a non-negative number, or null.
 *
 * Exports are inconsistent: numbers arrive as strings, empty strings, "NULL",
 * or negatives from bad arithmetic upstream. All of those mean "no value" and
 * must not silently become 0 — a food with no reported fibre is not a food
 * with zero fibre.
 */
export function toOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;

  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < 0) return null;

  return parsed;
}
