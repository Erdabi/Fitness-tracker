-- ===========================================================================
-- Training: exercises, workouts, workout exercises and sets
--
-- Four tables, and three kinds of thing that can go wrong with them.
--
-- The first is the ordinary cross-user matrix, which every user-owned table in
-- this schema gets. The second is *containment*: a workout exercise belonging
-- to somebody else's workout, or a set belonging to somebody else's exercise.
-- Those are not prevented by a policy here — they are prevented by composite
-- foreign keys, which means they stay prevented for the service role too, and
-- these assertions check that rather than checking the policy twice.
--
-- The third is historical integrity. A workout performed in March has to keep
-- saying what was performed in March after the exercise is renamed, edited,
-- and soft-deleted. That is the same snapshot invariant the food diary has,
-- and it is worth just as many assertions.
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

create or replace function assert(condition boolean, description text)
returns void language plpgsql as $$
begin
  if condition then
    raise notice '  PASS  %', description;
  else
    raise exception 'FAIL  %', description;
  end if;
end $$;

create or replace function denied(claim_user uuid, statement text)
returns boolean language plpgsql as $$
declare affected int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', claim_user)::text, true);
  execute statement;
  get diagnostics affected = row_count;
  reset role;
  return affected = 0;
exception when others then
  reset role;
  return true;
end $$;

create or replace function raises(statement text)
returns boolean language plpgsql as $$
begin
  execute statement;
  return false;
exception when others then
  return true;
end $$;

create or replace function visible_rows(claim_user uuid, query text)
returns int language plpgsql as $$
declare total int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', claim_user)::text, true);
  execute 'select count(*) from (' || query || ') q' into total;
  reset role;
  return total;
end $$;

/* Starts a session. Mirrors the client: an instant and a zone, never a date. */
create or replace function start_workout(
  p_user uuid, p_name text, p_at timestamptz, p_zone text, p_date date default null)
returns uuid language plpgsql as $$
declare result uuid;
begin
  insert into public.workouts (user_id, name, started_at, time_zone, local_date, status)
  values (p_user, p_name, p_at, p_zone, p_date, 'in_progress')
  returning id into result;
  return result;
end $$;

create or replace function add_exercise(
  p_workout uuid, p_user uuid, p_exercise uuid, p_name text,
  p_position int, p_load public.exercise_load_type default 'weighted')
returns uuid language plpgsql as $$
declare result uuid;
begin
  insert into public.workout_exercises
    (workout_id, user_id, exercise_id, exercise_name, load_type, position)
  values (p_workout, p_user, p_exercise, p_name, p_load, p_position)
  returning id into result;
  return result;
end $$;

create or replace function add_set(
  p_we uuid, p_user uuid, p_number int, p_kg numeric, p_reps int,
  p_done boolean default true)
returns uuid language plpgsql as $$
declare result uuid;
begin
  insert into public.workout_sets
    (workout_exercise_id, user_id, set_number, weight_kg, reps, is_completed)
  values (p_we, p_user, p_number, p_kg, p_reps, p_done)
  returning id into result;
  return result;
end $$;

-- ---------------------------------------------------------------- fixtures

do $$
declare alice uuid; bob uuid;
begin
  insert into auth.users (email) values ('alice@example.com') returning id into alice;
  insert into auth.users (email) values ('bob@example.com')   returning id into bob;
  create temp table actors (name text primary key, id uuid);
  insert into actors values ('alice', alice), ('bob', bob);
end $$;

-- =========================================================================
-- 1. The shared catalogue
-- =========================================================================

\echo ''
\echo '=== the shared catalogue is readable by all and writable by none ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  bob   uuid := (select id from actors where name = 'bob');
  bench uuid := (select id from public.exercises where normalized_name = 'barbell bench press');
begin
  perform assert(
    (select count(*) from public.exercises where owner_id is null) >= 16,
    'the migration seeded a starter catalogue');

  perform assert(
    visible_rows(alice, 'select 1 from public.exercises where owner_id is null') >= 16
    and visible_rows(bob, 'select 1 from public.exercises where owner_id is null') >= 16,
    'both users can read all of it');

  perform assert(
    denied(alice, format(
      'update public.exercises set name = ''Alice''''s Bench'' where id = %L', bench)),
    'alice cannot rename a shared exercise for everyone');

  perform assert(
    raises(format($q$
      set local role authenticated;
      select set_config('request.jwt.claims', json_build_object('sub', %L)::text, true);
      insert into public.exercises
        (owner_id, name, normalized_name, primary_muscle, equipment, load_type, source)
      values (null, 'Forged', 'forged', 'chest', 'barbell', 'weighted', 'system');
    $q$, alice)),
    'and cannot add one to the shared catalogue at all');

  reset role;

  perform assert(
    (select count(*) from public.exercises
      where owner_id is null and load_type = 'bodyweight') >= 3
    and (select count(*) from public.exercises
      where owner_id is null and load_type = 'duration') >= 2
    and (select count(*) from public.exercises
      where owner_id is null and load_type = 'distance') >= 2,
    'every load type has real exercises behind it, so every set editor does too');
end $$;

\echo ''
\echo '=== a custom exercise belongs to exactly one user ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  bob   uuid := (select id from actors where name = 'bob');
  custom uuid;
begin
  insert into public.exercises
    (owner_id, name, normalized_name, primary_muscle, equipment, load_type, source)
  values (alice, 'Zercher Squat', 'zercher squat', 'quadriceps', 'barbell', 'weighted', 'user')
  returning id into custom;

  perform assert(
    visible_rows(alice, format('select 1 from public.exercises where id = %L', custom)) = 1,
    'alice sees her own exercise');

  perform assert(
    visible_rows(bob, format('select 1 from public.exercises where id = %L', custom)) = 0,
    'bob cannot see it even knowing its id');

  perform assert(
    denied(bob, format('update public.exercises set name = ''Stolen'' where id = %L', custom)),
    'bob cannot edit it');

  perform assert(
    raises(format($q$
      set local role authenticated;
      select set_config('request.jwt.claims', json_build_object('sub', %L)::text, true);
      insert into public.exercises
        (owner_id, name, normalized_name, primary_muscle, equipment, load_type, source)
      values (%L, 'Planted', 'planted', 'chest', 'barbell', 'weighted', 'user');
    $q$, bob, alice)),
    'bob cannot create an exercise owned by alice');

  reset role;

  perform assert(
    denied(alice, format(
      'update public.exercises set owner_id = %L where id = %L', bob, custom)),
    'alice cannot hand her exercise to bob (WITH CHECK holds)');

  perform assert(
    (select owner_id from public.exercises where id = custom) = alice,
    'after all of that it is still hers');

  perform assert(
    raises(format($q$
      insert into public.exercises
        (owner_id, name, normalized_name, primary_muscle, equipment, load_type, source)
      values (%L, 'Mislabelled', 'mislabelled', 'chest', 'barbell', 'weighted', 'system');
    $q$, alice)),
    'an owned exercise cannot be attributed to the system');

  perform assert(
    raises($q$
      insert into public.exercises
        (owner_id, name, normalized_name, primary_muscle, equipment, load_type, source)
      values (null, 'Mislabelled2', 'mislabelled2', 'chest', 'barbell', 'weighted', 'user');
    $q$),
    'nor a shared one to a user');
end $$;

-- =========================================================================
-- 2. The local day
-- =========================================================================

\echo ''
\echo '=== a session belongs to the user local day, through the shared resolver ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  w uuid;
begin
  -- UTC+12: the local day is ahead of the UTC day.
  w := start_workout(alice, 'Evening', timestamptz '2026-06-14 11:30:00+00', 'Pacific/Auckland');
  perform assert(
    (select local_date from public.workouts where id = w) = date '2026-06-14',
    'UTC+12: 23:30 local on the 14th is that day, not the 15th');

  -- UTC-10: behind. The opposite direction.
  w := start_workout(alice, 'Late', timestamptz '2026-06-15 08:00:00+00', 'Pacific/Honolulu');
  perform assert(
    (select local_date from public.workouts where id = w) = date '2026-06-14',
    'UTC-10: 22:00 local on the 14th is not the 15th');

  perform assert(
    raises(format($q$
      insert into public.workouts (user_id, name, started_at, time_zone, local_date, status)
      values (%L, 'Wrong day', timestamptz '2026-06-15 21:30:00+02',
              'Europe/Zurich', date '2026-06-16', 'in_progress');
    $q$, alice)),
    'a supplied day that disagrees with its instant is refused');

  perform assert(
    raises(format($q$
      insert into public.workouts (user_id, name, started_at, time_zone, local_date, status)
      values (%L, 'Nowhere', now(), 'Mars/Olympus', null, 'in_progress');
    $q$, alice)),
    'and an unknown time zone is refused rather than silently defaulted');
end $$;

\echo ''
\echo '=== a planned session has a day but no instant yet ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  w uuid;
begin
  insert into public.workouts (user_id, name, time_zone, local_date, status)
  values (alice, 'Next Tuesday', 'Europe/Zurich', date '2026-06-23', 'planned')
  returning id into w;

  perform assert(
    (select local_date from public.workouts where id = w) = date '2026-06-23'
    and (select started_at from public.workouts where id = w) is null,
    'a planned session keeps the day it was planned for');

  -- Starting it re-imposes the ordinary rule.
  update public.workouts
     set started_at = timestamptz '2026-06-23 17:00:00+02', status = 'in_progress'
   where id = w;

  perform assert(
    (select local_date from public.workouts where id = w) = date '2026-06-23',
    'and starting it on that day is consistent');

  perform assert(
    raises(format($q$
      update public.workouts
         set started_at = timestamptz '2026-06-25 17:00:00+02'
       where id = %L;
    $q$, w)),
    'but starting it on a different day than it claims is refused');
end $$;

\echo ''
\echo '=== the status and the timestamps have to agree ==='

do $$
declare alice uuid := (select id from actors where name = 'alice');
begin
  perform assert(
    raises(format($q$
      insert into public.workouts (user_id, name, time_zone, local_date, status, started_at)
      values (%L, 'Impossible', 'Europe/Zurich', date '2026-06-01', 'planned', now());
    $q$, alice)),
    'a planned session cannot already have started');

  perform assert(
    raises(format($q$
      insert into public.workouts
        (user_id, name, time_zone, local_date, status, started_at, completed_at)
      values (%L, 'Impossible', 'Europe/Zurich', date '2026-06-01', 'completed',
              timestamptz '2026-06-01 18:00:00+02', timestamptz '2026-06-01 17:00:00+02');
    $q$, alice)),
    'a session cannot finish before it starts');

  perform assert(
    raises(format($q$
      insert into public.workouts (user_id, name, time_zone, local_date, status)
      values (%L, 'Impossible', 'Europe/Zurich', date '2026-06-01', 'completed');
    $q$, alice)),
    'nor be complete without ever having started');

  perform assert(
    raises(format($q$
      insert into public.workouts
        (user_id, name, time_zone, local_date, status, started_at, completed_at)
      values (%L, 'Stuck', 'Europe/Zurich', date '2026-06-01', 'completed',
              timestamptz '2026-06-01 18:00:00+02', timestamptz '2026-06-04 18:00:00+02');
    $q$, alice)),
    'a three-day session is a stuck timer, not a workout');
end $$;

-- =========================================================================
-- 3. Containment
-- =========================================================================

\echo ''
\echo '=== a workout exercise cannot belong to another user workout ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  bob   uuid := (select id from actors where name = 'bob');
  bench uuid := (select id from public.exercises where normalized_name = 'barbell bench press');
  aw    uuid;
begin
  aw := start_workout(alice, 'Push', timestamptz '2026-06-15 16:00:00+02', 'Europe/Zurich');

  /*
   * Not a policy check. The composite foreign key makes this unrepresentable,
   * so it fails here as the migration role — which bypasses RLS entirely.
   * A policy alone would leave the service role able to write it.
   */
  perform assert(
    raises(format($q$
      insert into public.workout_exercises
        (workout_id, user_id, exercise_id, exercise_name, load_type, position)
      values (%L, %L, %L, 'Bench Press', 'weighted', 0);
    $q$, aw, bob, bench)),
    'bob cannot be recorded as the owner of a row in alice''s workout');

  perform assert(
    raises(format($q$
      insert into public.workout_sets
        (workout_exercise_id, user_id, set_number, weight_kg, reps)
      values (%L, %L, 1, 60, 10);
    $q$, gen_random_uuid(), alice)),
    'and a set cannot reference an exercise that does not exist');
end $$;

\echo ''
\echo '=== a set cannot belong to another user exercise ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  bob   uuid := (select id from actors where name = 'bob');
  bench uuid := (select id from public.exercises where normalized_name = 'barbell bench press');
  aw uuid; awe uuid;
begin
  aw  := start_workout(alice, 'Push 2', timestamptz '2026-06-16 16:00:00+02', 'Europe/Zurich');
  awe := add_exercise(aw, alice, bench, 'Barbell Bench Press', 0);

  perform assert(
    raises(format($q$
      insert into public.workout_sets
        (workout_exercise_id, user_id, set_number, weight_kg, reps)
      values (%L, %L, 1, 60, 10);
    $q$, awe, bob)),
    'bob cannot own a set inside alice''s exercise');

  perform assert(
    denied(bob, format(
      'update public.workout_sets set reps = 1 where workout_exercise_id = %L', awe)),
    'and cannot edit her sets through a policy either');
end $$;

-- =========================================================================
-- 4. Set integrity
-- =========================================================================

\echo ''
\echo '=== the database refuses a set that could not have happened ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  bench uuid := (select id from public.exercises where normalized_name = 'barbell bench press');
  w uuid; we uuid;
begin
  w  := start_workout(alice, 'Integrity', timestamptz '2026-06-17 16:00:00+02', 'Europe/Zurich');
  we := add_exercise(w, alice, bench, 'Barbell Bench Press', 0);

  perform assert(
    raises(format('select add_set(%L, %L, 1, 60, -1)', we, alice)),
    'negative reps are refused');

  perform assert(
    raises(format('select add_set(%L, %L, 1, -60, 10)', we, alice)),
    'a negative weight is refused');

  perform assert(
    raises(format('select add_set(%L, %L, 0, 60, 10)', we, alice)),
    'set zero is refused');

  perform assert(
    raises(format('select add_set(%L, %L, 1, 5000, 10)', we, alice)),
    'a five-tonne bench press is a slipped decimal, not a lift');

  perform assert(
    raises(format($q$
      insert into public.workout_sets (workout_exercise_id, user_id, set_number)
      values (%L, %L, 1);
    $q$, we, alice)),
    'a set that measures nothing at all is refused');

  perform assert(
    raises(format($q$
      insert into public.workout_sets
        (workout_exercise_id, user_id, set_number, weight_kg, reps, weight_unit)
      values (%L, %L, 1, 60, 10, 'stone');
    $q$, we, alice)),
    'an unknown display unit is refused');

  -- The ones that must be allowed.
  perform add_set(we, alice, 1, 60, 10);
  perform assert(
    (select weight_kg from public.workout_sets
      where workout_exercise_id = we and set_number = 1) = 60,
    'a real set is stored');

  perform assert(
    raises(format('select add_set(%L, %L, 1, 70, 8)', we, alice)),
    'and a second "set 1" for the same exercise is refused');
end $$;

\echo ''
\echo '=== zero weight and null weight are different facts ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  pushup uuid := (select id from public.exercises where normalized_name = 'push up');
  plank  uuid := (select id from public.exercises where normalized_name = 'plank');
  w uuid; we uuid; wp uuid;
begin
  w  := start_workout(alice, 'Bodyweight', timestamptz '2026-06-18 16:00:00+02', 'Europe/Zurich');
  we := add_exercise(w, alice, pushup, 'Push-up', 0, 'bodyweight');
  wp := add_exercise(w, alice, plank, 'Plank', 1, 'duration');

  -- Zero: "no added weight" on a set of push-ups.
  perform add_set(we, alice, 1, 0, 20);
  perform assert(
    (select weight_kg from public.workout_sets
      where workout_exercise_id = we and set_number = 1) = 0,
    'a bodyweight set may carry zero added weight');

  -- Added load on a bodyweight movement is ordinary, not an error.
  perform add_set(we, alice, 2, 10, 12);
  perform assert(
    (select weight_kg from public.workout_sets
      where workout_exercise_id = we and set_number = 2) = 10,
    'and may carry added weight instead');

  -- Null: "weight is not how this is measured" on a plank.
  insert into public.workout_sets
    (workout_exercise_id, user_id, set_number, duration_seconds, is_completed)
  values (wp, alice, 1, 45, true);

  perform assert(
    (select weight_kg from public.workout_sets where workout_exercise_id = wp) is null
    and (select duration_seconds from public.workout_sets where workout_exercise_id = wp) = 45,
    'a held set records a duration and no weight at all');
end $$;

\echo ''
\echo '=== exercise order is deterministic and renumbering works ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  bench uuid := (select id from public.exercises where normalized_name = 'barbell bench press');
  row_  uuid := (select id from public.exercises where normalized_name = 'barbell row');
  w uuid; a uuid; b uuid;
begin
  w := start_workout(alice, 'Order', timestamptz '2026-06-19 16:00:00+02', 'Europe/Zurich');
  a := add_exercise(w, alice, bench, 'Barbell Bench Press', 0);
  b := add_exercise(w, alice, row_,  'Barbell Row', 1);

  perform assert(
    raises(format($q$
      insert into public.workout_exercises
        (workout_id, user_id, exercise_id, exercise_name, load_type, position)
      values (%L, %L, %L, 'Duplicate', 'weighted', 0);
    $q$, w, alice, bench)),
    'two exercises cannot share a position');

  perform assert(
    raises(format($q$
      insert into public.workout_exercises
        (workout_id, user_id, exercise_id, exercise_name, load_type, position)
      values (%L, %L, %L, 'Negative', 'weighted', -1);
    $q$, w, alice, bench)),
    'and a negative position is refused');

  /*
   * A swap inside one transaction, which is what a reorder is. The unique
   * constraint is deferrable precisely so the intermediate state — both rows
   * briefly at position 1 — does not abort the reorder.
   */
  set constraints public.workout_exercises_position_key deferred;
  update public.workout_exercises set position = 1 where id = a;
  update public.workout_exercises set position = 0 where id = b;
  set constraints public.workout_exercises_position_key immediate;

  perform assert(
    (select exercise_name from public.workout_exercises
      where workout_id = w and position = 0 and deleted_at is null) = 'Barbell Row',
    'a swap inside one transaction succeeds');
end $$;

-- =========================================================================
-- 5. Historical integrity
-- =========================================================================

\echo ''
\echo '=== a past session survives the catalogue changing under it ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  custom uuid; w uuid; we uuid;
begin
  insert into public.exercises
    (owner_id, name, normalized_name, primary_muscle, equipment, load_type, source)
  values (alice, 'Cable Fly', 'cable fly', 'chest', 'cable', 'weighted', 'user')
  returning id into custom;

  w  := start_workout(alice, 'March', timestamptz '2026-03-10 18:00:00+01', 'Europe/Zurich');
  we := add_exercise(w, alice, custom, 'Cable Fly', 0);
  perform add_set(we, alice, 1, 20, 12);
  perform add_set(we, alice, 2, 22.5, 10);

  -- Rename it.
  update public.exercises
     set name = 'Standing Cable Fly', normalized_name = 'standing cable fly'
   where id = custom;

  perform assert(
    (select exercise_name from public.workout_exercises where id = we) = 'Cable Fly',
    'renaming the exercise does not rename it in history');

  -- Change what it is.
  update public.exercises set primary_muscle = 'shoulders', load_type = 'bodyweight'
   where id = custom;

  perform assert(
    (select load_type from public.workout_exercises where id = we) = 'weighted',
    'and changing its load type does not re-render the past session');

  -- Soft-delete it, which is what the app does.
  update public.exercises set deleted_at = now() where id = custom;

  perform assert(
    (select count(*) from public.workout_sets
      where workout_exercise_id = we and deleted_at is null) = 2,
    'deleting the exercise does not delete the sets performed with it');

  perform assert(
    (select exercise_name from public.workout_exercises where id = we) = 'Cable Fly'
    and (select exercise_id from public.workout_exercises where id = we) = custom,
    'the session still names it and still points at it');

  -- And the harder case: the catalogue row physically gone.
  delete from public.exercises where id = custom;

  perform assert(
    (select count(*) from public.workout_sets
      where workout_exercise_id = we and deleted_at is null) = 2,
    'even a hard delete leaves the sets standing');

  perform assert(
    (select exercise_name from public.workout_exercises where id = we) = 'Cable Fly'
    and (select exercise_id from public.workout_exercises where id = we) is null,
    'the snapshot survives; only the provenance link drops to null');
end $$;

\echo ''
\echo '=== previous performance follows the exercise, not its name ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  squat uuid := (select id from public.exercises where normalized_name = 'barbell back squat');
  w1 uuid; w2 uuid; we1 uuid; we2 uuid;
begin
  w1  := start_workout(alice, 'Legs 1', timestamptz '2026-05-04 18:00:00+02', 'Europe/Zurich');
  we1 := add_exercise(w1, alice, squat, 'Barbell Back Squat', 0);
  perform add_set(we1, alice, 1, 100, 5);
  perform add_set(we1, alice, 2, 105, 5);

  w2  := start_workout(alice, 'Legs 2', timestamptz '2026-05-11 18:00:00+02', 'Europe/Zurich');
  we2 := add_exercise(w2, alice, squat, 'Barbell Back Squat', 0);
  perform add_set(we2, alice, 1, 110, 5);

  perform assert(
    (select count(*) from public.previous_exercise_performance(alice, squat, w2)) = 2,
    'the previous session for this exercise is the one before the current workout');

  perform assert(
    (select max(weight_kg) from public.previous_exercise_performance(alice, squat, w2)) = 105,
    'and it reports what was actually lifted then');

  perform assert(
    (select local_date from public.previous_exercise_performance(alice, squat, w2) limit 1)
      = date '2026-05-04',
    'with the day it happened on');

  -- Renaming must not sever the link: the match is on the id.
  update public.exercises set name = 'Back Squat', normalized_name = 'back squat'
   where id = squat;

  perform assert(
    (select count(*) from public.previous_exercise_performance(alice, squat, w2)) = 2,
    'renaming the exercise does not lose the user''s history with it');

  perform assert(
    (select count(*) from public.previous_exercise_performance(alice, null, null)) = 0,
    'and an exercise with no catalogue id matches nothing rather than everything');
end $$;

-- =========================================================================
-- 6. The cross-user matrix
-- =========================================================================

\echo ''
\echo '=== alice and bob cannot reach each other ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  bob   uuid := (select id from actors where name = 'bob');
  bench uuid := (select id from public.exercises where normalized_name = 'barbell bench press');
  aw uuid; awe uuid; aset uuid;
begin
  aw   := start_workout(alice, 'Private', timestamptz '2026-06-20 16:00:00+02', 'Europe/Zurich');
  awe  := add_exercise(aw, alice, bench, 'Barbell Bench Press', 0);
  aset := add_set(awe, alice, 1, 80, 5);

  perform assert(
    visible_rows(alice, 'select 1 from public.workouts') > 0
    and visible_rows(bob, format('select 1 from public.workouts where id = %L', aw)) = 0,
    'bob cannot read alice''s workout, even knowing its id');

  perform assert(
    visible_rows(bob, format(
      'select 1 from public.workout_exercises where id = %L', awe)) = 0,
    'nor its exercises');

  perform assert(
    visible_rows(bob, format('select 1 from public.workout_sets where id = %L', aset)) = 0,
    'nor its sets');

  perform assert(
    denied(bob, format('update public.workouts set name = ''Stolen'' where id = %L', aw)),
    'bob cannot rename alice''s workout');

  perform assert(
    denied(bob, format(
      'update public.workout_exercises set position = 9 where id = %L', awe)),
    'nor reorder her exercises');

  perform assert(
    denied(bob, format('update public.workout_sets set weight_kg = 200 where id = %L', aset)),
    'nor rewrite her sets');

  perform assert(
    raises(format($q$
      set local role authenticated;
      select set_config('request.jwt.claims', json_build_object('sub', %L)::text, true);
      insert into public.workouts (user_id, name, started_at, time_zone, local_date, status)
      values (%L, 'Planted', now(), 'Europe/Zurich', null, 'in_progress');
    $q$, bob, alice)),
    'nor insert a workout into her history');

  reset role;

  perform assert(
    denied(alice, format(
      'update public.workouts set user_id = %L where id = %L', bob, aw)),
    'alice cannot hand her workout to bob (WITH CHECK holds)');

  perform assert(
    denied(alice, format(
      'update public.workout_sets set user_id = %L where id = %L', bob, aset)),
    'nor reassign a single set');

  perform assert(
    denied(alice, format('delete from public.workouts where id = %L', aw))
    and denied(alice, format('delete from public.workout_sets where id = %L', aset)),
    'nobody may hard-delete a workout or a set');

  perform assert(
    (select user_id from public.workouts where id = aw) = alice
    and (select weight_kg from public.workout_sets where id = aset) = 80,
    'after all of that the session is untouched and still hers');

  -- Removal is a soft delete, which is what synchronises.
  perform assert(
    not denied(alice, format(
      'update public.workout_sets set deleted_at = now() where id = %L', aset)),
    'she removes a set by soft-deleting it');
end $$;

\echo ''
\echo '=== the policy shape matches every other user-owned table ==='

do $$
declare training_tables text[] :=
  array['exercises', 'workouts', 'workout_exercises', 'workout_sets'];
begin
  perform assert(
    (select count(*) from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = any(training_tables)
       and c.relrowsecurity) = 4,
    'RLS is enabled on all four training tables');

  perform assert(
    (select count(*) from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = any(training_tables)
       and c.relforcerowsecurity) = 0,
    'and forced on none of them');

  perform assert(
    (select count(*) from pg_policies
      where schemaname = 'public' and tablename = any(training_tables)
        and cmd = 'DELETE') = 0,
    'none has a delete policy');

  perform assert(
    (select count(*) from pg_policies
      where schemaname = 'public' and tablename = any(training_tables)
        and cmd in ('INSERT', 'UPDATE') and with_check is null) = 0,
    'every insert and update policy sets WITH CHECK');

  perform assert(
    (select count(*) from information_schema.role_table_grants
      where table_schema = 'public' and table_name = any(training_tables)
        and grantee = 'anon') = 0,
    'anonymous callers have no grant on any of them');

  perform assert(
    (select count(*) from information_schema.role_table_grants
      where table_schema = 'public' and table_name = any(training_tables)
        and grantee = 'authenticated' and privilege_type = 'DELETE') = 0,
    'and authenticated callers hold no DELETE');
end $$;

-- =========================================================================
-- 7. Calories burned: still absent, on purpose
-- =========================================================================

\echo ''
\echo '=== recording a workout does not touch anything nutritional ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  training_tables text[] :=
    array['exercises', 'workouts', 'workout_exercises', 'workout_sets'];
begin
  /*
   * The decision from §9 of the migration, asserted rather than described.
   * If somebody later adds a calories column to a training table, this fails
   * and they have to come and read the reasoning first.
   */
  perform assert(
    (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = any(training_tables)
        and (column_name like '%calor%' or column_name like '%kcal%'
             or column_name like '%energy%' or column_name like '%met_%')) = 0,
    'no training table claims an energy expenditure');

  perform assert(
    (select exercise_adds_calories from public.user_settings where user_id = alice) = false,
    'the setting that would switch one on is still off by default');

  perform assert(
    (select count(*) from public.nutrition_goals where user_id = alice) = 0
    and (select count(*) from public.food_logs where user_id = alice) = 0,
    'and a session of training left the diary and the goals untouched');
end $$;

\echo ''
\echo '=== a deleted account takes its training with it ==='

do $$
declare bob uuid := (select id from actors where name = 'bob');
  bench uuid := (select id from public.exercises where normalized_name = 'barbell bench press');
  w uuid; we uuid;
begin
  w  := start_workout(bob, 'Bob''s session', timestamptz '2026-06-21 16:00:00+02', 'Europe/Zurich');
  we := add_exercise(w, bob, bench, 'Barbell Bench Press', 0);
  perform add_set(we, bob, 1, 70, 8);

  insert into public.exercises
    (owner_id, name, normalized_name, primary_muscle, equipment, load_type, source)
  values (bob, 'Bob Special', 'bob special', 'chest', 'barbell', 'weighted', 'user');

  perform assert(
    (select count(*) from public.workout_sets where user_id = bob) > 0,
    'bob has training to lose');

  delete from auth.users where id = bob;

  perform assert(
    (select count(*) from public.workouts where user_id = bob) = 0
    and (select count(*) from public.workout_exercises where user_id = bob) = 0
    and (select count(*) from public.workout_sets where user_id = bob) = 0
    and (select count(*) from public.exercises where owner_id = bob) = 0,
    'deleting the account removes every training row it owned');

  perform assert(
    (select count(*) from public.exercises where owner_id is null) >= 16,
    'and leaves the shared catalogue alone');
end $$;

\echo ''
\echo 'All training checks passed.'

rollback;
