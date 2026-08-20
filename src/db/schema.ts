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
export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

/** Meals in the order a day happens, which is also the order they render. */
export const MEAL_SLOTS: readonly MealSlot[] = [
  'breakfast',
  'lunch',
  'dinner',
  'snack',
];

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
 * One logged item.
 *
 * The `basis_*` columns are a frozen copy of the food's nutrition per
 * `basis_amount` of `basis_unit`, taken at the moment of logging. The
 * unprefixed nutrient columns are that basis scaled to what was actually
 * eaten. Nothing here is read back from the catalogue, which is what makes a
 * historical entry immune to a food being corrected, renamed or deleted.
 */
export interface FoodLogRow extends SyncColumns {
  id: string;
  user_id: string;
  /** Provenance only, and null once the catalogue row is gone. */
  food_id: string | null;
  serving_id: string | null;
  meal: MealSlot;

  /** Epoch ms. The instant the food was eaten. */
  logged_at: number;
  /** IANA zone the entry was made in, kept so its date can be explained. */
  time_zone: string;
  /** `YYYY-MM-DD` in `time_zone`. Never a UTC truncation. */
  diary_date: string;

  quantity: number;
  serving_label: string;
  /** The portion's size in `basis_unit`; 1 when logging raw base units. */
  serving_amount: number;
  /** `quantity * serving_amount`, the only number the arithmetic uses. */
  amount_in_base: number;

  food_name: string;
  brand_name: string | null;
  food_source_id: string;
  /** 0 or 1. Whether the data was verified *when this was logged*. */
  food_is_verified: number;

  basis_unit: 'g' | 'ml' | 'item';
  basis_amount: number;
  basis_calories: number;
  basis_protein_g: number;
  basis_carbohydrates_g: number;
  basis_fat_g: number;
  basis_fiber_g: number | null;
  basis_sugar_g: number | null;
  basis_saturated_fat_g: number | null;
  basis_sodium_mg: number | null;

  calories: number;
  protein_g: number;
  carbohydrates_g: number;
  fat_g: number;
  fiber_g: number | null;
  sugar_g: number | null;
  saturated_fat_g: number | null;
  sodium_mg: number | null;

  note: string | null;
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
  food_logs: [
    'id',
    'user_id',
    'food_id',
    'serving_id',
    'meal',
    'logged_at',
    'time_zone',
    'diary_date',
    'quantity',
    'serving_label',
    'serving_amount',
    'amount_in_base',
    'food_name',
    'brand_name',
    'food_source_id',
    'food_is_verified',
    'basis_unit',
    'basis_amount',
    'basis_calories',
    'basis_protein_g',
    'basis_carbohydrates_g',
    'basis_fat_g',
    'basis_fiber_g',
    'basis_sugar_g',
    'basis_saturated_fat_g',
    'basis_sodium_mg',
    'calories',
    'protein_g',
    'carbohydrates_g',
    'fat_g',
    'fiber_g',
    'sugar_g',
    'saturated_fat_g',
    'sodium_mg',
    'note',
    'created_at',
    'updated_at',
    'server_updated_at',
    'deleted_at',
  ],
} as const satisfies Record<string, readonly string[]>;
