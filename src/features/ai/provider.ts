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
 * Reference to an uploaded image.
 *
 * A storage path, never image bytes. The upload happens first so a scan can be
 * retried or re-run later without asking the user to photograph the label
 * again, and so the function payload stays small.
 */
export interface ImageRef {
  /** Path within the private `scans` bucket, e.g. `<user-id>/<scan-id>.jpg`. */
  readonly storagePath: string;
  /** Content hash, used to short-circuit repeat scans of the same label. */
  readonly sha256: string;
}

export interface AIProvider {
  /** Extracts structured nutrition facts from a photograph of a label. */
  analyzeNutritionLabel(image: ImageRef): Promise<Result<LabelExtraction>>;
  /** Estimates items and portions from a photograph of a meal. */
  analyzeFoodPhoto(image: ImageRef): Promise<Result<MealEstimation>>;
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
