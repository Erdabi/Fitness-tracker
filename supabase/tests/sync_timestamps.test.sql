-- ===========================================================================
-- The sync timestamp invariant
--
--   Every synchronised row receives a wall-clock `updated_at` on BOTH insert
--   and update, so no row can be committed behind an already-advanced pull
--   cursor.
--
-- This file holds ONE transaction open for longer than the engine's cursor
-- overlap window and then writes a synchronised row inside it — the exact
-- shape of the failure. It costs a few seconds of wall time, which is the
-- price of testing a property that is *about* wall time: there is no way to
-- prove a row survives a five-second window without five seconds passing.
--
-- The counterfactual is asserted too. It is not enough to show the row is
-- found now; the test also shows that under the previous `now()` semantics the
-- same row would have been missed. Otherwise a future regression could restore
-- the bug and this file would still pass.
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

/*
 * The engine's cursor overlap, mirrored.
 *
 * SYNC_CURSOR_LAG_MS in src/sync/engine.ts. If that constant changes, this
 * must change with it — the schema assertion at the end of this file is what
 * makes the coupling visible, and the sleep below must stay longer than it or
 * the counterfactual stops being a counterfactual.
 */
create or replace function sync_cursor_lag() returns interval
language sql immutable as $$ select interval '5 seconds' $$;

do $$
declare alice uuid;
begin
  insert into auth.users (email) values ('alice@example.com') returning id into alice;
  create temp table actors (name text primary key, id uuid);
  insert into actors values ('alice', alice);
end $$;

-- =========================================================================
-- 1. A row written late in a long transaction is not stranded
-- =========================================================================

\echo ''
\echo '=== a transaction held open past the cursor overlap window ==='

do $$
declare
  alice          uuid := (select id from actors where name = 'alice');
  txn_start      timestamptz;
  cursor_at      timestamptz;
  overlap_from   timestamptz;
  stamped        timestamptz;
  held_open      interval;
begin
  -- `now()` is transaction-start time, frozen for the whole transaction. It is
  -- also exactly what the column default used to write on insert.
  txn_start := now();

  -- Hold the transaction open past the overlap window. Everything below turns
  -- on this having genuinely elapsed, so it is asserted rather than assumed.
  perform pg_sleep(extract(epoch from sync_cursor_lag()) + 0.5);

  held_open := clock_timestamp() - txn_start;
  perform assert(
    held_open > sync_cursor_lag(),
    format('the transaction really has been open longer than the overlap window (%s)',
           justify_interval(held_open)));

  /*
   * The adversarial cursor: another device pulled while we were open, and the
   * cursor advanced to the newest row the server had — an instant before our
   * write lands. This is the worst case for the row about to be inserted.
   */
  cursor_at    := clock_timestamp();
  overlap_from := cursor_at - sync_cursor_lag();

  insert into public.weight_entries (user_id, measured_on, weight_kg)
  values (alice, current_date, 80)
  returning updated_at into stamped;

  -- The engine pulls `updated_at >= overlapFrom(cursor)`. See engine.ts.
  perform assert(
    stamped >= overlap_from,
    'the inserted row is inside the next pull''s window, so it cannot be stranded');

  perform assert(
    stamped >= cursor_at,
    'and it is newer than the cursor itself, so even a strict > cursor pull finds it');

  /*
   * The counterfactual. Under the old default the row would have carried
   * `txn_start`, which by now sits further behind the cursor than the overlap
   * window reaches back — the row would have been skipped by every subsequent
   * pull, permanently.
   */
  perform assert(
    txn_start < overlap_from,
    'under the previous now() semantics that same row WOULD have been stranded');

  perform assert(
    stamped - txn_start > sync_cursor_lag(),
    format('updated_at tracks wall time, not transaction start (%s behind)',
           justify_interval(stamped - txn_start)));
end $$;

\echo ''
\echo '=== the same holds for every synchronised table ==='

do $$
declare
  alice     uuid := (select id from actors where name = 'alice');
  txn_start timestamptz := now();
  food      uuid := '00000000-0000-4000-8000-0000000020a1';
begin
  -- The transaction is already old by this point; no further sleep needed.
  perform assert(
    clock_timestamp() - txn_start > sync_cursor_lag(),
    'this transaction is still older than the overlap window');

  insert into public.foods
    (id, owner_id, name, normalized_name, kind, base_unit, base_amount, source_id)
  values (food, null, 'Timestamp Probe', 'timestamp probe', 'generic', 'g', 100, 'usda');

  insert into public.food_nutrition (food_id, calories, source_id)
  values (food, 100, 'usda');

  insert into public.food_logs
    (user_id, meal, logged_at, time_zone, diary_date, quantity, serving_label,
     serving_amount, food_name, food_source_id, basis_unit, basis_amount, basis_calories)
  values (alice, 'lunch', clock_timestamp(), 'Europe/Zurich', current_date,
          100, 'g', 1, 'Timestamp Probe', 'usda', 'g', 100, 100);

  insert into public.nutrition_goals
    (user_id, effective_from, calorie_target, protein_target_g,
     carbohydrate_target_g, fat_target_g, source)
  values (alice, current_date, 2000, 140, 200, 60, 'manual');

  insert into public.food_recents (user_id, food_id) values (alice, food);

  perform assert(
    (select bool_and(updated_at - txn_start > sync_cursor_lag())
       from (
         select updated_at from public.foods           where id = food
         union all
         select updated_at from public.food_nutrition  where food_id = food
         union all
         select updated_at from public.food_logs       where user_id = alice
         union all
         select updated_at from public.nutrition_goals where user_id = alice
         union all
         select updated_at from public.food_recents    where user_id = alice
       ) stamps),
    'foods, food_nutrition, food_logs, nutrition_goals and food_recents all stamp wall-clock time on insert');
end $$;

-- =========================================================================
-- 2. The update path is unchanged
-- =========================================================================

\echo ''
\echo '=== update behaviour is exactly as it was ==='

do $$
declare
  alice  uuid := (select id from actors where name = 'alice');
  before timestamptz;
  after  timestamptz;
begin
  select updated_at into before from public.profiles where id = alice;

  perform pg_sleep(0.05);
  update public.profiles set display_name = 'Alice' where id = alice;
  select updated_at into after from public.profiles where id = alice;

  perform assert(after > before,
    'an update still advances updated_at within the same transaction');

  perform assert(after > now(),
    'and still uses clock_timestamp() rather than transaction start');
end $$;

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  stamped timestamptz;
begin
  -- Already true for updates; now true for inserts as well, which is what
  -- stops a client's own clock from ever entering the sync cursor.
  insert into public.weight_entries (user_id, measured_on, weight_kg, updated_at)
  values (alice, current_date - 30, 79, timestamptz '1999-01-01 00:00:00+00')
  returning updated_at into stamped;

  perform assert(stamped > now(),
    'a client-supplied updated_at is overwritten on INSERT, not just on UPDATE');

  update public.weight_entries
     set updated_at = timestamptz '1999-01-01 00:00:00+00'
   where user_id = alice and measured_on = current_date - 30
  returning updated_at into stamped;

  perform assert(stamped > now(),
    'and on UPDATE, as before');
end $$;

\echo ''
\echo '=== created_at was deliberately left alone ==='

do $$
declare
  alice   uuid := (select id from actors where name = 'alice');
  created timestamptz;
begin
  /*
   * `created_at` is not a sync cursor and was out of scope for this fix. The
   * two tables that use it as a resolution tiebreak — nutrition_goals and
   * weight_entries — already default to clock_timestamp(); the rest still use
   * now(), which is harmless for a column nothing pages by.
   *
   * Asserted so the scope of the change stays visible rather than being
   * rediscovered later as an inconsistency nobody meant.
   */
  select created_at into created from public.nutrition_goals where user_id = alice;
  perform assert(created > now(),
    'nutrition_goals.created_at is wall-clock, because goal resolution ties on it');

  select created_at into created from public.weight_entries
   where user_id = alice and measured_on = current_date;
  perform assert(created > now(),
    'weight_entries.created_at likewise');
end $$;

-- =========================================================================
-- 3. The invariant is enforced for tables that do not exist yet
-- =========================================================================

\echo ''
\echo '=== schema invariant ==='

do $$
declare
  uncovered text;
begin
  /*
   * The assertion that actually closes this. A table added later with an
   * `updated_at` column but no trigger would reintroduce exactly the defect
   * this file exists to prevent — silently, because it would look fine until
   * a row went missing. Here it fails the build instead.
   */
  select string_agg(c.relname, ', ' order by c.relname) into uncovered
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
                       and a.attname = 'updated_at'
                       and a.attnum > 0
                       and not a.attisdropped
   where n.nspname = 'public'
     and c.relkind = 'r'
     and not exists (
       select 1 from pg_trigger tg
        where tg.tgrelid = c.oid
          and not tg.tgisinternal
          and tg.tgfoid = 'public.set_updated_at'::regproc
     );

  perform assert(uncovered is null,
    coalesce('every table with updated_at has the trigger — missing: ' || uncovered,
             'every table with updated_at has the set_updated_at trigger'));
end $$;

do $$
declare
  insert_only text;
begin
  -- tgtype bit 2 (value 4) is INSERT, bit 4 (value 16) is UPDATE.
  select string_agg(c.relname, ', ' order by c.relname) into insert_only
    from pg_trigger tg
    join pg_class c     on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where tg.tgfoid = 'public.set_updated_at'::regproc
     and n.nspname = 'public'
     and not tg.tgisinternal
     and not ((tg.tgtype & 4) > 0 and (tg.tgtype & 16) > 0);

  perform assert(insert_only is null,
    coalesce('every set_updated_at trigger fires on both — wrong: ' || insert_only,
             'every set_updated_at trigger fires BEFORE INSERT OR UPDATE'));

  perform assert(
    (select count(*) from pg_trigger tg
      join pg_class c on c.oid = tg.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where tg.tgfoid = 'public.set_updated_at'::regproc
       and n.nspname = 'public' and not tg.tgisinternal) = 12,
    'all twelve synchronised tables are covered');
end $$;

do $$
begin
  perform assert(
    (select prosrc like '%clock_timestamp()%' and prosrc not like '%now()%'
       from pg_proc where oid = 'public.set_updated_at'::regproc),
    'set_updated_at uses clock_timestamp() and never now()');
end $$;

\echo ''
\echo 'All sync timestamp checks passed.'

rollback;
