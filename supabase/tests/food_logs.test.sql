-- ===========================================================================
-- The food diary: snapshot immutability, diary dates, aggregation, isolation
--
-- Three properties are worth more than the rest put together, and all three
-- are the kind that look fine in code review and fail in production a year
-- later, in data nobody is watching:
--
--   1. A historical log does not change when the catalogue changes.
--   2. Editing a log re-derives from the basis it was WRITTEN with.
--   3. The diary day is the user's day, never a UTC truncation.
--
-- So each is proved by mutation: change the source food, then read the log
-- back; edit the quantity, then read the calories back; log at instants where
-- the local day and the UTC day genuinely disagree, then read the date back.
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

/* True when `statement` is refused — by an error, or by matching no rows. */
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

/* True when `statement` raises. Runs as the owner, so RLS is not the cause. */
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

-- ---------------------------------------------------------------- fixtures

do $$
declare
  alice uuid;
  bob   uuid;
  apple uuid := '00000000-0000-4000-8000-0000000010a1';
  oats  uuid := '00000000-0000-4000-8000-0000000010a2';
begin
  insert into auth.users (email) values ('alice@example.com') returning id into alice;
  insert into auth.users (email) values ('bob@example.com')   returning id into bob;

  create temp table actors (name text primary key, id uuid);
  insert into actors values ('alice', alice), ('bob', bob),
                            ('apple', apple), ('oats', oats);

  insert into public.foods
    (id, owner_id, name, normalized_name, kind, base_unit, base_amount,
     source_id, external_id, is_verified)
  values
    (apple, null, 'Apple, raw', 'apple, raw', 'generic', 'g', 100, 'usda', '171688', true),
    (oats,  null, 'Rolled Oats', 'rolled oats', 'generic', 'g', 100, 'usda', '169705', true);

  -- 52 kcal per 100 g. Every expected number below comes from this line.
  insert into public.food_nutrition
    (food_id, calories, protein_g, carbohydrates_g, fat_g, fiber_g, source_id)
  values
    (apple, 52, 0.26, 13.81, 0.17, 2.4, 'usda'),
    (oats, 379, 13.2, 67.7, 6.5, 10.1, 'usda');

  insert into public.food_servings (food_id, label, amount, unit, is_default, source_id)
  values (apple, '1 medium apple', 182, 'g', true, 'usda');
end $$;

-- =========================================================================
-- 1. The snapshot survives every mutation of its source
-- =========================================================================

\echo ''
\echo '=== a log carries its own nutrition and does not read the catalogue ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  apple uuid := (select id from actors where name = 'apple');
  log   uuid := '00000000-0000-4000-8000-000000001101';
begin
  insert into public.food_logs
    (id, user_id, food_id, meal, logged_at, time_zone, diary_date,
     quantity, serving_label, serving_amount,
     food_name, brand_name, food_source_id, food_is_verified,
     basis_unit, basis_amount,
     basis_calories, basis_protein_g, basis_carbohydrates_g, basis_fat_g, basis_fiber_g)
  values
    (log, alice, apple, 'breakfast',
     timestamptz '2026-03-03 07:30:00+01', 'Europe/Zurich', date '2026-03-03',
     200, 'g', 1,
     'Apple, raw', null, 'usda', true,
     'g', 100,
     52, 0.26, 13.81, 0.17, 2.4);

  perform assert(
    (select calories from public.food_logs where id = log) = 104,
    '200 g of a 52 kcal/100 g food is 104 kcal');

  perform assert(
    (select amount_in_base from public.food_logs where id = log) = 200,
    'the canonical quantity is stored in the base unit');

  perform assert(
    (select round(carbohydrates_g, 3) from public.food_logs where id = log) = 27.620,
    'macros scale by the same factor');
end $$;

do $$
declare
  apple uuid := (select id from actors where name = 'apple');
  log   uuid := '00000000-0000-4000-8000-000000001101';
begin
  -- The catalogue is corrected: a different importer, different numbers.
  update public.food_nutrition
     set calories = 60, protein_g = 1.5, carbohydrates_g = 15, fat_g = 0.5
   where food_id = apple;

  perform assert(
    (select calories from public.food_logs where id = log) = 104,
    'correcting the food does NOT change what the log says was eaten');

  perform assert(
    (select basis_calories from public.food_logs where id = log) = 52,
    'the log keeps the basis it was written with');
end $$;

do $$
declare
  apple uuid := (select id from actors where name = 'apple');
  log   uuid := '00000000-0000-4000-8000-000000001101';
begin
  update public.foods
     set name = 'Apple, raw, with skin (revised)',
         normalized_name = 'apple, raw, with skin (revised)',
         base_amount = 50,
         is_verified = false
   where id = apple;

  perform assert(
    (select food_name from public.food_logs where id = log) = 'Apple, raw',
    'renaming the food does not rename it in history');

  perform assert(
    (select basis_amount from public.food_logs where id = log) = 100,
    'changing the food''s base amount does not re-base the log');

  perform assert(
    (select food_is_verified from public.food_logs where id = log),
    'the log remembers that the data was verified when it was written');

  perform assert(
    (select calories from public.food_logs where id = log) = 104,
    'the total is still 104 kcal after name, base and verification changed');
end $$;

do $$
declare
  apple uuid := (select id from actors where name = 'apple');
  log   uuid := '00000000-0000-4000-8000-000000001101';
begin
  update public.foods set deleted_at = now() where id = apple;

  perform assert(
    (select calories from public.food_logs where id = log) = 104,
    'soft-deleting the food leaves the log intact');

  update public.foods set deleted_at = null where id = apple;
end $$;

\echo ''
\echo '=== deleting the catalogue row does not delete the history ==='

do $$
declare
  apple uuid := (select id from actors where name = 'apple');
  log   uuid := '00000000-0000-4000-8000-000000001101';
begin
  -- The extreme case: the food is removed from the database entirely.
  delete from public.food_servings where food_id = apple;
  delete from public.food_nutrition where food_id = apple;
  delete from public.foods where id = apple;

  perform assert(
    (select count(*) from public.food_logs where id = log) = 1,
    'hard-deleting the food does NOT cascade into the diary');

  perform assert(
    (select food_id from public.food_logs where id = log) is null,
    'the provenance link is cleared rather than the row destroyed');

  perform assert(
    (select food_name from public.food_logs where id = log) = 'Apple, raw'
    and (select calories from public.food_logs where id = log) = 104,
    'the entry still renders and still totals correctly with no food behind it');
end $$;

-- =========================================================================
-- 2. Editing re-derives from the ORIGINAL basis
-- =========================================================================

\echo ''
\echo '=== an edit uses the basis the log was written with ==='

do $$
declare
  log uuid := '00000000-0000-4000-8000-000000001101';
begin
  -- The food said 52 kcal when this was logged and says 60 now (and no
  -- longer exists at all). 300 g must be 156 kcal, not 180.
  update public.food_logs set quantity = 300 where id = log;

  perform assert(
    (select calories from public.food_logs where id = log) = 156,
    'editing 200 g to 300 g gives 156 kcal, not 180 from today''s numbers');

  perform assert(
    (select amount_in_base from public.food_logs where id = log) = 300,
    'the canonical quantity follows the edit');
end $$;

do $$
declare
  oats uuid := (select id from actors where name = 'oats');
  log  uuid := '00000000-0000-4000-8000-000000001101';
begin
  perform assert(
    raises(format('update public.food_logs set basis_calories = 999 where id = %L', log)),
    'the stored basis cannot be edited directly');

  perform assert(
    raises(format('update public.food_logs set food_name = ''Pear'' where id = %L', log)),
    'the snapshotted food name cannot be edited');

  perform assert(
    raises(format('update public.food_logs set basis_amount = 50 where id = %L', log)),
    'the snapshotted basis amount cannot be edited');

  perform assert(
    raises(format('update public.food_logs set food_id = %L where id = %L', oats, log)),
    'a log cannot be repointed at a different food');

  perform assert(
    raises(format('update public.food_logs set calories = 1 where id = %L', log)),
    'the totals are generated and cannot be written by any client');

  perform assert(
    raises(format(
      'insert into public.food_logs (user_id, meal, time_zone, diary_date, quantity,
         serving_label, serving_amount, food_name, food_source_id, basis_unit,
         basis_amount, basis_calories, calories)
       values (%L, ''snack'', ''UTC'', date ''2026-03-03'', 1, ''g'', 1, ''X'',
               ''user'', ''g'', 100, 10, 5)',
      (select id from actors where name = 'alice'))),
    'a client cannot supply a total that disagrees with its own basis');
end $$;

\echo ''
\echo '=== what an edit may legitimately change ==='

do $$
declare
  log uuid := '00000000-0000-4000-8000-000000001101';
begin
  update public.food_logs
     set meal = 'snack', note = 'after the run', quantity = 200
   where id = log;

  perform assert(
    (select meal from public.food_logs where id = log) = 'snack'
    and (select note from public.food_logs where id = log) = 'after the run'
    and (select calories from public.food_logs where id = log) = 104,
    'meal, note and quantity are editable and the basis still governs the total');

  -- Switching from grams to a named portion is a portion change, not a
  -- nutrition change: 1 × 182 g of the same 52 kcal/100 g basis.
  update public.food_logs
     set quantity = 1, serving_label = '1 medium apple', serving_amount = 182
   where id = log;

  perform assert(
    (select round(calories, 2) from public.food_logs where id = log) = 94.64,
    'switching to a named portion rescales from the same basis');
end $$;

-- =========================================================================
-- 3. The diary day is the user's day
-- =========================================================================

\echo ''
\echo '=== the diary date is the local day, never the UTC day ==='

create or replace function log_at(
  p_user uuid, p_instant timestamptz, p_zone text, p_day date default null)
returns date language plpgsql as $$
declare result date;
begin
  insert into public.food_logs
    (user_id, meal, logged_at, time_zone, diary_date, quantity,
     serving_label, serving_amount, food_name, food_source_id,
     basis_unit, basis_amount, basis_calories)
  values
    (p_user, 'snack', p_instant, p_zone, p_day, 100,
     'g', 1, 'Test food', 'user', 'g', 100, 50)
  returning diary_date into result;
  return result;
end $$;

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
begin
  -- 23:30 in Zurich is 22:30 UTC the same day; the trap is the other way.
  perform assert(
    log_at(alice, timestamptz '2026-06-15 23:30:00+02', 'Europe/Zurich')
      = date '2026-06-15',
    'a 23:30 snack in Zurich belongs to that evening');

  -- 00:30 local on the 16th is still the 15th in UTC.
  perform assert(
    log_at(alice, timestamptz '2026-06-16 00:30:00+02', 'Europe/Zurich')
      = date '2026-06-16',
    'a 00:30 snack in Zurich belongs to the new day, not the UTC one');

  -- Honolulu is UTC-10: local day is BEHIND the UTC day.
  perform assert(
    log_at(alice, timestamptz '2026-06-15 08:00:00+00', 'Pacific/Honolulu')
      = date '2026-06-14',
    'UTC-10: 22:00 local on the 14th is not the 15th');

  -- Auckland is UTC+12: local day is AHEAD of the UTC day.
  perform assert(
    log_at(alice, timestamptz '2026-06-14 23:00:00+00', 'Pacific/Auckland')
      = date '2026-06-15',
    'UTC+12: 11:00 local on the 15th is not the 14th');
end $$;

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  utc_day date;
  local_day date;
begin
  -- The explicit contrast: the two answers differ, and the stored one is the
  -- local answer. A UTC truncation would have passed every test above that
  -- happened to be logged mid-afternoon.
  utc_day   := (timestamptz '2026-06-15 08:00:00+00' at time zone 'UTC')::date;
  local_day := log_at(alice, timestamptz '2026-06-15 08:00:00+00', 'Pacific/Honolulu');

  perform assert(utc_day = date '2026-06-15', 'the UTC day for that instant is the 15th');
  perform assert(local_day = date '2026-06-14', 'the stored diary day is the 14th');
  perform assert(local_day <> utc_day,
    'the stored day and the UTC day genuinely disagree for this entry');
end $$;

\echo ''
\echo '=== daylight saving and travel ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
begin
  -- Zurich falls back at 03:00 on 2026-10-25: 00:30 UTC and 01:30 UTC are
  -- both 02:30 local, an hour apart in reality, the same calendar day here.
  perform assert(
    log_at(alice, timestamptz '2026-10-25 00:30:00+00', 'Europe/Zurich') = date '2026-10-25'
    and log_at(alice, timestamptz '2026-10-25 01:30:00+00', 'Europe/Zurich') = date '2026-10-25',
    'both halves of an ambiguous local hour land on the same diary day');

  -- The instant just before the fall-back day begins locally.
  perform assert(
    log_at(alice, timestamptz '2026-10-24 21:59:00+00', 'Europe/Zurich') = date '2026-10-24',
    'the last minute of the previous local day is not swallowed by the change');

  -- Spring forward: 02:00 -> 03:00 on 2026-03-29, so 01:30 local exists and
  -- 02:30 local does not.
  perform assert(
    log_at(alice, timestamptz '2026-03-29 00:30:00+00', 'Europe/Zurich') = date '2026-03-29'
    and log_at(alice, timestamptz '2026-03-29 01:30:00+00', 'Europe/Zurich') = date '2026-03-29',
    'a 23-hour local day still resolves to one diary day');
end $$;

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  before_travel int;
begin
  select count(*) into before_travel
    from public.food_logs
   where user_id = alice and diary_date = date '2026-06-15'
     and time_zone = 'Europe/Zurich';

  -- The user flies to Tokyo. New entries are dated in Tokyo.
  perform assert(
    log_at(alice, timestamptz '2026-06-20 16:00:00+00', 'Asia/Tokyo') = date '2026-06-21',
    'after moving zones, a new entry uses the new zone');

  perform assert(
    (select count(*) from public.food_logs
      where user_id = alice and diary_date = date '2026-06-15'
        and time_zone = 'Europe/Zurich') = before_travel,
    'historical entries keep the date and the zone they were written with');
end $$;

\echo ''
\echo '=== the date is validated, not merely accepted ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
begin
  perform assert(
    raises(format(
      'select log_at(%L, timestamptz ''2026-06-15 12:00:00+00'', ''Europe/Zurich'',
                     date ''2026-01-01'')', alice)),
    'a diary date that does not match the instant and zone is refused');

  perform assert(
    raises(format(
      'select log_at(%L, timestamptz ''2026-06-15 12:00:00+00'', ''Mars/Olympus'')', alice)),
    'an unknown time zone is refused rather than silently treated as UTC');

  perform assert(
    log_at(alice, timestamptz '2026-06-15 08:00:00+00', 'Pacific/Honolulu', null)
      = date '2026-06-14',
    'a null diary date is derived from the instant and the zone');
end $$;

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  moved uuid;
begin
  select id into moved from public.food_logs
   where user_id = alice and diary_date = date '2026-06-21' limit 1;

  perform assert(
    raises(format(
      'update public.food_logs set diary_date = date ''2026-06-22'' where id = %L', moved)),
    'a diary date cannot be moved without moving the instant it describes');

  update public.food_logs
     set logged_at = timestamptz '2026-06-21 16:00:00+00', diary_date = null
   where id = moved;

  perform assert(
    (select diary_date from public.food_logs where id = moved) = date '2026-06-22',
    'moving the instant re-derives the day');
end $$;

-- =========================================================================
-- 4. Daily aggregation
-- =========================================================================

\echo ''
\echo '=== daily and per-meal totals ==='

do $$
declare
  bob uuid := (select id from actors where name = 'bob');
begin
  insert into public.food_logs
    (user_id, meal, logged_at, time_zone, diary_date, quantity, serving_label,
     serving_amount, food_name, food_source_id, basis_unit, basis_amount,
     basis_calories, basis_protein_g, basis_fiber_g)
  values
    (bob, 'breakfast', timestamptz '2026-04-01 07:00:00+02', 'Europe/Zurich',
     date '2026-04-01', 100, 'g', 1, 'Oats', 'usda', 'g', 100, 379, 13.2, 10.1),
    (bob, 'breakfast', timestamptz '2026-04-01 07:05:00+02', 'Europe/Zurich',
     date '2026-04-01', 200, 'g', 1, 'Milk', 'usda', 'g', 100, 42, 3.4, null),
    (bob, 'lunch', timestamptz '2026-04-01 12:30:00+02', 'Europe/Zurich',
     date '2026-04-01', 150, 'g', 1, 'Rice', 'usda', 'g', 100, 130, 2.7, 0.4),
    -- Deleted entries must not count toward anything.
    (bob, 'dinner', timestamptz '2026-04-01 19:00:00+02', 'Europe/Zurich',
     date '2026-04-01', 500, 'g', 1, 'Cake', 'usda', 'g', 100, 350, 5, 1);

  update public.food_logs
     set deleted_at = now()
   where user_id = bob and food_name = 'Cake';

  perform assert(
    (select round(sum(calories), 2) from public.food_logs
      where user_id = bob and diary_date = date '2026-04-01' and deleted_at is null)
      = 658.00,
    'the day total sums the live entries only (379 + 84 + 195)');

  perform assert(
    (select round(sum(calories), 2) from public.food_logs
      where user_id = bob and diary_date = date '2026-04-01'
        and meal = 'breakfast' and deleted_at is null) = 463.00,
    'per-meal subtotals split the same day');

  perform assert(
    (select round(sum(fiber_g), 2) from public.food_logs
      where user_id = bob and diary_date = date '2026-04-01' and deleted_at is null)
      = 10.70,
    'a nutrient nobody reported for one food does not make the total null');

  perform assert(
    (select count(*) from public.food_logs
      where user_id = bob and diary_date = date '2026-04-01'
        and deleted_at is null and fiber_g is null) = 1,
    'and the unreported value stays null on the entry itself rather than zero');
end $$;

-- =========================================================================
-- 5. Isolation
-- =========================================================================

\echo ''
\echo '=== one user never reaches another user''s diary ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  bob   uuid := (select id from actors where name = 'bob');
  alice_log uuid := '00000000-0000-4000-8000-000000001101';
begin
  perform assert(
    visible_rows(bob, 'select * from public.food_logs') =
    (select count(*) from public.food_logs where user_id = bob),
    'bob sees exactly his own entries and no others');

  perform assert(
    visible_rows(bob, format('select * from public.food_logs where id = %L', alice_log)) = 0,
    'bob cannot read a specific entry of alice''s even knowing its id');

  perform assert(
    denied(bob, format(
      'update public.food_logs set quantity = 1 where id = %L', alice_log)),
    'bob cannot edit alice''s entry');

  perform assert(
    denied(bob, format(
      'insert into public.food_logs
         (user_id, meal, time_zone, diary_date, quantity, serving_label,
          serving_amount, food_name, food_source_id, basis_unit, basis_amount,
          basis_calories)
       values (%L, ''snack'', ''UTC'', date ''2026-04-02'', 1, ''g'', 1, ''X'',
               ''user'', ''g'', 100, 10)', alice)),
    'bob cannot write an entry into alice''s diary');

  perform assert(
    denied(alice, format(
      'update public.food_logs set user_id = %L where id = %L', bob, alice_log)),
    'alice cannot hand her entry to bob (WITH CHECK holds)');

  perform assert(
    (select user_id from public.food_logs where id = alice_log) = alice,
    'and the entry is still hers');
end $$;

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  alice_log uuid := '00000000-0000-4000-8000-000000001101';
begin
  perform assert(
    denied(alice, format('delete from public.food_logs where id = %L', alice_log)),
    'nobody may hard-delete an entry: deletion has to be a fact that syncs');

  set local role authenticated;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', alice)::text, true);
  update public.food_logs set deleted_at = now() where id = alice_log;
  reset role;

  perform assert(
    (select deleted_at from public.food_logs where id = alice_log) is not null,
    'alice removes her own entry by soft-deleting it');

  perform assert(
    visible_rows(alice, format(
      'select * from public.food_logs where id = %L and deleted_at is null', alice_log)) = 0,
    'and it stops appearing in her diary');
end $$;

do $$
begin
  perform assert(
    (select count(*) from information_schema.role_table_grants
      where table_name = 'food_logs' and grantee = 'anon') = 0,
    'anonymous callers have no grant on the diary at all');
end $$;

-- =========================================================================
-- 6. Schema invariants
-- =========================================================================

\echo ''
\echo '=== schema invariants ==='

do $$
begin
  perform assert(
    (select relrowsecurity from pg_class
      where oid = 'public.food_logs'::regclass),
    'RLS is enabled on food_logs');

  perform assert(
    (select count(*) from pg_policies
      where tablename = 'food_logs' and cmd = 'DELETE') = 0,
    'there is no delete policy');

  perform assert(
    (select count(*) from pg_policies
      where tablename = 'food_logs' and cmd in ('INSERT', 'UPDATE')
        and with_check is null) = 0,
    'every insert/update policy sets WITH CHECK');

  perform assert(
    (select confdeltype from pg_constraint
      where conrelid = 'public.food_logs'::regclass
        and confrelid = 'public.foods'::regclass) = 'n',
    'the food reference is ON DELETE SET NULL, not CASCADE');

  perform assert(
    (select confdeltype from pg_constraint
      where conrelid = 'public.food_logs'::regclass
        and confrelid = 'public.profiles'::regclass) = 'c',
    'the owner reference IS on delete cascade: deleting an account removes its diary');

  perform assert(
    (select count(*) from pg_attribute
      where attrelid = 'public.food_logs'::regclass
        and attgenerated = 's'
        and attname in ('amount_in_base', 'calories', 'protein_g',
                        'carbohydrates_g', 'fat_g', 'fiber_g', 'sugar_g',
                        'saturated_fat_g', 'sodium_mg')) = 9,
    'every total is a generated column rather than a client-supplied number');

  perform assert(
    (select count(*) from pg_indexes
      where tablename = 'food_logs'
        and indexdef like '%user_id, diary_date%') >= 1,
    'the day read is indexed on (user_id, diary_date)');
end $$;

do $$
declare
  bob uuid := (select id from actors where name = 'bob');
  before int;
begin
  select count(*) into before from public.food_logs where user_id = bob;
  perform assert(before > 0, 'bob has entries to lose');

  delete from auth.users where id = bob;

  perform assert(
    (select count(*) from public.food_logs where user_id = bob) = 0,
    'deleting the account removes the diary with it');
end $$;

\echo ''
\echo 'All food diary checks passed.'

rollback;
