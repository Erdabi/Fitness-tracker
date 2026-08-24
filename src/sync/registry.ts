import { resyncGoalPeriods } from '@/db/repositories/goals';
import { resyncWaterGoalPeriods } from '@/db/repositories/water';
import { describeTable, type TableDescriptor } from './types';
import type {
  ExerciseRow,
  FoodLogRow,
  FoodRecentRow,
  NutritionGoalRow,
  ProfileRow,
  UserSettingsRow,
  WaterGoalRow,
  WaterLogRow,
  WeightEntryRow,
  WorkoutExerciseRow,
  WorkoutRow,
  WorkoutSetRow,
} from '@/db/schema';

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
    activity_level: local.activity_level,
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
    activity_level: asNullableString(
      remote.activity_level,
    ) as ProfileRow['activity_level'],
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

/**
 * A Postgres `numeric`, which PostgREST sends as a string to avoid the
 * precision loss of a float round-trip. Everything the diary stores locally is
 * a REAL, so the conversion happens once, here.
 */
function asNumeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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

/**
 * The food diary.
 *
 * Registered last, after the recents that share its foods.
 *
 * `toRemote` deliberately omits `amount_in_base` and every nutrient total.
 * Those are GENERATED columns in Postgres — the server derives them from the
 * basis and the portion, and refuses to accept a supplied value. That refusal
 * is the point: it makes it impossible for any client, including a stale build
 * of this one, to post a calorie figure that disagrees with the basis it
 * claims to come from. What the device sends is what the user chose; the
 * arithmetic is the database's.
 *
 * `fromRemote` reads them back, so the local row still carries totals SQLite
 * can sum without recomputing anything on read.
 */
const foodLogs: TableDescriptor = describeTable<FoodLogRow>({
  table: 'food_logs',
  remoteTable: 'food_logs',
  userColumn: 'user_id',
  toRemote: (local) => ({
    id: local.id,
    user_id: local.user_id,
    food_id: local.food_id,
    serving_id: local.serving_id,
    meal: local.meal,

    logged_at: new Date(local.logged_at).toISOString(),
    time_zone: local.time_zone,
    diary_date: local.diary_date,

    quantity: local.quantity,
    serving_label: local.serving_label,
    serving_amount: local.serving_amount,

    food_name: local.food_name,
    brand_name: local.brand_name,
    food_source_id: local.food_source_id,
    food_is_verified: local.food_is_verified === 1,

    basis_unit: local.basis_unit,
    basis_amount: local.basis_amount,
    basis_calories: local.basis_calories,
    basis_protein_g: local.basis_protein_g,
    basis_carbohydrates_g: local.basis_carbohydrates_g,
    basis_fat_g: local.basis_fat_g,
    basis_fiber_g: local.basis_fiber_g,
    basis_sugar_g: local.basis_sugar_g,
    basis_saturated_fat_g: local.basis_saturated_fat_g,
    basis_sodium_mg: local.basis_sodium_mg,

    note: local.note,
    deleted_at: local.deleted_at ? new Date(local.deleted_at).toISOString() : null,
  }),
  fromRemote: (remote) => ({
    id: String(remote.id),
    user_id: String(remote.user_id),
    food_id: asNullableString(remote.food_id),
    serving_id: asNullableString(remote.serving_id),
    meal: (asNullableString(remote.meal) ?? 'snack') as FoodLogRow['meal'],

    logged_at: toEpochMs(remote.logged_at) ?? Date.now(),
    time_zone: asNullableString(remote.time_zone) ?? 'UTC',
    // Already a calendar day on the server; re-deriving it from the instant
    // here is exactly the mistake this column exists to prevent.
    diary_date: asNullableString(remote.diary_date) ?? '1970-01-01',

    quantity: asNumeric(remote.quantity) ?? 0,
    serving_label: asNullableString(remote.serving_label) ?? 'g',
    serving_amount: asNumeric(remote.serving_amount) ?? 1,
    amount_in_base: asNumeric(remote.amount_in_base) ?? 0,

    food_name: asNullableString(remote.food_name) ?? 'Unknown food',
    brand_name: asNullableString(remote.brand_name),
    food_source_id: asNullableString(remote.food_source_id) ?? 'user',
    food_is_verified: remote.food_is_verified === true ? 1 : 0,

    basis_unit: (asNullableString(remote.basis_unit) ?? 'g') as FoodLogRow['basis_unit'],
    basis_amount: asNumeric(remote.basis_amount) ?? 100,
    basis_calories: asNumeric(remote.basis_calories) ?? 0,
    basis_protein_g: asNumeric(remote.basis_protein_g) ?? 0,
    basis_carbohydrates_g: asNumeric(remote.basis_carbohydrates_g) ?? 0,
    basis_fat_g: asNumeric(remote.basis_fat_g) ?? 0,
    basis_fiber_g: asNumeric(remote.basis_fiber_g),
    basis_sugar_g: asNumeric(remote.basis_sugar_g),
    basis_saturated_fat_g: asNumeric(remote.basis_saturated_fat_g),
    basis_sodium_mg: asNumeric(remote.basis_sodium_mg),

    calories: asNumeric(remote.calories) ?? 0,
    protein_g: asNumeric(remote.protein_g) ?? 0,
    carbohydrates_g: asNumeric(remote.carbohydrates_g) ?? 0,
    fat_g: asNumeric(remote.fat_g) ?? 0,
    fiber_g: asNumeric(remote.fiber_g),
    sugar_g: asNumeric(remote.sugar_g),
    saturated_fat_g: asNumeric(remote.saturated_fat_g),
    sodium_mg: asNumeric(remote.sodium_mg),

    note: asNullableString(remote.note),
    created_at: toEpochMs(remote.created_at) ?? Date.now(),
    updated_at: toEpochMs(remote.updated_at) ?? Date.now(),
    server_updated_at: asNullableString(remote.updated_at),
    deleted_at: toEpochMs(remote.deleted_at),
  }),
});

/**
 * Goal periods.
 *
 * `effective_to` is absent from `toRemote` on purpose. It is derived — by
 * trigger on the server, by `resyncGoalPeriods` on the device — so a change of
 * target is exactly ONE row to push. A client that closed the previous period
 * itself would have two writes that must land in order, and an offline outbox
 * cannot promise that: a partially applied push would leave two periods
 * claiming the same day, which is the one thing the whole design exists to
 * prevent.
 */
const nutritionGoals: TableDescriptor = describeTable<NutritionGoalRow>({
  table: 'nutrition_goals',
  remoteTable: 'nutrition_goals',
  userColumn: 'user_id',
  /*
   * A period arriving from another device changes where the period before it
   * ends. The server recomputes its own chain by trigger; this recomputes the
   * device's, so both sides answer "which goal applies on 5 August" the same
   * way — including for a period created here that has not been pushed yet.
   */
  afterPull: (db, userId) => resyncGoalPeriods(userId, db),
  toRemote: (local) => ({
    id: local.id,
    user_id: local.user_id,
    effective_from: local.effective_from,

    calorie_target: local.calorie_target,
    protein_target_g: local.protein_target_g,
    carbohydrate_target_g: local.carbohydrate_target_g,
    fat_target_g: local.fat_target_g,

    source: local.source,

    calculated_calories: local.calculated_calories,
    calculated_protein_g: local.calculated_protein_g,
    calculated_carbohydrate_g: local.calculated_carbohydrate_g,
    calculated_fat_g: local.calculated_fat_g,

    basis_bmr: local.basis_bmr,
    basis_tdee: local.basis_tdee,
    basis_activity: local.basis_activity,
    basis_direction: local.basis_direction,
    basis_weight_kg: local.basis_weight_kg,
    basis_height_cm: local.basis_height_cm,
    basis_age_years: local.basis_age_years,
    basis_sex: local.basis_sex,

    acknowledged_below_floor: local.acknowledged_below_floor === 1,
    note: local.note,
    deleted_at: local.deleted_at ? new Date(local.deleted_at).toISOString() : null,
  }),
  fromRemote: (remote) => ({
    id: String(remote.id),
    user_id: String(remote.user_id),
    effective_from: asNullableString(remote.effective_from) ?? '1970-01-01',
    effective_to: asNullableString(remote.effective_to),

    calorie_target: asNumeric(remote.calorie_target) ?? 2000,
    protein_target_g: asNumeric(remote.protein_target_g) ?? 0,
    carbohydrate_target_g: asNumeric(remote.carbohydrate_target_g) ?? 0,
    fat_target_g: asNumeric(remote.fat_target_g) ?? 0,

    source: (asNullableString(remote.source) ?? 'manual') as NutritionGoalRow['source'],

    calculated_calories: asNumeric(remote.calculated_calories),
    calculated_protein_g: asNumeric(remote.calculated_protein_g),
    calculated_carbohydrate_g: asNumeric(remote.calculated_carbohydrate_g),
    calculated_fat_g: asNumeric(remote.calculated_fat_g),

    basis_bmr: asNumeric(remote.basis_bmr),
    basis_tdee: asNumeric(remote.basis_tdee),
    basis_activity: asNullableString(
      remote.basis_activity,
    ) as NutritionGoalRow['basis_activity'],
    basis_direction: asNullableString(
      remote.basis_direction,
    ) as NutritionGoalRow['basis_direction'],
    basis_weight_kg: asNumeric(remote.basis_weight_kg),
    basis_height_cm: asNumeric(remote.basis_height_cm),
    basis_age_years: asNumeric(remote.basis_age_years),
    basis_sex: asNullableString(remote.basis_sex) as NutritionGoalRow['basis_sex'],

    acknowledged_below_floor: remote.acknowledged_below_floor === true ? 1 : 0,
    note: asNullableString(remote.note),

    created_at: toEpochMs(remote.created_at) ?? Date.now(),
    updated_at: toEpochMs(remote.updated_at) ?? Date.now(),
    server_updated_at: asNullableString(remote.updated_at),
    deleted_at: toEpochMs(remote.deleted_at),
  }),
});

const weightEntries: TableDescriptor = describeTable<WeightEntryRow>({
  table: 'weight_entries',
  remoteTable: 'weight_entries',
  userColumn: 'user_id',
  toRemote: (local) => ({
    id: local.id,
    user_id: local.user_id,
    measured_on: local.measured_on,
    weight_kg: local.weight_kg,
    note: local.note,
    deleted_at: local.deleted_at ? new Date(local.deleted_at).toISOString() : null,
  }),
  fromRemote: (remote) => ({
    id: String(remote.id),
    user_id: String(remote.user_id),
    measured_on: asNullableString(remote.measured_on) ?? '1970-01-01',
    weight_kg: asNumeric(remote.weight_kg) ?? 0,
    note: asNullableString(remote.note),
    created_at: toEpochMs(remote.created_at) ?? Date.now(),
    updated_at: toEpochMs(remote.updated_at) ?? Date.now(),
    server_updated_at: asNullableString(remote.updated_at),
    deleted_at: toEpochMs(remote.deleted_at),
  }),
});

/**
 * Water logs.
 *
 * `local_date` is pushed, not re-derived: it is the user's day, settled at
 * write time, and a receiving device in another timezone must not recompute it
 * into its own. The server validates the pair through the same resolver the
 * diary uses, so a client that got it wrong is rejected rather than accepted
 * quietly.
 */
const waterLogs: TableDescriptor = describeTable<WaterLogRow>({
  table: 'water_logs',
  remoteTable: 'water_logs',
  userColumn: 'user_id',
  toRemote: (local) => ({
    id: local.id,
    user_id: local.user_id,
    amount_ml: local.amount_ml,
    consumed_at: new Date(local.consumed_at).toISOString(),
    time_zone: local.time_zone,
    local_date: local.local_date,
    note: local.note,
    deleted_at: local.deleted_at ? new Date(local.deleted_at).toISOString() : null,
  }),
  fromRemote: (remote) => ({
    id: String(remote.id),
    user_id: String(remote.user_id),
    amount_ml: asNumeric(remote.amount_ml) ?? 0,
    consumed_at: toEpochMs(remote.consumed_at) ?? Date.now(),
    time_zone: asNullableString(remote.time_zone) ?? 'UTC',
    local_date: asNullableString(remote.local_date) ?? '1970-01-01',
    note: asNullableString(remote.note),
    created_at: toEpochMs(remote.created_at) ?? Date.now(),
    updated_at: toEpochMs(remote.updated_at) ?? Date.now(),
    server_updated_at: asNullableString(remote.updated_at),
    deleted_at: toEpochMs(remote.deleted_at),
  }),
});

/**
 * Water goal periods.
 *
 * `effective_to` is omitted on push for the same reason it is on nutrition
 * goals: it is derived on both sides, so changing a target is exactly one row
 * and there is no pair of writes that has to land in order.
 */
const waterGoals: TableDescriptor = describeTable<WaterGoalRow>({
  table: 'water_goals',
  remoteTable: 'water_goals',
  userColumn: 'user_id',
  afterPull: (db, userId) => resyncWaterGoalPeriods(userId, db),
  toRemote: (local) => ({
    id: local.id,
    user_id: local.user_id,
    effective_from: local.effective_from,
    target_ml: local.target_ml,
    source: local.source,
    calculated_ml: local.calculated_ml,
    basis_weight_kg: local.basis_weight_kg,
    note: local.note,
    deleted_at: local.deleted_at ? new Date(local.deleted_at).toISOString() : null,
  }),
  fromRemote: (remote) => ({
    id: String(remote.id),
    user_id: String(remote.user_id),
    effective_from: asNullableString(remote.effective_from) ?? '1970-01-01',
    effective_to: asNullableString(remote.effective_to),
    target_ml: asNumeric(remote.target_ml) ?? 2000,
    source: (asNullableString(remote.source) ?? 'manual') as WaterGoalRow['source'],
    calculated_ml: asNumeric(remote.calculated_ml),
    basis_weight_kg: asNumeric(remote.basis_weight_kg),
    note: asNullableString(remote.note),
    created_at: toEpochMs(remote.created_at) ?? Date.now(),
    updated_at: toEpochMs(remote.updated_at) ?? Date.now(),
    server_updated_at: asNullableString(remote.updated_at),
    deleted_at: toEpochMs(remote.deleted_at),
  }),
});


/* -------------------------------------------------------------- training */

/*
 * The four training tables, registered in dependency order.
 *
 * Order matters twice over, and the two are different mechanisms:
 *
 *   • On PULL, the engine walks this array. An exercise must land before the
 *     workout exercise that references it, and a workout before the exercises
 *     inside it, or the local foreign keys reject the row.
 *
 *   • On PUSH, order comes from the outbox rather than from here — entries
 *     drain by insertion id, and the repositories create a parent before its
 *     children, so the server sees them in the order its own foreign keys
 *     require. Nothing sequences anything by hand and nothing sleeps.
 *
 * `trainingSync.node.test.ts` exercises both directions against an in-memory
 * server, including the case that actually breaks people: a whole session
 * recorded offline and pushed in one go.
 */

/**
 * The exercise catalogue.
 *
 * Registered before workouts. Shared rows arrive with `owner_id` null and are
 * read-only — the pull scopes on `owner_id`, so a first sync brings the user's
 * own exercises; the shared catalogue is seeded locally by migration v7's
 * counterpart on the server and arrives the same way for a returning user.
 *
 * `secondary_muscles` crosses the boundary as a Postgres `text[]` and is
 * stored locally as JSON, because SQLite has no array type.
 */
const exercises: TableDescriptor = describeTable<ExerciseRow>({
  table: 'exercises',
  remoteTable: 'exercises',
  userColumn: 'owner_id',
  toRemote: (local) => ({
    id: local.id,
    owner_id: local.owner_id,
    name: local.name,
    normalized_name: local.normalized_name,
    description: local.description,
    instructions: local.instructions,
    primary_muscle: local.primary_muscle,
    secondary_muscles: parseStringArray(local.secondary_muscles),
    equipment: local.equipment,
    movement_type: local.movement_type,
    load_type: local.load_type,
    source: local.source,
    deleted_at: local.deleted_at ? new Date(local.deleted_at).toISOString() : null,
  }),
  fromRemote: (remote) => ({
    id: String(remote.id),
    owner_id: asNullableString(remote.owner_id),
    name: asNullableString(remote.name) ?? 'Exercise',
    normalized_name: asNullableString(remote.normalized_name) ?? '',
    description: asNullableString(remote.description),
    instructions: asNullableString(remote.instructions),
    primary_muscle: asNullableString(remote.primary_muscle) ?? 'other',
    secondary_muscles: JSON.stringify(
      Array.isArray(remote.secondary_muscles)
        ? remote.secondary_muscles.filter((entry) => typeof entry === 'string')
        : [],
    ),
    equipment: asNullableString(remote.equipment) ?? 'other',
    movement_type: asNullableString(
      remote.movement_type,
    ) as ExerciseRow['movement_type'],
    load_type: (asNullableString(remote.load_type) ??
      'weighted') as ExerciseRow['load_type'],
    source: (asNullableString(remote.source) ?? 'system') as ExerciseRow['source'],
    created_at: toEpochMs(remote.created_at) ?? Date.now(),
    updated_at: toEpochMs(remote.updated_at) ?? Date.now(),
    server_updated_at: asNullableString(remote.updated_at),
    deleted_at: toEpochMs(remote.deleted_at),
  }),
});

/**
 * Workouts.
 *
 * `local_date` is pushed, not re-derived: it is the user's day, settled at
 * write time, and a receiving device in another timezone must not recompute it
 * into its own. The server validates the pair through the same resolver the
 * diary and water use, so a client that got it wrong is rejected rather than
 * accepted quietly.
 *
 * `started_at` is null while a session is only planned, which is exactly the
 * case the resolver was generalised for in migration 20260827000001.
 */
const workouts: TableDescriptor = describeTable<WorkoutRow>({
  table: 'workouts',
  remoteTable: 'workouts',
  userColumn: 'user_id',
  toRemote: (local) => ({
    id: local.id,
    user_id: local.user_id,
    name: local.name,
    local_date: local.local_date,
    time_zone: local.time_zone,
    started_at: local.started_at ? new Date(local.started_at).toISOString() : null,
    completed_at: local.completed_at ? new Date(local.completed_at).toISOString() : null,
    notes: local.notes,
    status: local.status,
    deleted_at: local.deleted_at ? new Date(local.deleted_at).toISOString() : null,
  }),
  fromRemote: (remote) => ({
    id: String(remote.id),
    user_id: String(remote.user_id),
    name: asNullableString(remote.name) ?? 'Workout',
    // Already a calendar day on the server; re-deriving it from the instant
    // here is exactly the mistake this column exists to prevent.
    local_date: asNullableString(remote.local_date) ?? '1970-01-01',
    time_zone: asNullableString(remote.time_zone) ?? 'UTC',
    started_at: toEpochMs(remote.started_at),
    completed_at: toEpochMs(remote.completed_at),
    notes: asNullableString(remote.notes),
    status: (asNullableString(remote.status) ?? 'completed') as WorkoutRow['status'],
    created_at: toEpochMs(remote.created_at) ?? Date.now(),
    updated_at: toEpochMs(remote.updated_at) ?? Date.now(),
    server_updated_at: asNullableString(remote.updated_at),
    deleted_at: toEpochMs(remote.deleted_at),
  }),
});

/**
 * The exercises inside a session.
 *
 * `exercise_name` and `load_type` travel as the snapshots they are. Nothing
 * re-reads the catalogue on either side, which is what makes a session from
 * March survive the exercise being renamed on another device.
 */
const workoutExercises: TableDescriptor = describeTable<WorkoutExerciseRow>({
  table: 'workout_exercises',
  remoteTable: 'workout_exercises',
  userColumn: 'user_id',
  toRemote: (local) => ({
    id: local.id,
    user_id: local.user_id,
    workout_id: local.workout_id,
    exercise_id: local.exercise_id,
    exercise_name: local.exercise_name,
    load_type: local.load_type,
    position: local.position,
    notes: local.notes,
    target_sets: local.target_sets,
    target_reps: local.target_reps,
    deleted_at: local.deleted_at ? new Date(local.deleted_at).toISOString() : null,
  }),
  fromRemote: (remote) => ({
    id: String(remote.id),
    user_id: String(remote.user_id),
    workout_id: String(remote.workout_id),
    exercise_id: asNullableString(remote.exercise_id),
    exercise_name: asNullableString(remote.exercise_name) ?? 'Exercise',
    load_type: (asNullableString(remote.load_type) ??
      'weighted') as WorkoutExerciseRow['load_type'],
    position: asNullableNumber(remote.position) ?? 0,
    notes: asNullableString(remote.notes),
    target_sets: asNullableNumber(remote.target_sets),
    target_reps: asNullableNumber(remote.target_reps),
    created_at: toEpochMs(remote.created_at) ?? Date.now(),
    updated_at: toEpochMs(remote.updated_at) ?? Date.now(),
    server_updated_at: asNullableString(remote.updated_at),
    deleted_at: toEpochMs(remote.deleted_at),
  }),
});

/**
 * Sets.
 *
 * Registered last: a set references a workout exercise, which references a
 * workout. `weight_kg` and `distance_m` are Postgres `numeric`, so they arrive
 * as strings and go through `asNumeric` — the same coercion the diary uses.
 *
 * Zero and null are preserved separately all the way across: zero is "no added
 * weight" on a pull-up, null is "weight is not how this is measured" on a
 * plank, and collapsing them would silently rewrite what the user recorded.
 */
const workoutSets: TableDescriptor = describeTable<WorkoutSetRow>({
  table: 'workout_sets',
  remoteTable: 'workout_sets',
  userColumn: 'user_id',
  toRemote: (local) => ({
    id: local.id,
    user_id: local.user_id,
    workout_exercise_id: local.workout_exercise_id,
    set_number: local.set_number,
    weight_kg: local.weight_kg,
    weight_unit: local.weight_unit,
    reps: local.reps,
    duration_seconds: local.duration_seconds,
    distance_m: local.distance_m,
    // SQLite stores booleans as 0/1; Postgres wants a real boolean.
    is_completed: local.is_completed === 1,
    notes: local.notes,
    deleted_at: local.deleted_at ? new Date(local.deleted_at).toISOString() : null,
  }),
  fromRemote: (remote) => ({
    id: String(remote.id),
    user_id: String(remote.user_id),
    workout_exercise_id: String(remote.workout_exercise_id),
    set_number: asNullableNumber(remote.set_number) ?? 1,
    weight_kg: asNumeric(remote.weight_kg),
    weight_unit: (asNullableString(remote.weight_unit) ??
      'kg') as WorkoutSetRow['weight_unit'],
    reps: asNullableNumber(remote.reps),
    duration_seconds: asNullableNumber(remote.duration_seconds),
    distance_m: asNumeric(remote.distance_m),
    is_completed: remote.is_completed === true ? 1 : 0,
    notes: asNullableString(remote.notes),
    created_at: toEpochMs(remote.created_at) ?? Date.now(),
    updated_at: toEpochMs(remote.updated_at) ?? Date.now(),
    server_updated_at: asNullableString(remote.updated_at),
    deleted_at: toEpochMs(remote.deleted_at),
  }),
});

/** A Postgres `text[]` from a locally stored JSON array. Never throws. */
function parseStringArray(encoded: string): string[] {
  try {
    const parsed: unknown = JSON.parse(encoded);
    return Array.isArray(parsed) ? parsed.filter((e) => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

export const SYNC_REGISTRY = [
  profiles,
  userSettings,
  foodRecents,
  foodLogs,
  nutritionGoals,
  weightEntries,
  waterLogs,
  waterGoals,
  exercises,
  workouts,
  workoutExercises,
  workoutSets,
] as const;
