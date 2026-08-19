import { z } from 'zod';

/**
 * Contracts for AI extraction results.
 *
 * Defined in Phase 0 — ahead of the features that use them — because they are
 * shared by the app and the Edge Functions. Nothing from a model is trusted
 * until it has passed through these schemas server-side, so a malformed or
 * hallucinated response becomes a typed error rather than a database row.
 *
 * Phase 4 moves this file to a shared package imported by both sides.
 */

/**
 * A single extracted number with its own confidence.
 *
 * Per-field rather than per-response: a label photo is often crisp on calories
 * and blurred on sodium, and one overall score cannot express that. The confirm
 * screen uses these to decide which fields to flag for review.
 */
export const measuredValueSchema = z.object({
  value: z.number().nullable(),
  confidence: z.number().min(0).max(1),
});

export type MeasuredValue = z.infer<typeof measuredValueSchema>;

export const nutrientSetSchema = z.object({
  kcal: measuredValueSchema,
  protein_g: measuredValueSchema,
  carb_g: measuredValueSchema,
  fat_g: measuredValueSchema,
  sugar_g: measuredValueSchema,
  fiber_g: measuredValueSchema,
  sat_fat_g: measuredValueSchema,
  sodium_mg: measuredValueSchema,
});

/** Which quantity the numbers on the label refer to. */
export const nutritionBasisSchema = z.enum(['per_100g', 'per_100ml', 'per_serving']);

export const labelExtractionSchema = z.object({
  productName: z.string().nullable(),
  brand: z.string().nullable(),
  servingSize: z
    .object({
      amount: z.number().positive(),
      unit: z.enum(['g', 'ml']),
    })
    .nullable(),
  basis: nutritionBasisSchema,
  nutrients: nutrientSetSchema,
  overallConfidence: z.number().min(0).max(1),
});

export type LabelExtraction = z.infer<typeof labelExtractionSchema>;

export const mealItemSchema = z.object({
  name: z.string().min(1),
  estimatedWeightG: z.number().positive(),
  kcal: z.number().nonnegative(),
  protein_g: z.number().nonnegative(),
  carb_g: z.number().nonnegative(),
  fat_g: z.number().nonnegative(),
  fiber_g: z.number().nonnegative().nullable(),
  confidence: z.number().min(0).max(1),
});

export const mealEstimationSchema = z.object({
  items: z.array(mealItemSchema).min(1),
  total: z.object({
    kcal: z.number().nonnegative(),
    protein_g: z.number().nonnegative(),
    carb_g: z.number().nonnegative(),
    fat_g: z.number().nonnegative(),
    fiber_g: z.number().nonnegative().nullable(),
  }),
  /**
   * Portion estimation from a single photo without a size reference carries
   * roughly ±25–30% error. The UI must present a range, never a bare figure.
   */
  overallConfidence: z.number().min(0).max(1),
});

export type MealEstimation = z.infer<typeof mealEstimationSchema>;
export type MealItem = z.infer<typeof mealItemSchema>;
