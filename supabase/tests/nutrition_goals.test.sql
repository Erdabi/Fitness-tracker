-- ===========================================================================
-- Goal periods: history, supersession, isolation
--
-- The property that matters most is the one nobody notices until it is wrong:
-- a goal set in August still reads as it did in August, months later, after
-- the profile it came from has changed several times. Every assertion about
-- history below is made by changing something and then reading the past back.
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

/* Opens a goal period. Mirrors what the client writes: a start date and a
   target, never an end date. */
create or replace function open_goal(
  p_user uuid, p_from date, p_calories int,
  p_source public.goal_source default 'calculated',
  p_calculated int default null)
returns uuid language plpgsql as $$
declare new_id uuid;
begin
  insert into public.nutrition_goals
    (user_id, effective_from, calorie_target,
     protein_target_g, carbohydrate_target_g, fat_target_g,
     source, calculated_calories, calculated_protein_g,
     calculated_carbohydrate_g, calculated_fat_g,
     basis_bmr, basis_tdee, basis_activity, basis_direction,
     basis_weight_kg, basis_height_cm, basis_age_years, basis_sex)
  values
    (p_user, p_from, p_calories,
     140, 200, 60,
     p_source,
     case when p_source = 'manual' then null
          else coalesce(p_calculated, p_calories) end,
     case when p_source = 'manual' then null else 140 end,
     case when p_source = 'manual' then null
          when p_source = 'calculated_then_modified' then 210 else 200 end,
     case when p_source = 'manual' then null else 60 end,
     case when p_source = 'manual' then null else 1780 end,
     case when p_source = 'manual' then null else 2759 end,
     case when p_source = 'manual' then null else 'moderate' end::public.activity_level,
     case when p_source = 'manual' then null else 'lose' end::public.goal_direction,
     case when p_source = 'manual' then null else 80 end,
     case when p_source = 'manual' then null else 180 end,
     case when p_source = 'manual' then null else 30 end,
     case when p_source = 'manual' then null else 'male' end::public.sex)
  returning id into new_id;
  return new_id;
end $$;

create or replace function goal_calories_on(p_user uuid, p_date date)
returns int language sql stable as $$
  select calorie_target from public.goal_for_date(p_user, p_date);
$$;

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
-- 1. Periods and history
-- =========================================================================

\echo ''
\echo '=== a goal is a period, and the past keeps its own ==='

do $$
declare
  alice   uuid := (select id from actors where name = 'alice');
  first   uuid;
  second  uuid;
begin
  first  := open_goal(alice, date '2026-08-01', 2000);
  second := open_goal(alice, date '2026-08-11', 2200);

  perform assert(
    goal_calories_on(alice, date '2026-08-05') = 2000,
    '5 August reads the goal that was in force on 5 August');

  perform assert(
    goal_calories_on(alice, date '2026-08-15') = 2200,
    '15 August reads the newer goal');

  perform assert(
    (select effective_to from public.nutrition_goals where id = first)
      = date '2026-08-10',
    'the earlier period was closed the day before the next one starts');

  perform assert(
    (select effective_to from public.nutrition_goals where id = second) is null,
    'the current period stays open');

  perform assert(
    (select calorie_target from public.nutrition_goals where id = first) = 2000,
    'and the earlier period''s target was not touched');
end $$;

\echo ''
\echo '=== boundary dates ==='

do $$
declare alice uuid := (select id from actors where name = 'alice');
begin
  perform assert(goal_calories_on(alice, date '2026-08-01') = 2000,
    'the first day of a period is inside it');
  perform assert(goal_calories_on(alice, date '2026-08-10') = 2000,
    'the last day of a period is inside it');
  perform assert(goal_calories_on(alice, date '2026-08-11') = 2200,
    'the first day of the next period belongs to the next period');
  perform assert(goal_calories_on(alice, date '2026-07-31') is null,
    'a date before every period has no goal, rather than the earliest one');
  perform assert(goal_calories_on(alice, date '2030-01-01') = 2200,
    'the open period extends indefinitely forward');
end $$;

\echo ''
\echo '=== a third period does not disturb the first two ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
begin
  perform open_goal(alice, date '2026-09-01', 2400);

  perform assert(goal_calories_on(alice, date '2026-08-05') = 2000,
    'August 5 still reads 2000');
  perform assert(goal_calories_on(alice, date '2026-08-15') = 2200,
    'August 15 still reads 2200');
  perform assert(goal_calories_on(alice, date '2026-09-15') = 2400,
    'September reads the newest');

  perform assert(
    (select count(*) from public.nutrition_goals
      where user_id = alice and deleted_at is null) = 3,
    'all three periods survive; none was overwritten');
end $$;

\echo ''
\echo '=== inserting a period out of order still chains correctly ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  gap   uuid;
begin
  -- A period slotted between two that already exist, as a backfill would.
  gap := open_goal(alice, date '2026-08-20', 2300);

  perform assert(
    (select effective_to from public.nutrition_goals where id = gap)
      = date '2026-08-31',
    'the inserted period ends where the next one begins');

  perform assert(goal_calories_on(alice, date '2026-08-15') = 2200,
    'the period before it was shortened, not replaced');
  perform assert(goal_calories_on(alice, date '2026-08-25') = 2300,
    'and the new period covers its own dates');
end $$;

-- =========================================================================
-- 2. One goal per user per date
-- =========================================================================

\echo ''
\echo '=== no date is ever covered by two goals ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  probe date;
  hits  int;
begin
  for probe in
    select generate_series(date '2026-07-25', date '2026-09-30', interval '1 day')::date
  loop
    select count(*) into hits
      from public.nutrition_goals
     where user_id = alice and deleted_at is null
       and effective_from <= probe
       and (effective_to is null or effective_to >= probe);

    if hits > 1 then
      raise exception 'FAIL  % is covered by % goals', probe, hits;
    end if;
  end loop;

  raise notice '  PASS  every day across the whole range is covered at most once';
end $$;

/*
 * Two devices opening a period on the same day, offline, is the case a unique
 * constraint would reject forever. Both rows are kept; the later one takes
 * effect and the earlier is marked as superseded before it applied.
 */
do $$
declare
  bob    uuid := (select id from actors where name = 'bob');
  losing uuid;
  winner uuid;
begin
  losing := open_goal(bob, date '2026-08-01', 1900);
  winner := open_goal(bob, date '2026-08-01', 2100);

  perform assert(goal_calories_on(bob, date '2026-08-01') = 2100,
    'when two periods start on the same day, the later one is in force');

  perform assert(
    (select effective_to from public.nutrition_goals where id = losing)
      = date '2026-07-31',
    'the superseded period is closed the day before it started');

  perform assert(
    (select count(*) from public.nutrition_goals where id = losing) = 1,
    'and it is kept, because it is still a record of something the user did');

  perform assert(
    (select count(*) from public.nutrition_goals
      where user_id = bob and deleted_at is null
        and effective_from <= date '2026-08-01'
        and (effective_to is null or effective_to >= date '2026-08-01')) = 1,
    'exactly one goal covers that date');
end $$;

do $$
declare
  bob uuid := (select id from actors where name = 'bob');
begin
  perform assert(
    raises(format(
      'insert into public.nutrition_goals
         (user_id, effective_from, effective_to, calorie_target,
          protein_target_g, carbohydrate_target_g, fat_target_g, source)
       values (%L, date ''2026-08-05'', date ''2026-08-01'', 2000, 140, 200, 60, ''manual'')',
      bob)),
    'a range that ends well before it starts is refused outright');
end $$;

-- =========================================================================
-- 3. Deleting a period
-- =========================================================================

\echo ''
\echo '=== removing a period reopens the one before it ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  removed uuid;
begin
  select id into removed from public.nutrition_goals
   where user_id = alice and effective_from = date '2026-08-20';

  update public.nutrition_goals set deleted_at = now() where id = removed;

  perform assert(goal_calories_on(alice, date '2026-08-25') = 2200,
    'the dates it covered fall back to the period before it');
  perform assert(goal_calories_on(alice, date '2026-09-15') = 2400,
    'and the period after it is unaffected');
  perform assert(
    (select count(*) from public.nutrition_goals where id = removed) = 1,
    'the row survives as a soft delete, so the deletion can sync');
end $$;

-- =========================================================================
-- 4. The recommendation is preserved
-- =========================================================================

\echo ''
\echo '=== a manual override keeps the number the app suggested ==='

do $$
declare
  bob  uuid := (select id from actors where name = 'bob');
  goal uuid;
begin
  goal := open_goal(bob, date '2026-09-01', 2200, 'calculated_then_modified', 2050);

  perform assert(
    (select calorie_target from public.nutrition_goals where id = goal) = 2200,
    'the active target is what the user chose');
  perform assert(
    (select calculated_calories from public.nutrition_goals where id = goal) = 2050,
    'and the recommendation is still there beside it');
  perform assert(
    (select source from public.nutrition_goals where id = goal)
      = 'calculated_then_modified',
    'the source records that a recommendation existed and was not taken');
end $$;

\echo ''
\echo '=== a macro-only override counts as a modification ==='

do $$
declare
  bob  uuid := (select id from actors where name = 'bob');
  goal uuid;
begin
  -- Same calories, different split. The user changed something, so the source
  -- has to say so even though the headline number is unchanged.
  insert into public.nutrition_goals
    (user_id, effective_from, calorie_target, protein_target_g,
     carbohydrate_target_g, fat_target_g, source, calculated_calories,
     calculated_protein_g, calculated_carbohydrate_g, calculated_fat_g,
     basis_bmr, basis_tdee, basis_activity, basis_direction,
     basis_weight_kg, basis_sex)
  values (bob, date '2026-12-01', 2000, 170, 155, 60, 'calculated_then_modified',
          2000, 140, 200, 60, 1780, 2759, 'moderate', 'lose', 80, 'male')
  returning id into goal;

  perform assert(
    (select protein_target_g from public.nutrition_goals where id = goal) = 170
    and (select calculated_protein_g from public.nutrition_goals where id = goal) = 140,
    'both the chosen macro split and the suggested one are kept');
end $$;

do $$
declare bob uuid := (select id from actors where name = 'bob');
begin
  perform assert(
    raises(format(
      'insert into public.nutrition_goals
         (user_id, effective_from, calorie_target, protein_target_g,
          carbohydrate_target_g, fat_target_g, source, calculated_calories,
          calculated_protein_g, calculated_carbohydrate_g, calculated_fat_g,
          basis_bmr, basis_tdee, basis_activity, basis_direction,
          basis_weight_kg, basis_sex)
       values (%L, date ''2026-10-01'', 2000, 140, 200, 60, ''calculated_then_modified'',
               2000, 140, 200, 60, 1780, 2759, ''moderate'', ''lose'', 80, ''male'')',
      bob)),
    'a "modified" goal identical to its recommendation in every field is refused');

  perform assert(
    raises(format(
      'insert into public.nutrition_goals
         (user_id, effective_from, calorie_target, protein_target_g,
          carbohydrate_target_g, fat_target_g, source, calculated_calories)
       values (%L, date ''2026-10-01'', 2000, 140, 200, 60, ''calculated'', 1800)',
      bob)),
    'a "calculated" goal that does not match its own recommendation is refused');

  perform assert(
    raises(format(
      'insert into public.nutrition_goals
         (user_id, effective_from, calorie_target, protein_target_g,
          carbohydrate_target_g, fat_target_g, source)
       values (%L, date ''2026-10-01'', 2000, 140, 200, 60, ''calculated'')',
      bob)),
    'a calculated goal with no basis at all is refused');
end $$;

\echo ''
\echo '=== a purely manual goal needs no basis ==='

do $$
declare
  bob  uuid := (select id from actors where name = 'bob');
  goal uuid;
begin
  goal := open_goal(bob, date '2026-11-01', 2500, 'manual');

  perform assert(
    (select calculated_calories from public.nutrition_goals where id = goal) is null,
    'there was no recommendation, so none is invented');
  perform assert(
    (select basis_bmr from public.nutrition_goals where id = goal) is null,
    'and no basis is fabricated either');
end $$;

-- =========================================================================
-- 5. Profile changes do not rewrite history
-- =========================================================================

\echo ''
\echo '=== changing the profile leaves past goals exactly as they were ==='

do $$
declare
  alice  uuid := (select id from actors where name = 'alice');
  before jsonb;
begin
  select to_jsonb(g) - 'updated_at' into before
    from public.nutrition_goals g
   where g.user_id = alice and g.effective_from = date '2026-08-01';

  update public.profiles
     set height_cm = 165, activity_level = 'extra', birth_date = date '1970-01-01'
   where id = alice;

  perform assert(
    (select to_jsonb(g) - 'updated_at' from public.nutrition_goals g
      where g.user_id = alice and g.effective_from = date '2026-08-01') = before,
    'not one column of the August goal moved');

  perform assert(
    (select basis_height_cm from public.nutrition_goals
      where user_id = alice and effective_from = date '2026-08-01') = 180,
    'the goal still reports the height it was calculated from, not the new one');

  perform assert(goal_calories_on(alice, date '2026-08-05') = 2000,
    'and August 5 still resolves to 2000');
end $$;

-- =========================================================================
-- 6. Weight history
-- =========================================================================

\echo ''
\echo '=== weight history ==='

do $$
declare alice uuid := (select id from actors where name = 'alice');
begin
  insert into public.weight_entries (user_id, measured_on, weight_kg)
  values (alice, date '2026-08-01', 82.4),
         (alice, date '2026-08-15', 81.1),
         (alice, date '2026-09-01', 80.2);

  perform assert(
    (select weight_kg from public.weight_entries
      where user_id = alice and measured_on <= date '2026-08-20'
        and deleted_at is null
      order by measured_on desc limit 1) = 81.1,
    'the weight on a date is the most recent measurement on or before it');

  perform assert(
    (select count(*) from public.weight_entries where user_id = alice) = 3,
    'every measurement is kept');

  -- Two devices, one morning. Both rows survive; the later one reads.
  insert into public.weight_entries (user_id, measured_on, weight_kg)
  values (alice, date '2026-09-01', 80.4);

  perform assert(
    (select count(*) from public.weight_entries
      where user_id = alice and measured_on = date '2026-09-01') = 2,
    'a second reading on the same day is kept rather than rejected');

  perform assert(
    (select weight_kg from public.weight_entries
      where user_id = alice and measured_on = date '2026-09-01'
        and deleted_at is null
      order by created_at desc, id desc limit 1) = 80.4,
    'and the later one is the one that reads back');

  perform assert(
    raises(format(
      'insert into public.weight_entries (user_id, measured_on, weight_kg)
       values (%L, date ''2026-09-02'', 5)', alice)),
    'an impossible weight is refused');
end $$;

-- =========================================================================
-- 7. Isolation
-- =========================================================================

\echo ''
\echo '=== one user never reaches another user''s goals ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  bob   uuid := (select id from actors where name = 'bob');
  alice_goal uuid;
begin
  select id into alice_goal from public.nutrition_goals
   where user_id = alice and effective_from = date '2026-08-01';

  perform assert(
    visible_rows(alice, 'select * from public.nutrition_goals') =
    (select count(*) from public.nutrition_goals where user_id = alice),
    'alice sees exactly her own goals');

  perform assert(
    visible_rows(bob, format(
      'select * from public.nutrition_goals where id = %L', alice_goal)) = 0,
    'bob cannot read alice''s goal even knowing its id');

  perform assert(
    denied(bob, format(
      'update public.nutrition_goals set calorie_target = 1200 where id = %L',
      alice_goal)),
    'bob cannot edit alice''s goal');

  perform assert(
    denied(bob, format(
      'insert into public.nutrition_goals
         (user_id, effective_from, calorie_target, protein_target_g,
          carbohydrate_target_g, fat_target_g, source)
       values (%L, date ''2027-01-01'', 1000, 140, 200, 60, ''manual'')', alice)),
    'bob cannot write a goal into alice''s history');

  perform assert(
    denied(alice, format(
      'update public.nutrition_goals set user_id = %L where id = %L', bob, alice_goal)),
    'alice cannot hand her goal to bob (WITH CHECK holds)');

  perform assert(
    denied(alice, format(
      'delete from public.nutrition_goals where id = %L', alice_goal)),
    'nobody may hard-delete a goal period');

  perform assert(
    (select calorie_target from public.nutrition_goals where id = alice_goal) = 2000,
    'and after all of that the goal is untouched');
end $$;

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  bob   uuid := (select id from actors where name = 'bob');
  entry uuid;
begin
  select id into entry from public.weight_entries
   where user_id = alice order by measured_on limit 1;

  perform assert(
    visible_rows(bob, 'select * from public.weight_entries') = 0,
    'bob has no weight entries and sees none of alice''s');

  perform assert(
    denied(bob, format('update public.weight_entries set weight_kg = 50 where id = %L', entry)),
    'bob cannot edit alice''s weight');

  perform assert(
    denied(bob, format(
      'insert into public.weight_entries (user_id, measured_on, weight_kg)
       values (%L, date ''2027-01-01'', 60)', alice)),
    'bob cannot record a weight for alice');

  perform assert(
    denied(alice, format('delete from public.weight_entries where id = %L', entry)),
    'nobody may hard-delete a weight entry');

  perform assert(
    denied(alice, format(
      'update public.weight_entries set user_id = %L where id = %L', bob, entry)),
    'alice cannot reassign her weight entry to bob');
end $$;

do $$
begin
  perform assert(
    (select count(*) from information_schema.role_table_grants
      where table_name in ('nutrition_goals', 'weight_entries') and grantee = 'anon') = 0,
    'anonymous callers have no grant on either table');
end $$;

-- =========================================================================
-- 8. Schema invariants
-- =========================================================================

\echo ''
\echo '=== schema invariants ==='

do $$
begin
  perform assert(
    (select relrowsecurity from pg_class where oid = 'public.nutrition_goals'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.weight_entries'::regclass),
    'RLS is enabled on both tables');

  perform assert(
    (select count(*) from pg_policies
      where tablename in ('nutrition_goals', 'weight_entries') and cmd = 'DELETE') = 0,
    'neither table has a delete policy');

  perform assert(
    (select count(*) from pg_policies
      where tablename in ('nutrition_goals', 'weight_entries')
        and cmd in ('INSERT', 'UPDATE') and with_check is null) = 0,
    'every insert/update policy sets WITH CHECK');

  perform assert(
    (select count(*) from pg_constraint
      where conrelid = 'public.nutrition_goals'::regclass
        and contype = 'x') = 1,
    'the no-overlap exclusion constraint exists');

  perform assert(
    (select condeferrable from pg_constraint
      where conrelid = 'public.nutrition_goals'::regclass and contype = 'x'),
    'and it is deferrable, so the period trigger can settle the chain first');

  perform assert(
    (select count(*) from pg_indexes
      where tablename = 'nutrition_goals'
        and indexdef like '%user_id, effective_from%') >= 1,
    'goal lookup is indexed on (user_id, effective_from)');

  perform assert(
    (select confdeltype from pg_constraint
      where conrelid = 'public.nutrition_goals'::regclass
        and confrelid = 'public.profiles'::regclass) = 'c',
    'deleting an account removes its goals');
end $$;

do $$
declare
  bob uuid := (select id from actors where name = 'bob');
begin
  perform assert(
    (select count(*) from public.nutrition_goals where user_id = bob) > 0,
    'bob has goals to lose');

  delete from auth.users where id = bob;

  perform assert(
    (select count(*) from public.nutrition_goals where user_id = bob) = 0,
    'deleting the account removes the goals with it');
  perform assert(
    (select count(*) from public.weight_entries where user_id = bob) = 0,
    'and the weight history too');
end $$;

\echo ''
\echo 'All nutrition goal checks passed.'

rollback;
