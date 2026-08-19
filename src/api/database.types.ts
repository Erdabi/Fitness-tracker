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
    };
    Views: Record<never, never>;
    Functions: Record<never, never>;
    Enums: {
      sex: 'male' | 'female' | 'other';
      unit_system: 'metric' | 'imperial';
      theme_pref: 'light' | 'dark' | 'system';
    };
    CompositeTypes: Record<never, never>;
  };
}
