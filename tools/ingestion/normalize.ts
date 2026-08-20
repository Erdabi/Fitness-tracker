import type { BarcodeFormat, BaseUnit } from './types';

/**
 * Normalisation shared by every source adapter and by the app when a user
 * creates a food.
 *
 * These functions decide what "the same food" means and what units things are
 * stored in, so they must behave identically wherever they run — which is why
 * they are pure, dependency-free and heavily tested rather than inlined into
 * each importer.
 */

/* ------------------------------------------------------------------ names */

/**
 * Display name: trimmed, internal whitespace collapsed, control characters
 * removed. Case is preserved — "Greek Yogurt" should not become "greek yogurt"
 * on screen.
 */
export function cleanName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Search/dedup key: lowercased, accent-folded, punctuation reduced to spaces.
 *
 * Accent folding is what makes "Crème Fraîche" and "Creme Fraiche" the same
 * record. Done here rather than in Postgres because `unaccent()` is not
 * immutable and so cannot back a generated column or an index expression.
 */
export function normalizeForSearch(raw: string): string {
  return cleanName(raw)
    .normalize('NFD')
    // Combining diacritical marks.
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/* --------------------------------------------------------------- barcodes */

/**
 * Reduces a barcode to digits and classifies it.
 *
 * UPC-A is widened to EAN-13 with a leading zero, because the two are the same
 * number and a product scanned in the US must match the same row as one
 * scanned in Europe. The original form is reported so callers can record it.
 *
 * Returns null for anything that is not a plausible GTIN.
 */
export function normalizeBarcode(
  raw: string,
): { barcode: string; format: BarcodeFormat } | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 14) return null;

  if (digits.length === 12) {
    // UPC-A widened to EAN-13; the check digit stays valid.
    return { barcode: `0${digits}`, format: 'upca' };
  }

  const format: BarcodeFormat =
    digits.length === 13
      ? 'ean13'
      : digits.length === 8
        ? 'ean8'
        : digits.length === 6
          ? 'upce'
          : 'other';

  return { barcode: digits, format };
}

/**
 * GS1 modulo-10 check digit.
 *
 * Worth validating at import: a barcode with a bad check digit is a typo or a
 * corrupted export, and storing it would make a real product unfindable while
 * occupying its number.
 */
export function hasValidCheckDigit(barcode: string): boolean {
  const digits = barcode.replace(/\D/g, '');
  if (digits.length < 8) return false;

  const body = digits.slice(0, -1);
  const expected = Number(digits[digits.length - 1]);

  // Weights alternate 3,1,3,1… reading right-to-left from the digit before
  // the check digit.
  let sum = 0;
  for (let index = 0; index < body.length; index += 1) {
    const digit = Number(body[body.length - 1 - index]);
    sum += index % 2 === 0 ? digit * 3 : digit;
  }

  return (10 - (sum % 10)) % 10 === expected;
}

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
