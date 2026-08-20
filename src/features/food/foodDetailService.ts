import { supabase } from '@/api/supabase';
import { getDatabase } from '@/db/client';
import { getCachedFood, getCachedServings } from '@/db/repositories/foodRecents';
import { appError, err, ok, type Result } from '@/lib/result';
import type { NutritionPerBase, Serving } from '@/lib/nutrition';
import type { FoodSearchResult, ResultOrigin } from './types';

/**
 * Full detail for one food: everything the serving screen needs to do real
 * arithmetic.
 *
 * Tries the server, falls back to the local cache. The fallback is what makes
 * a recent food loggable with no connection, and `origin` is reported so the
 * UI can say which it is showing rather than blurring the two.
 */

export interface FoodDetail {
  readonly food: FoodSearchResult;
  readonly nutrition: NutritionPerBase;
  readonly servings: readonly Serving[];
  readonly origin: ResultOrigin;
}

const num = (value: number | string | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

const optionalNum = (value: number | string | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

export async function getFoodDetail(foodId: string): Promise<Result<FoodDetail>> {
  try {
    const { data, error } = await supabase
      .from('foods')
      .select(
        `id, name, base_unit, base_amount, source_id, is_verified, owner_id,
         food_brands(name),
         food_nutrition(calories, protein_g, carbohydrates_g, fat_g,
                        fiber_g, sugar_g, saturated_fat_g, sodium_mg),
         food_servings(id, label, amount, unit, is_default, sort_order)`,
      )
      .eq('id', foodId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (data) return ok(fromServer(data as ServerFoodRow));

    return err(
      appError('not_found', 'That food is no longer available.', {
        code: 'food_not_found',
        retryable: false,
      }),
    );
  } catch (cause) {
    // Offline, or the server is unreachable: the cache is the fallback, and it
    // holds exactly the foods this user has picked before.
    const cached = readFromCache(foodId);
    if (cached) return ok(cached);

    return err(
      appError(
        'network',
        'This food needs an internet connection — it is not saved on your device.',
        { code: 'offline_uncached', cause, retryable: true },
      ),
    );
  }
}

interface ServerFoodRow {
  id: string;
  name: string;
  base_unit: 'g' | 'ml' | 'item';
  base_amount: number | string;
  source_id: string;
  is_verified: boolean;
  owner_id: string | null;
  food_brands: { name: string } | { name: string }[] | null;
  food_nutrition:
    | Record<string, number | string | null>
    | Record<string, number | string | null>[]
    | null;
  food_servings: {
    id: string;
    label: string;
    amount: number | string;
    unit: 'g' | 'ml' | 'item';
    is_default: boolean;
    sort_order: number;
  }[];
}

function fromServer(row: ServerFoodRow): FoodDetail {
  // PostgREST returns an embedded to-one relation as an object or a
  // single-element array depending on how it inferred the relationship.
  const brand = Array.isArray(row.food_brands) ? row.food_brands[0] : row.food_brands;
  const rawNutrition = Array.isArray(row.food_nutrition)
    ? row.food_nutrition[0]
    : row.food_nutrition;

  const nutrition: NutritionPerBase = {
    calories: num(rawNutrition?.calories),
    protein_g: num(rawNutrition?.protein_g),
    carbohydrates_g: num(rawNutrition?.carbohydrates_g),
    fat_g: num(rawNutrition?.fat_g),
    fiber_g: optionalNum(rawNutrition?.fiber_g),
    sugar_g: optionalNum(rawNutrition?.sugar_g),
    saturated_fat_g: optionalNum(rawNutrition?.saturated_fat_g),
    sodium_mg: optionalNum(rawNutrition?.sodium_mg),
  };

  const servings: Serving[] = [...(row.food_servings ?? [])]
    .sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.sort_order - b.sort_order)
    .map((serving) => ({
      id: serving.id,
      label: serving.label,
      amount: num(serving.amount),
      unit: serving.unit,
    }));

  return {
    food: {
      foodId: row.id,
      name: row.name,
      brandName: brand?.name ?? null,
      sourceId: row.source_id as FoodSearchResult['sourceId'],
      isVerified: row.is_verified,
      isOwn: row.owner_id !== null,
      baseUnit: row.base_unit,
      baseAmount: num(row.base_amount),
      calories: nutrition.calories,
      protein_g: nutrition.protein_g,
      carbohydrates_g: nutrition.carbohydrates_g,
      fat_g: nutrition.fat_g,
      defaultServing: servings[0]
        ? { label: servings[0].label, amount: servings[0].amount, unit: servings[0].unit }
        : null,
      matchKind: 'exact_name',
      score: 0,
    },
    nutrition,
    servings,
    origin: 'server',
  };
}

function readFromCache(foodId: string): FoodDetail | null {
  try {
    const db = getDatabase();
    const cached = getCachedFood(foodId, db);
    if (!cached) return null;

    const nutrition: NutritionPerBase = {
      calories: cached.calories,
      protein_g: cached.protein_g,
      carbohydrates_g: cached.carbohydrates_g,
      fat_g: cached.fat_g,
      fiber_g: cached.fiber_g,
      sugar_g: cached.sugar_g,
      saturated_fat_g: cached.saturated_fat_g,
      sodium_mg: cached.sodium_mg,
    };

    const servings: Serving[] = getCachedServings(foodId, db).map((serving) => ({
      id: serving.id,
      label: serving.label,
      amount: serving.amount,
      unit: serving.unit,
    }));

    return {
      food: {
        foodId: cached.food_id,
        name: cached.name,
        brandName: cached.brand_name,
        sourceId: cached.source_id as FoodSearchResult['sourceId'],
        isVerified: cached.is_verified === 1,
        isOwn: cached.is_own === 1,
        baseUnit: cached.base_unit,
        baseAmount: cached.base_amount,
        calories: cached.calories,
        protein_g: cached.protein_g,
        carbohydrates_g: cached.carbohydrates_g,
        fat_g: cached.fat_g,
        defaultServing: servings[0]
          ? { label: servings[0].label, amount: servings[0].amount, unit: servings[0].unit }
          : null,
        matchKind: 'recent',
        score: 0,
      },
      nutrition,
      servings,
      origin: 'cache',
    };
  } catch {
    return null;
  }
}
