import type { LoadType } from './training';

/**
 * The starter exercise catalogue.
 *
 * ── Why the ids are hard-coded ─────────────────────────────────────────────
 *
 * This list exists twice: here, where migration v7 seeds it into SQLite, and
 * in `supabase/migrations/20260827000001_training.sql`, where it is inserted
 * server-side. Both must produce the *same rows with the same primary keys*.
 *
 * If they did not, a workout recorded on a fresh device would reference a
 * locally-generated exercise id that does not exist on the server, and the
 * push would be rejected by the foreign key — the session would sync as far as
 * the workout and then stop. Fixed ids make the catalogue the same object
 * everywhere: on this phone, on the server, on a tablet, and after a reinstall.
 *
 * The two copies are kept in step by `exerciseCatalogue.node.test.ts`, which
 * reads the migration SQL and compares it field by field. That is the same
 * mirror-plus-drift-test pattern the AI wire contract uses.
 *
 * ── Why it is seeded rather than synced ────────────────────────────────────
 *
 * Browsing exercises has to work on a first run with no network, in a gym
 * basement. Seeding is one INSERT at migration time; syncing would mean a
 * first-launch download and an empty catalogue until it finished. The sync
 * pull therefore scopes exercises on `owner_id`, and carries only what the
 * user made.
 */

export interface CatalogueExercise {
  readonly id: string;
  readonly name: string;
  readonly normalizedName: string;
  readonly primaryMuscle: string;
  readonly secondaryMuscles: readonly string[];
  readonly equipment: string;
  readonly movementType: 'compound' | 'isolation' | null;
  readonly loadType: LoadType;
  readonly description: string;
}

/** `e5e0…` so a seeded row is recognisable at a glance in a database client. */
const id = (n: number): string =>
  `e5e00000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const EXERCISE_CATALOGUE: readonly CatalogueExercise[] = [
  {
    id: id(1),
    name: 'Barbell Bench Press',
    normalizedName: 'barbell bench press',
    primaryMuscle: 'chest',
    secondaryMuscles: ['triceps', 'shoulders'],
    equipment: 'barbell',
    movementType: 'compound',
    loadType: 'weighted',
    description: 'Flat barbell press from the chest.',
  },
  {
    id: id(2),
    name: 'Barbell Back Squat',
    normalizedName: 'barbell back squat',
    primaryMuscle: 'quadriceps',
    secondaryMuscles: ['glutes', 'hamstrings', 'core'],
    equipment: 'barbell',
    movementType: 'compound',
    loadType: 'weighted',
    description: 'Squat with the bar racked on the upper back.',
  },
  {
    id: id(3),
    name: 'Conventional Deadlift',
    normalizedName: 'conventional deadlift',
    primaryMuscle: 'back',
    secondaryMuscles: ['hamstrings', 'glutes', 'forearms'],
    equipment: 'barbell',
    movementType: 'compound',
    loadType: 'weighted',
    description: 'Lift from the floor to a standing position.',
  },
  {
    id: id(4),
    name: 'Overhead Press',
    normalizedName: 'overhead press',
    primaryMuscle: 'shoulders',
    secondaryMuscles: ['triceps', 'core'],
    equipment: 'barbell',
    movementType: 'compound',
    loadType: 'weighted',
    description: 'Standing press from the shoulders to overhead.',
  },
  {
    id: id(5),
    name: 'Barbell Row',
    normalizedName: 'barbell row',
    primaryMuscle: 'back',
    secondaryMuscles: ['biceps', 'forearms'],
    equipment: 'barbell',
    movementType: 'compound',
    loadType: 'weighted',
    description: 'Bent-over row to the lower ribs.',
  },
  {
    id: id(6),
    name: 'Dumbbell Curl',
    normalizedName: 'dumbbell curl',
    primaryMuscle: 'biceps',
    secondaryMuscles: ['forearms'],
    equipment: 'dumbbell',
    movementType: 'isolation',
    loadType: 'weighted',
    description: 'Curl one dumbbell in each hand.',
  },
  {
    id: id(7),
    name: 'Lat Pulldown',
    normalizedName: 'lat pulldown',
    primaryMuscle: 'back',
    secondaryMuscles: ['biceps'],
    equipment: 'cable',
    movementType: 'compound',
    loadType: 'weighted',
    description: 'Pull the bar to the upper chest.',
  },
  {
    id: id(8),
    name: 'Leg Press',
    normalizedName: 'leg press',
    primaryMuscle: 'quadriceps',
    secondaryMuscles: ['glutes'],
    equipment: 'machine',
    movementType: 'compound',
    loadType: 'weighted',
    description: 'Press the platform away on a leg press machine.',
  },
  {
    id: id(9),
    name: 'Romanian Deadlift',
    normalizedName: 'romanian deadlift',
    primaryMuscle: 'hamstrings',
    secondaryMuscles: ['glutes', 'back'],
    equipment: 'barbell',
    movementType: 'compound',
    loadType: 'weighted',
    description: 'Hinge at the hips with a near-straight leg.',
  },
  {
    id: id(10),
    name: 'Pull-up',
    normalizedName: 'pull up',
    primaryMuscle: 'back',
    secondaryMuscles: ['biceps', 'forearms'],
    equipment: 'bodyweight',
    movementType: 'compound',
    loadType: 'bodyweight',
    description: 'Pull to the bar from a dead hang. Add weight with a belt if you like.',
  },
  {
    id: id(11),
    name: 'Push-up',
    normalizedName: 'push up',
    primaryMuscle: 'chest',
    secondaryMuscles: ['triceps', 'shoulders', 'core'],
    equipment: 'bodyweight',
    movementType: 'compound',
    loadType: 'bodyweight',
    description: 'Press from the floor with a braced trunk.',
  },
  {
    id: id(12),
    name: 'Dip',
    normalizedName: 'dip',
    primaryMuscle: 'triceps',
    secondaryMuscles: ['chest', 'shoulders'],
    equipment: 'bodyweight',
    movementType: 'compound',
    loadType: 'bodyweight',
    description: 'Lower and press between parallel bars.',
  },
  {
    id: id(13),
    name: 'Plank',
    normalizedName: 'plank',
    primaryMuscle: 'core',
    secondaryMuscles: ['shoulders'],
    equipment: 'bodyweight',
    movementType: 'isolation',
    loadType: 'duration',
    description: 'Hold a straight line on the forearms.',
  },
  {
    id: id(14),
    name: 'Dead Hang',
    normalizedName: 'dead hang',
    primaryMuscle: 'forearms',
    secondaryMuscles: ['back'],
    equipment: 'bodyweight',
    movementType: 'isolation',
    loadType: 'duration',
    description: 'Hang from the bar with straight arms.',
  },
  {
    id: id(15),
    name: 'Running',
    normalizedName: 'running',
    primaryMuscle: 'cardio',
    secondaryMuscles: ['quadriceps', 'calves'],
    equipment: 'other',
    movementType: null,
    loadType: 'distance',
    description: 'Distance run. Record the distance and how long it took.',
  },
  {
    id: id(16),
    name: 'Rowing Machine',
    normalizedName: 'rowing machine',
    primaryMuscle: 'cardio',
    secondaryMuscles: ['back', 'quadriceps'],
    equipment: 'machine',
    movementType: null,
    loadType: 'distance',
    description: 'Distance on an indoor rower.',
  },
];

/**
 * The seed as SQLite statements.
 *
 * Built from the list rather than written out, so the catalogue exists once.
 * `created_at`/`updated_at` are a fixed epoch rather than `Date.now()`: a
 * migration must produce identical rows on every device and at every install
 * time, and a row whose timestamp is "whenever this phone was set up" would
 * make the sync cursor behave differently per device for no reason.
 */
export const CATALOGUE_SEED_EPOCH_MS = Date.UTC(2026, 7, 27, 0, 0, 0);

const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

export function catalogueSeedStatements(): string[] {
  return EXERCISE_CATALOGUE.map(
    (exercise) =>
      `INSERT INTO exercises (
         id, owner_id, name, normalized_name, description, instructions,
         primary_muscle, secondary_muscles, equipment, movement_type,
         load_type, source, created_at, updated_at, server_updated_at, deleted_at
       ) VALUES (
         ${sqlString(exercise.id)}, NULL, ${sqlString(exercise.name)},
         ${sqlString(exercise.normalizedName)}, ${sqlString(exercise.description)}, NULL,
         ${sqlString(exercise.primaryMuscle)},
         ${sqlString(JSON.stringify(exercise.secondaryMuscles))},
         ${sqlString(exercise.equipment)},
         ${exercise.movementType ? sqlString(exercise.movementType) : 'NULL'},
         ${sqlString(exercise.loadType)}, 'system',
         ${CATALOGUE_SEED_EPOCH_MS}, ${CATALOGUE_SEED_EPOCH_MS}, NULL, NULL
       )`,
  );
}
