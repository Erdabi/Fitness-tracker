import type { SyncColumns } from './types';

/**
 * Local row shapes.
 *
 * These mirror the tables created in `src/db/migrations.ts` exactly. The
 * migration test asserts that every field declared here exists as a column, so
 * the two cannot drift apart silently.
 *
 * SQLite has no boolean or date types: booleans are 0/1, timestamps are epoch
 * milliseconds, and calendar days are `YYYY-MM-DD` strings.
 */

export type Sex = 'male' | 'female' | 'other';
export type UnitSystemValue = 'metric' | 'imperial';
export type ThemeValue = 'light' | 'dark' | 'system';

export interface ProfileRow extends SyncColumns {
  id: string;
  email: string | null;
  display_name: string | null;
  sex: Sex | null;
  /** `YYYY-MM-DD`. */
  birth_date: string | null;
  height_cm: number | null;
  unit_system: UnitSystemValue;
  /** IANA zone, e.g. `Europe/Zurich`. Drives every calendar-day calculation. */
  time_zone: string;
  created_at: number;
}

export interface UserSettingsRow extends SyncColumns {
  id: string;
  user_id: string;
  theme: ThemeValue;
  water_goal_ml: number;
  /** 0 or 1. Whether exercise adds calories back to the daily budget. */
  exercise_adds_calories: number;
  created_at: number;
}

export interface FoodRecentRow extends SyncColumns {
  id: string;
  user_id: string;
  food_id: string;
  /** Epoch ms. */
  last_used_at: number;
  use_count: number;
  created_at: number;
}

/**
 * A cached catalogue food. Local only — never synced, never pushed.
 *
 * Booleans are 0/1 and nutrients are per `base_amount` of `base_unit`, matching
 * the server representation so the same arithmetic works on both.
 */
export interface FoodCacheRow {
  food_id: string;
  name: string;
  brand_name: string | null;
  source_id: string;
  is_verified: number;
  is_own: number;
  base_unit: 'g' | 'ml' | 'item';
  base_amount: number;
  calories: number;
  protein_g: number;
  carbohydrates_g: number;
  fat_g: number;
  fiber_g: number | null;
  sugar_g: number | null;
  saturated_fat_g: number | null;
  sodium_mg: number | null;
  cached_at: number;
}

export interface FoodCacheServingRow {
  id: string;
  food_id: string;
  label: string;
  amount: number;
  unit: 'g' | 'ml' | 'item';
  is_default: number;
  sort_order: number;
}

/**
 * Column manifest, used by the migration test to verify that the shipped SQL
 * actually produces the shape the code expects.
 */
export const TABLE_COLUMNS = {
  profiles: [
    'id',
    'email',
    'display_name',
    'sex',
    'birth_date',
    'height_cm',
    'unit_system',
    'time_zone',
    'created_at',
    'updated_at',
    'server_updated_at',
    'deleted_at',
  ],
  user_settings: [
    'id',
    'user_id',
    'theme',
    'water_goal_ml',
    'exercise_adds_calories',
    'created_at',
    'updated_at',
    'server_updated_at',
    'deleted_at',
  ],
  sync_outbox: [
    'id',
    'table_name',
    'row_id',
    'operation',
    'payload',
    'created_at',
    'attempts',
    'next_attempt_at',
    'last_error',
  ],
  sync_state: ['table_name', 'cursor', 'last_pulled_at'],
  food_recents: [
    'id',
    'user_id',
    'food_id',
    'last_used_at',
    'use_count',
    'created_at',
    'updated_at',
    'server_updated_at',
    'deleted_at',
  ],
  food_cache: [
    'food_id',
    'name',
    'brand_name',
    'source_id',
    'is_verified',
    'is_own',
    'base_unit',
    'base_amount',
    'calories',
    'protein_g',
    'carbohydrates_g',
    'fat_g',
    'fiber_g',
    'sugar_g',
    'saturated_fat_g',
    'sodium_mg',
    'cached_at',
  ],
  food_cache_servings: [
    'id',
    'food_id',
    'label',
    'amount',
    'unit',
    'is_default',
    'sort_order',
  ],
} as const satisfies Record<string, readonly string[]>;
