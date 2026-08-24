import { getDatabase } from '../client';
import type { ExerciseRow, LoadTypeValue } from '../schema';
import type { SqlDatabase } from '../types';
import { newId } from '@/lib/id';
import { cleanName, normalizeForSearch } from '@/lib/search';
import { withOutbox } from '@/sync/outbox';

/**
 * The exercise catalogue, locally.
 *
 * One table for two kinds of row — the shared catalogue that arrives by sync
 * and the user's own exercises — so browsing, searching and picking are one
 * query rather than a union of two. That is the same decision `foods` made,
 * and it is why a custom exercise appears everywhere a catalogue one does
 * without a second code path.
 *
 * Reads never touch the network. Browsing the catalogue in a gym basement is
 * the normal case, not the degraded one.
 */

export interface Exercise {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly instructions: string | null;
  readonly primaryMuscle: string;
  readonly secondaryMuscles: readonly string[];
  readonly equipment: string;
  readonly movementType: 'compound' | 'isolation' | null;
  readonly loadType: LoadTypeValue;
  /** True when the user created it, so the UI can offer an edit. */
  readonly isOwn: boolean;
}

export const MUSCLE_GROUPS = [
  'chest',
  'back',
  'shoulders',
  'biceps',
  'triceps',
  'forearms',
  'quadriceps',
  'hamstrings',
  'glutes',
  'calves',
  'core',
  'full_body',
  'cardio',
  'other',
] as const;

export const EQUIPMENT = [
  'barbell',
  'dumbbell',
  'kettlebell',
  'machine',
  'cable',
  'bodyweight',
  'band',
  'other',
] as const;

export type MuscleGroup = (typeof MUSCLE_GROUPS)[number];
export type Equipment = (typeof EQUIPMENT)[number];

/** Turns a stored row into what the UI reads. */
export function toExercise(row: ExerciseRow): Exercise {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    primaryMuscle: row.primary_muscle,
    secondaryMuscles: parseMuscles(row.secondary_muscles),
    equipment: row.equipment,
    movementType: row.movement_type,
    loadType: row.load_type,
    isOwn: row.owner_id !== null,
  };
}

/**
 * A JSON column that must never throw.
 *
 * The array arrives from the server as a Postgres `text[]` and is stored here
 * as JSON. A malformed value costs a chip on a detail screen; letting it throw
 * would cost the whole exercise list.
 */
function parseMuscles(encoded: string): string[] {
  try {
    const parsed: unknown = JSON.parse(encoded);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------- searching */

export interface BrowseOptions {
  /** Free text. Matched against the same normalised form the server stores. */
  readonly query?: string;
  readonly muscle?: string | null;
  readonly equipment?: string | null;
  /** Only the user's own exercises. */
  readonly ownOnly?: boolean;
  readonly limit?: number;
}

/**
 * Browse or search the catalogue.
 *
 * Ordered so a user's own exercises come first at equal relevance: they made
 * it, they are looking for it. Within that, a prefix match beats a substring
 * one — typing "bench" should not surface "Close-Grip Bench Press" above
 * "Bench Press".
 */
export function browseExercises(
  userId: string,
  options: BrowseOptions = {},
  db: SqlDatabase = getDatabase(),
): Exercise[] {
  const normalized = options.query ? normalizeForSearch(options.query) : '';
  const limit = options.limit ?? 100;

  const conditions: string[] = [
    'deleted_at IS NULL',
    '(owner_id IS NULL OR owner_id = ?)',
  ];
  const params: unknown[] = [userId];

  if (options.ownOnly) {
    conditions.push('owner_id = ?');
    params.push(userId);
  }
  if (options.muscle) {
    conditions.push('primary_muscle = ?');
    params.push(options.muscle);
  }
  if (options.equipment) {
    conditions.push('equipment = ?');
    params.push(options.equipment);
  }
  if (normalized) {
    conditions.push('normalized_name LIKE ?');
    params.push(`%${normalized}%`);
  }

  const rows = db.all<ExerciseRow>(
    `SELECT * FROM exercises
      WHERE ${conditions.join(' AND ')}
      ORDER BY
        CASE WHEN owner_id IS NOT NULL THEN 0 ELSE 1 END,
        ${normalized ? 'CASE WHEN normalized_name LIKE ? THEN 0 ELSE 1 END,' : ''}
        normalized_name
      LIMIT ?`,
    normalized ? [...params, `${normalized}%`, limit] : [...params, limit],
  );

  return rows.map(toExercise);
}

export function getExercise(
  id: string,
  db: SqlDatabase = getDatabase(),
): Exercise | null {
  const row = db.get<ExerciseRow>(
    'SELECT * FROM exercises WHERE id = ? AND deleted_at IS NULL',
    [id],
  );
  return row ? toExercise(row) : null;
}

export function countExercises(db: SqlDatabase = getDatabase()): number {
  const row = db.get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM exercises WHERE deleted_at IS NULL',
  );
  return row?.count ?? 0;
}

/* ------------------------------------------------------- custom exercises */

export interface CustomExerciseInput {
  readonly userId: string;
  readonly name: string;
  readonly primaryMuscle: string;
  readonly equipment: string;
  readonly loadType: LoadTypeValue;
  readonly secondaryMuscles?: readonly string[];
  readonly movementType?: 'compound' | 'isolation' | null;
  readonly description?: string | null;
  readonly instructions?: string | null;
  readonly at?: number;
}

/**
 * Creates an exercise the user owns.
 *
 * Written locally first and pushed through the ordinary outbox, so a new
 * exercise can be invented mid-session on a gym floor with no signal and used
 * in that same session. Unlike a custom *food* — which has to exist in the
 * shared catalogue before the diary can reference it — an exercise is
 * referenced by a workout row that also snapshots its name, so there is
 * nothing to reconcile later.
 */
export function createCustomExercise(
  input: CustomExerciseInput,
  db: SqlDatabase = getDatabase(),
): ExerciseRow {
  const name = cleanName(input.name);
  if (!name) throw new Error('An exercise needs a name');

  const now = input.at ?? Date.now();

  const row: ExerciseRow = {
    id: newId(),
    owner_id: input.userId,
    name,
    normalized_name: normalizeForSearch(name),
    description: input.description ?? null,
    instructions: input.instructions ?? null,
    primary_muscle: input.primaryMuscle,
    secondary_muscles: JSON.stringify(input.secondaryMuscles ?? []),
    equipment: input.equipment,
    movement_type: input.movementType ?? null,
    load_type: input.loadType,
    // Never 'system'. The database enforces it too, through
    // `exercise_source_matches_owner`.
    source: 'user',
    created_at: now,
    updated_at: now,
    server_updated_at: null,
    deleted_at: null,
  };

  insertRow(db, 'exercises', row as unknown as Record<string, unknown>);
  return row;
}

export interface EditExerciseInput {
  readonly name?: string;
  readonly primaryMuscle?: string;
  readonly equipment?: string;
  readonly loadType?: LoadTypeValue;
  readonly secondaryMuscles?: readonly string[];
  readonly movementType?: 'compound' | 'isolation' | null;
  readonly description?: string | null;
  readonly instructions?: string | null;
  readonly at?: number;
}

/**
 * Edits an exercise the user owns.
 *
 * Editing changes the catalogue and nothing else. Every past session that used
 * it keeps the name and load type it snapshotted, so correcting a typo does
 * not retitle six months of history — see `workout_exercises.exercise_name`.
 */
export function editCustomExercise(
  id: string,
  patch: EditExerciseInput,
  db: SqlDatabase = getDatabase(),
): ExerciseRow {
  const existing = db.get<ExerciseRow>('SELECT * FROM exercises WHERE id = ?', [id]);
  if (!existing) throw new Error(`No exercise ${id}`);
  if (existing.owner_id === null) {
    // The server would refuse it anyway; failing here gives a real message
    // instead of a rejected push three minutes later.
    throw new Error('Shared catalogue exercises cannot be edited');
  }

  const name = patch.name !== undefined ? cleanName(patch.name) : existing.name;
  if (!name) throw new Error('An exercise needs a name');

  const next: ExerciseRow = {
    ...existing,
    name,
    normalized_name: normalizeForSearch(name),
    description: patch.description !== undefined ? patch.description : existing.description,
    instructions:
      patch.instructions !== undefined ? patch.instructions : existing.instructions,
    primary_muscle: patch.primaryMuscle ?? existing.primary_muscle,
    secondary_muscles:
      patch.secondaryMuscles !== undefined
        ? JSON.stringify(patch.secondaryMuscles)
        : existing.secondary_muscles,
    equipment: patch.equipment ?? existing.equipment,
    movement_type:
      patch.movementType !== undefined ? patch.movementType : existing.movement_type,
    load_type: patch.loadType ?? existing.load_type,
    updated_at: patch.at ?? Date.now(),
  };

  updateRow(db, 'exercises', next as unknown as Record<string, unknown>);
  return next;
}

/**
 * Removes an exercise the user owns.
 *
 * A soft delete, for two reasons. It is what synchronises — a hard delete is
 * invisible to a delta pull, so the other device would push the row straight
 * back. And it leaves every past session intact: the sets performed with it
 * are not touched, because they never referenced it for their values in the
 * first place.
 */
export function deleteCustomExercise(
  id: string,
  db: SqlDatabase = getDatabase(),
  at: number = Date.now(),
): void {
  const existing = db.get<ExerciseRow>('SELECT * FROM exercises WHERE id = ?', [id]);
  if (!existing) return;
  if (existing.owner_id === null) {
    throw new Error('Shared catalogue exercises cannot be deleted');
  }

  updateRow(db, 'exercises', {
    ...existing,
    deleted_at: at,
    updated_at: at,
  } as unknown as Record<string, unknown>);
}

/* ------------------------------------------------------------------ write */

/**
 * Insert plus outbox entry, atomically.
 *
 * Shared by every training repository. `withOutbox` reads the row back after
 * the write and queues the whole thing, so consecutive edits collapse into a
 * self-consistent payload rather than a fragment.
 */
export function insertRow(
  db: SqlDatabase,
  table: 'exercises' | 'workouts' | 'workout_exercises' | 'workout_sets',
  row: Record<string, unknown>,
): void {
  withOutbox(db, { table, rowId: String(row.id), operation: 'upsert' }, () => {
    const columns = Object.keys(row);
    db.run(
      `INSERT INTO ${table} (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map((column) => row[column] ?? null),
    );
  });
}

export function updateRow(
  db: SqlDatabase,
  table: 'exercises' | 'workouts' | 'workout_exercises' | 'workout_sets',
  row: Record<string, unknown>,
): void {
  withOutbox(db, { table, rowId: String(row.id), operation: 'upsert' }, () => {
    const columns = Object.keys(row).filter((column) => column !== 'id');
    db.run(
      `UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(', ')}
        WHERE id = ?`,
      [...columns.map((column) => row[column] ?? null), row.id],
    );
  });
}
