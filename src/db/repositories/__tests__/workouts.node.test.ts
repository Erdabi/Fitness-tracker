import { createTestDatabase } from '@/db/__tests__/testDb';
import { migrate } from '@/db/migrator';
import type { SqlDatabase } from '@/db/types';
import { EXERCISE_CATALOGUE } from '@/lib/exerciseCatalogue';
import { asLocalDay } from '@/lib/date';
import { toCanonicalKg } from '@/lib/training';
import {
  browseExercises,
  createCustomExercise,
  deleteCustomExercise,
  editCustomExercise,
  getExercise,
} from '../exercises';
import {
  abandonWorkout,
  activeWorkout,
  addWorkoutExercise,
  deleteSet,
  deleteWorkout,
  duplicateWorkoutExercise,
  editSet,
  editWorkout,
  finishWorkout,
  getWorkoutDetail,
  listSetRows,
  listWorkoutExerciseRows,
  listWorkouts,
  previousPerformance,
  recordSet,
  removeWorkoutExercise,
  repeatWorkout,
  reorderWorkoutExercises,
  startWorkout,
  toggleSetCompleted,
} from '../workouts';

jest.mock('@/api/supabase', () => ({ supabase: {} }));

/**
 * The training repositories, against a real SQLite database.
 *
 * Every mutation runs through the same `withOutbox` the rest of the app uses,
 * so these also assert the thing that makes training work offline: that a
 * local write and its queued sync entry are one transaction.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const ZURICH = 'Europe/Zurich';
/** 2026-06-15 18:00 Zurich. */
const EVENING = Date.parse('2026-06-15T16:00:00.000Z');

const BENCH = EXERCISE_CATALOGUE.find((e) => e.normalizedName === 'barbell bench press')!;
const PLANK = EXERCISE_CATALOGUE.find((e) => e.normalizedName === 'plank')!;
const PUSHUP = EXERCISE_CATALOGUE.find((e) => e.normalizedName === 'push up')!;

function freshDatabase(): SqlDatabase & { close: () => void } {
  const db = createTestDatabase();
  migrate(db);
  db.run(
    `INSERT INTO profiles (id, email, unit_system, time_zone, created_at, updated_at)
     VALUES (?, 'sam@example.com', 'metric', 'Europe/Zurich', 1000, 1000)`,
    [USER],
  );
  db.run('DELETE FROM sync_outbox');
  return db;
}

function pending(db: SqlDatabase, table?: string): number {
  const row = db.get<{ count: number }>(
    table
      ? 'SELECT COUNT(*) AS count FROM sync_outbox WHERE table_name = ?'
      : 'SELECT COUNT(*) AS count FROM sync_outbox',
    table ? [table] : [],
  );
  return row?.count ?? 0;
}

/** A whole session: bench press, three sets. */
function benchSession(db: SqlDatabase, at = EVENING) {
  const workout = startWorkout(
    { userId: USER, name: 'Push', timeZone: ZURICH, at },
    db,
  );
  const exercise = addWorkoutExercise(
    {
      workoutId: workout.id,
      userId: USER,
      exerciseId: BENCH.id,
      name: BENCH.name,
      loadType: 'weighted',
      at,
    },
    db,
  );

  recordSet({ workoutExerciseId: exercise.id, userId: USER, weightKg: 60, reps: 10, at }, db);
  recordSet({ workoutExerciseId: exercise.id, userId: USER, weightKg: 70, reps: 8, at }, db);
  recordSet({ workoutExerciseId: exercise.id, userId: USER, weightKg: 70, reps: 8, at }, db);

  return { workout, exercise };
}

/* --------------------------------------------------------------- catalogue */

describe('the seeded catalogue', () => {
  it('is there on a fresh install with no network', () => {
    const db = freshDatabase();
    expect(browseExercises(USER, {}, db)).toHaveLength(EXERCISE_CATALOGUE.length);
    db.close();
  });

  it('seeds nothing into the outbox: the catalogue is not the user data to push', () => {
    const db = freshDatabase();
    // freshDatabase clears the outbox; assert the seed itself did not enqueue.
    const clean = createTestDatabase();
    migrate(clean);
    expect(
      clean.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sync_outbox WHERE table_name = 'exercises'",
      )?.count,
    ).toBe(0);
    clean.close();
    db.close();
  });

  it('finds an exercise by a partial name', () => {
    const db = freshDatabase();
    const results = browseExercises(USER, { query: 'bench' }, db);
    expect(results[0]?.name).toBe('Barbell Bench Press');
    db.close();
  });

  it('filters by muscle and by equipment', () => {
    const db = freshDatabase();
    expect(browseExercises(USER, { muscle: 'chest' }, db).length).toBeGreaterThan(0);
    expect(
      browseExercises(USER, { equipment: 'bodyweight' }, db).every(
        (exercise) => exercise.equipment === 'bodyweight',
      ),
    ).toBe(true);
    db.close();
  });

  it('carries the load type that decides how a set is entered', () => {
    const db = freshDatabase();
    expect(getExercise(PLANK.id, db)?.loadType).toBe('duration');
    expect(getExercise(PUSHUP.id, db)?.loadType).toBe('bodyweight');
    db.close();
  });
});

describe('custom exercises', () => {
  it('is created locally and queued for sync', () => {
    const db = freshDatabase();

    const exercise = createCustomExercise(
      {
        userId: USER,
        name: 'Zercher Squat',
        primaryMuscle: 'quadriceps',
        equipment: 'barbell',
        loadType: 'weighted',
      },
      db,
    );

    expect(exercise.owner_id).toBe(USER);
    expect(exercise.source).toBe('user');
    expect(pending(db, 'exercises')).toBe(1);
    db.close();
  });

  it('appears alongside the catalogue, ahead of it at equal relevance', () => {
    const db = freshDatabase();
    createCustomExercise(
      {
        userId: USER,
        name: 'Bench Press Variation',
        primaryMuscle: 'chest',
        equipment: 'barbell',
        loadType: 'weighted',
      },
      db,
    );

    const results = browseExercises(USER, { query: 'bench' }, db);
    // The user made it; they are looking for it.
    expect(results[0]?.isOwn).toBe(true);
    db.close();
  });

  it('can be edited by its owner', () => {
    const db = freshDatabase();
    const exercise = createCustomExercise(
      {
        userId: USER,
        name: 'Zercher Squat',
        primaryMuscle: 'quadriceps',
        equipment: 'barbell',
        loadType: 'weighted',
      },
      db,
    );

    const edited = editCustomExercise(exercise.id, { name: 'Zercher Front Squat' }, db);

    expect(edited.name).toBe('Zercher Front Squat');
    expect(edited.normalized_name).toBe('zercher front squat');
    db.close();
  });

  it('refuses to edit or delete a shared catalogue exercise', () => {
    const db = freshDatabase();
    expect(() => editCustomExercise(BENCH.id, { name: 'Mine now' }, db)).toThrow();
    expect(() => deleteCustomExercise(BENCH.id, db)).toThrow();
    db.close();
  });

  it('is soft-deleted, so the removal can synchronise', () => {
    const db = freshDatabase();
    const exercise = createCustomExercise(
      {
        userId: USER,
        name: 'Zercher Squat',
        primaryMuscle: 'quadriceps',
        equipment: 'barbell',
        loadType: 'weighted',
      },
      db,
    );

    deleteCustomExercise(exercise.id, db, EVENING);

    expect(getExercise(exercise.id, db)).toBeNull();
    expect(
      db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM exercises WHERE id = ?', [
        exercise.id,
      ])?.deleted_at,
    ).toBe(EVENING);
    db.close();
  });
});

/* ---------------------------------------------------------------- sessions */

describe('a session', () => {
  it('records the local day at write time, not a UTC truncation', () => {
    const db = freshDatabase();

    // 23:30 in Auckland on the 14th is 11:30 UTC — a different UTC day.
    const workout = startWorkout(
      {
        userId: USER,
        name: 'Evening',
        timeZone: 'Pacific/Auckland',
        at: Date.parse('2026-06-14T11:30:00.000Z'),
      },
      db,
    );

    expect(workout.local_date).toBe('2026-06-14');
    db.close();
  });

  it('starts in progress and is the active session', () => {
    const db = freshDatabase();
    const { workout } = benchSession(db);

    expect(workout.status).toBe('in_progress');
    expect(activeWorkout(USER, db)?.id).toBe(workout.id);
    db.close();
  });

  it('leaves a planned session without an instant', () => {
    const db = freshDatabase();

    const workout = startWorkout(
      {
        userId: USER,
        name: 'Next Tuesday',
        timeZone: ZURICH,
        at: EVENING,
        status: 'planned',
        localDate: asLocalDay('2026-06-23'),
      },
      db,
    );

    expect(workout.started_at).toBeNull();
    expect(workout.local_date).toBe('2026-06-23');
    // Not active: it has not started.
    expect(activeWorkout(USER, db)).toBeNull();
    db.close();
  });

  it('acquires its instant and its day when it is started', () => {
    const db = freshDatabase();
    const planned = startWorkout(
      {
        userId: USER,
        name: 'Next Tuesday',
        timeZone: ZURICH,
        at: EVENING,
        status: 'planned',
        localDate: asLocalDay('2026-06-23'),
      },
      db,
    );

    const started = editWorkout(planned.id, { status: 'in_progress', at: EVENING }, db);

    expect(started.started_at).toBe(EVENING);
    expect(started.local_date).toBe('2026-06-15');
    db.close();
  });

  it('finishes with a duration', () => {
    const db = freshDatabase();
    const { workout } = benchSession(db);

    const finished = finishWorkout(workout.id, db, EVENING + 45 * 60_000);

    expect(finished.status).toBe('completed');
    expect(getWorkoutDetail(workout.id, db)?.durationSeconds).toBe(2700);
    expect(activeWorkout(USER, db)).toBeNull();
    db.close();
  });

  it('never records a completion before its start', () => {
    const db = freshDatabase();
    const { workout } = benchSession(db);

    // A clock corrected backwards mid-session.
    const finished = finishWorkout(workout.id, db, EVENING - 60_000);

    expect(finished.completed_at).toBe(EVENING);
    db.close();
  });

  it('can be abandoned, keeping what was recorded', () => {
    const db = freshDatabase();
    const { workout } = benchSession(db);

    abandonWorkout(workout.id, db, EVENING + 60_000);

    const detail = getWorkoutDetail(workout.id, db);
    expect(detail?.workout.status).toBe('abandoned');
    expect(detail?.totalSets).toBe(3);
    db.close();
  });

  it('soft-deletes its exercises and sets with it, so both devices learn', () => {
    const db = freshDatabase();
    const { workout, exercise } = benchSession(db);

    deleteWorkout(workout.id, db, EVENING + 1000);

    expect(getWorkoutDetail(workout.id, db)).toBeNull();
    expect(listSetRows(db, exercise.id)).toHaveLength(0);
    // Every removal is queued: a hard delete would be invisible to a pull.
    expect(pending(db, 'workout_sets')).toBeGreaterThan(3);
    db.close();
  });
});

/* --------------------------------------------------------------- exercises */

describe('exercises within a session', () => {
  it('are positioned densely from zero in the order added', () => {
    const db = freshDatabase();
    const { workout } = benchSession(db);

    addWorkoutExercise(
      {
        workoutId: workout.id,
        userId: USER,
        exerciseId: PUSHUP.id,
        name: PUSHUP.name,
        loadType: 'bodyweight',
        at: EVENING,
      },
      db,
    );

    expect(listWorkoutExerciseRows(db, workout.id).map((row) => row.position)).toEqual([
      0, 1,
    ]);
    db.close();
  });

  it('snapshot the name and load type, never a reference to read later', () => {
    const db = freshDatabase();
    const { exercise } = benchSession(db);

    expect(exercise.exercise_name).toBe('Barbell Bench Press');
    expect(exercise.load_type).toBe('weighted');
    expect(exercise.exercise_id).toBe(BENCH.id);
    db.close();
  });

  it('reorder to a caller-supplied order', () => {
    const db = freshDatabase();
    const { workout, exercise } = benchSession(db);
    const second = addWorkoutExercise(
      {
        workoutId: workout.id,
        userId: USER,
        exerciseId: PUSHUP.id,
        name: PUSHUP.name,
        loadType: 'bodyweight',
        at: EVENING,
      },
      db,
    );

    reorderWorkoutExercises(workout.id, [second.id, exercise.id], db, EVENING + 1000);

    const rows = listWorkoutExerciseRows(db, workout.id);
    expect(rows.map((row) => row.exercise_name)).toEqual([
      'Push-up',
      'Barbell Bench Press',
    ]);
    expect(rows.map((row) => row.position)).toEqual([0, 1]);
    db.close();
  });

  it('ignore a stale id in a reorder rather than throwing', () => {
    const db = freshDatabase();
    const { workout, exercise } = benchSession(db);

    reorderWorkoutExercises(workout.id, ['gone', exercise.id], db, EVENING + 1000);

    expect(listWorkoutExerciseRows(db, workout.id)).toHaveLength(1);
    db.close();
  });

  it('close the gap when one is removed', () => {
    const db = freshDatabase();
    const { workout, exercise } = benchSession(db);
    const second = addWorkoutExercise(
      {
        workoutId: workout.id,
        userId: USER,
        exerciseId: PUSHUP.id,
        name: PUSHUP.name,
        loadType: 'bodyweight',
        at: EVENING,
      },
      db,
    );

    removeWorkoutExercise(exercise.id, db, EVENING + 1000);

    const rows = listWorkoutExerciseRows(db, workout.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(second.id);
    // Not left at 1 — "position 1 of 1" is a gap the next add would collide with.
    expect(rows[0]?.position).toBe(0);
    db.close();
  });

  it('take their sets down with them when removed', () => {
    const db = freshDatabase();
    const { exercise } = benchSession(db);

    removeWorkoutExercise(exercise.id, db, EVENING + 1000);

    expect(listSetRows(db, exercise.id)).toHaveLength(0);
    db.close();
  });

  it('can be duplicated, at the end, with no sets', () => {
    const db = freshDatabase();
    const { workout, exercise } = benchSession(db);

    const copy = duplicateWorkoutExercise(exercise.id, db, EVENING + 1000);

    expect(copy.exercise_name).toBe('Barbell Bench Press');
    expect(copy.position).toBe(1);
    expect(listSetRows(db, copy.id)).toHaveLength(0);
    expect(listWorkoutExerciseRows(db, workout.id)).toHaveLength(2);
    db.close();
  });
});

/* -------------------------------------------------------------------- sets */

describe('sets', () => {
  it('number themselves from one, in order', () => {
    const db = freshDatabase();
    const { exercise } = benchSession(db);

    expect(listSetRows(db, exercise.id).map((row) => row.set_number)).toEqual([1, 2, 3]);
    db.close();
  });

  it('are complete by default — the user pressed the button', () => {
    const db = freshDatabase();
    const { exercise } = benchSession(db);

    expect(listSetRows(db, exercise.id).every((row) => row.is_completed === 1)).toBe(true);
    db.close();
  });

  it('store kilograms whatever the user typed in', () => {
    const db = freshDatabase();
    const { exercise } = benchSession(db);

    const set = recordSet(
      {
        workoutExerciseId: exercise.id,
        userId: USER,
        weightKg: toCanonicalKg(155, 'lb'),
        weightUnit: 'lb',
        reps: 5,
        at: EVENING,
      },
      db,
    );

    expect(set.weight_kg).toBeCloseTo(70.307, 3);
    // The unit travels with the row so it reads back as 155 lb.
    expect(set.weight_unit).toBe('lb');
    db.close();
  });

  it('are edited in place', () => {
    const db = freshDatabase();
    const { exercise } = benchSession(db);
    const [first] = listSetRows(db, exercise.id);

    const edited = editSet(first!.id, { weightKg: 65, reps: 9, at: EVENING + 1000 }, db);

    expect(edited.weight_kg).toBe(65);
    expect(edited.reps).toBe(9);
    db.close();
  });

  it('toggle between done and not done', () => {
    const db = freshDatabase();
    const { exercise } = benchSession(db);
    const [first] = listSetRows(db, exercise.id);

    expect(toggleSetCompleted(first!.id, db, EVENING + 1000).is_completed).toBe(0);
    expect(toggleSetCompleted(first!.id, db, EVENING + 2000).is_completed).toBe(1);
    db.close();
  });

  it('renumber contiguously when one is deleted', () => {
    const db = freshDatabase();
    const { exercise } = benchSession(db);
    const sets = listSetRows(db, exercise.id);

    deleteSet(sets[1]!.id, db, EVENING + 1000);

    // "Set 1, Set 3" would read as a lost set rather than a deleted one.
    expect(listSetRows(db, exercise.id).map((row) => row.set_number)).toEqual([1, 2]);
    db.close();
  });

  it('keep an incomplete set out of the volume total', () => {
    const db = freshDatabase();
    const { workout, exercise } = benchSession(db);

    recordSet(
      {
        workoutExerciseId: exercise.id,
        userId: USER,
        weightKg: 80,
        reps: 5,
        isCompleted: false,
        at: EVENING,
      },
      db,
    );

    // 60×10 + 70×8 + 70×8 = 1720. The planned 80×5 is not work done.
    expect(getWorkoutDetail(workout.id, db)?.totalVolumeKg).toBe(1720);
    db.close();
  });

  it('record a hold with no weight at all', () => {
    const db = freshDatabase();
    const workout = startWorkout(
      { userId: USER, name: 'Core', timeZone: ZURICH, at: EVENING },
      db,
    );
    const plank = addWorkoutExercise(
      {
        workoutId: workout.id,
        userId: USER,
        exerciseId: PLANK.id,
        name: PLANK.name,
        loadType: 'duration',
        at: EVENING,
      },
      db,
    );

    recordSet(
      { workoutExerciseId: plank.id, userId: USER, durationSeconds: 45, at: EVENING },
      db,
    );

    const detail = getWorkoutDetail(workout.id, db);
    expect(detail?.exercises[0]?.summary.bestDurationSeconds).toBe(45);
    // Null, not zero: a plank session is not a rest day.
    expect(detail?.totalVolumeKg).toBeNull();
    expect(detail?.exercises[0]?.summary.estimatedOneRepMaxKg).toBeNull();
    db.close();
  });

  it('distinguish zero added weight from no weight at all', () => {
    const db = freshDatabase();
    const workout = startWorkout(
      { userId: USER, name: 'Bodyweight', timeZone: ZURICH, at: EVENING },
      db,
    );
    const pushups = addWorkoutExercise(
      {
        workoutId: workout.id,
        userId: USER,
        exerciseId: PUSHUP.id,
        name: PUSHUP.name,
        loadType: 'bodyweight',
        at: EVENING,
      },
      db,
    );

    const bare = recordSet(
      { workoutExerciseId: pushups.id, userId: USER, weightKg: 0, reps: 20, at: EVENING },
      db,
    );
    const loaded = recordSet(
      { workoutExerciseId: pushups.id, userId: USER, weightKg: 10, reps: 12, at: EVENING },
      db,
    );

    expect(bare.weight_kg).toBe(0);
    expect(loaded.weight_kg).toBe(10);
    // The added load is real load; the unloaded set contributes nothing.
    expect(getWorkoutDetail(workout.id, db)?.totalVolumeKg).toBe(120);
    db.close();
  });
});

/* --------------------------------------------------- previous performance */

describe('previous performance', () => {
  it('is answered from the device, with no network', () => {
    const db = freshDatabase();
    benchSession(db, EVENING);

    const current = startWorkout(
      { userId: USER, name: 'Push again', timeZone: ZURICH, at: EVENING + 7 * 86_400_000 },
      db,
    );

    const previous = previousPerformance(USER, BENCH.id, current.id, db);

    expect(previous?.localDate).toBe('2026-06-15');
    expect(previous?.sets.map((set) => `${set.weightKg}x${set.reps}`)).toEqual([
      '60x10',
      '70x8',
      '70x8',
    ]);
    db.close();
  });

  it('excludes the session currently being performed', () => {
    const db = freshDatabase();
    const { workout } = benchSession(db);

    // The only session with this exercise is the current one.
    expect(previousPerformance(USER, BENCH.id, workout.id, db)).toBeNull();
    db.close();
  });

  it('ignores a session where nothing was ticked off', () => {
    const db = freshDatabase();
    const workout = startWorkout(
      { userId: USER, name: 'Planned only', timeZone: ZURICH, at: EVENING },
      db,
    );
    const exercise = addWorkoutExercise(
      {
        workoutId: workout.id,
        userId: USER,
        exerciseId: BENCH.id,
        name: BENCH.name,
        loadType: 'weighted',
        at: EVENING,
      },
      db,
    );
    recordSet(
      {
        workoutExerciseId: exercise.id,
        userId: USER,
        weightKg: 60,
        reps: 10,
        isCompleted: false,
        at: EVENING,
      },
      db,
    );

    expect(previousPerformance(USER, BENCH.id, null, db)).toBeNull();
    db.close();
  });

  it('survives the exercise being renamed', () => {
    const db = freshDatabase();
    const custom = createCustomExercise(
      {
        userId: USER,
        name: 'Cable Fly',
        primaryMuscle: 'chest',
        equipment: 'cable',
        loadType: 'weighted',
      },
      db,
    );

    const workout = startWorkout(
      { userId: USER, name: 'Chest', timeZone: ZURICH, at: EVENING },
      db,
    );
    const exercise = addWorkoutExercise(
      {
        workoutId: workout.id,
        userId: USER,
        exerciseId: custom.id,
        name: 'Cable Fly',
        loadType: 'weighted',
        at: EVENING,
      },
      db,
    );
    recordSet(
      { workoutExerciseId: exercise.id, userId: USER, weightKg: 20, reps: 12, at: EVENING },
      db,
    );

    editCustomExercise(custom.id, { name: 'Standing Cable Fly' }, db);

    // Matched on the id, so renaming does not sever the user from their history.
    expect(previousPerformance(USER, custom.id, null, db)?.sets).toHaveLength(1);
    db.close();
  });

  it('matches nothing for an exercise with no catalogue id', () => {
    const db = freshDatabase();
    benchSession(db);
    expect(previousPerformance(USER, null, null, db)).toBeNull();
    db.close();
  });
});

/* ----------------------------------------------------------- repeat, history */

describe('repeating a session', () => {
  it('copies the shape and marks nothing as performed', () => {
    const db = freshDatabase();
    const { workout } = benchSession(db);
    finishWorkout(workout.id, db, EVENING + 3600_000);

    const repeated = repeatWorkout(
      workout.id,
      { userId: USER, timeZone: ZURICH, at: EVENING + 7 * 86_400_000 },
      db,
    );

    const detail = getWorkoutDetail(repeated.id, db)!;

    expect(detail.workout.name).toBe('Push');
    expect(detail.exercises).toHaveLength(1);
    expect(detail.exercises[0]?.sets.map((set) => `${set.weightKg}x${set.reps}`)).toEqual([
      '60x10',
      '70x8',
      '70x8',
    ]);
    // Nothing has happened yet. Copying the ticks would forge a session.
    expect(detail.exercises[0]?.sets.every((set) => !set.isCompleted)).toBe(true);
    expect(detail.totalVolumeKg).toBe(0);
    db.close();
  });

  it('leaves the session it copied untouched', () => {
    const db = freshDatabase();
    const { workout } = benchSession(db);
    finishWorkout(workout.id, db, EVENING + 3600_000);

    repeatWorkout(workout.id, { userId: USER, timeZone: ZURICH, at: EVENING + 86_400_000 }, db);

    expect(getWorkoutDetail(workout.id, db)?.totalVolumeKg).toBe(1720);
    db.close();
  });
});

describe('history', () => {
  it('lists sessions newest first', () => {
    const db = freshDatabase();
    benchSession(db, EVENING);
    benchSession(db, EVENING + 2 * 86_400_000);

    expect(listWorkouts(USER, 10, db).map((row) => row.local_date)).toEqual([
      '2026-06-17',
      '2026-06-15',
    ]);
    db.close();
  });

  it('shows the historical values after the exercise is edited', () => {
    const db = freshDatabase();
    const custom = createCustomExercise(
      {
        userId: USER,
        name: 'Cable Fly',
        primaryMuscle: 'chest',
        equipment: 'cable',
        loadType: 'weighted',
      },
      db,
    );

    const workout = startWorkout(
      { userId: USER, name: 'March', timeZone: ZURICH, at: EVENING },
      db,
    );
    const exercise = addWorkoutExercise(
      {
        workoutId: workout.id,
        userId: USER,
        exerciseId: custom.id,
        name: 'Cable Fly',
        loadType: 'weighted',
        at: EVENING,
      },
      db,
    );
    recordSet(
      { workoutExerciseId: exercise.id, userId: USER, weightKg: 20, reps: 12, at: EVENING },
      db,
    );

    editCustomExercise(
      custom.id,
      { name: 'Standing Cable Fly', loadType: 'bodyweight' },
      db,
    );
    deleteCustomExercise(custom.id, db, EVENING + 1000);

    const detail = getWorkoutDetail(workout.id, db)!;

    expect(detail.exercises[0]?.name).toBe('Cable Fly');
    expect(detail.exercises[0]?.loadType).toBe('weighted');
    expect(detail.exercises[0]?.sets).toHaveLength(1);
    // Still 240 kg of volume, computed from the snapshotted load type.
    expect(detail.totalVolumeKg).toBe(240);
    db.close();
  });

  it('reports volume, best weight and an estimated 1RM together', () => {
    const db = freshDatabase();
    const { workout } = benchSession(db);

    const summary = getWorkoutDetail(workout.id, db)!.exercises[0]!.summary;

    expect(summary.volumeKg).toBe(1720);
    expect(summary.bestWeightKg).toBe(70);
    expect(summary.bestReps).toBe(10);
    // 70 × (1 + 8/30) = 88.67
    expect(summary.estimatedOneRepMaxKg).toBeCloseTo(88.7, 1);
    db.close();
  });
});

/* ------------------------------------------------------------------ outbox */

describe('every write is queued in the same transaction', () => {
  it('queues one entry per row, in dependency order', () => {
    const db = freshDatabase();
    benchSession(db);

    const entries = db.all<{ table_name: string }>(
      'SELECT table_name FROM sync_outbox ORDER BY id',
    );

    expect(entries.map((entry) => entry.table_name)).toEqual([
      'workouts',
      'workout_exercises',
      'workout_sets',
      'workout_sets',
      'workout_sets',
    ]);
    db.close();
  });

  it('queues nothing when the write fails', () => {
    const db = freshDatabase();
    const { exercise } = benchSession(db);
    const before = pending(db);

    // Negative reps violate the CHECK constraint.
    expect(() =>
      recordSet(
        { workoutExerciseId: exercise.id, userId: USER, weightKg: 60, reps: -1 },
        db,
      ),
    ).toThrow();

    expect(pending(db)).toBe(before);
    db.close();
  });
});
