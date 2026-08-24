import { getDatabase } from '../client';
import type {
  ExerciseRow,
  LoadTypeValue,
  WorkoutExerciseRow,
  WorkoutRow,
  WorkoutSetRow,
  WorkoutStatus,
} from '../schema';
import type { SqlDatabase } from '../types';
import { asLocalDay, localDayFor, type LocalDay } from '@/lib/date';
import { newId } from '@/lib/id';
import { cleanName } from '@/lib/search';
import {
  summariseExercise,
  type ExerciseSummary,
  type SetMeasurement,
  type WeightUnit,
} from '@/lib/training';
import { insertRow, updateRow } from './exercises';

/**
 * Workouts, their exercises and their sets.
 *
 * Everything here is a local write followed by an outbox entry, in one
 * transaction, through the same `withOutbox` every other feature uses. There
 * is no training-specific sync anything: a session recorded on a gym floor
 * with no signal is queued exactly like a glass of water.
 *
 * Dependency order comes free from that. The outbox drains in insertion order,
 * so a workout is created before its exercises, which are created before their
 * sets — and the server sees them in the order its foreign keys require
 * without anybody sequencing anything. `trainingSync.node.test.ts` proves it.
 *
 * Reads never touch the network, including previous performance. Waiting for a
 * request between two sets is the one thing this screen must never do.
 */

/* -------------------------------------------------------------- workouts */

export interface StartWorkoutInput {
  readonly userId: string;
  readonly name: string;
  readonly timeZone: string;
  /** Defaults to the day `at` falls on in `timeZone`. */
  readonly localDate?: LocalDay;
  /** Epoch ms. Defaults to now. */
  readonly at?: number;
  readonly notes?: string | null;
  /** `planned` leaves `started_at` null; the day is then authored. */
  readonly status?: Extract<WorkoutStatus, 'planned' | 'in_progress'>;
}

export function startWorkout(
  input: StartWorkoutInput,
  db: SqlDatabase = getDatabase(),
): WorkoutRow {
  const name = cleanName(input.name);
  if (!name) throw new Error('A workout needs a name');

  const now = input.at ?? Date.now();
  const status = input.status ?? 'in_progress';
  const startedAt = status === 'planned' ? null : now;

  /*
   * The day is computed here, once, at write time — never re-derived on read
   * and never a UTC truncation. A session starting at 23:30 on Monday is a
   * Monday session, and flying somewhere else afterwards does not re-date it.
   */
  const localDate =
    input.localDate ??
    (startedAt === null
      ? localDayFor(new Date(now), input.timeZone)
      : localDayFor(new Date(startedAt), input.timeZone));

  const row: WorkoutRow = {
    id: newId(),
    user_id: input.userId,
    name,
    local_date: localDate,
    time_zone: input.timeZone,
    started_at: startedAt,
    completed_at: null,
    notes: input.notes ?? null,
    status,
    created_at: now,
    updated_at: now,
    server_updated_at: null,
    deleted_at: null,
  };

  insertRow(db, 'workouts', row as unknown as Record<string, unknown>);
  return row;
}

export interface EditWorkoutInput {
  readonly name?: string;
  readonly notes?: string | null;
  readonly status?: WorkoutStatus;
  readonly at?: number;
}

export function editWorkout(
  id: string,
  patch: EditWorkoutInput,
  db: SqlDatabase = getDatabase(),
): WorkoutRow {
  const existing = requireWorkout(db, id);
  const now = patch.at ?? Date.now();

  const name = patch.name !== undefined ? cleanName(patch.name) : existing.name;
  if (!name) throw new Error('A workout needs a name');

  const next: WorkoutRow = {
    ...existing,
    name,
    notes: patch.notes !== undefined ? patch.notes : existing.notes,
    status: patch.status ?? existing.status,
    updated_at: now,
  };

  // A planned session that is being started acquires its instant here, and
  // with it the ordinary local-day rule.
  if (patch.status === 'in_progress' && existing.started_at === null) {
    next.started_at = now;
    next.local_date = localDayFor(new Date(now), existing.time_zone);
  }

  updateRow(db, 'workouts', next as unknown as Record<string, unknown>);
  return next;
}

/**
 * Finishes a session.
 *
 * Marks every set that was ticked off as such and nothing else — an untouched
 * set stays incomplete, because a set the user did not do is not work done and
 * must not enter a volume total.
 */
export function finishWorkout(
  id: string,
  db: SqlDatabase = getDatabase(),
  at: number = Date.now(),
): WorkoutRow {
  const existing = requireWorkout(db, id);

  if (existing.started_at === null) {
    throw new Error('A workout that never started cannot be finished');
  }

  const next: WorkoutRow = {
    ...existing,
    status: 'completed',
    // Clock skew or a session left open overnight would otherwise write a
    // completion before the start, which the database refuses outright.
    completed_at: Math.max(at, existing.started_at),
    updated_at: at,
  };

  updateRow(db, 'workouts', next as unknown as Record<string, unknown>);
  return next;
}

/** Abandons a session, keeping whatever was recorded. */
export function abandonWorkout(
  id: string,
  db: SqlDatabase = getDatabase(),
  at: number = Date.now(),
): WorkoutRow {
  const existing = requireWorkout(db, id);
  if (existing.started_at === null) {
    throw new Error('A workout that never started cannot be abandoned');
  }

  const next: WorkoutRow = {
    ...existing,
    status: 'abandoned',
    completed_at: Math.max(at, existing.started_at),
    updated_at: at,
  };

  updateRow(db, 'workouts', next as unknown as Record<string, unknown>);
  return next;
}

/** Soft-deletes a session and everything under it. */
export function deleteWorkout(
  id: string,
  db: SqlDatabase = getDatabase(),
  at: number = Date.now(),
): void {
  const existing = db.get<WorkoutRow>('SELECT * FROM workouts WHERE id = ?', [id]);
  if (!existing) return;

  /*
   * Cascaded by hand rather than by the foreign key, because a soft delete is
   * an update and ON DELETE CASCADE does not fire for one. Each row is queued
   * separately, which is what lets the other device learn about all of them —
   * a hard delete would be invisible to a delta pull.
   */
  for (const exercise of listWorkoutExerciseRows(db, id)) {
    for (const set of listSetRows(db, exercise.id)) {
      updateRow(db, 'workout_sets', {
        ...set,
        deleted_at: at,
        updated_at: at,
      } as unknown as Record<string, unknown>);
    }
    updateRow(db, 'workout_exercises', {
      ...exercise,
      deleted_at: at,
      updated_at: at,
    } as unknown as Record<string, unknown>);
  }

  updateRow(db, 'workouts', {
    ...existing,
    deleted_at: at,
    updated_at: at,
  } as unknown as Record<string, unknown>);
}

export function getWorkout(
  id: string,
  db: SqlDatabase = getDatabase(),
): WorkoutRow | null {
  return (
    db.get<WorkoutRow>('SELECT * FROM workouts WHERE id = ? AND deleted_at IS NULL', [
      id,
    ]) ?? null
  );
}

/** The session currently open, if there is one. At most one by construction. */
export function activeWorkout(
  userId: string,
  db: SqlDatabase = getDatabase(),
): WorkoutRow | null {
  return (
    db.get<WorkoutRow>(
      `SELECT * FROM workouts
        WHERE user_id = ? AND status = 'in_progress' AND deleted_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1`,
      [userId],
    ) ?? null
  );
}

export function listWorkouts(
  userId: string,
  limit = 30,
  db: SqlDatabase = getDatabase(),
): WorkoutRow[] {
  return db.all<WorkoutRow>(
    `SELECT * FROM workouts
      WHERE user_id = ? AND deleted_at IS NULL
      ORDER BY local_date DESC, started_at DESC, created_at DESC
      LIMIT ?`,
    [userId, limit],
  );
}

/* ----------------------------------------------------- workout exercises */

export interface AddExerciseInput {
  readonly workoutId: string;
  readonly userId: string;
  /** Null when the exercise is not in the catalogue. Provenance only. */
  readonly exerciseId: string | null;
  readonly name: string;
  readonly loadType: LoadTypeValue;
  readonly notes?: string | null;
  readonly targetSets?: number | null;
  readonly targetReps?: number | null;
  readonly at?: number;
}

/**
 * Adds an exercise to a session.
 *
 * The name and load type are **snapshotted** here and never read back from the
 * catalogue. That is the whole historical-integrity story: rename the
 * exercise, change its load type, delete it outright — this row still says
 * what was performed.
 */
export function addWorkoutExercise(
  input: AddExerciseInput,
  db: SqlDatabase = getDatabase(),
): WorkoutExerciseRow {
  const name = cleanName(input.name);
  if (!name) throw new Error('An exercise needs a name');

  const now = input.at ?? Date.now();

  const row: WorkoutExerciseRow = {
    id: newId(),
    user_id: input.userId,
    workout_id: input.workoutId,
    exercise_id: input.exerciseId,
    exercise_name: name,
    load_type: input.loadType,
    position: nextPosition(db, input.workoutId),
    notes: input.notes ?? null,
    target_sets: input.targetSets ?? null,
    target_reps: input.targetReps ?? null,
    created_at: now,
    updated_at: now,
    server_updated_at: null,
    deleted_at: null,
  };

  insertRow(db, 'workout_exercises', row as unknown as Record<string, unknown>);
  return row;
}

/** Adds the same exercise again, at the end. */
export function duplicateWorkoutExercise(
  id: string,
  db: SqlDatabase = getDatabase(),
  at: number = Date.now(),
): WorkoutExerciseRow {
  const existing = requireWorkoutExercise(db, id);

  return addWorkoutExercise(
    {
      workoutId: existing.workout_id,
      userId: existing.user_id,
      exerciseId: existing.exercise_id,
      name: existing.exercise_name,
      loadType: existing.load_type,
      notes: existing.notes,
      targetSets: existing.target_sets,
      targetReps: existing.target_reps,
      at,
    },
    db,
  );
}

export function removeWorkoutExercise(
  id: string,
  db: SqlDatabase = getDatabase(),
  at: number = Date.now(),
): void {
  const existing = db.get<WorkoutExerciseRow>(
    'SELECT * FROM workout_exercises WHERE id = ?',
    [id],
  );
  if (!existing) return;

  for (const set of listSetRows(db, id)) {
    updateRow(db, 'workout_sets', {
      ...set,
      deleted_at: at,
      updated_at: at,
    } as unknown as Record<string, unknown>);
  }

  updateRow(db, 'workout_exercises', {
    ...existing,
    deleted_at: at,
    updated_at: at,
  } as unknown as Record<string, unknown>);

  // Close the gap the removal left, so positions stay dense.
  compactPositions(db, existing.workout_id, at);
}

/**
 * Writes a new order for a session's exercises.
 *
 * Takes the ids in their intended order rather than a from/to pair, so the
 * caller can produce that order however it likes — a drag, the move-up button,
 * or a repeat of a previous session — and this stays the one place that
 * renumbers.
 *
 * Positions are dense integers from zero. Two devices reordering the same
 * session therefore converge on comparable numbers instead of drifting apart
 * by fractions nobody can read.
 */
export function reorderWorkoutExercises(
  workoutId: string,
  orderedIds: readonly string[],
  db: SqlDatabase = getDatabase(),
  at: number = Date.now(),
): void {
  const rows = listWorkoutExerciseRows(db, workoutId);
  const byId = new Map(rows.map((row) => [row.id, row]));

  orderedIds.forEach((id, position) => {
    const row = byId.get(id);
    // An id that is not in this workout is ignored rather than throwing: a
    // stale drag from a screen that has since refreshed should be a no-op.
    if (!row || row.position === position) return;

    updateRow(db, 'workout_exercises', {
      ...row,
      position,
      updated_at: at,
    } as unknown as Record<string, unknown>);
  });
}

export function listWorkoutExerciseRows(
  db: SqlDatabase,
  workoutId: string,
): WorkoutExerciseRow[] {
  return db.all<WorkoutExerciseRow>(
    `SELECT * FROM workout_exercises
      WHERE workout_id = ? AND deleted_at IS NULL
      ORDER BY position, created_at`,
    [workoutId],
  );
}

function nextPosition(db: SqlDatabase, workoutId: string): number {
  const row = db.get<{ next: number | null }>(
    `SELECT MAX(position) + 1 AS next FROM workout_exercises
      WHERE workout_id = ? AND deleted_at IS NULL`,
    [workoutId],
  );
  return row?.next ?? 0;
}

function compactPositions(db: SqlDatabase, workoutId: string, at: number): void {
  listWorkoutExerciseRows(db, workoutId).forEach((row, position) => {
    if (row.position === position) return;
    updateRow(db, 'workout_exercises', {
      ...row,
      position,
      updated_at: at,
    } as unknown as Record<string, unknown>);
  });
}

/* ------------------------------------------------------------------- sets */

export interface RecordSetInput {
  readonly workoutExerciseId: string;
  readonly userId: string;
  /** Canonical kilograms. Convert at the UI edge with `toCanonicalKg`. */
  readonly weightKg?: number | null;
  /** What the user typed in. A display preference only. */
  readonly weightUnit?: WeightUnit;
  readonly reps?: number | null;
  readonly durationSeconds?: number | null;
  readonly distanceM?: number | null;
  readonly isCompleted?: boolean;
  readonly notes?: string | null;
  /** Defaults to one past the last set. */
  readonly setNumber?: number;
  readonly at?: number;
}

export function recordSet(
  input: RecordSetInput,
  db: SqlDatabase = getDatabase(),
): WorkoutSetRow {
  const now = input.at ?? Date.now();

  const row: WorkoutSetRow = {
    id: newId(),
    user_id: input.userId,
    workout_exercise_id: input.workoutExerciseId,
    set_number: input.setNumber ?? nextSetNumber(db, input.workoutExerciseId),
    weight_kg: input.weightKg ?? null,
    weight_unit: input.weightUnit ?? 'kg',
    reps: input.reps ?? null,
    duration_seconds: input.durationSeconds ?? null,
    distance_m: input.distanceM ?? null,
    is_completed: input.isCompleted === false ? 0 : 1,
    notes: input.notes ?? null,
    created_at: now,
    updated_at: now,
    server_updated_at: null,
    deleted_at: null,
  };

  insertRow(db, 'workout_sets', row as unknown as Record<string, unknown>);
  return row;
}

export interface EditSetInput {
  readonly weightKg?: number | null;
  readonly weightUnit?: WeightUnit;
  readonly reps?: number | null;
  readonly durationSeconds?: number | null;
  readonly distanceM?: number | null;
  readonly isCompleted?: boolean;
  readonly setNumber?: number;
  readonly notes?: string | null;
  readonly at?: number;
}

export function editSet(
  id: string,
  patch: EditSetInput,
  db: SqlDatabase = getDatabase(),
): WorkoutSetRow {
  const existing = db.get<WorkoutSetRow>('SELECT * FROM workout_sets WHERE id = ?', [id]);
  if (!existing) throw new Error(`No set ${id}`);

  const next: WorkoutSetRow = {
    ...existing,
    weight_kg: patch.weightKg !== undefined ? patch.weightKg : existing.weight_kg,
    weight_unit: patch.weightUnit ?? existing.weight_unit,
    reps: patch.reps !== undefined ? patch.reps : existing.reps,
    duration_seconds:
      patch.durationSeconds !== undefined
        ? patch.durationSeconds
        : existing.duration_seconds,
    distance_m: patch.distanceM !== undefined ? patch.distanceM : existing.distance_m,
    is_completed:
      patch.isCompleted !== undefined
        ? patch.isCompleted
          ? 1
          : 0
        : existing.is_completed,
    set_number: patch.setNumber ?? existing.set_number,
    notes: patch.notes !== undefined ? patch.notes : existing.notes,
    updated_at: patch.at ?? Date.now(),
  };

  updateRow(db, 'workout_sets', next as unknown as Record<string, unknown>);
  return next;
}

/** Flips a set between done and not done. The commonest gym interaction. */
export function toggleSetCompleted(
  id: string,
  db: SqlDatabase = getDatabase(),
  at: number = Date.now(),
): WorkoutSetRow {
  const existing = db.get<WorkoutSetRow>('SELECT * FROM workout_sets WHERE id = ?', [id]);
  if (!existing) throw new Error(`No set ${id}`);

  return editSet(id, { isCompleted: existing.is_completed === 0, at }, db);
}

/**
 * Removes a set and closes the gap in the numbering.
 *
 * Renumbering matters more than it looks: "Set 1, Set 3" reads as a lost set
 * rather than as a deleted one, and the server's unique constraint would
 * happily keep it that way forever.
 */
export function deleteSet(
  id: string,
  db: SqlDatabase = getDatabase(),
  at: number = Date.now(),
): void {
  const existing = db.get<WorkoutSetRow>('SELECT * FROM workout_sets WHERE id = ?', [id]);
  if (!existing) return;

  updateRow(db, 'workout_sets', {
    ...existing,
    deleted_at: at,
    updated_at: at,
  } as unknown as Record<string, unknown>);

  renumberSets(db, existing.workout_exercise_id, at);
}

/**
 * Rewrites set numbers as a contiguous 1..n sequence.
 *
 * The server's unique constraint on (workout_exercise_id, set_number) is
 * deferrable, so this arrives as one transaction there too. Locally there is
 * no unique constraint at all — SQLite cannot defer one, and a mid-renumber
 * collision would abort a legitimate write. This function is what upholds the
 * invariant on the device.
 */
export function renumberSets(
  db: SqlDatabase,
  workoutExerciseId: string,
  at: number,
): void {
  listSetRows(db, workoutExerciseId).forEach((row, index) => {
    const setNumber = index + 1;
    if (row.set_number === setNumber) return;

    updateRow(db, 'workout_sets', {
      ...row,
      set_number: setNumber,
      updated_at: at,
    } as unknown as Record<string, unknown>);
  });
}

export function listSetRows(
  db: SqlDatabase,
  workoutExerciseId: string,
): WorkoutSetRow[] {
  return db.all<WorkoutSetRow>(
    `SELECT * FROM workout_sets
      WHERE workout_exercise_id = ? AND deleted_at IS NULL
      ORDER BY set_number, created_at`,
    [workoutExerciseId],
  );
}

function nextSetNumber(db: SqlDatabase, workoutExerciseId: string): number {
  const row = db.get<{ next: number | null }>(
    `SELECT MAX(set_number) + 1 AS next FROM workout_sets
      WHERE workout_exercise_id = ? AND deleted_at IS NULL`,
    [workoutExerciseId],
  );
  return row?.next ?? 1;
}

/* ---------------------------------------------------------------- reading */

export interface WorkoutSet extends SetMeasurement {
  readonly id: string;
  readonly setNumber: number;
  readonly weightUnit: WeightUnit;
  readonly notes: string | null;
}

export interface WorkoutExerciseDetail {
  readonly id: string;
  readonly exerciseId: string | null;
  /** The snapshot, not the catalogue's current name. */
  readonly name: string;
  readonly loadType: LoadTypeValue;
  readonly position: number;
  readonly notes: string | null;
  readonly targetSets: number | null;
  readonly targetReps: number | null;
  readonly sets: readonly WorkoutSet[];
  readonly summary: ExerciseSummary;
}

export interface WorkoutDetail {
  readonly workout: WorkoutRow;
  readonly exercises: readonly WorkoutExerciseDetail[];
  /** Summed over exercises that have one. Null when none does. */
  readonly totalVolumeKg: number | null;
  readonly totalSets: number;
  /** Seconds, once the session is finished. Null while it is still open. */
  readonly durationSeconds: number | null;
}

export function toSet(row: WorkoutSetRow): WorkoutSet {
  return {
    id: row.id,
    setNumber: row.set_number,
    weightKg: row.weight_kg,
    weightUnit: row.weight_unit,
    reps: row.reps,
    durationSeconds: row.duration_seconds,
    distanceM: row.distance_m,
    isCompleted: row.is_completed === 1,
    notes: row.notes,
  };
}

/**
 * A whole session, ready to render.
 *
 * Reads only the stored snapshots — the exercise name and load type come from
 * `workout_exercises`, never from a join to the catalogue. Opening a session
 * from March therefore shows March's values even if the exercise has since
 * been renamed, retyped, or deleted.
 */
export function getWorkoutDetail(
  workoutId: string,
  db: SqlDatabase = getDatabase(),
): WorkoutDetail | null {
  const workout = getWorkout(workoutId, db);
  if (!workout) return null;

  const exercises = listWorkoutExerciseRows(db, workoutId).map((row) => {
    const sets = listSetRows(db, row.id).map(toSet);

    return {
      id: row.id,
      exerciseId: row.exercise_id,
      name: row.exercise_name,
      loadType: row.load_type,
      position: row.position,
      notes: row.notes,
      targetSets: row.target_sets,
      targetReps: row.target_reps,
      sets,
      summary: summariseExercise(sets, row.load_type),
    } satisfies WorkoutExerciseDetail;
  });

  const volumes = exercises
    .map((exercise) => exercise.summary.volumeKg)
    .filter((value): value is number => value !== null);

  return {
    workout,
    exercises,
    totalVolumeKg:
      volumes.length === 0
        ? null
        : Math.round(volumes.reduce((total, value) => total + value, 0) * 1000) / 1000,
    totalSets: exercises.reduce(
      (total, exercise) => total + exercise.summary.completedSets,
      0,
    ),
    durationSeconds:
      workout.completed_at !== null && workout.started_at !== null
        ? Math.max(0, Math.floor((workout.completed_at - workout.started_at) / 1000))
        : null,
  };
}

/* --------------------------------------------------- previous performance */

export interface PreviousPerformance {
  readonly workoutId: string;
  readonly localDate: LocalDay;
  readonly sets: readonly WorkoutSet[];
}

/**
 * What this user did last time they performed this exercise.
 *
 * Answered entirely from SQLite. Section F is explicit that set entry must not
 * wait for a network request, and this is why it does not have to: the query
 * is two indexed lookups against rows the device already holds.
 *
 * Matched on the catalogue id, not the name — renaming an exercise must not
 * sever a user from their own history. An exercise with no catalogue id
 * matches nothing rather than matching every other null.
 */
export function previousPerformance(
  userId: string,
  exerciseId: string | null,
  excludeWorkoutId: string | null,
  db: SqlDatabase = getDatabase(),
): PreviousPerformance | null {
  if (!exerciseId) return null;

  const previous = db.get<{ id: string; workout_id: string; local_date: string }>(
    `SELECT we.id, we.workout_id, w.local_date
       FROM workout_exercises we
       JOIN workouts w ON w.id = we.workout_id
      WHERE we.user_id = ?
        AND we.exercise_id = ?
        AND we.deleted_at IS NULL
        AND w.deleted_at IS NULL
        AND (? IS NULL OR we.workout_id <> ?)
        AND EXISTS (
          SELECT 1 FROM workout_sets s
           WHERE s.workout_exercise_id = we.id
             AND s.deleted_at IS NULL
             AND s.is_completed = 1
        )
      ORDER BY w.local_date DESC, w.started_at DESC, we.created_at DESC
      LIMIT 1`,
    [userId, exerciseId, excludeWorkoutId, excludeWorkoutId],
  );

  if (!previous) return null;

  const sets = listSetRows(db, previous.id)
    .filter((row) => row.is_completed === 1)
    .map(toSet);

  return {
    workoutId: previous.workout_id,
    localDate: asLocalDay(previous.local_date),
    sets,
  };
}

/**
 * Repeats a previous session as a new one.
 *
 * Copies the exercises and the *shape* of the sets — the weights and reps that
 * were performed — with every set marked not done. That is the difference
 * between repeating a workout and forging one: the numbers are a starting
 * point to be confirmed or corrected, not a record of something that happened.
 */
export function repeatWorkout(
  sourceWorkoutId: string,
  input: { userId: string; timeZone: string; at?: number; name?: string },
  db: SqlDatabase = getDatabase(),
): WorkoutRow {
  const source = getWorkoutDetail(sourceWorkoutId, db);
  if (!source) throw new Error(`No workout ${sourceWorkoutId}`);

  const now = input.at ?? Date.now();

  const workout = startWorkout(
    {
      userId: input.userId,
      name: input.name ?? source.workout.name,
      timeZone: input.timeZone,
      at: now,
    },
    db,
  );

  for (const exercise of source.exercises) {
    const added = addWorkoutExercise(
      {
        workoutId: workout.id,
        userId: input.userId,
        exerciseId: exercise.exerciseId,
        name: exercise.name,
        loadType: exercise.loadType,
        targetSets: exercise.targetSets,
        targetReps: exercise.targetReps,
        at: now,
      },
      db,
    );

    for (const set of exercise.sets) {
      recordSet(
        {
          workoutExerciseId: added.id,
          userId: input.userId,
          weightKg: set.weightKg,
          weightUnit: set.weightUnit,
          reps: set.reps,
          durationSeconds: set.durationSeconds,
          distanceM: set.distanceM,
          // Nothing has been performed yet.
          isCompleted: false,
          setNumber: set.setNumber,
          at: now,
        },
        db,
      );
    }
  }

  return workout;
}

/* ------------------------------------------------------------- assertions */

function requireWorkout(db: SqlDatabase, id: string): WorkoutRow {
  const row = db.get<WorkoutRow>('SELECT * FROM workouts WHERE id = ?', [id]);
  if (!row) throw new Error(`No workout ${id}`);
  return row;
}

function requireWorkoutExercise(db: SqlDatabase, id: string): WorkoutExerciseRow {
  const row = db.get<WorkoutExerciseRow>(
    'SELECT * FROM workout_exercises WHERE id = ?',
    [id],
  );
  if (!row) throw new Error(`No workout exercise ${id}`);
  return row;
}

/** Re-exported so a caller needs one import for a whole session. */
export type { ExerciseRow, WorkoutRow, WorkoutExerciseRow, WorkoutSetRow };
