-- ===========================================================================
-- Phase 5 — training
--
-- Four tables and one new idea.
--
-- The three that are not new ideas reuse mechanisms that already exist and
-- were expensive to get right: the exercise catalogue is the food catalogue's
-- shared/owned split (`owner_id is null` means everyone reads it and nobody
-- writes it), a workout's `local_date` is the diary's local-day rule through
-- the same trigger function, and every user-owned table keeps the same RLS
-- shape — USING and WITH CHECK on every write, no DELETE policy, soft deletes
-- only. None of that is re-implemented here.
--
-- The new idea is `load_type`. It is what decides whether a set means
-- "70 kg × 8", "× 12 with no external load", "held for 45 s" or "ran 5 km" —
-- and, critically, whether an estimated one-rep max is a meaningful number for
-- this exercise at all. Section H asks for 1RM "where appropriate"; this
-- column is what makes "appropriate" a property of the data rather than a
-- guess in the UI.
--
-- What is deliberately NOT here: any estimate of calories burned. See §9.
--
-- As everywhere else, RLS is enabled but NOT forced — see the note in
-- 20260819000002_rls_policies.sql.
-- ===========================================================================

-- =========================================================================
-- 1. Let the local-date rule serve a workout that has not started
-- =========================================================================

/*
 * `resolve_local_date`, with one explicit addition: a null instant.
 *
 * The rule is unchanged for every existing caller — food_logs and water_logs
 * both declare their instant NOT NULL, so the new branch is unreachable there
 * and the 63 food-log and 30 water assertions run against this version
 * untouched.
 *
 * It matters for workouts. A *planned* workout has a day but has not started,
 * so there is no instant to derive its day from; the day is authored and there
 * is nothing to validate it against yet. Previously that case fell through the
 * comparison by accident — `supplied <> null` is null, which is not true, so
 * the row passed. Relying on that would be relying on an accident. Once the
 * workout starts, `started_at` is set and the ordinary rule applies again: the
 * day must be the local day of the instant, in the zone stored beside it.
 */
create or replace function public.resolve_local_date()
returns trigger
language plpgsql
as $$
declare
  instant_col constant text := tg_argv[0];
  zone_col    constant text := tg_argv[1];
  date_col    constant text := tg_argv[2];

  incoming jsonb := to_jsonb(new);
  previous jsonb;

  instant  timestamptz;
  zone     text;
  supplied date;
  derived  date;
begin
  if tg_op = 'UPDATE' then
    previous := to_jsonb(old);
    if incoming -> instant_col is not distinct from previous -> instant_col
       and incoming -> zone_col is not distinct from previous -> zone_col
       and incoming -> date_col is not distinct from previous -> date_col then
      return new;
    end if;
  end if;

  instant  := (incoming ->> instant_col)::timestamptz;
  zone     := incoming ->> zone_col;
  supplied := (incoming ->> date_col)::date;

  /*
   * No instant yet. Nothing to derive from and nothing to check against, so
   * the authored day stands. A table that wants a day unconditionally declares
   * the column NOT NULL, and the insert fails on the column rather than here.
   */
  if instant is null then
    return new;
  end if;

  begin
    derived := (instant at time zone zone)::date;
  exception
    when invalid_parameter_value then
      raise exception 'Unknown time zone "%" on %.%', zone, tg_table_name, date_col
        using errcode = 'check_violation';
  end;

  if supplied is null then
    -- Only the one key is supplied, so every other column keeps its value.
    return jsonb_populate_record(new, jsonb_build_object(date_col, derived));
  end if;

  if supplied <> derived then
    raise exception
      '%.% is % but % in % is %; a local day is the local day of its instant',
      tg_table_name, date_col, supplied, instant_col, zone, derived
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.resolve_local_date() is
  'Derives and validates a local calendar day from an instant and an IANA zone. Trigger args: instant column, zone column, date column. A null instant leaves the authored day alone. Never a UTC truncation.';

-- =========================================================================
-- 2. exercises
-- =========================================================================

/*
 * How a set is measured, and therefore what it means.
 *
 *   weighted    Bench press, squat. External load and reps. The only kind
 *               where an estimated 1RM is a meaningful number.
 *   bodyweight  Push-ups, pull-ups. Reps, with optional *added* load. An
 *               estimated 1RM from the added load alone is nonsense — a set
 *               of 20 push-ups would compute a one-rep max of zero — and the
 *               real load includes a bodyweight this row does not know.
 *   duration    Plank, dead hang. Held for a time.
 *   distance    Running, rowing. A distance, usually with a time.
 *
 * Four values rather than a matrix of independent flags: these are the four
 * ways the set editor has to lay itself out, and a flag combination that no
 * editor renders is a state nothing can display.
 */
create type public.exercise_load_type as enum (
  'weighted',
  'bodyweight',
  'duration',
  'distance'
);

create type public.exercise_movement as enum ('compound', 'isolation');

/*
 * Muscle groups and equipment are text with a check rather than enums.
 *
 * Both are lists that grow — a new machine, a finer-grained split — and
 * growing an enum takes a migration that cannot run inside a transaction on
 * older Postgres. `load_type` is an enum because it is closed by construction:
 * adding a value there means adding a set editor, which is a migration anyway.
 */
create table public.exercises (
  id              uuid primary key default gen_random_uuid(),

  /*
   * Null = shared catalogue: readable by every signed-in user, writable by
   * nobody through the API. Imports run through the service role, which
   * bypasses RLS and only exists server-side. Set = a user's own exercise,
   * readable and writable only by them. Exactly the foods model.
   */
  owner_id        uuid references public.profiles(id) on delete cascade,

  name            text not null check (length(btrim(name)) between 1 and 120),
  -- Search key, produced by the same normaliser the food catalogue uses so
  -- one query shape serves both.
  normalized_name text not null check (length(normalized_name) between 1 and 120),

  description     text check (description is null or length(description) <= 1000),
  instructions    text check (instructions is null or length(instructions) <= 4000),

  primary_muscle  text not null check (primary_muscle in (
                    'chest', 'back', 'shoulders', 'biceps', 'triceps',
                    'forearms', 'quadriceps', 'hamstrings', 'glutes',
                    'calves', 'core', 'full_body', 'cardio', 'other'
                  )),
  /*
   * Secondary muscles are a set, not a ranking, so an array beats a join
   * table nobody will ever query on its own. Constrained to the same
   * vocabulary as the primary, and bounded so a client cannot post a
   * thousand-element array.
   */
  secondary_muscles text[] not null default '{}'
                    check (
                      array_length(secondary_muscles, 1) is null
                      or (
                        array_length(secondary_muscles, 1) <= 6
                        and secondary_muscles <@ array[
                          'chest', 'back', 'shoulders', 'biceps', 'triceps',
                          'forearms', 'quadriceps', 'hamstrings', 'glutes',
                          'calves', 'core', 'full_body', 'cardio', 'other'
                        ]::text[]
                      )
                    ),

  equipment       text not null check (equipment in (
                    'barbell', 'dumbbell', 'kettlebell', 'machine', 'cable',
                    'bodyweight', 'band', 'other'
                  )),

  movement_type   public.exercise_movement,
  load_type       public.exercise_load_type not null,

  source          text not null check (source in ('system', 'user')),

  created_at      timestamptz not null default clock_timestamp(),
  updated_at      timestamptz not null default clock_timestamp(),
  deleted_at      timestamptz,

  /*
   * A user's exercise is always attributed to the user, and a shared
   * catalogue row is always attributed to the system. Without this a client
   * could post an exercise labelled as curated content.
   */
  constraint exercise_source_matches_owner
    check ((owner_id is null) = (source = 'system'))
);

comment on table public.exercises is
  'Exercise catalogue. owner_id null = shared and read-only through the API; owner_id set = that user''s own exercise.';
comment on column public.exercises.load_type is
  'How a set is measured. Decides the set editor layout and whether an estimated 1RM is meaningful at all.';

-- Shared names are unique; a user may name their own exercise whatever they
-- like without colliding with the catalogue or with another user.
create unique index exercises_shared_name_key
  on public.exercises (normalized_name)
  where owner_id is null and deleted_at is null;

create unique index exercises_owner_name_key
  on public.exercises (owner_id, normalized_name)
  where owner_id is not null and deleted_at is null;

-- Browsing: by muscle, then by name.
create index exercises_browse_idx
  on public.exercises (primary_muscle, normalized_name)
  where deleted_at is null;

-- Sync cursor. Unfiltered: deletions have to travel too.
create index exercises_owner_sync_idx on public.exercises (owner_id, updated_at);

create trigger exercises_set_updated_at
  before insert or update on public.exercises
  for each row execute function public.set_updated_at();

-- =========================================================================
-- 3. workouts
-- =========================================================================

create type public.workout_status as enum (
  'planned',
  'in_progress',
  'completed',
  'abandoned'
);

create table public.workouts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,

  name         text not null check (length(btrim(name)) between 1 and 120),

  /*
   * The day this workout belongs to, in the user's zone.
   *
   * Authored while planned; once `started_at` is set, the trigger requires it
   * to equal the local day of that instant. A session beginning at 23:30 on
   * Monday is a Monday session even when it finishes on Tuesday, and flying
   * somewhere else afterwards does not re-date it.
   */
  local_date   date not null,
  time_zone    text not null check (length(time_zone) between 1 and 64),

  started_at   timestamptz,
  completed_at timestamptz,

  notes        text check (notes is null or length(notes) <= 2000),
  status       public.workout_status not null default 'in_progress',

  created_at   timestamptz not null default clock_timestamp(),
  updated_at   timestamptz not null default clock_timestamp(),
  deleted_at   timestamptz,

  /*
   * Timestamps that describe a real session.
   *
   * A workout cannot finish before it starts, and cannot finish without
   * having started. The 24-hour ceiling is a clock-skew and stuck-session
   * guard rather than an opinion about training: a session still open a day
   * later was abandoned and never marked.
   */
  constraint workout_finishes_after_starting
    check (completed_at is null or (started_at is not null and completed_at >= started_at)),
  constraint workout_duration_is_plausible
    check (
      completed_at is null
      or completed_at <= started_at + interval '24 hours'
    ),

  -- The states have to agree with the timestamps, or history shows sessions
  -- that were never performed and completed sessions with no end.
  constraint workout_status_matches_timestamps
    check (
      case status
        when 'planned'     then started_at is null and completed_at is null
        when 'in_progress' then started_at is not null and completed_at is null
        when 'completed'   then started_at is not null and completed_at is not null
        when 'abandoned'   then started_at is not null
      end
    ),

  /*
   * Referenced by workout_exercises as a composite foreign key, which is what
   * makes "this exercise belongs to another user's workout" impossible to
   * express rather than merely denied by a policy.
   */
  constraint workouts_id_user_key unique (id, user_id)
);

comment on column public.workouts.local_date is
  'The user''s calendar day for this session. Never a UTC truncation.';

-- History: one user, most recent first.
create index workouts_history_idx
  on public.workouts (user_id, local_date desc, started_at desc)
  where deleted_at is null;

-- "Do I have a session open?" — asked on every visit to the Train tab.
create index workouts_active_idx
  on public.workouts (user_id, status)
  where deleted_at is null and status = 'in_progress';

create index workouts_sync_idx on public.workouts (user_id, updated_at);

create trigger workouts_resolve_day
  before insert or update on public.workouts
  for each row
  execute function public.resolve_local_date('started_at', 'time_zone', 'local_date');

create trigger workouts_set_updated_at
  before insert or update on public.workouts
  for each row execute function public.set_updated_at();

-- =========================================================================
-- 4. workout_exercises
-- =========================================================================

/*
 * An exercise as it appeared in one session.
 *
 * `exercise_id` is provenance and nothing more — it is nullable, and it drops
 * to null if the catalogue row is ever hard-removed. `exercise_name` and
 * `load_type` are *snapshots*, taken when the exercise was added, and they are
 * what history renders from. This is the same invariant the food diary uses,
 * and for the same reason: renaming "Bench Press" to "Barbell Bench Press"
 * must not rewrite what a session in March says was performed, and correcting
 * a custom exercise must not retitle every past workout containing it.
 */
create table public.workout_exercises (
  id            uuid primary key default gen_random_uuid(),

  /*
   * Denormalised from the workout. Two jobs: it scopes the sync pull without
   * a join, and it carries the composite foreign key below.
   */
  user_id       uuid not null,
  workout_id    uuid not null,

  exercise_id   uuid references public.exercises(id) on delete set null,

  -- The snapshot. Not read back from the catalogue, ever.
  exercise_name text not null check (length(btrim(exercise_name)) between 1 and 120),
  load_type     public.exercise_load_type not null,

  /*
   * Ordering within the session. Deferrable so a reorder can renumber several
   * rows inside one transaction without tripping over itself halfway through —
   * the same reason the goal-period exclusion constraint is deferrable.
   */
  position      integer not null check (position >= 0 and position < 1000),

  notes         text check (notes is null or length(notes) <= 1000),

  -- What the user intended, when they planned it. Never confused with what
  -- was performed, which is the sets.
  target_sets   integer check (target_sets is null or (target_sets between 1 and 50)),
  target_reps   integer check (target_reps is null or (target_reps between 1 and 1000)),

  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp(),
  deleted_at    timestamptz,

  /*
   * The containment guarantee, declarative.
   *
   * A composite reference to (workout.id, workout.user_id) means a row whose
   * user_id does not match its workout's owner cannot be written at all — not
   * by a client with a forged payload, not by a bug in this codebase, and not
   * by the service role. A policy alone would only stop the first of those.
   */
  constraint workout_exercises_belong_to_own_workout
    foreign key (workout_id, user_id)
    references public.workouts (id, user_id)
    on delete cascade,

  constraint workout_exercises_position_key
    unique (workout_id, position) deferrable initially immediate,

  -- Referenced in turn by workout_sets, for the same containment reason.
  constraint workout_exercises_id_user_key unique (id, user_id)
);

comment on column public.workout_exercises.exercise_name is
  'Snapshot taken when the exercise was added. History renders from this, never from the catalogue.';

create index workout_exercises_workout_idx
  on public.workout_exercises (workout_id, position)
  where deleted_at is null;

create index workout_exercises_history_idx
  on public.workout_exercises (user_id, exercise_id)
  where deleted_at is null;

create index workout_exercises_sync_idx
  on public.workout_exercises (user_id, updated_at);

create trigger workout_exercises_set_updated_at
  before insert or update on public.workout_exercises
  for each row execute function public.set_updated_at();

-- =========================================================================
-- 5. workout_sets
-- =========================================================================

/*
 * One set.
 *
 * `weight_kg` is canonical and always kilograms. `weight_unit` records what
 * the user was typing in so the same number reads back as 155 lb rather than
 * 70.31 kg — it is a display preference travelling with the row, never the
 * value itself. A display string is not storable here at all, which is the
 * point: a unit mistake is a rendering bug that can be fixed later, whereas a
 * stored "155 lb" string is a data loss that cannot.
 */
create table public.workout_sets (
  id                  uuid primary key default gen_random_uuid(),

  user_id             uuid not null,
  workout_exercise_id uuid not null,

  set_number          integer not null check (set_number between 1 and 100),

  /*
   * External load only, and never negative.
   *
   * Zero is meaningful and different from null: zero is "no added weight" on a
   * set of pull-ups, null is "weight is not how this exercise is measured" on
   * a plank. The 1000 kg ceiling is a slipped-decimal guard.
   */
  weight_kg           numeric(7, 3) check (weight_kg is null or (weight_kg >= 0 and weight_kg <= 1000)),
  weight_unit         text not null default 'kg' check (weight_unit in ('kg', 'lb')),

  reps                integer check (reps is null or (reps >= 0 and reps <= 1000)),
  duration_seconds    integer check (duration_seconds is null or (duration_seconds > 0 and duration_seconds <= 86400)),
  distance_m          numeric(9, 2) check (distance_m is null or (distance_m > 0 and distance_m <= 1000000)),

  is_completed        boolean not null default false,
  notes               text check (notes is null or length(notes) <= 500),

  created_at          timestamptz not null default clock_timestamp(),
  updated_at          timestamptz not null default clock_timestamp(),
  deleted_at          timestamptz,

  /*
   * A set has to measure something.
   *
   * Without this, "Set 3" can exist with every field null — a row that renders
   * as an empty line, counts towards nothing, and is indistinguishable from a
   * bug. A planned-but-unperformed set is `is_completed = false` with its
   * intended numbers, not a row with no numbers.
   */
  constraint set_measures_something
    check (reps is not null or duration_seconds is not null or distance_m is not null),

  constraint workout_sets_belong_to_own_exercise
    foreign key (workout_exercise_id, user_id)
    references public.workout_exercises (id, user_id)
    on delete cascade,

  /*
   * One "Set 2" per exercise. Deferrable so inserting a set in the middle can
   * renumber the ones after it inside a single transaction.
   */
  constraint workout_sets_number_key
    unique (workout_exercise_id, set_number) deferrable initially immediate
);

comment on column public.workout_sets.weight_kg is
  'Canonical external load in kilograms. Zero means no added weight; null means weight is not how this exercise is measured.';
comment on column public.workout_sets.weight_unit is
  'What the user typed in. A display preference only — weight_kg is the value.';

create index workout_sets_exercise_idx
  on public.workout_sets (workout_exercise_id, set_number)
  where deleted_at is null;

create index workout_sets_sync_idx
  on public.workout_sets (user_id, updated_at);

create trigger workout_sets_set_updated_at
  before insert or update on public.workout_sets
  for each row execute function public.set_updated_at();

-- =========================================================================
-- 6. Previous performance
-- =========================================================================

/*
 * The last session in which this user performed this exercise.
 *
 * Matched on the *catalogue id*, not the name: renaming an exercise must not
 * sever a user from their own history. A custom exercise deleted from the
 * catalogue leaves `exercise_id` null on future rows, and the function
 * returns nothing rather than matching every other null — which is why the
 * null case is excluded explicitly.
 *
 * Mirrored by the client's local query. This exists for other clients and for
 * a fresh install; the app itself answers it from SQLite so set entry never
 * waits for the network.
 */
create or replace function public.previous_exercise_performance(
  p_user     uuid,
  p_exercise uuid,
  p_before   uuid default null
)
returns table (
  workout_exercise_id uuid,
  local_date          date,
  set_number          integer,
  weight_kg           numeric,
  reps                integer,
  duration_seconds    integer,
  distance_m          numeric
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with last_session as (
    select we.id, w.local_date
      from public.workout_exercises we
      join public.workouts w on w.id = we.workout_id
     where we.user_id = p_user
       and we.exercise_id = p_exercise
       and p_exercise is not null
       and we.deleted_at is null
       and w.deleted_at is null
       and (p_before is null or we.workout_id <> p_before)
       and exists (
         select 1 from public.workout_sets s
          where s.workout_exercise_id = we.id
            and s.deleted_at is null
            and s.is_completed
       )
     order by w.local_date desc, w.started_at desc nulls last, we.created_at desc
     limit 1
  )
  select ls.id, ls.local_date, s.set_number, s.weight_kg, s.reps,
         s.duration_seconds, s.distance_m
    from last_session ls
    join public.workout_sets s on s.workout_exercise_id = ls.id
   where s.deleted_at is null and s.is_completed
   order by s.set_number;
$$;

grant execute on function public.previous_exercise_performance(uuid, uuid, uuid) to authenticated;
revoke execute on function public.previous_exercise_performance(uuid, uuid, uuid) from anon, public;

-- =========================================================================
-- 7. RLS
-- =========================================================================

alter table public.exercises          enable row level security;
alter table public.workouts           enable row level security;
alter table public.workout_exercises  enable row level security;
alter table public.workout_sets       enable row level security;

-- ------------------------------------------------------------ exercises --

/*
 * Shared rows are readable by everyone signed in; owned rows only by their
 * owner. A user's custom exercise is invisible to every other user — there is
 * no "public custom exercise" and no sharing mechanism, deliberately.
 */
create policy "Read shared and own exercises"
  on public.exercises for select
  to authenticated
  using (owner_id is null or owner_id = auth.uid());

/*
 * WITH CHECK carries two guarantees: a user cannot create an exercise owned by
 * someone else, and cannot create a shared one at all — `owner_id = auth.uid()`
 * is never null, so the catalogue is unreachable from a client. Imports run
 * through the service role.
 */
create policy "Create own exercises"
  on public.exercises for insert
  to authenticated
  with check (owner_id = auth.uid() and source = 'user');

create policy "Update own exercises"
  on public.exercises for update
  to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid() and source = 'user');

-- ------------------------------------------------------------- workouts --

create policy "Read own workouts"
  on public.workouts for select
  to authenticated
  using (user_id = auth.uid());

create policy "Create own workouts"
  on public.workouts for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Update own workouts"
  on public.workouts for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------- workout_exercises --

/*
 * Scoped on the row's own `user_id` rather than through a join to the workout.
 *
 * The composite foreign key already guarantees the two agree, so a join would
 * be a second check of something the schema makes unrepresentable — and it
 * would put a subquery in the hot path of every set read.
 */
create policy "Read own workout exercises"
  on public.workout_exercises for select
  to authenticated
  using (user_id = auth.uid());

create policy "Create own workout exercises"
  on public.workout_exercises for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Update own workout exercises"
  on public.workout_exercises for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- --------------------------------------------------------- workout_sets --

create policy "Read own sets"
  on public.workout_sets for select
  to authenticated
  using (user_id = auth.uid());

create policy "Create own sets"
  on public.workout_sets for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Update own sets"
  on public.workout_sets for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

/*
 * No DELETE policy or grant on any of the four, matching every other
 * user-owned table: removing something is a soft delete, because a hard
 * delete cannot be synchronised — the other device would have nothing to
 * learn from and would push the row straight back.
 */
grant select, insert, update on public.exercises         to authenticated;
grant select, insert, update on public.workouts          to authenticated;
grant select, insert, update on public.workout_exercises to authenticated;
grant select, insert, update on public.workout_sets      to authenticated;

revoke all on public.exercises         from anon;
revoke all on public.workouts          from anon;
revoke all on public.workout_exercises from anon;
revoke all on public.workout_sets      from anon;

-- =========================================================================
-- 8. A starter catalogue
-- =========================================================================

/*
 * Enough shared exercises that the feature is usable on first run without an
 * import pipeline, covering every load type so each set editor layout has
 * something real behind it. Inserted with owner_id null, which no client can
 * write — this statement runs as the migration role.
 */
/*
 * Enough shared exercises that the feature is usable on first run without an
 * import pipeline, covering every load type so each set editor layout has
 * something real behind it. Inserted with owner_id null, which no client can
 * write — this statement runs as the migration role.
 *
 * ── The ids are fixed, and that matters ───────────────────────────────────
 *
 * The same list is seeded into SQLite by local migration v7, from
 * `src/lib/exerciseCatalogue.ts`. Both sides must produce the same rows with
 * the same primary keys: a session recorded on a fresh device references a
 * catalogue exercise by id, and if the device had invented its own the push
 * would be rejected by `workout_exercises_exercise_id_fkey`. `id` is therefore
 * written out rather than defaulted, and a drift test compares the two lists
 * field by field.
 */
insert into public.exercises
  (id, owner_id, name, normalized_name, primary_muscle, secondary_muscles,
   equipment, movement_type, load_type, source, description)
values
  ('e5e00000-0000-4000-8000-000000000001', null, 'Barbell Bench Press', 'barbell bench press', 'chest',
   array['triceps', 'shoulders']::text[], 'barbell',
   'compound', 'weighted', 'system',
   'Flat barbell press from the chest.'),
  ('e5e00000-0000-4000-8000-000000000002', null, 'Barbell Back Squat', 'barbell back squat', 'quadriceps',
   array['glutes', 'hamstrings', 'core']::text[], 'barbell',
   'compound', 'weighted', 'system',
   'Squat with the bar racked on the upper back.'),
  ('e5e00000-0000-4000-8000-000000000003', null, 'Conventional Deadlift', 'conventional deadlift', 'back',
   array['hamstrings', 'glutes', 'forearms']::text[], 'barbell',
   'compound', 'weighted', 'system',
   'Lift from the floor to a standing position.'),
  ('e5e00000-0000-4000-8000-000000000004', null, 'Overhead Press', 'overhead press', 'shoulders',
   array['triceps', 'core']::text[], 'barbell',
   'compound', 'weighted', 'system',
   'Standing press from the shoulders to overhead.'),
  ('e5e00000-0000-4000-8000-000000000005', null, 'Barbell Row', 'barbell row', 'back',
   array['biceps', 'forearms']::text[], 'barbell',
   'compound', 'weighted', 'system',
   'Bent-over row to the lower ribs.'),
  ('e5e00000-0000-4000-8000-000000000006', null, 'Dumbbell Curl', 'dumbbell curl', 'biceps',
   array['forearms']::text[], 'dumbbell',
   'isolation', 'weighted', 'system',
   'Curl one dumbbell in each hand.'),
  ('e5e00000-0000-4000-8000-000000000007', null, 'Lat Pulldown', 'lat pulldown', 'back',
   array['biceps']::text[], 'cable',
   'compound', 'weighted', 'system',
   'Pull the bar to the upper chest.'),
  ('e5e00000-0000-4000-8000-000000000008', null, 'Leg Press', 'leg press', 'quadriceps',
   array['glutes']::text[], 'machine',
   'compound', 'weighted', 'system',
   'Press the platform away on a leg press machine.'),
  ('e5e00000-0000-4000-8000-000000000009', null, 'Romanian Deadlift', 'romanian deadlift', 'hamstrings',
   array['glutes', 'back']::text[], 'barbell',
   'compound', 'weighted', 'system',
   'Hinge at the hips with a near-straight leg.'),
  ('e5e00000-0000-4000-8000-000000000010', null, 'Pull-up', 'pull up', 'back',
   array['biceps', 'forearms']::text[], 'bodyweight',
   'compound', 'bodyweight', 'system',
   'Pull to the bar from a dead hang. Add weight with a belt if you like.'),
  ('e5e00000-0000-4000-8000-000000000011', null, 'Push-up', 'push up', 'chest',
   array['triceps', 'shoulders', 'core']::text[], 'bodyweight',
   'compound', 'bodyweight', 'system',
   'Press from the floor with a braced trunk.'),
  ('e5e00000-0000-4000-8000-000000000012', null, 'Dip', 'dip', 'triceps',
   array['chest', 'shoulders']::text[], 'bodyweight',
   'compound', 'bodyweight', 'system',
   'Lower and press between parallel bars.'),
  ('e5e00000-0000-4000-8000-000000000013', null, 'Plank', 'plank', 'core',
   array['shoulders']::text[], 'bodyweight',
   'isolation', 'duration', 'system',
   'Hold a straight line on the forearms.'),
  ('e5e00000-0000-4000-8000-000000000014', null, 'Dead Hang', 'dead hang', 'forearms',
   array['back']::text[], 'bodyweight',
   'isolation', 'duration', 'system',
   'Hang from the bar with straight arms.'),
  ('e5e00000-0000-4000-8000-000000000015', null, 'Running', 'running', 'cardio',
   array['quadriceps', 'calves']::text[], 'other',
   null, 'distance', 'system',
   'Distance run. Record the distance and how long it took.'),
  ('e5e00000-0000-4000-8000-000000000016', null, 'Rowing Machine', 'rowing machine', 'cardio',
   array['back', 'quadriceps']::text[], 'machine',
   null, 'distance', 'system',
   'Distance on an indoor rower.')
on conflict (id) do nothing;

-- =========================================================================
-- 9. Calories burned: deliberately absent
-- =========================================================================

/*
 * There is no exercise-calorie column anywhere in this migration, and that is
 * a decision rather than an omission.
 *
 * An honest estimate of the energy cost of resistance training needs a MET
 * value for the movement, the user's bodyweight, and the working time — and
 * even then the published MET tables for weight training are coarse enough
 * that the answer is a range, not a number. This schema records none of the
 * three reliably: `load_type` is not a MET class, bodyweight is a separate
 * time series that may be weeks stale, and the gap between `started_at` and
 * `completed_at` includes changing, chatting and resting.
 *
 * Producing a figure anyway would put a fabricated number next to real
 * measured food data and let it be eaten back, which is worse than showing
 * nothing.
 *
 * `user_settings.exercise_adds_calories` has existed since Phase 0 and remains
 * false with no consumer. It is the switch a defensible model would attach to
 * — nothing reads it today, so recording a workout cannot change a calorie
 * goal or a diary total. `supabase/tests/training.test.sql` asserts that.
 */
