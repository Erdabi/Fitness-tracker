import { supabase } from '@/api/supabase';
import { normalizeForSearch, normalizeBarcode } from '@/lib/search';
import { appError, err, ok, type Result } from '@/lib/result';
import type {
  BarcodeLookup,
  FoodSearchResult,
  SearchCursor,
  SearchPage,
} from './types';

/**
 * The food search service.
 *
 * The only place the app talks to the search RPCs. Screens call this; they
 * never build queries, and they never see a Postgres row shape.
 *
 * Search is server-side by design: the catalogue is hundreds of thousands to
 * millions of rows, and the device gets a page at a time.
 */

/** Raw shape returned by the `food_search_result` composite type. */
interface SearchRow {
  food_id: string;
  name: string;
  brand_name: string | null;
  source_id: string;
  is_verified: boolean;
  is_own: boolean;
  base_unit: 'g' | 'ml' | 'item';
  base_amount: number | string;
  calories: number | string;
  protein_g: number | string;
  carbohydrates_g: number | string;
  fat_g: number | string;
  serving_label: string | null;
  serving_amount: number | string | null;
  serving_unit: 'g' | 'ml' | 'item' | null;
  match_kind: string;
  score: number | string;
}

/**
 * Postgres returns `numeric` as a string over PostgREST, to avoid the
 * precision loss of a float round-trip. Converting once at the boundary keeps
 * every downstream calculation working with real numbers.
 */
const num = (value: number | string | null): number =>
  value === null ? 0 : typeof value === 'number' ? value : Number(value);

function toResult(row: SearchRow): FoodSearchResult {
  return {
    foodId: row.food_id,
    name: row.name,
    brandName: row.brand_name,
    sourceId: row.source_id as FoodSearchResult['sourceId'],
    isVerified: row.is_verified,
    isOwn: row.is_own,
    baseUnit: row.base_unit,
    baseAmount: num(row.base_amount),
    calories: num(row.calories),
    protein_g: num(row.protein_g),
    carbohydrates_g: num(row.carbohydrates_g),
    fat_g: num(row.fat_g),
    defaultServing:
      row.serving_label && row.serving_amount !== null && row.serving_unit
        ? {
            label: row.serving_label,
            amount: num(row.serving_amount),
            unit: row.serving_unit,
          }
        : null,
    matchKind: row.match_kind as FoodSearchResult['matchKind'],
    score: num(row.score),
  };
}

/** Shortest query worth sending. Matches the guard inside search_foods. */
export const MIN_QUERY_LENGTH = 2;

export interface SearchOptions {
  readonly limit?: number;
  readonly cursor?: SearchCursor | null;
}

export async function searchFoods(
  query: string,
  options: SearchOptions = {},
): Promise<Result<SearchPage>> {
  // Normalised with the same function the importer and the schema use, so the
  // client and the stored `normalized_name` always agree on what a query is.
  const normalized = normalizeForSearch(query);
  const limit = options.limit ?? 25;

  if (normalized.length < MIN_QUERY_LENGTH) {
    return ok({ results: [], origin: 'server', nextCursor: null });
  }

  try {
    const { data, error } = await supabase.rpc('search_foods', {
      p_query: normalized,
      p_limit: limit,
      p_cursor_score: options.cursor?.score ?? null,
      p_cursor_id: options.cursor?.foodId ?? null,
    });

    if (error) return err(mapSearchError(error));

    const rows = (data ?? []) as SearchRow[];
    const results = rows.map(toResult);
    const last = results[results.length - 1];

    return ok({
      results,
      origin: 'server',
      // A short page means the end; a full page means there may be more.
      nextCursor:
        results.length === limit && last
          ? { score: last.score, foodId: last.foodId }
          : null,
    });
  } catch (cause) {
    return err(mapSearchError(cause));
  }
}

/**
 * Exact barcode lookup. Never fuzzy — a barcode is an identifier, and a
 * near-miss is a different product.
 */
export async function lookupBarcode(raw: string): Promise<Result<BarcodeLookup>> {
  const normalized = normalizeBarcode(raw);

  if (!normalized) {
    return err(
      appError('validation', 'That does not look like a product barcode.', {
        code: 'invalid_barcode',
        retryable: false,
      }),
    );
  }

  try {
    const { data, error } = await supabase.rpc('lookup_barcode', {
      p_barcode: normalized.barcode,
    });

    if (error) return err(mapSearchError(error));

    const rows = (data ?? []) as { result: SearchRow; duplicate_count: number }[];
    const first = rows[0];

    return ok({
      result: first ? toResult(first.result) : null,
      duplicateCount: first?.duplicate_count ?? 0,
    });
  } catch (cause) {
    return err(mapSearchError(cause));
  }
}

export type RecentOrder = 'recent' | 'frequent';

/** Recent or frequent foods, in the same shape search returns. */
export async function listRecentFoods(
  order: RecentOrder = 'recent',
  limit = 20,
): Promise<Result<readonly FoodSearchResult[]>> {
  try {
    const { data, error } = await supabase.rpc('list_recent_foods', {
      p_limit: limit,
      p_order: order,
    });

    if (error) return err(mapSearchError(error));
    return ok(((data ?? []) as SearchRow[]).map(toResult));
  } catch (cause) {
    return err(mapSearchError(cause));
  }
}

function mapSearchError(cause: unknown) {
  const message =
    typeof cause === 'object' && cause !== null && 'message' in cause
      ? String((cause as { message: unknown }).message)
      : '';

  if (
    cause instanceof TypeError ||
    /network request failed|failed to fetch/i.test(message)
  ) {
    return appError(
      'network',
      'Search needs an internet connection. Your recent foods are still available.',
      { code: 'offline', cause, retryable: true },
    );
  }

  return appError('server', 'Search is unavailable right now. Try again shortly.', {
    cause,
    retryable: true,
  });
}
