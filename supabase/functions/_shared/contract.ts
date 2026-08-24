import { z } from 'npm:zod@3.25.76';

/**
 * The AI wire contract — Deno side.
 *
 * ── Why this is a mirror ───────────────────────────────────────────────────
 *
 * The canonical declaration is `src/features/ai/schemas.ts`. Edge Functions run
 * under Deno, which does not resolve this project's TypeScript path aliases or
 * its React Native module graph, so importing across the boundary is not
 * possible without a build step that would exist only for this one file.
 *
 * The two are kept in step by a drift test that reads both files and compares
 * their field sets — the same mirror-plus-test pattern already used for the
 * goal-period chain and SYNC_CURSOR_LAG_MS. Adding a field to one and not the
 * other fails the suite.
 */

export const confidenceSchema = z.enum(['high', 'medium', 'low']);

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

const nullableNonNegative = z.number().nonnegative().nullable();

export const energySchema = z.object({
  kcal: nullableNonNegative,
  kj: nullableNonNegative,
});

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

export const nutritionBasisSchema = z.enum([
  'per_100g',
  'per_100ml',
  'per_serving',
]);

export const servingSizeSchema = z
  .object({
    amount: z.number().positive(),
    unit: z.enum(['g', 'ml']),
  })
  .nullable();

export const labelExtractionSchema = z.object({
  status: labelStatusSchema,
  confidence: confidenceSchema,
  productName: z.string().min(1).max(300).nullable(),
  brand: z.string().min(1).max(200).nullable(),
  servingSize: servingSizeSchema,
  servingsPerContainer: z.number().positive().max(1000).nullable(),
  basis: nutritionBasisSchema,
  nutrients: labelNutrientsSchema,
  barcode: z
    .string()
    .regex(/^[0-9]{6,14}$/)
    .nullable(),
  warnings: z.array(z.string().max(300)).max(10),
});

export type LabelExtraction = z.infer<typeof labelExtractionSchema>;

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

export const mealEstimationSchema = z.object({
  status: photoStatusSchema,
  confidence: confidenceSchema,
  items: z.array(photoItemSchema).max(12),
  warnings: z.array(z.string().max(300)).max(10),
});

export type MealEstimation = z.infer<typeof mealEstimationSchema>;

/* ------------------------------------------------------------- the request */

/**
 * What the app sends.
 *
 * Image bytes, base64-encoded, rather than a storage path. Phase 0 sketched a
 * storage-path design so a scan could be re-run later; that was reconsidered
 * here against the requirement to prefer temporary processing. Sending the
 * bytes means no bucket, no storage RLS, no retention policy and no cleanup
 * job for photographs of people's food — the image exists for the duration of
 * one request and is never written down.
 */
export const analyzeRequestSchema = z.object({
  image: z.object({
    /** Base64, without a data: prefix. Size is checked before decoding. */
    data: z.string().min(1),
    mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  }),
  /** Client-computed, for logging correlation only. Never trusted. */
  requestId: z.string().max(64).optional(),
});
