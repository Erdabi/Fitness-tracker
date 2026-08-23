-- ===========================================================================
-- Water logs and water goals
--
-- Water is the diary with one number instead of eight, and its goals are goal
-- periods with one target instead of four — so most of what could go wrong
-- here is already prevented by machinery this milestone reuses rather than
-- rewrites. What these assertions check is that the reuse actually holds:
-- that a glass at 23:30 in Auckland lands on the right day through the SAME
-- resolver the food diary uses, and that a water goal from last month survives
-- a weight change through the SAME period chain.
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

/* Logs a drink. Mirrors the client: an instant and a zone, never a date. */
create or replace function drink(
  p_user uuid, p_ml int, p_at timestamptz, p_zone text, p_date date default null)
returns date language plpgsql as $$
declare result date;
begin
  insert into public.water_logs (user_id, amount_ml, consumed_at, time_zone, local_date)
  values (p_user, p_ml, p_at, p_zone, p_date)
  returning local_date into result;
  return result;
end $$;

create or replace function water_target_on(p_user uuid, p_date date)
returns int language sql stable as $$
  select target_ml from public.water_goal_for_date(p_user, p_date);
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
-- 1. The local day, through the shared resolver
-- =========================================================================

\echo ''
\echo '=== a drink belongs to the user local day, never the UTC day ==='

do $$
declare alice uuid := (select id from actors where name = 'alice');
begin
  -- UTC+12: local day is AHEAD of the UTC day.
  perform assert(
    drink(alice, 250, timestamptz '2026-06-14 11:30:00+00', 'Pacific/Auckland')
      = date '2026-06-14',
    'UTC+12: 23:30 local on the 14th is that day, not the 15th');

  perform assert(
    drink(alice, 250, timestamptz '2026-06-14 23:00:00+00', 'Pacific/Auckland')
      = date '2026-06-15',
    'UTC+12: 11:00 local on the 15th is not the 14th');

  -- UTC-10: local day is BEHIND the UTC day. The opposite direction.
  perform assert(
    drink(alice, 250, timestamptz '2026-06-15 08:00:00+00', 'Pacific/Honolulu')
      = date '2026-06-14',
    'UTC-10: 22:00 local on the 14th is not the 15th');

  perform assert(
    drink(alice, 250, timestamptz '2026-06-15 21:30:00+02', 'Europe/Zurich')
      = date '2026-06-15',
    'a 21:30 glass in Zurich belongs to that evening');

  perform assert(
    drink(alice, 250, timestamptz '2026-06-15 22:30:00+00', 'Europe/Zurich')
      = date '2026-06-16',
    'a 00:30 glass in Zurich belongs to the new local day');
end $$;

do $$
declare
  alice     uuid := (select id from actors where name = 'alice');
  utc_day   date;
  local_day date;
begin
  -- The explicit contrast. A UTC truncation would agree with the local answer
  -- for anything logged mid-afternoon, so the test uses an instant where the
  -- two genuinely differ and asserts the stored one is local.
  utc_day   := (timestamptz '2026-06-15 08:00:00+00' at time zone 'UTC')::date;
  local_day := drink(alice, 100, timestamptz '2026-06-15 08:00:00+00', 'Pacific/Honolulu');

  perform assert(utc_day = date '2026-06-15', 'the UTC day for that instant is the 15th');
  perform assert(local_day = date '2026-06-14', 'the stored local day is the 14th');
  perform assert(local_day <> utc_day, 'and the two genuinely disagree');
end $$;

do $$
declare alice uuid := (select id from actors where name = 'alice');
begin
  -- Zurich falls back at 03:00 on 2026-10-25: both instants read 02:30 local.
  perform assert(
    drink(alice, 100, timestamptz '2026-10-25 00:30:00+00', 'Europe/Zurich') = date '2026-10-25'
    and drink(alice, 100, timestamptz '2026-10-25 01:30:00+00', 'Europe/Zurich') = date '2026-10-25',
    'both halves of an ambiguous local hour land on the same local day');

  perform assert(
    raises(format(
      'select drink(%L, 250, timestamptz ''2026-06-15 12:00:00+00'', ''Mars/Olympus'')',
      alice)),
    'an unknown time zone is refused rather than silently treated as UTC');

  perform assert(
    raises(format(
      'select drink(%L, 250, timestamptz ''2026-06-15 12:00:00+00'', ''Europe/Zurich'',
                    date ''2026-01-01'')', alice)),
    'a local date that does not match the instant and zone is refused');

  perform assert(
    drink(alice, 250, timestamptz '2026-06-15 08:00:00+00', 'Pacific/Honolulu', null)
      = date '2026-06-14',
    'a null local date is derived rather than rejected');
end $$;

\echo ''
\echo '=== amounts are constrained in the database, not only in the client ==='

do $$
declare alice uuid := (select id from actors where name = 'alice');
begin
  perform assert(
    raises(format('select drink(%L, 0, now(), ''Europe/Zurich'')', alice)),
    'a zero amount is refused');
  perform assert(
    raises(format('select drink(%L, -250, now(), ''Europe/Zurich'')', alice)),
    'a negative amount is refused');
  perform assert(
    raises(format('select drink(%L, 50000, now(), ''Europe/Zurich'')', alice)),
    'an implausible single amount is refused as a slipped decimal');
  perform assert(
    not raises(format('select drink(%L, 5000, now(), ''Europe/Zurich'')', alice)),
    'the upper bound itself is allowed');
end $$;

-- =========================================================================
-- 2. Daily totals
-- =========================================================================

\echo ''
\echo '=== daily totals ==='

do $$
declare
  bob uuid := (select id from actors where name = 'bob');
  removed uuid;
begin
  perform drink(bob, 250, timestamptz '2026-04-01 07:00:00+02', 'Europe/Zurich');
  perform drink(bob, 500, timestamptz '2026-04-01 12:00:00+02', 'Europe/Zurich');
  perform drink(bob, 1000, timestamptz '2026-04-01 18:00:00+02', 'Europe/Zurich');
  perform drink(bob, 750, timestamptz '2026-04-02 09:00:00+02', 'Europe/Zurich');

  perform assert(
    (select sum(amount_ml) from public.water_logs
      where user_id = bob and local_date = date '2026-04-01' and deleted_at is null) = 1750,
    'the day total is the sum of that day''s entries (250 + 500 + 1000)');

  perform assert(
    (select sum(amount_ml) from public.water_logs
      where user_id = bob and local_date = date '2026-04-02' and deleted_at is null) = 750,
    'and a different day is a different total');

  -- Soft delete, as everywhere else in this app.
  select id into removed from public.water_logs
   where user_id = bob and amount_ml = 1000 limit 1;
  update public.water_logs set deleted_at = now() where id = removed;

  perform assert(
    (select sum(amount_ml) from public.water_logs
      where user_id = bob and local_date = date '2026-04-01' and deleted_at is null) = 750,
    'a deleted entry contributes nothing to the total');

  perform assert(
    (select count(*) from public.water_logs where id = removed) = 1,
    'while the row itself survives, so the deletion can synchronise');
end $$;

do $$
declare bob uuid := (select id from actors where name = 'bob');
begin
  perform assert(
    (select amount_ml from public.water_logs
      where user_id = bob and amount_ml = 250 limit 1) = 250,
    'an entry can be read back');

  update public.water_logs set amount_ml = 300
   where user_id = bob and amount_ml = 250;

  perform assert(
    (select sum(amount_ml) from public.water_logs
      where user_id = bob and local_date = date '2026-04-01' and deleted_at is null) = 800,
    'editing an entry moves the day total with it');
end $$;

-- =========================================================================
-- 3. Goal periods
-- =========================================================================

\echo ''
\echo '=== a water goal is a period, and old days keep their own ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  first uuid;
begin
  insert into public.water_goals
    (user_id, effective_from, target_ml, source, calculated_ml, basis_weight_kg)
  values (alice, date '2026-08-01', 2400, 'calculated', 2400, 68.5)
  returning id into first;

  insert into public.water_goals
    (user_id, effective_from, target_ml, source, calculated_ml, basis_weight_kg)
  values (alice, date '2026-08-11', 2800, 'manual', 2600, 74.0);

  perform assert(water_target_on(alice, date '2026-08-05') = 2400,
    '5 August reads the goal that was in force on 5 August');
  perform assert(water_target_on(alice, date '2026-08-15') = 2800,
    '15 August reads the newer goal');
  perform assert(water_target_on(alice, date '2026-08-01') = 2400,
    'the first day of a period is inside it');
  perform assert(water_target_on(alice, date '2026-08-10') = 2400,
    'the last day of a period is inside it');
  perform assert(water_target_on(alice, date '2026-07-31') is null,
    'a date before every period has no goal, rather than the earliest one');
  perform assert(water_target_on(alice, date '2030-01-01') = 2800,
    'the open period extends indefinitely forward');

  perform assert(
    (select effective_to from public.water_goals where id = first) = date '2026-08-10',
    'the earlier period was closed the day before the next one starts');
end $$;

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  probe date;
  hits  int;
begin
  for probe in
    select generate_series(date '2026-07-25', date '2026-09-15', interval '1 day')::date
  loop
    select count(*) into hits
      from public.water_goals
     where user_id = alice and deleted_at is null
       and effective_from <= probe
       and (effective_to is null or effective_to >= probe);
    if hits > 1 then
      raise exception 'FAIL  % is covered by % water goals', probe, hits;
    end if;
  end loop;
  raise notice '  PASS  no day is ever covered by two water goals';
end $$;

\echo ''
\echo '=== the recommendation is kept beside a manual target ==='

do $$
declare alice uuid := (select id from actors where name = 'alice');
begin
  perform assert(
    (select target_ml from public.water_goals
      where user_id = alice and effective_from = date '2026-08-11') = 2800,
    'the active target is what the user chose');
  perform assert(
    (select calculated_ml from public.water_goals
      where user_id = alice and effective_from = date '2026-08-11') = 2600,
    'and the recommendation is still there beside it');
  perform assert(
    (select source from public.water_goals
      where user_id = alice and effective_from = date '2026-08-11') = 'manual',
    'with the source recording that the user chose it');

  perform assert(
    raises(format(
      'insert into public.water_goals
         (user_id, effective_from, target_ml, source, calculated_ml)
       values (%L, date ''2026-12-01'', 3000, ''calculated'', 2400)', alice)),
    'a "calculated" goal that does not match its own recommendation is refused');

  perform assert(
    raises(format(
      'insert into public.water_goals (user_id, effective_from, target_ml, source)
       values (%L, date ''2026-12-01'', 200, ''manual'')', alice)),
    'an implausibly small target is refused');
end $$;

\echo ''
\echo '=== a weight change never rewrites a historical water goal ==='

do $$
declare
  alice  uuid := (select id from actors where name = 'alice');
  before jsonb;
begin
  select to_jsonb(g) - 'updated_at' into before
    from public.water_goals g
   where g.user_id = alice and g.effective_from = date '2026-08-01';

  -- The user gains weight and records it. The recommendation depends on
  -- weight, so this is exactly the moment a naive design would re-derive.
  insert into public.weight_entries (user_id, measured_on, weight_kg)
  values (alice, current_date, 82.0);

  update public.profiles set height_cm = 172 where id = alice;

  perform assert(
    (select to_jsonb(g) - 'updated_at' from public.water_goals g
      where g.user_id = alice and g.effective_from = date '2026-08-01') = before,
    'not one column of the August water goal moved');

  perform assert(
    (select basis_weight_kg from public.water_goals
      where user_id = alice and effective_from = date '2026-08-01') = 68.5,
    'it still reports the weight it was calculated from, not the new one');

  perform assert(water_target_on(alice, date '2026-08-05') = 2400,
    'and 5 August still resolves to 2400 ml');
end $$;

-- =========================================================================
-- 4. Isolation
-- =========================================================================

\echo ''
\echo '=== one user never reaches another user''s water ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  bob   uuid := (select id from actors where name = 'bob');
  alice_log uuid;
begin
  select id into alice_log from public.water_logs where user_id = alice limit 1;

  perform assert(
    visible_rows(alice, 'select * from public.water_logs') =
    (select count(*) from public.water_logs where user_id = alice),
    'alice sees exactly her own water logs');

  perform assert(
    visible_rows(bob, format('select * from public.water_logs where id = %L', alice_log)) = 0,
    'bob cannot read a specific entry of alice''s even knowing its id');

  perform assert(
    denied(bob, format('update public.water_logs set amount_ml = 1 where id = %L', alice_log)),
    'bob cannot edit alice''s water log');

  perform assert(
    denied(bob, format(
      'insert into public.water_logs (user_id, amount_ml, time_zone, local_date)
       values (%L, 250, ''UTC'', current_date)', alice)),
    'bob cannot write water into alice''s day');

  perform assert(
    denied(alice, format(
      'update public.water_logs set user_id = %L where id = %L', bob, alice_log)),
    'alice cannot hand her entry to bob (WITH CHECK holds)');

  perform assert(
    denied(alice, format('delete from public.water_logs where id = %L', alice_log)),
    'nobody may hard-delete a water log');

  perform assert(
    (select user_id from public.water_logs where id = alice_log) = alice,
    'and after all of that the entry is still hers');
end $$;

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  bob   uuid := (select id from actors where name = 'bob');
  alice_goal uuid;
begin
  select id into alice_goal from public.water_goals where user_id = alice limit 1;

  perform assert(
    visible_rows(bob, 'select * from public.water_goals') = 0,
    'bob has no water goals and sees none of alice''s');

  perform assert(
    denied(bob, format('update public.water_goals set target_ml = 500 where id = %L', alice_goal)),
    'bob cannot edit alice''s water goal');

  perform assert(
    denied(bob, format(
      'insert into public.water_goals (user_id, effective_from, target_ml, source)
       values (%L, date ''2027-01-01'', 3000, ''manual'')', alice)),
    'bob cannot write a water goal into alice''s history');

  perform assert(
    denied(alice, format(
      'update public.water_goals set user_id = %L where id = %L', bob, alice_goal)),
    'alice cannot reassign her water goal to bob');

  perform assert(
    denied(alice, format('delete from public.water_goals where id = %L', alice_goal)),
    'nobody may hard-delete a water goal period');

  -- Alice removes her own entry the supported way.
  set local role authenticated;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', alice)::text, true);
  update public.water_logs set deleted_at = now()
   where id = (select id from public.water_logs where user_id = alice limit 1);
  reset role;

  perform assert(
    visible_rows(alice,
      'select * from public.water_logs where deleted_at is not null') >= 1,
    'she removes an entry by soft-deleting it, which is what synchronises');
end $$;

do $$
begin
  perform assert(
    (select count(*) from information_schema.role_table_grants
      where table_name in ('water_logs', 'water_goals') and grantee = 'anon') = 0,
    'anonymous callers have no grant on either water table');
end $$;

-- =========================================================================
-- 5. Schema invariants
-- =========================================================================

\echo ''
\echo '=== schema invariants ==='

do $$
begin
  perform assert(
    (select relrowsecurity from pg_class where oid = 'public.water_logs'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.water_goals'::regclass),
    'RLS is enabled on both water tables');

  perform assert(
    (select count(*) from pg_policies
      where tablename in ('water_logs', 'water_goals') and cmd = 'DELETE') = 0,
    'neither has a delete policy');

  perform assert(
    (select count(*) from pg_policies
      where tablename in ('water_logs', 'water_goals')
        and cmd in ('INSERT', 'UPDATE') and with_check is null) = 0,
    'every insert/update policy sets WITH CHECK');

  perform assert(
    (select count(*) from pg_constraint
      where conrelid = 'public.water_goals'::regclass and contype = 'x') = 1,
    'water goals carry the no-overlap exclusion constraint');

  perform assert(
    (select confdeltype from pg_constraint
      where conrelid = 'public.water_logs'::regclass
        and confrelid = 'public.profiles'::regclass) = 'c',
    'deleting an account removes its water logs');
end $$;

do $$
begin
  /*
   * The reuse assertion. Both tables resolve their local day through the same
   * function, which is the point of generalising it — a second copy is how the
   * DST and travel behaviour drifts apart between two features that are meant
   * to agree.
   */
  perform assert(
    (select count(*) from pg_trigger tg
      join pg_class c on c.oid = tg.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and not tg.tgisinternal
       and tg.tgfoid = 'public.resolve_local_date'::regproc) = 2,
    'food_logs and water_logs share one local-date resolver');

  perform assert(
    not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'resolve_food_log_day'),
    'and the implementation it replaced is gone, not left lying around');
end $$;

do $$
declare bob uuid := (select id from actors where name = 'bob');
begin
  perform assert(
    (select count(*) from public.water_logs where user_id = bob) > 0,
    'bob has water logs to lose');

  delete from auth.users where id = bob;

  perform assert(
    (select count(*) from public.water_logs where user_id = bob) = 0,
    'deleting the account removes the water logs with it');
end $$;

\echo ''
\echo 'All water checks passed.'

rollback;
