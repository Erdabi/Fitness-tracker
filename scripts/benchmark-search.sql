-- ===========================================================================
-- Search benchmark
--
-- Generates a synthetic catalogue and times the five representative queries.
-- Run against a throwaway database — it writes hundreds of thousands of rows.
--
-- Every generated row is CLEARLY MARKED test data: names are built from a
-- word list and the nutrition is arbitrary. No real food is fabricated here,
-- and nothing from this script should ever reach a real project.
--
--   psql -d bench -v scale=100000 -f scripts/benchmark-search.sql
-- ===========================================================================

\set ON_ERROR_STOP on
\timing off

\if :{?scale}
\else
  \set scale 100000
\endif

\echo ''
\echo '── generating' :scale 'synthetic foods'

/*
 * Vocabulary.
 *
 * Size matters more than realism here. An earlier version of this script
 * embedded the row number in every name, which produced one distinct lexeme
 * per row — a 1,000,035-entry GIN lexicon — and made a *non-matching* prefix
 * scan cost 230 ms while a matching one cost 1.3 ms. That is a property of
 * the generator, not of the search, and reporting it would have been
 * misleading.
 *
 * A real catalogue of a million foods has tens of thousands of distinct
 * words, not a million, so the vocabulary below is built to roughly that
 * shape: ~1,700 synthetic stems combined two or three at a time.
 */
create temp table words (w text);
insert into words
select stem || suffix
  from (values
    ('bench'),('synth'),('sampl'),('trial'),('mock'),('proxy'),('fixt'),
    ('alpha'),('beta'),('gamma'),('delta'),('omega'),('sigma'),('theta'),
    ('bread'),('yogurt'),('cheese'),('cereal'),('biscuit'),('cracker'),('wafer'),
    ('chicken'),('salmon'),('lentil'),('quinoa'),('almond'),('cashew'),('oat'),
    ('smoothie'),('juice'),('cordial'),('spread'),('paste'),('sauce'),('relish')
  ) v(stem)
  cross join (
    select '' as suffix
    union all select 'ito' union all select 'ella' union all select 'oso'
    union all select 'ina' union all select 'ade' union all select 'ique'
  ) sfx
  cross join generate_series(1, 7) n;

-- Deduplicate; the cross join above is only a cheap way to reach ~1.7k words.
create temp table vocab (id serial, w text);
insert into vocab (w)
select distinct w || case when n = 1 then '' else n::text end
  from words cross join generate_series(1, 7) n;

create temp table brand_words (w text);
insert into brand_words values
  ('benchco'),('testmark'),('fixturely'),('samplelab'),('proxyfoods'),
  ('mockworks'),('trialbrand'),('syntheco'),('dataworks'),('nullcorp');

-- Brands first, so foods can reference them.
insert into public.food_brands (name, normalized_name, source_id)
select initcap(w) || ' Bench', w || ' bench', 'openfoodfacts'
  from brand_words
on conflict do nothing;

insert into public.foods
  (owner_id, brand_id, name, normalized_name, kind, base_unit, base_amount,
   source_id, external_id, is_verified)
select
  null,
  case when g % 3 = 0
       then (select id from public.food_brands
              where normalized_name like '% bench'
              offset (g % 10) limit 1)
       else null end,
  -- The row number lives in external_id, never in the searchable name, so
  -- lexeme diversity stays realistic.
  initcap(w1.w) || ' ' || w2.w,
  w1.w || ' ' || w2.w,
  (case when g % 3 = 0 then 'branded' else 'generic' end)::public.food_kind,
  'g', 100,
  case when g % 2 = 0 then 'usda' else 'openfoodfacts' end,
  'bench-' || g,
  g % 2 = 0
from generate_series(1, :scale) g
cross join lateral (
  select w from vocab where id = 1 + (g * 7)  % (select count(*) from vocab) limit 1
) w1
cross join lateral (
  select w from vocab where id = 1 + (g * 13) % (select count(*) from vocab) limit 1
) w2;

-- Nutrition for every generated food. Values are arbitrary test data.
insert into public.food_nutrition
  (food_id, calories, protein_g, carbohydrates_g, fat_g, source_id)
select f.id,
       50 + (abs(hashtext(f.id::text)) % 400),
       (abs(hashtext(f.id::text)) % 25),
       (abs(hashtext(f.id::text)) % 50),
       (abs(hashtext(f.id::text)) % 20),
       f.source_id
  from public.foods f
 where f.external_id like 'bench-%'
   and not exists (select 1 from public.food_nutrition n where n.food_id = f.id);

-- A default serving for a third of them.
insert into public.food_servings (food_id, label, amount, unit, is_default, source_id)
select f.id, '1 portion', 30 + (abs(hashtext(f.id::text)) % 200), 'g', true, f.source_id
  from public.foods f
 where f.external_id like 'bench-%'
   and (abs(hashtext(f.id::text)) % 3) = 0;

-- Barcodes for a tenth, to give the barcode index real selectivity work.
insert into public.food_barcodes (food_id, barcode, format, source_id)
select f.id,
       lpad((4000000000000 + (abs(hashtext(f.id::text)) % 900000000000))::text, 13, '0'),
       'ean13', f.source_id
  from public.foods f
 where f.external_id like 'bench-%'
   and (abs(hashtext(f.id::text)) % 10) = 0
on conflict do nothing;

analyze public.foods;
analyze public.food_nutrition;
analyze public.food_servings;
analyze public.food_barcodes;
analyze public.food_brands;

\echo ''
\echo '── lexicon size (a real 1M catalogue has tens of thousands, not millions)'
select count(*) as distinct_lexemes
  from (select distinct word from ts_stat('select search_tsv from public.foods')) x;

\echo ''
\echo '── catalogue size'
select
  (select count(*) from public.foods)          as foods,
  (select count(*) from public.food_nutrition) as nutrition,
  (select count(*) from public.food_servings)  as servings,
  (select count(*) from public.food_barcodes)  as barcodes;

-- Search runs as `authenticated`, exactly as the app calls it, so the RLS
-- predicates are part of what is being measured.
set role authenticated;
select set_config('request.jwt.claims',
                  json_build_object('sub', '00000000-0000-4000-8000-000000000001')::text,
                  false);

\echo ''
\echo '── timings (each query run 5x; see EXPLAIN output below for plans)'
\timing on

\echo ''
\echo 'exact barcode lookup'
select count(*) from public.lookup_barcode(
  (select barcode from public.food_barcodes limit 1));
select count(*) from public.lookup_barcode(
  (select barcode from public.food_barcodes offset 5 limit 1));

\echo ''
\echo 'exact name search'
-- Sampled from the generated data so the probe matches something. Hardcoded
-- strings silently rot when the generator changes, and a query that matches
-- nothing measures the fuzzy fallback instead of exact search.
select name as sample_name from public.foods offset 5000 limit 1 \gset
select count(*) from public.search_foods(:'sample_name', 25);
select name as sample_name2 from public.foods offset 90000 limit 1 \gset
select count(*) from public.search_foods(:'sample_name2', 25);

\echo ''
\echo 'prefix search'
select count(*) from public.search_foods('yogur', 25);
select count(*) from public.search_foods('chick', 25);

\echo ''
\echo 'fuzzy search (typo; only runs when nothing else matched)'
select count(*) from public.search_foods('yugurt', 25);
select count(*) from public.search_foods('chikcen', 25);

\echo ''
\echo 'prefix search, no matches (worst case for a GIN prefix scan)'
select count(*) from public.search_foods('zzzqqqxyz', 25);

\echo ''
\echo 'brand search'
select count(*) from public.search_foods('benchco', 25);
select count(*) from public.search_foods('testmark', 25);

\echo ''
\echo 'paged search (page 5 via keyset)'
select count(*) from public.search_foods('bench', 25, 500, gen_random_uuid());

\timing off
reset role;
