import { describeTable, type TableDescriptor } from './types';
import type { FoodRecentRow, ProfileRow, UserSettingsRow } from '@/db/schema';

/**
 * Registered syncable tables, in dependency order.
 *
 * Order matters on push: `user_settings` references `profiles`, so a profile
 * must exist server-side before its settings row is accepted.
 *
 * Adding a table to sync means adding a descriptor here. The engine never
 * needs to change.
 */

const profiles: TableDescriptor = describeTable<ProfileRow>({
  table: 'profiles',
  remoteTable: 'profiles',
  userColumn: 'id',
  toRemote: (local) => ({
    id: local.id,
    display_name: local.display_name,
    sex: local.sex,
    birth_date: local.birth_date,
    height_cm: local.height_cm,
    unit_system: local.unit_system,
    time_zone: local.time_zone,
    deleted_at: local.deleted_at ? new Date(local.deleted_at).toISOString() : null,
  }),
  fromRemote: (remote) => ({
    id: String(remote.id),
    email: asNullableString(remote.email),
    display_name: asNullableString(remote.display_name),
    sex: asNullableString(remote.sex) as ProfileRow['sex'],
    birth_date: asNullableString(remote.birth_date),
    height_cm: asNullableNumber(remote.height_cm),
    unit_system: (asNullableString(remote.unit_system) ??
      'metric') as ProfileRow['unit_system'],
    time_zone: asNullableString(remote.time_zone) ?? 'UTC',
    created_at: toEpochMs(remote.created_at) ?? Date.now(),
    updated_at: toEpochMs(remote.updated_at) ?? Date.now(),
    server_updated_at: asNullableString(remote.updated_at),
    deleted_at: toEpochMs(remote.deleted_at),
  }),
});

const userSettings: TableDescriptor = describeTable<UserSettingsRow>({
  table: 'user_settings',
  remoteTable: 'user_settings',
  userColumn: 'user_id',
  toRemote: (local) => ({
    id: local.id,
    user_id: local.user_id,
    theme: local.theme,
    water_goal_ml: local.water_goal_ml,
    // SQLite stores booleans as 0/1; Postgres wants a real boolean.
    exercise_adds_calories: local.exercise_adds_calories === 1,
    deleted_at: local.deleted_at ? new Date(local.deleted_at).toISOString() : null,
  }),
  fromRemote: (remote) => ({
    id: String(remote.id),
    user_id: String(remote.user_id),
    theme: (asNullableString(remote.theme) ?? 'system') as UserSettingsRow['theme'],
    water_goal_ml: asNullableNumber(remote.water_goal_ml) ?? 2500,
    exercise_adds_calories: remote.exercise_adds_calories === true ? 1 : 0,
    created_at: toEpochMs(remote.created_at) ?? Date.now(),
    updated_at: toEpochMs(remote.updated_at) ?? Date.now(),
    server_updated_at: asNullableString(remote.updated_at),
    deleted_at: toEpochMs(remote.deleted_at),
  }),
});



/* ------------------------------------------------------------- coercion -- */
// Server payloads are `unknown` at the boundary. These narrow without
// throwing, so one unexpected column cannot abort an entire pull.

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toEpochMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Recently used foods.
 *
 * Registered last: a recent row references a food, and although the shared
 * catalogue always exists server-side, keeping the order explicit means a
 * future user-owned food will push before the recent that points at it.
 */
const foodRecents: TableDescriptor = describeTable<FoodRecentRow>({
  table: 'food_recents',
  remoteTable: 'food_recents',
  userColumn: 'user_id',
  toRemote: (local) => ({
    id: local.id,
    user_id: local.user_id,
    food_id: local.food_id,
    last_used_at: new Date(local.last_used_at).toISOString(),
    use_count: local.use_count,
    deleted_at: local.deleted_at ? new Date(local.deleted_at).toISOString() : null,
  }),
  fromRemote: (remote) => ({
    id: String(remote.id),
    user_id: String(remote.user_id),
    food_id: String(remote.food_id),
    last_used_at: toEpochMs(remote.last_used_at) ?? Date.now(),
    use_count: asNullableNumber(remote.use_count) ?? 1,
    created_at: toEpochMs(remote.created_at) ?? Date.now(),
    updated_at: toEpochMs(remote.updated_at) ?? Date.now(),
    server_updated_at: asNullableString(remote.updated_at),
    deleted_at: toEpochMs(remote.deleted_at),
  }),
});

export const SYNC_REGISTRY = [profiles, userSettings, foodRecents] as const;
