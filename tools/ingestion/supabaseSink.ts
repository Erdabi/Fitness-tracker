import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { CatalogSink, ExistingFood } from './pipeline';
import type { CanonicalFood, SourceId } from './types';

/**
 * Writes the shared catalogue.
 *
 * SECURITY: this runs with the **service role key**, which bypasses Row Level
 * Security. That is exactly why importing is a server-side tool and not an app
 * feature — the shared catalogue has no write policy for `authenticated`, so
 * there is no path from the mobile client to these rows at all.
 *
 * The key is read from the environment and must never be committed, put in
 * `app.config.ts`, or given an `EXPO_PUBLIC_` prefix.
 */
export function createSupabaseSink(): CatalogSink {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before importing.\n' +
        'Find them in Project Settings → API. The service role key bypasses ' +
        'RLS — keep it out of the repository and out of the app bundle.',
    );
  }

  const client: SupabaseClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return createSinkFor(client);
}

/** Exported separately so tests can supply their own client. */
export function createSinkFor(client: SupabaseClient): CatalogSink {
  /** Finds or creates a shared brand, returning its id. */
  async function resolveBrand(food: CanonicalFood): Promise<string | null> {
    if (!food.brand) return null;

    const { data: existing } = await client
      .from('food_brands')
      .select('id')
      .is('owner_id', null)
      .eq('normalized_name', food.brand.normalizedName)
      .maybeSingle();

    if (existing) return (existing as { id: string }).id;

    const { data, error } = await client
      .from('food_brands')
      .insert({
        owner_id: null,
        name: food.brand.name,
        normalized_name: food.brand.normalizedName,
        source_id: food.sourceId,
      })
      .select('id')
      .single();

    if (error) throw new Error(`brand insert failed: ${error.message}`);
    return (data as { id: string }).id;
  }

  async function writeChildren(foodId: string, food: CanonicalFood): Promise<void> {
    const { error: nutritionError } = await client.from('food_nutrition').upsert(
      {
        food_id: foodId,
        calories: food.nutrition.calories,
        protein_g: food.nutrition.protein_g,
        carbohydrates_g: food.nutrition.carbohydrates_g,
        fat_g: food.nutrition.fat_g,
        fiber_g: food.nutrition.fiber_g,
        sugar_g: food.nutrition.sugar_g,
        saturated_fat_g: food.nutrition.saturated_fat_g,
        sodium_mg: food.nutrition.sodium_mg,
        micronutrients: food.nutrition.micronutrients,
        source_id: food.sourceId,
      },
      { onConflict: 'food_id' },
    );
    // The database refuses a downgrade even if the pipeline's own check let
    // one through. Surface it rather than swallowing it.
    if (nutritionError) throw new Error(`nutrition write failed: ${nutritionError.message}`);

    if (food.servings.length > 0) {
      // Replace wholesale: a source revision may have removed a portion, and
      // a stale serving would keep offering a portion the label no longer has.
      await client.from('food_servings').delete().eq('food_id', foodId);

      const { error } = await client.from('food_servings').insert(
        food.servings.map((serving, index) => ({
          food_id: foodId,
          label: serving.label,
          amount: serving.amount,
          unit: serving.unit,
          is_default: serving.isDefault,
          sort_order: index,
          source_id: food.sourceId,
        })),
      );
      if (error) throw new Error(`servings write failed: ${error.message}`);
    }

    for (const barcode of food.barcodes) {
      const { error } = await client.from('food_barcodes').upsert(
        {
          food_id: foodId,
          barcode: barcode.barcode,
          format: barcode.format,
          source_id: food.sourceId,
        },
        { onConflict: 'barcode' },
      );
      if (error) throw new Error(`barcode write failed: ${error.message}`);
    }
  }

  return {
    async findByExternalId(
      sourceId: SourceId,
      externalId: string,
    ): Promise<ExistingFood | null> {
      const { data, error } = await client
        .from('foods')
        .select('id, source_updated_at, food_nutrition(source_id)')
        .is('owner_id', null)
        .eq('source_id', sourceId)
        .eq('external_id', externalId)
        .maybeSingle();

      if (error) throw new Error(`lookup failed: ${error.message}`);
      if (!data) return null;

      const row = data as {
        id: string;
        source_updated_at: string | null;
        food_nutrition: { source_id: SourceId }[] | { source_id: SourceId } | null;
      };

      const nutrition = Array.isArray(row.food_nutrition)
        ? row.food_nutrition[0]
        : row.food_nutrition;

      return {
        id: row.id,
        // No nutrition row yet means nothing to protect; treat it as the
        // weakest source so any incoming data is allowed to land.
        nutritionSource: nutrition?.source_id ?? 'ai_estimated',
        sourceUpdatedAt: row.source_updated_at,
      };
    },

    async insert(food: CanonicalFood): Promise<string> {
      const brandId = await resolveBrand(food);

      const { data, error } = await client
        .from('foods')
        .insert({
          owner_id: null,
          brand_id: brandId,
          name: food.name,
          normalized_name: food.normalizedName,
          kind: food.kind,
          base_unit: food.baseUnit,
          base_amount: food.baseAmount,
          source_id: food.sourceId,
          external_id: food.externalId,
          source_url: food.sourceUrl,
          source_updated_at: food.sourceUpdatedAt,
          imported_at: new Date().toISOString(),
          is_verified: food.sourceId === 'usda',
        })
        .select('id')
        .single();

      if (error) throw new Error(`food insert failed: ${error.message}`);

      const foodId = (data as { id: string }).id;
      await writeChildren(foodId, food);
      return foodId;
    },

    async replace(id: string, food: CanonicalFood): Promise<void> {
      const brandId = await resolveBrand(food);

      const { error } = await client
        .from('foods')
        .update({
          brand_id: brandId,
          name: food.name,
          normalized_name: food.normalizedName,
          kind: food.kind,
          base_unit: food.baseUnit,
          base_amount: food.baseAmount,
          source_url: food.sourceUrl,
          source_updated_at: food.sourceUpdatedAt,
          imported_at: new Date().toISOString(),
        })
        .eq('id', id);

      if (error) throw new Error(`food update failed: ${error.message}`);
      await writeChildren(id, food);
    },
  };
}
