import { appError, err, type Result } from '@/lib/result';
import type { LabelExtraction, MealEstimation } from './schemas';

/**
 * The AI boundary.
 *
 * Declared in Phase 0 so the rest of the app can be written against a stable
 * shape, and so it is structurally impossible for a feature to reach a model
 * provider directly. Implementations run inside Supabase Edge Functions, where
 * the API key lives; the client only ever invokes a function by name.
 *
 * Not implemented until Phase 4 — see `docs/architecture.html` §5.
 */

/**
 * An image to analyse.
 *
 * ── Changed from the Phase 0 sketch, deliberately ──────────────────────────
 *
 * Phase 0 declared this as a storage path, so a scan could be re-run later
 * without re-photographing the label. That was reconsidered against the
 * requirement to prefer temporary processing: a bucket means storage RLS, a
 * retention policy and a cleanup job, all for photographs of people's food and
 * kitchens. Sending the bytes means the image exists for one request and is
 * never written down — no bucket, nothing to leak, nothing to purge.
 *
 * The cost is a larger request body, which the size and dimension limits in
 * `prepareImage` bound.
 */
export interface ScanImage {
  /** Base64-encoded bytes, with no `data:` prefix. */
  readonly data: string;
  readonly mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  /** Decoded size, for the client-side guard and for error messages. */
  readonly byteLength: number;
}

export interface AIProvider {
  /** Extracts structured nutrition facts from a photograph of a label. */
  analyzeNutritionLabel(image: ScanImage): Promise<Result<LabelExtraction>>;
  /** Estimates items and portions from a photograph of a meal. */
  analyzeFoodPhoto(image: ScanImage): Promise<Result<MealEstimation>>;
}

/**
 * Placeholder registered until Phase 4.
 *
 * Fails loudly rather than returning empty data: a silent empty result would
 * look like "the label had no nutrition facts", which is a far more confusing
 * bug than an explicit not-implemented error.
 */
export const notImplementedProvider: AIProvider = {
  analyzeNutritionLabel: async () => err(notImplemented('analyzeNutritionLabel')),
  analyzeFoodPhoto: async () => err(notImplemented('analyzeFoodPhoto')),
};

function notImplemented(operation: string) {
  return appError('server', 'Scanning is not available yet.', {
    code: `not_implemented:${operation}`,
    retryable: false,
  });
}

let activeProvider: AIProvider = notImplementedProvider;

export function getAIProvider(): AIProvider {
  return activeProvider;
}

/**
 * Swaps the provider. Phase 4 calls this once at startup with the Edge
 * Function-backed implementation; tests use it to inject a stub.
 */
export function setAIProvider(provider: AIProvider): void {
  activeProvider = provider;
}
