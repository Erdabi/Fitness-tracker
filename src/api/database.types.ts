/**
 * Postgres schema types.
 *
 * Hand-written for Phase 0 to match `supabase/migrations`. Once the schema
 * grows, regenerate instead of editing:
 *
 *   npx supabase gen types typescript --project-id <ref> > src/api/database.types.ts
 *
 * Keep the shape identical to the generator's output so the switch is a
 * drop-in replacement.
 */

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

/** Mirrors the `public.food_search_result` composite type. */
export interface FoodSearchResultRow {
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

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string | null;
          display_name: string | null;
          sex: 'male' | 'female' | 'other' | null;
          birth_date: string | null;
          height_cm: number | null;
          unit_system: 'metric' | 'imperial';
          time_zone: string;
          activity_level: 'sedentary' | 'light' | 'moderate' | 'very' | 'extra' | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id: string;
          email?: string | null;
          display_name?: string | null;
          sex?: 'male' | 'female' | 'other' | null;
          birth_date?: string | null;
          height_cm?: number | null;
          unit_system?: 'metric' | 'imperial';
          time_zone?: string;
          deleted_at?: string | null;
        };
        Update: {
          display_name?: string | null;
          sex?: 'male' | 'female' | 'other' | null;
          birth_date?: string | null;
          height_cm?: number | null;
          unit_system?: 'metric' | 'imperial';
          time_zone?: string;
          activity_level?: 'sedentary' | 'light' | 'moderate' | 'very' | 'extra' | null;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      user_settings: {
        Row: {
          id: string;
          user_id: string;
          theme: 'light' | 'dark' | 'system';
          water_goal_ml: number;
          exercise_adds_calories: boolean;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          theme?: 'light' | 'dark' | 'system';
          water_goal_ml?: number;
          exercise_adds_calories?: boolean;
          deleted_at?: string | null;
        };
        Update: {
          theme?: 'light' | 'dark' | 'system';
          water_goal_ml?: number;
          exercise_adds_calories?: boolean;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'user_settings_user_id_fkey';
            columns: ['user_id'];
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      food_brands: {
        Row: {
          id: string;
          owner_id: string | null;
          name: string;
          normalized_name: string;
          source_id: string;
          external_id: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          owner_id?: string | null;
          name: string;
          normalized_name: string;
          source_id: string;
          external_id?: string | null;
        };
        Update: { name?: string; normalized_name?: string; deleted_at?: string | null };
        Relationships: [];
      };
      foods: {
        Row: {
          id: string;
          owner_id: string | null;
          brand_id: string | null;
          category_id: string | null;
          name: string;
          normalized_name: string;
          name_i18n: Json;
          description: string | null;
          kind: 'generic' | 'branded' | 'packaged';
          base_unit: 'g' | 'ml' | 'item';
          base_amount: number;
          source_id: string;
          external_id: string | null;
          source_url: string | null;
          source_updated_at: string | null;
          imported_at: string | null;
          is_verified: boolean;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          owner_id: string | null;
          brand_id?: string | null;
          name: string;
          normalized_name: string;
          kind?: 'generic' | 'branded' | 'packaged';
          base_unit: 'g' | 'ml' | 'item';
          base_amount?: number;
          source_id: string;
          is_verified?: boolean;
        };
        Update: {
          name?: string;
          normalized_name?: string;
          brand_id?: string | null;
          base_unit?: 'g' | 'ml' | 'item';
          base_amount?: number;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'foods_brand_id_fkey';
            columns: ['brand_id'];
            referencedRelation: 'food_brands';
            referencedColumns: ['id'];
          },
        ];
      };
      food_nutrition: {
        Row: {
          food_id: string;
          calories: number;
          protein_g: number;
          carbohydrates_g: number;
          fat_g: number;
          fiber_g: number | null;
          sugar_g: number | null;
          saturated_fat_g: number | null;
          sodium_mg: number | null;
          micronutrients: Json;
          source_id: string;
          confidence: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          food_id: string;
          calories: number;
          protein_g?: number;
          carbohydrates_g?: number;
          fat_g?: number;
          fiber_g?: number | null;
          sugar_g?: number | null;
          saturated_fat_g?: number | null;
          sodium_mg?: number | null;
          micronutrients?: Json;
          source_id: string;
          confidence?: number | null;
        };
        Update: {
          calories?: number;
          protein_g?: number;
          carbohydrates_g?: number;
          fat_g?: number;
          source_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'food_nutrition_food_id_fkey';
            columns: ['food_id'];
            referencedRelation: 'foods';
            referencedColumns: ['id'];
          },
        ];
      };
      food_servings: {
        Row: {
          id: string;
          food_id: string;
          label: string;
          amount: number;
          unit: 'g' | 'ml' | 'item';
          is_default: boolean;
          sort_order: number;
          source_id: string;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          food_id: string;
          label: string;
          amount: number;
          unit: 'g' | 'ml' | 'item';
          is_default?: boolean;
          sort_order?: number;
          source_id: string;
        };
        Update: {
          label?: string;
          amount?: number;
          is_default?: boolean;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'food_servings_food_id_fkey';
            columns: ['food_id'];
            referencedRelation: 'foods';
            referencedColumns: ['id'];
          },
        ];
      };
      food_barcodes: {
        Row: {
          id: string;
          food_id: string;
          owner_id: string | null;
          barcode: string;
          format: 'ean13' | 'ean8' | 'upca' | 'upce' | 'other';
          source_id: string;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          food_id: string;
          barcode: string;
          format?: 'ean13' | 'ean8' | 'upca' | 'upce' | 'other';
          source_id: string;
        };
        Update: { deleted_at?: string | null };
        Relationships: [
          {
            foreignKeyName: 'food_barcodes_food_id_fkey';
            columns: ['food_id'];
            referencedRelation: 'foods';
            referencedColumns: ['id'];
          },
        ];
      };
      food_recents: {
        Row: {
          id: string;
          user_id: string;
          food_id: string;
          last_used_at: string;
          use_count: number;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          food_id: string;
          last_used_at?: string;
          use_count?: number;
          deleted_at?: string | null;
        };
        Update: {
          last_used_at?: string;
          use_count?: number;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'food_recents_user_id_fkey';
            columns: ['user_id'];
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'food_recents_food_id_fkey';
            columns: ['food_id'];
            referencedRelation: 'foods';
            referencedColumns: ['id'];
          },
        ];
      };
      food_logs: {
        Row: {
          id: string;
          user_id: string;
          food_id: string | null;
          serving_id: string | null;
          meal: 'breakfast' | 'lunch' | 'dinner' | 'snack';
          logged_at: string;
          time_zone: string;
          /** `YYYY-MM-DD` in `time_zone`. Never a UTC truncation. */
          diary_date: string;
          quantity: number | string;
          serving_label: string;
          serving_amount: number | string;
          /** Generated. */
          amount_in_base: number | string;
          food_name: string;
          brand_name: string | null;
          food_source_id: string;
          food_is_verified: boolean;
          basis_unit: 'g' | 'ml' | 'item';
          basis_amount: number | string;
          basis_calories: number | string;
          basis_protein_g: number | string;
          basis_carbohydrates_g: number | string;
          basis_fat_g: number | string;
          basis_fiber_g: number | string | null;
          basis_sugar_g: number | string | null;
          basis_saturated_fat_g: number | string | null;
          basis_sodium_mg: number | string | null;
          /** Generated from the basis and the portion; never client-supplied. */
          calories: number | string;
          protein_g: number | string;
          carbohydrates_g: number | string;
          fat_g: number | string;
          fiber_g: number | string | null;
          sugar_g: number | string | null;
          saturated_fat_g: number | string | null;
          sodium_mg: number | string | null;
          note: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        /*
         * The generated columns are absent by construction: Postgres rejects a
         * supplied value for them, which is what stops any client from writing
         * a total that contradicts its own basis.
         */
        Insert: {
          id?: string;
          user_id: string;
          food_id?: string | null;
          serving_id?: string | null;
          meal: 'breakfast' | 'lunch' | 'dinner' | 'snack';
          logged_at?: string;
          time_zone: string;
          /** Optional: derived from `logged_at` in `time_zone` when omitted. */
          diary_date?: string | null;
          quantity: number;
          serving_label: string;
          serving_amount: number;
          food_name: string;
          brand_name?: string | null;
          food_source_id: string;
          food_is_verified?: boolean;
          basis_unit: 'g' | 'ml' | 'item';
          basis_amount: number;
          basis_calories: number;
          basis_protein_g?: number;
          basis_carbohydrates_g?: number;
          basis_fat_g?: number;
          basis_fiber_g?: number | null;
          basis_sugar_g?: number | null;
          basis_saturated_fat_g?: number | null;
          basis_sodium_mg?: number | null;
          note?: string | null;
          deleted_at?: string | null;
        };
        /* The snapshot columns are absent here too: a trigger refuses them. */
        Update: {
          meal?: 'breakfast' | 'lunch' | 'dinner' | 'snack';
          logged_at?: string;
          time_zone?: string;
          diary_date?: string | null;
          quantity?: number;
          serving_label?: string;
          serving_amount?: number;
          serving_id?: string | null;
          note?: string | null;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'food_logs_user_id_fkey';
            columns: ['user_id'];
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'food_logs_food_id_fkey';
            columns: ['food_id'];
            referencedRelation: 'foods';
            referencedColumns: ['id'];
          },
        ];
      };
      nutrition_goals: {
        Row: {
          id: string;
          user_id: string;
          effective_from: string;
          /** Derived by trigger. NULL = current period. */
          effective_to: string | null;
          calorie_target: number;
          protein_target_g: number | string;
          carbohydrate_target_g: number | string;
          fat_target_g: number | string;
          source: 'calculated' | 'manual' | 'calculated_then_modified';
          calculated_calories: number | null;
          calculated_protein_g: number | string | null;
          calculated_carbohydrate_g: number | string | null;
          calculated_fat_g: number | string | null;
          basis_bmr: number | null;
          basis_tdee: number | null;
          basis_activity: 'sedentary' | 'light' | 'moderate' | 'very' | 'extra' | null;
          basis_direction: 'lose' | 'maintain' | 'gain' | null;
          basis_weight_kg: number | string | null;
          basis_height_cm: number | string | null;
          basis_age_years: number | null;
          basis_sex: 'male' | 'female' | 'other' | null;
          acknowledged_below_floor: boolean;
          note: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        /*
         * `effective_to` is absent by design: the server derives it, and a
         * client that supplied it would need two writes to land in order.
         */
        Insert: {
          id?: string;
          user_id: string;
          effective_from: string;
          calorie_target: number;
          protein_target_g: number;
          carbohydrate_target_g: number;
          fat_target_g: number;
          source: 'calculated' | 'manual' | 'calculated_then_modified';
          calculated_calories?: number | null;
          calculated_protein_g?: number | null;
          calculated_carbohydrate_g?: number | null;
          calculated_fat_g?: number | null;
          basis_bmr?: number | null;
          basis_tdee?: number | null;
          basis_activity?: 'sedentary' | 'light' | 'moderate' | 'very' | 'extra' | null;
          basis_direction?: 'lose' | 'maintain' | 'gain' | null;
          basis_weight_kg?: number | null;
          basis_height_cm?: number | null;
          basis_age_years?: number | null;
          basis_sex?: 'male' | 'female' | 'other' | null;
          acknowledged_below_floor?: boolean;
          note?: string | null;
          deleted_at?: string | null;
        };
        Update: {
          calorie_target?: number;
          protein_target_g?: number;
          carbohydrate_target_g?: number;
          fat_target_g?: number;
          source?: 'calculated' | 'manual' | 'calculated_then_modified';
          acknowledged_below_floor?: boolean;
          note?: string | null;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'nutrition_goals_user_id_fkey';
            columns: ['user_id'];
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      weight_entries: {
        Row: {
          id: string;
          user_id: string;
          measured_on: string;
          weight_kg: number | string;
          note: string | null;
          created_at: string;
          updated_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          measured_on: string;
          weight_kg: number;
          note?: string | null;
          deleted_at?: string | null;
        };
        Update: {
          weight_kg?: number;
          note?: string | null;
          deleted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'weight_entries_user_id_fkey';
            columns: ['user_id'];
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: Record<never, never>;
    Functions: {
      /*
       * The search RPCs. `numeric` columns arrive as strings over PostgREST —
       * that is deliberate on Supabase's side, to avoid float precision loss —
       * so the row type says `number | string` and searchService converts once
       * at the boundary.
       */
      search_foods: {
        Args: {
          p_query: string;
          p_limit?: number;
          p_cursor_score?: number | null;
          p_cursor_id?: string | null;
        };
        Returns: FoodSearchResultRow[];
      };
      lookup_barcode: {
        Args: { p_barcode: string };
        Returns: { result: FoodSearchResultRow; duplicate_count: number }[];
      };
      list_recent_foods: {
        Args: { p_limit?: number; p_order?: string };
        Returns: FoodSearchResultRow[];
      };
    };
    Enums: {
      sex: 'male' | 'female' | 'other';
      unit_system: 'metric' | 'imperial';
      theme_pref: 'light' | 'dark' | 'system';
      meal_slot: 'breakfast' | 'lunch' | 'dinner' | 'snack';
      activity_level: 'sedentary' | 'light' | 'moderate' | 'very' | 'extra';
      goal_direction: 'lose' | 'maintain' | 'gain';
      goal_source: 'calculated' | 'manual' | 'calculated_then_modified';
    };
    CompositeTypes: Record<never, never>;
  };
}
