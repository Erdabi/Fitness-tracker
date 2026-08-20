import type { BaseUnit } from '@/lib/nutrition';

/**
 * The lightweight search result.
 *
 * Deliberately narrow: enough to render a result row and open the serving
 * screen, and nothing more. Full nutrition, micronutrients and raw source
 * payloads stay on the server — returning them would move megabytes per
 * keystroke and hand every device a bulk copy of the catalogue.
 *
 * Mirrors the `food_search_result` composite type in
 * supabase/migrations/20260821000001_food_search.sql.
 */
export interface FoodSearchResult {
  readonly foodId: string;
  readonly name: string;
  readonly brandName: string | null;

  readonly sourceId: FoodSourceId;
  /** Curated and trusted, rather than merely present in the catalogue. */
  readonly isVerified: boolean;
  /** Created by the signed-in user, as opposed to the shared catalogue. */
  readonly isOwn: boolean;

  readonly baseUnit: BaseUnit;
  readonly baseAmount: number;

  /** Per `baseAmount` of `baseUnit`. The row shows these; the detail screen scales them. */
  readonly calories: number;
  readonly protein_g: number;
  readonly carbohydrates_g: number;
  readonly fat_g: number;

  /** The food's default portion, when it has one. */
  readonly defaultServing: {
    readonly label: string;
    readonly amount: number;
    readonly unit: BaseUnit;
  } | null;

  /** Why this row matched. Drives the "why am I seeing this" affordances. */
  readonly matchKind: MatchKind;
  readonly score: number;
}

export type FoodSourceId = 'usda' | 'openfoodfacts' | 'user' | 'ai_estimated';

export type MatchKind =
  | 'exact_name'
  | 'exact_brand_name'
  | 'prefix_name'
  | 'prefix_brand'
  | 'all_words'
  | 'fuzzy'
  | 'barcode'
  | 'recent'
  | 'frequent';

/**
 * Where a set of results came from.
 *
 * The UI must never present cached data as if it were a live search — a user
 * offline needs to know that what they are looking at is what the device
 * already had, not everything that exists.
 */
export type ResultOrigin = 'server' | 'cache' | 'recent';

/** Keyset cursor. Opaque to callers; only the service constructs one. */
export interface SearchCursor {
  readonly score: number;
  readonly foodId: string;
}

export interface SearchPage {
  readonly results: readonly FoodSearchResult[];
  readonly origin: ResultOrigin;
  /** Null when there are no further pages. */
  readonly nextCursor: SearchCursor | null;
}

export interface BarcodeLookup {
  readonly result: FoodSearchResult | null;
  /**
   * How many rows carry this barcode. Above 1 is a data-quality fault: the
   * returned row is chosen deterministically, and the UI should say so rather
   * than pretend the match was unambiguous.
   */
  readonly duplicateCount: number;
}
