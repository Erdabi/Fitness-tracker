import { getDatabase } from '../client';
import type { ProfileRow, UserSettingsRow } from '../schema';
import type { SqlDatabase } from '../types';
import { newId } from '@/lib/id';
import { withOutbox } from '@/sync/outbox';

/**
 * Profile reads and writes.
 *
 * Reads hit SQLite only — never the network — so screens render instantly and
 * work offline. Writes go through `withOutbox` so the local row and its sync
 * entry commit atomically.
 */

export function getProfile(
  userId: string,
  db: SqlDatabase = getDatabase(),
): ProfileRow | undefined {
  return db.get<ProfileRow>(
    'SELECT * FROM profiles WHERE id = ? AND deleted_at IS NULL',
    [userId],
  );
}

export function getSettings(
  userId: string,
  db: SqlDatabase = getDatabase(),
): UserSettingsRow | undefined {
  return db.get<UserSettingsRow>(
    'SELECT * FROM user_settings WHERE user_id = ? AND deleted_at IS NULL',
    [userId],
  );
}

/**
 * Creates the local profile and settings rows if they are absent.
 *
 * The server creates both via a trigger on `auth.users`, but the app may be
 * offline on first launch after signing up. Seeding locally means onboarding
 * works without a connection; the pull reconciles the two afterwards.
 *
 * Writes here are deliberately *not* queued to the outbox — the server already
 * has its own copy, and pushing a device-local default would overwrite it.
 */
export function ensureLocalProfile(
  params: { userId: string; email: string | null; timeZone: string },
  db: SqlDatabase = getDatabase(),
): void {
  const now = Date.now();

  db.transaction(() => {
    db.run(
      `INSERT INTO profiles (id, email, unit_system, time_zone, created_at, updated_at)
       VALUES (?, ?, 'metric', ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [params.userId, params.email, params.timeZone, now, now],
    );

    db.run(
      `INSERT INTO user_settings (id, user_id, created_at, updated_at)
       SELECT ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM user_settings WHERE user_id = ?)`,
      [newId(), params.userId, now, now, params.userId],
    );
  });
}

export type ProfileUpdate = Partial<
  Pick<
    ProfileRow,
    'display_name' | 'sex' | 'birth_date' | 'height_cm' | 'unit_system' | 'time_zone'
  >
>;

const UPDATABLE_PROFILE_FIELDS = [
  'display_name',
  'sex',
  'birth_date',
  'height_cm',
  'unit_system',
  'time_zone',
] as const;

export function updateProfile(
  userId: string,
  patch: ProfileUpdate,
  db: SqlDatabase = getDatabase(),
): void {
  // Whitelist rather than iterating the patch, so a caller cannot set
  // `id` or `server_updated_at` by passing extra keys.
  const fields = UPDATABLE_PROFILE_FIELDS.filter((field) => field in patch);
  if (fields.length === 0) return;

  const now = Date.now();
  const assignments = fields.map((field) => `${field} = ?`).join(', ');
  const values = fields.map((field) => patch[field] ?? null);

  withOutbox(
    db,
    {
      table: 'profiles',
      rowId: userId,
      operation: 'upsert',
      payload: { id: userId, ...pick(patch, fields) },
    },
    () => {
      db.run(`UPDATE profiles SET ${assignments}, updated_at = ? WHERE id = ?`, [
        ...values,
        now,
        userId,
      ]);
    },
  );
}

export type SettingsUpdate = Partial<
  Pick<UserSettingsRow, 'theme' | 'water_goal_ml' | 'exercise_adds_calories'>
>;

const UPDATABLE_SETTINGS_FIELDS = [
  'theme',
  'water_goal_ml',
  'exercise_adds_calories',
] as const;

export function updateSettings(
  userId: string,
  patch: SettingsUpdate,
  db: SqlDatabase = getDatabase(),
): void {
  const existing = getSettings(userId, db);
  if (!existing) return;

  const fields = UPDATABLE_SETTINGS_FIELDS.filter((field) => field in patch);
  if (fields.length === 0) return;

  const now = Date.now();
  const assignments = fields.map((field) => `${field} = ?`).join(', ');
  const values = fields.map((field) => patch[field] ?? null);

  withOutbox(
    db,
    {
      table: 'user_settings',
      rowId: existing.id,
      operation: 'upsert',
      payload: { id: existing.id, user_id: userId, ...pick(patch, fields) },
    },
    () => {
      db.run(
        `UPDATE user_settings SET ${assignments}, updated_at = ? WHERE user_id = ?`,
        [...values, now, userId],
      );
    },
  );
}

function pick<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Partial<T> {
  const result: Partial<T> = {};
  for (const key of keys) {
    if (key in source) result[key] = source[key];
  }
  return result;
}
