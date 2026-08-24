import { createTestDatabase } from '@/db/__tests__/testDb';
import { migrate } from '@/db/migrator';
import type { SqlDatabase } from '@/db/types';
import {
  browseExercises,
  createCustomExercise,
  editCustomExercise,
} from '@/db/repositories/exercises';
import {
  addWorkoutExercise,
  deleteSet,
  editSet,
  editWorkout,
  finishWorkout,
  getWorkoutDetail,
  listSetRows,
  listWorkoutExerciseRows,
  previousPerformance,
  recordSet,
  reorderWorkoutExercises,
  startWorkout,
} from '@/db/repositories/workouts';
import { EXERCISE_CATALOGUE } from '@/lib/exerciseCatalogue';
import { sync } from '../engine';
import { countPending } from '../outbox';
import { SYNC_REGISTRY } from '../registry';
import { createFakeRemote, type FakeRemote } from './fakeRemote';

jest.mock('@/api/supabase', () => ({ supabase: {} }));

/**
 * Training, offline and across devices.
 *
 * The scenario that decides whether this feature works is the ordinary one:
 * a gym in a basement, no signal, a whole session recorded, then a train home
 * where it syncs. Everything here is driven through the real engine and the
 * real outbox against an in-memory server.
 *
 * The specific risk training adds is **dependency order**. A set references a
 * workout exercise, which references a workout; the server's foreign keys
 * reject any other arrival order. Nothing here sequences that by hand — the
 * outbox drains by insertion id and the repositories create parents first —
 * and these assertions are what prove it stays true.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const ZURICH = 'Europe/Zurich';
/** 2026-06-15 18:00 Zurich. */
const EVENING = Date.parse('2026-06-15T16:00:00.000Z');

const BENCH = EXERCISE_CATALOGUE.find((e) => e.normalizedName === 'barbell bench press')!;
const ROW = EXERCISE_CATALOGUE.find((e) => e.normalizedName === 'barbell row')!;

function device(): SqlDatabase & { close: () => void } {
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

/** Records a full session locally, exactly as the UI would. */
function recordSession(db: SqlDatabase, at = EVENING) {
  const workout = startWorkout({ userId: USER, name: 'Push', timeZone: ZURICH, at }, db);

  const bench = addWorkoutExercise(
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
  const row = addWorkoutExercise(
    {
      workoutId: workout.id,
      userId: USER,
      exerciseId: ROW.id,
      name: ROW.name,
      loadType: 'weighted',
      at,
    },
    db,
  );

  recordSet({ workoutExerciseId: bench.id, userId: USER, weightKg: 60, reps: 10, at }, db);
  recordSet({ workoutExerciseId: bench.id, userId: USER, weightKg: 70, reps: 8, at }, db);
  recordSet({ workoutExerciseId: bench.id, userId: USER, weightKg: 70, reps: 8, at }, db);
  recordSet({ workoutExerciseId: row.id, userId: USER, weightKg: 50, reps: 12, at }, db);

  return { workout, bench, row };
}

/** The order rows actually reached the server, by table. */
function arrivalOrder(remote: FakeRemote): string[] {
  return remote.upsertLog.map((entry) => entry.table);
}

/* ------------------------------------------------------- the whole journey */

describe('a session recorded with no signal', () => {
  it('is written locally, queued, and pushed intact when the signal returns', async () => {
    const db = device();
    const remote = createFakeRemote();
    remote.goOffline();

    const { workout } = recordSession(db);
    finishWorkout(workout.id, db, EVENING + 45 * 60_000);

    // Everything is already readable. This is the point of offline-first.
    const local = getWorkoutDetail(workout.id, db)!;
    expect(local.totalSets).toBe(4);
    expect(local.totalVolumeKg).toBe(2320);

    // 1 workout + 2 exercises + 4 sets + 1 finish = 8 queued writes.
    expect(countPending(db)).toBe(8);

    const offline = await sync({ db, userId: USER, remote });
    expect(offline.pushed).toBe(0);
    expect(countPending(db)).toBe(8);

    remote.goOnline();
    // The failed attempt scheduled an exponential backoff; a real device would
    // simply sync again later. Clearing it is how every sync suite here
    // simulates "later" without sleeping.
    db.run('UPDATE sync_outbox SET next_attempt_at = 0');
    await sync({ db, userId: USER, remote });

    expect(countPending(db)).toBe(0);
    expect(remote.rows('workouts')).toHaveLength(1);
    expect(remote.rows('workout_exercises')).toHaveLength(2);
    expect(remote.rows('workout_sets')).toHaveLength(4);

    db.close();
  });

  it('reaches the server parents-first, without anything sequencing it', async () => {
    const db = device();
    const remote = createFakeRemote();
    remote.goOffline();

    recordSession(db);

    remote.goOnline();
    await sync({ db, userId: USER, remote });

    const order = arrivalOrder(remote);

    // The exact guarantee the server's foreign keys need.
    expect(order.indexOf('workouts')).toBeLessThan(order.indexOf('workout_exercises'));
    expect(order.indexOf('workout_exercises')).toBeLessThan(order.indexOf('workout_sets'));

    db.close();
  });

  it('pushes a custom exercise before the session that uses it', async () => {
    const db = device();
    const remote = createFakeRemote();
    remote.goOffline();

    // Inventing an exercise on the gym floor, then using it immediately.
    const custom = createCustomExercise(
      {
        userId: USER,
        name: 'Zercher Squat',
        primaryMuscle: 'quadriceps',
        equipment: 'barbell',
        loadType: 'weighted',
        at: EVENING,
      },
      db,
    );

    const workout = startWorkout(
      { userId: USER, name: 'Legs', timeZone: ZURICH, at: EVENING + 1000 },
      db,
    );
    const exercise = addWorkoutExercise(
      {
        workoutId: workout.id,
        userId: USER,
        exerciseId: custom.id,
        name: custom.name,
        loadType: 'weighted',
        at: EVENING + 2000,
      },
      db,
    );
    recordSet(
      {
        workoutExerciseId: exercise.id,
        userId: USER,
        weightKg: 80,
        reps: 8,
        at: EVENING + 3000,
      },
      db,
    );

    remote.goOnline();
    await sync({ db, userId: USER, remote });

    const order = arrivalOrder(remote);
    expect(order.indexOf('exercises')).toBeLessThan(order.indexOf('workout_exercises'));
    expect(countPending(db)).toBe(0);

    db.close();
  });

  it('collapses repeated offline edits into one self-consistent row', async () => {
    const db = device();
    const remote = createFakeRemote();
    remote.goOffline();

    const { workout, bench } = recordSession(db);
    const [first] = listSetRows(db, bench.id);

    // The user corrects the same set three times before any signal returns.
    editSet(first!.id, { weightKg: 62.5, at: EVENING + 1000 }, db);
    editSet(first!.id, { weightKg: 65, at: EVENING + 2000 }, db);
    editSet(first!.id, { weightKg: 65, reps: 9, at: EVENING + 3000 }, db);
    editWorkout(workout.id, { name: 'Push A' }, db);

    remote.goOnline();
    await sync({ db, userId: USER, remote });

    const synced = remote.find('workout_sets', first!.id);

    // Whichever entry sent last carried the whole row, not a fragment.
    expect(synced).toMatchObject({ weight_kg: 65, reps: 9, set_number: 1 });
    expect(remote.find('workouts', workout.id)?.name).toBe('Push A');

    db.close();
  });
});

/* ---------------------------------------------------- the second device */

describe('a second device', () => {
  it('receives the whole session with no data loss and no duplicates', async () => {
    const phone = device();
    const tablet = device();
    const remote = createFakeRemote();

    const { workout, bench } = recordSession(phone);
    finishWorkout(workout.id, phone, EVENING + 45 * 60_000);
    await sync({ db: phone, userId: USER, remote });

    await sync({ db: tablet, userId: USER, remote });

    const mirrored = getWorkoutDetail(workout.id, tablet)!;

    expect(mirrored.workout.name).toBe('Push');
    expect(mirrored.workout.status).toBe('completed');
    // The local day travels as a day, never re-derived into the receiver's zone.
    expect(mirrored.workout.local_date).toBe('2026-06-15');
    expect(mirrored.exercises).toHaveLength(2);
    expect(mirrored.totalSets).toBe(4);
    expect(mirrored.totalVolumeKg).toBe(2320);

    // Exactly four sets, not eight.
    expect(listSetRows(tablet, bench.id)).toHaveLength(3);
    expect(
      tablet.get<{ count: number }>('SELECT COUNT(*) AS count FROM workout_sets')?.count,
    ).toBe(4);

    phone.close();
    tablet.close();
  });

  it('does not duplicate sets when the same cycle runs twice', async () => {
    const phone = device();
    const tablet = device();
    const remote = createFakeRemote();

    recordSession(phone);
    await sync({ db: phone, userId: USER, remote });

    await sync({ db: tablet, userId: USER, remote });
    // A second pull re-fetches the cursor overlap window on purpose.
    await sync({ db: tablet, userId: USER, remote });
    await sync({ db: tablet, userId: USER, remote });

    expect(
      tablet.get<{ count: number }>('SELECT COUNT(*) AS count FROM workout_sets')?.count,
    ).toBe(4);

    phone.close();
    tablet.close();
  });

  it('learns about a deleted set rather than keeping it forever', async () => {
    const phone = device();
    const tablet = device();
    const remote = createFakeRemote();

    const { bench } = recordSession(phone);
    await sync({ db: phone, userId: USER, remote });
    await sync({ db: tablet, userId: USER, remote });

    expect(listSetRows(tablet, bench.id)).toHaveLength(3);

    const [, second] = listSetRows(phone, bench.id);
    deleteSet(second!.id, phone, EVENING + 60_000);
    await sync({ db: phone, userId: USER, remote });
    await sync({ db: tablet, userId: USER, remote });

    // A soft delete is what synchronises; a hard delete would be invisible.
    const remaining = listSetRows(tablet, bench.id);
    expect(remaining).toHaveLength(2);
    // And the renumbering travelled with it.
    expect(remaining.map((row) => row.set_number)).toEqual([1, 2]);

    phone.close();
    tablet.close();
  });

  it('receives a reorder as positions, not as a shuffle', async () => {
    const phone = device();
    const tablet = device();
    const remote = createFakeRemote();

    const { workout, bench, row } = recordSession(phone);
    await sync({ db: phone, userId: USER, remote });
    await sync({ db: tablet, userId: USER, remote });

    reorderWorkoutExercises(workout.id, [row.id, bench.id], phone, EVENING + 60_000);
    await sync({ db: phone, userId: USER, remote });
    await sync({ db: tablet, userId: USER, remote });

    expect(
      listWorkoutExerciseRows(tablet, workout.id).map((entry) => entry.exercise_name),
    ).toEqual(['Barbell Row', 'Barbell Bench Press']);

    phone.close();
    tablet.close();
  });

  it('shares a custom exercise between the user own devices', async () => {
    const phone = device();
    const tablet = device();
    const remote = createFakeRemote();

    const custom = createCustomExercise(
      {
        userId: USER,
        name: 'Zercher Squat',
        primaryMuscle: 'quadriceps',
        equipment: 'barbell',
        loadType: 'weighted',
        secondaryMuscles: ['glutes', 'core'],
        at: EVENING,
      },
      phone,
    );

    await sync({ db: phone, userId: USER, remote });
    await sync({ db: tablet, userId: USER, remote });

    const mirrored = browseExercises(USER, { ownOnly: true }, tablet);

    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]?.name).toBe('Zercher Squat');
    // The array crossed as a Postgres text[] and came back as JSON.
    expect(mirrored[0]?.secondaryMuscles).toEqual(['glutes', 'core']);

    // Renaming it on the tablet reaches the phone.
    editCustomExercise(custom.id, { name: 'Zercher Front Squat' }, tablet);
    await sync({ db: tablet, userId: USER, remote });
    await sync({ db: phone, userId: USER, remote });

    expect(browseExercises(USER, { ownOnly: true }, phone)[0]?.name).toBe(
      'Zercher Front Squat',
    );

    phone.close();
    tablet.close();
  });

  it('answers previous performance from what it pulled, with no further request', async () => {
    const phone = device();
    const tablet = device();
    const remote = createFakeRemote();

    const { workout } = recordSession(phone);
    finishWorkout(workout.id, phone, EVENING + 3600_000);
    await sync({ db: phone, userId: USER, remote });
    await sync({ db: tablet, userId: USER, remote });

    const before = remote.stats.fetches;
    const previous = previousPerformance(USER, BENCH.id, null, tablet);

    expect(previous?.sets.map((set) => `${set.weightKg}x${set.reps}`)).toEqual([
      '60x10',
      '70x8',
      '70x8',
    ]);
    // Section F: set entry must never wait on the network.
    expect(remote.stats.fetches).toBe(before);

    phone.close();
    tablet.close();
  });
});

/* ----------------------------------------------------------------- failure */

describe('when a write is rejected', () => {
  it('retries the same row rather than losing it', async () => {
    const db = device();
    const remote = createFakeRemote();

    const { workout } = recordSession(db);

    // The first two attempts fail; the entries stay queued.
    remote.failWrites(2);
    await sync({ db, userId: USER, remote });

    expect(countPending(db)).toBeGreaterThan(0);

    // Retry backoff is time-based, so drain it by clearing the delay.
    db.run('UPDATE sync_outbox SET next_attempt_at = 0');
    await sync({ db, userId: USER, remote });

    expect(countPending(db)).toBe(0);
    expect(remote.find('workouts', workout.id)).toBeDefined();
    expect(remote.rows('workout_sets')).toHaveLength(4);

    db.close();
  });

  it('never applies a partial session — the parent is retried with the children', async () => {
    const db = device();
    const remote = createFakeRemote();
    remote.goOffline();

    const { workout } = recordSession(db);

    await sync({ db, userId: USER, remote });
    expect(remote.rows('workouts')).toHaveLength(0);
    expect(remote.rows('workout_sets')).toHaveLength(0);

    remote.goOnline();
    db.run('UPDATE sync_outbox SET next_attempt_at = 0');
    await sync({ db, userId: USER, remote });

    // All of it, or none of it — never a workout with no sets.
    expect(remote.find('workouts', workout.id)).toBeDefined();
    expect(remote.rows('workout_sets')).toHaveLength(4);

    db.close();
  });
});

/* ---------------------------------------------------------------- registry */

describe('the sync registry', () => {
  it('registers training in dependency order for the pull', () => {
    const tables = SYNC_REGISTRY.map((descriptor) => descriptor.table);

    expect(tables.indexOf('exercises')).toBeLessThan(tables.indexOf('workout_exercises'));
    expect(tables.indexOf('workouts')).toBeLessThan(tables.indexOf('workout_exercises'));
    expect(tables.indexOf('workout_exercises')).toBeLessThan(
      tables.indexOf('workout_sets'),
    );
  });

  it('adds no second sync engine', () => {
    // Training is four descriptors and nothing else: the same engine, the same
    // outbox, the same merge rules.
    const training = SYNC_REGISTRY.filter((descriptor) =>
      ['exercises', 'workouts', 'workout_exercises', 'workout_sets'].includes(
        descriptor.table,
      ),
    );

    expect(training).toHaveLength(4);
    expect(training.every((descriptor) => descriptor.afterPull === undefined)).toBe(true);
  });

  it('scopes the exercise pull on the owner, so the shared catalogue is not downloaded', () => {
    const exercises = SYNC_REGISTRY.find((entry) => entry.table === 'exercises');
    expect(exercises?.userColumn).toBe('owner_id');
  });
});
