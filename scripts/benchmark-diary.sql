-- ===========================================================================
-- Server-side diary aggregation.
--
-- The app aggregates locally — the diary is offline-first and the device holds
-- the rows — so nothing on the interactive path runs here. What this checks is
-- that the day index does the job it was built for, because a server-side
-- rollup is exactly what a web client or a multi-year chart would need next,
-- and an index that turns out not to cover the query is better discovered now.
--
--   createdb bench_diary && psql -d bench_diary -f supabase/tests/harness.sql
--   for f in supabase/migrations/*.sql; do psql -q -d bench_diary -f "$f"; done
--   psql -d bench_diary -v entries=100000 -f scripts/benchmark-diary.sql
-- ===========================================================================

\set ON_ERROR_STOP on
\if :{?entries} \else \set entries 100000 \endif

\echo ''
\echo 'Generating synthetic diary entries (clearly marked test data)…'

do $$
declare
  target int := current_setting('bench.entries')::int;
  owner  uuid;
begin
  insert into auth.users (email) values ('bench@example.com') returning id into owner;
  perform set_config('bench.user', owner::text, false);

  insert into public.food_logs
    (user_id, meal, logged_at, time_zone, diary_date, quantity, serving_label,
     serving_amount, food_name, food_source_id, basis_unit, basis_amount,
     basis_calories, basis_protein_g, basis_carbohydrates_g, basis_fat_g,
     basis_fiber_g)
  select
    owner,
    (array['breakfast','lunch','dinner','snack'])[1 + (i % 4)]::public.meal_slot,
    timestamptz '2026-06-15 08:00:00+02' - ((i / 5) || ' days')::interval,
    'Europe/Zurich',
    (date '2026-06-15' - (i / 5)),
    50 + (i % 200),
    'g',
    1,
    'Benchmark food ' || (i % 300),
    'usda',
    'g',
    100,
    50 + (i % 300),
    i % 25,
    i % 60,
    i % 15,
    case when i % 4 = 0 then null else i % 8 end
  from generate_series(0, target - 1) as i;
end $$;

analyze public.food_logs;

\echo ''
\echo '=== one day, grouped by meal ==='
explain (analyze, buffers, costs off)
select meal, count(*), sum(calories), sum(protein_g), sum(carbohydrates_g), sum(fat_g)
  from public.food_logs
 where user_id = current_setting('bench.user')::uuid
   and diary_date = date '2026-06-15'
   and deleted_at is null
 group by meal;

\echo ''
\echo '=== 30 days, grouped by day ==='
explain (analyze, buffers, costs off)
select diary_date, count(*), sum(calories), sum(protein_g), sum(carbohydrates_g), sum(fat_g)
  from public.food_logs
 where user_id = current_setting('bench.user')::uuid
   and diary_date between date '2026-05-17' and date '2026-06-15'
   and deleted_at is null
 group by diary_date
 order by diary_date;

\echo ''
\echo '=== 365 days, grouped by day ==='
explain (analyze, buffers, costs off)
select diary_date, count(*), sum(calories)
  from public.food_logs
 where user_id = current_setting('bench.user')::uuid
   and diary_date between date '2025-06-16' and date '2026-06-15'
   and deleted_at is null
 group by diary_date
 order by diary_date;
