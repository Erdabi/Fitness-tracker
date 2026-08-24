import { supabase } from '@/api/supabase';
import { appError, err, ok, type Result } from '@/lib/result';
import { cleanName, normalizeForSearch } from '@/lib/search';
import type { BaseUnit, NutritionPerBase, Serving } from '@/lib/nutrition';
import { logger } from '@/lib/logger';
import type { FoodSearchResult } from './types';

/**
 * Creating a food the user owns.
 *
 * Not a new data model. A custom food is an ordinary row in `foods` with
 * `owner_id` set — the same table search reads, the diary snapshots from and
 * recipes will use later. That was decided in Milestone 1 precisely so this
 * milestone would not need a parallel table: one code path for logging, one
 * for searching, one for everything after.
 *
 * Three routes in, one function: typed by hand, read off a label, or estimated
 * from a photograph. They differ only in `sourceId` and in who filled the form.
 */

/**
 * Where a custom food's numbers came from.
 *
 * The database constrains an owned food to these two — `user` or
 * `ai_estimated` — and separately forbids `is_verified` on anything owned. So
 * an AI-derived food cannot be marked as USDA or Open Food Facts data, and
 * cannot claim to be verified, whatever this code does. See the
 * `user_foods_use_user_source` and `only_global_foods_are_verified` checks.
 */
export type CustomFoodSource = 'user' | 'ai_estimated';

export interface CustomFoodInput {
  readonly name: string;
  readonly brandName?: string | null;
  readonly baseUnit: BaseUnit;
  /** 100 for g/ml, 1 for a countable item. */
  readonly baseAmount: number;
  readonly nutrition: NutritionPerBase;
  /** Portions to offer when logging. The base unit is always offered anyway. */
  readonly servings?: readonly Omit<Serving, 'id'>[];
  /** Attached only when it is a real, check-digit-valid code. */
  readonly barcode?: string | null;
  readonly source: CustomFoodSource;
}

/**
 * Creates the food and everything that hangs off it.
 *
 * `foods`, `food_nutrition`, optional `food_servings` and an optional
 * `food_barcodes` row — written in that order because each references the one
 * before it.
 *
 * Deliberately NOT offline-capable, and this is the one place in the app where
 * that is true. A custom food lives in the shared catalogue schema, whose ids
 * the diary's snapshots reference for provenance; creating one locally and
 * reconciling later would mean either a second id space or a rewrite pass over
 * food_logs. The user-facing consequence is small, because the diary entry
 * itself does not need the food to exist — it snapshots the nutrition. See
 * `docs/scanning.md`.
 */
export async function createCustomFood(
  input: CustomFoodInput,
  client = supabase,
): Promise<Result<FoodSearchResult>> {
  const name = cleanName(input.name);
  if (!name) {
    return err(
      appError('validation', 'Give the food a name before saving it.', {
        code: 'missing_name',
        retryable: false,
      }),
    );
  }

  const { data: session } = await client.auth.getSession();
  const userId = session.session?.user.id;
  if (!userId) {
    return err(
      appError('auth', 'Sign in to save your own foods.', {
        code: 'not_signed_in',
        retryable: false,
      }),
    );
  }

  try {
    const brandId = input.brandName
      ? await resolveOwnedBrand(client, userId, input.brandName, input.source)
      : null;

    const { data: food, error: foodError } = await client
      .from('foods')
      .insert({
        owner_id: userId,
        brand_id: brandId,
        name,
        normalized_name: normalizeForSearch(name),
        kind: input.brandName ? 'branded' : 'generic',
        base_unit: input.baseUnit,
        base_amount: input.baseAmount,
        source_id: input.source,
        // Never true for an owned food; the database enforces it too.
        is_verified: false,
      })
      .select('id')
      .single();

    if (foodError || !food) throw foodError ?? new Error('Food row was not created');

    const foodId = String((food as { id: string }).id);

    const { error: nutritionError } = await client.from('food_nutrition').insert({
      food_id: foodId,
      calories: input.nutrition.calories,
      protein_g: input.nutrition.protein_g,
      carbohydrates_g: input.nutrition.carbohydrates_g,
      fat_g: input.nutrition.fat_g,
      fiber_g: input.nutrition.fiber_g,
      sugar_g: input.nutrition.sugar_g,
      saturated_fat_g: input.nutrition.saturated_fat_g,
      sodium_mg: input.nutrition.sodium_mg,
      source_id: input.source,
    });

    if (nutritionError) throw nutritionError;

    if (input.servings?.length) {
      const { error: servingError } = await client.from('food_servings').insert(
        input.servings.map((serving, index) => ({
          food_id: foodId,
          label: serving.label,
          amount: serving.amount,
          unit: serving.unit,
          is_default: index === 0,
          sort_order: index,
          source_id: input.source,
        })) as never,
      );

      // A missing portion costs convenience, not correctness — the food is
      // still loggable in its base unit, so this does not fail the save.
      if (servingError) {
        logger.warn('Custom food saved without its servings', {
          reason: servingError.message,
        });
      }
    }

    if (input.barcode) {
      const { error: barcodeError } = await client.from('food_barcodes').insert({
        food_id: foodId,
        barcode: input.barcode,
        format: input.barcode.length === 13 ? 'ean13' : 'other',
        source_id: input.source,
      });

      // A barcode already attached to another of the user's foods collides on
      // the owner-scoped unique index. Not fatal: the food is saved, it simply
      // will not be found by that scan.
      if (barcodeError) {
        logger.warn('Custom food saved without its barcode', {
          reason: barcodeError.message,
        });
      }
    }

    return ok({
      foodId,
      name,
      brandName: input.brandName ?? null,
      sourceId: input.source,
      isVerified: false,
      isOwn: true,
      baseUnit: input.baseUnit,
      baseAmount: input.baseAmount,
      calories: input.nutrition.calories,
      protein_g: input.nutrition.protein_g,
      carbohydrates_g: input.nutrition.carbohydrates_g,
      fat_g: input.nutrition.fat_g,
      defaultServing: input.servings?.[0]
        ? {
            label: input.servings[0].label,
            amount: input.servings[0].amount,
            unit: input.servings[0].unit,
          }
        : null,
      matchKind: 'exact_name',
      score: 0,
    });
  } catch (cause) {
    logger.error('Could not create custom food', {
      reason: cause instanceof Error ? cause.message : 'unknown',
    });

    return err(
      appError('server', 'That food could not be saved. Check your connection and try again.', {
        code: 'custom_food_failed',
        retryable: true,
      }),
    );
  }
}

/**
 * Finds or creates a brand the user owns.
 *
 * Owner-scoped, never global: a user typing "Alpro" gets their own brand row
 * rather than editing the shared catalogue's. The shared brand table is
 * read-only to them by RLS anyway, so attempting otherwise would simply fail.
 */
async function resolveOwnedBrand(
  client: typeof supabase,
  userId: string,
  brandName: string,
  source: CustomFoodSource,
): Promise<string | null> {
  const name = cleanName(brandName);
  if (!name) return null;

  const normalized = normalizeForSearch(name);

  const { data: existing } = await client
    .from('food_brands')
    .select('id')
    .eq('owner_id', userId)
    .eq('normalized_name', normalized)
    .is('deleted_at', null)
    .maybeSingle();

  if (existing) return String((existing as { id: string }).id);

  const { data: created, error } = await client
    .from('food_brands')
    .insert({
      owner_id: userId,
      name,
      normalized_name: normalized,
      source_id: source,
    })
    .select('id')
    .single();

  if (error || !created) {
    // A nameless brand is better than a failed save; the food keeps its name.
    logger.warn('Could not create custom brand', { reason: error?.message });
    return null;
  }

  return String((created as { id: string }).id);
}
