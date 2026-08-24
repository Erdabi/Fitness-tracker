import { z } from 'zod';

/**
 * The AI wire contract.
 *
 * Declared in Phase 0 ahead of the features that use it, and completed here.
 * Nothing a model returns is trusted until it has passed through these
 * schemas — server-side first, then again on arrival — so a malformed or
 * hallucinated response becomes a typed error rather than a database row.
 *
 * ── Mirrored, deliberately ─────────────────────────────────────────────────
 *
 * `supabase/functions/_shared/contract.ts` holds the same shapes for the Deno
 * runtime, which cannot resolve this project's TypeScript path aliases. The
 * two are kept in step by a drift test (`aiContract.node.test.ts`) that reads
 * both files and compares their field sets — the same mirror-plus-test pattern
 * used for the goal-period chain and SYNC_CURSOR_LAG_MS.
 */

/**
 * How much to trust a result.
 *
 * A coarse three-level scale rather than a float, because that is the honest
 * resolution of the underlying judgement and because the UI branches three
 * ways: show it, show it with a warning, or refuse to prefill anything.
 *
 * NOT a probability, and never a medical certainty. `low` means the user must
 * check every field before it is saved.
 */
export const confidenceSchema = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof confidenceSchema>;

/** Whether the model produced something usable at all. */
export const labelStatusSchema = z.enum([
  'success',
  'needs_review',
  'unable_to_extract',
]);
export const photoStatusSchema = z.enum([
  'success',
  'needs_review',
  'unable_to_determine',
]);

/**
 * A number the model read off a label, or `null`.
 *
 * Null means "not visible / not stated" and must survive all the way to the
 * database as null. A missing nutrient silently becoming 0 is the single most
 * damaging thing this pipeline could do: it is indistinguishable from a real
 * zero, and it under-counts every total built on it forever after.
 */
const nullableNonNegative = z.number().nonnegative().nullable();

/**
 * Energy as printed. Labels outside the US lead with kilojoules, and many
 * print only kJ — so both are accepted and `normalizeLabel` resolves them.
 */
export const energySchema = z.object({
  kcal: nullableNonNegative,
  kj: nullableNonNegative,
});

/**
 * Nutrients exactly as printed, before any conversion.
 *
 * `salt_g` and `sodium_mg` are both present because labels print one or the
 * other by jurisdiction, and converting between them is arithmetic the
 * normalizer should do once rather than the model doing it unpredictably.
 */
export const labelNutrientsSchema = z.object({
  energy: energySchema,
  protein_g: nullableNonNegative,
  carbohydrates_g: nullableNonNegative,
  sugars_g: nullableNonNegative,
  fiber_g: nullableNonNegative,
  fat_g: nullableNonNegative,
  saturated_fat_g: nullableNonNegative,
  sodium_mg: nullableNonNegative,
  salt_g: nullableNonNegative,
});

export type LabelNutrients = z.infer<typeof labelNutrientsSchema>;

/** Which quantity the printed numbers describe. */
export const nutritionBasisSchema = z.enum([
  'per_100g',
  'per_100ml',
  'per_serving',
]);
export type NutritionBasis = z.infer<typeof nutritionBasisSchema>;

export const servingSizeSchema = z
  .object({
    amount: z.number().positive(),
    unit: z.enum(['g', 'ml']),
  })
  .nullable();

/**
 * A nutrition label, as read.
 *
 * Deliberately the *raw* reading: units unconverted, basis unresolved, missing
 * values null. `normalizeLabel` turns this into something the catalogue can
 * store, and both are kept — the raw result is what makes a wrong extraction
 * explicable after the fact.
 */
export const labelExtractionSchema = z.object({
  status: labelStatusSchema,
  confidence: confidenceSchema,
  productName: z.string().min(1).max(300).nullable(),
  brand: z.string().min(1).max(200).nullable(),
  servingSize: servingSizeSchema,
  servingsPerContainer: z.number().positive().max(1000).nullable(),
  basis: nutritionBasisSchema,
  nutrients: labelNutrientsSchema,
  /** Read off the packaging when visible. Validated before any lookup. */
  barcode: z
    .string()
    .regex(/^[0-9]{6,14}$/)
    .nullable(),
  /** Things the user should know: glare, a cropped panel, an unclear unit. */
  warnings: z.array(z.string().max(300)).max(10),
});

export type LabelExtraction = z.infer<typeof labelExtractionSchema>;

/**
 * One identified food in a photograph.
 *
 * Nutrition is per the estimated portion, not per 100 g — the model is
 * estimating "this plate of rice", and asking it to also normalise to a base
 * quantity adds an arithmetic step it has no reason to do reliably. The
 * normalizer derives the per-100 basis the catalogue needs.
 */
export const photoItemSchema = z.object({
  name: z.string().min(1).max(300),
  estimatedQuantity: z.number().positive(),
  unit: z.enum(['g', 'ml', 'item']),
  calories: z.number().nonnegative().nullable(),
  protein_g: nullableNonNegative,
  carbohydrates_g: nullableNonNegative,
  fat_g: nullableNonNegative,
  fiber_g: nullableNonNegative,
  sugars_g: nullableNonNegative,
  confidence: confidenceSchema,
});

export type PhotoItem = z.infer<typeof photoItemSchema>;

/**
 * A photographed meal.
 *
 * `items` may be empty — that is what `unable_to_determine` looks like, and it
 * is a legitimate, useful answer. Forcing at least one item would make
 * "I cannot tell what this is" impossible to express, and the model would
 * invent something instead.
 */
export const mealEstimationSchema = z.object({
  status: photoStatusSchema,
  confidence: confidenceSchema,
  items: z.array(photoItemSchema).max(12),
  warnings: z.array(z.string().max(300)).max(10),
});

export type MealEstimation = z.infer<typeof mealEstimationSchema>;

/**
 * Whether a result is safe to prefill without forcing a field-by-field check.
 *
 * `needs_review` and `low` both mean the same thing to the UI: show it, but do
 * not let it be saved until the user has looked at every number.
 */
export function requiresReview(
  result: Pick<LabelExtraction, 'status' | 'confidence'> |
    Pick<MealEstimation, 'status' | 'confidence'>,
): boolean {
  return result.status !== 'success' || result.confidence === 'low';
}

/** Whether the model declined to produce anything usable. */
export function isUnusable(
  result: Pick<LabelExtraction, 'status'> | Pick<MealEstimation, 'status'>,
): boolean {
  return (
    result.status === 'unable_to_extract' || result.status === 'unable_to_determine'
  );
}
