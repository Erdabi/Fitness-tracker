import type { BarcodeFormat } from '@/features/food/barcodeTypes';

/**
 * Name and barcode normalisation — the rules that decide what "the same food"
 * means.
 *
 * SHARED ON PURPOSE. The importer writes `foods.normalized_name` with
 * `normalizeForSearch`, and the app normalises a search query with the same
 * function before sending it. If the two ever disagreed, stored names and
 * typed queries would stop matching and search would quietly degrade — so
 * there is one implementation, here, and `tools/ingestion/normalize.ts`
 * re-exports it rather than keeping a copy.
 *
 * Pure and dependency-free so it runs identically on a device, in a Node
 * importer, and under test.
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
