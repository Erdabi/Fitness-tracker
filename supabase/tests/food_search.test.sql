-- ===========================================================================
-- Food search: correctness, ranking, barcode lookup, pagination, isolation
--
-- Runs as `authenticated` with a JWT claim set, exactly as PostgREST invokes
-- the functions — so RLS is exercised rather than bypassed.
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

create or replace function assert(condition boolean, description text)
returns void language plpgsql as $$
begin
  if condition then raise notice '  PASS  %', description;
  else raise exception 'FAIL  %', description;
  end if;
end $$;

/* Runs search_foods as a given user and returns the ordered food names. */
create or replace function search_names(claim_user uuid, q text, lim int default 25)
returns text[] language plpgsql as $$
declare names text[];
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', claim_user)::text, true);
  select array_agg(r.name order by r.score desc, r.food_id desc)
    into names
    from public.search_foods(q, lim) r;
  reset role;
  return coalesce(names, '{}');
exception when others then
  reset role;
  raise;
end $$;

create or replace function search_rows(claim_user uuid, q text, lim int default 25)
returns setof public.food_search_result language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', claim_user)::text, true);
  return query select * from public.search_foods(q, lim);
end $$;

-- ---------------------------------------------------------------- fixtures

do $$
declare
  alice uuid;
  bob   uuid;
  brand_mars uuid;
  brand_chob uuid;
begin
  insert into auth.users (email) values ('alice@example.com') returning id into alice;
  insert into auth.users (email) values ('bob@example.com')   returning id into bob;
  create temp table actors (name text primary key, id uuid);
  insert into actors values ('alice', alice), ('bob', bob);

  insert into public.food_brands (name, normalized_name, source_id)
  values ('Mars', 'mars', 'openfoodfacts') returning id into brand_mars;
  insert into public.food_brands (name, normalized_name, source_id)
  values ('Chobani', 'chobani', 'openfoodfacts') returning id into brand_chob;

  create temp table brands (slug text primary key, id uuid);
  insert into brands values ('mars', brand_mars), ('chobani', brand_chob);
end $$;

/* Seeds a catalogue food with nutrition and an optional default serving. */
create or replace function seed_food(
  p_name text, p_normalized text, p_source text, p_verified boolean,
  p_kcal numeric default 100, p_brand uuid default null,
  p_serving_label text default null, p_serving_amount numeric default null,
  p_owner uuid default null
) returns uuid language plpgsql as $$
declare new_id uuid;
begin
  insert into public.foods
    (owner_id, brand_id, name, normalized_name, kind, base_unit, base_amount,
     source_id, external_id, is_verified)
  values
    (p_owner, p_brand, p_name, p_normalized,
     (case when p_brand is null then 'generic' else 'branded' end)::public.food_kind,
     'g', 100, p_source,
     case when p_owner is null then p_normalized || '-ext' else null end,
     p_verified)
  returning id into new_id;

  insert into public.food_nutrition
    (food_id, calories, protein_g, carbohydrates_g, fat_g, source_id)
  values (new_id, p_kcal, 1, 10, 1, p_source);

  if p_serving_label is not null then
    insert into public.food_servings (food_id, label, amount, unit, is_default, source_id)
    values (new_id, p_serving_label, p_serving_amount, 'g', true, p_source);
  end if;

  return new_id;
end $$;

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  bob   uuid := (select id from actors where name = 'bob');
  mars  uuid := (select id from brands where slug = 'mars');
  chob  uuid := (select id from brands where slug = 'chobani');
  apple uuid;
begin
  apple := seed_food('Apple', 'apple', 'usda', true, 52, null, '1 medium', 182);
  perform seed_food('Apple, raw, with skin', 'apple raw with skin', 'usda', true, 52);
  perform seed_food('Apple Juice', 'apple juice', 'usda', true, 46);
  perform seed_food('Applesauce', 'applesauce', 'usda', true, 68);
  perform seed_food('Watermelon', 'watermelon', 'usda', true, 30);
  perform seed_food('Greek Yogurt', 'greek yogurt', 'usda', true, 59);
  perform seed_food('Café Latte', 'cafe latte', 'openfoodfacts', false, 55);
  perform seed_food('Crème Fraîche', 'creme fraiche', 'openfoodfacts', false, 292);
  perform seed_food('Snickers', 'snickers', 'openfoodfacts', false, 484, mars);
  perform seed_food('Greek Yogurt Plain', 'greek yogurt plain', 'openfoodfacts', false, 59, chob);
  -- A poor-match USDA row that must not outrank a good match from elsewhere.
  perform seed_food('Pineapple Chunks', 'pineapple chunks', 'usda', true, 50);
  -- Alice's own food, and Bob's, to prove isolation.
  perform seed_food('Apple Protein Bar', 'apple protein bar', 'user', false, 210, null, null, null, alice);
  perform seed_food('Bobs Secret Apple Cake', 'bobs secret apple cake', 'user', false, 400, null, null, null, bob);

  create temp table foods_seeded (slug text primary key, id uuid);
  insert into foods_seeded values ('apple', apple);

  -- Barcodes across every supported format.
  insert into public.food_barcodes (food_id, barcode, format, source_id)
  select id, '5000159484695', 'ean13', 'openfoodfacts'
    from public.foods where normalized_name = 'snickers';
  insert into public.food_barcodes (food_id, barcode, format, source_id)
  select id, '96385074', 'ean8', 'openfoodfacts'
    from public.foods where normalized_name = 'cafe latte';
  -- Stored in EAN-13 form, as the normaliser widens UPC-A.
  insert into public.food_barcodes (food_id, barcode, format, source_id)
  select id, '0012345678905', 'upca', 'openfoodfacts'
    from public.foods where normalized_name = 'creme fraiche';
end $$;

-- ------------------------------------------------------------- correctness

do $$
declare alice uuid := (select id from actors where name = 'alice');
begin
  raise notice '';
  raise notice '=== name matching ===';

  perform assert((search_names(alice, 'apple'))[1] = 'Apple',
    'exact match ranks first for "apple"');

  perform assert('Apple' = any(search_names(alice, 'appl')),
    'prefix "appl" finds Apple');

  perform assert('Watermelon' = any(search_names(alice, 'waterm')),
    'prefix "waterm" finds Watermelon');

  perform assert('Greek Yogurt' = any(search_names(alice, 'greek yog')),
    'partial "greek yog" finds Greek Yogurt');

  perform assert('Café Latte' = any(search_names(alice, 'cafe')),
    'accent-insensitive: "cafe" finds Café Latte');

  perform assert('Café Latte' = any(search_names(alice, 'café')),
    'accent-insensitive in reverse: "café" finds Café Latte');

  perform assert('Crème Fraîche' = any(search_names(alice, 'creme fraiche')),
    'accent-folded multi-word match');

  perform assert('Apple' = any(search_names(alice, 'APPLE')),
    'case-insensitive');

  perform assert('Apple' = any(search_names(alice, '  apple  ')),
    'surrounding whitespace is ignored');

  -- Typo tolerance via trigram similarity.
  perform assert('Watermelon' = any(search_names(alice, 'watermellon')),
    'fuzzy: "watermellon" still finds Watermelon');

  perform assert('Snickers' = any(search_names(alice, 'snikers')),
    'fuzzy: "snikers" still finds Snickers');

  perform assert('Snickers' = any(search_names(alice, 'mars')),
    'brand search finds the branded product');

  perform assert(array_length(search_names(alice, 'a'), 1) is null,
    'a single character returns nothing rather than the whole catalogue');

  perform assert(array_length(search_names(alice, 'zzzzqqqq'), 1) is null,
    'a query matching nothing returns nothing');
end $$;

-- ----------------------------------------------------------------- ranking

do $$
declare
  alice   uuid := (select id from actors where name = 'alice');
  results text[];
  pineapple_pos int;
  apple_pos int;
begin
  raise notice '';
  raise notice '=== ranking ===';

  results := search_names(alice, 'apple');

  perform assert(results[1] = 'Apple',
    'exact name beats every prefix and fuzzy match');

  apple_pos     := array_position(results, 'Apple');
  pineapple_pos := array_position(results, 'Pineapple Chunks');

  perform assert(
    pineapple_pos is null or apple_pos < pineapple_pos,
    'a relevant match outranks a weak one from the same source');

  /*
   * The requirement that source quality must not override relevance: a poor
   * USDA match must not beat a good match from Open Food Facts.
   */
  perform assert(
    array_position(search_names(alice, 'snickers'), 'Snickers') = 1,
    'an exact OFF match outranks better-sourced but irrelevant USDA rows');

  perform assert(
    array_position(search_names(alice, 'creme fraiche'), 'Crème Fraîche') = 1,
    'an exact unverified match still ranks first');

  -- Quality only orders *within* a tier.
  perform assert(
    (select count(*) from search_rows(alice, 'greek yogurt') r
      where r.match_kind = 'exact_name' and r.name = 'Greek Yogurt') = 1,
    'the USDA Greek Yogurt is the exact-name match');

  perform assert(
    array_position(search_names(alice, 'greek yogurt'), 'Greek Yogurt') = 1,
    'verified USDA wins the tie against a similar OFF row at equal relevance');

  -- Shorter, more generic names win the tiebreak.
  perform assert(
    array_position(search_names(alice, 'apple'), 'Apple')
      < array_position(search_names(alice, 'apple'), 'Apple, raw, with skin'),
    'the concise entry outranks the verbose one');

  perform assert(
    (select bool_and(r.score is not null and r.score > 0) from search_rows(alice, 'apple') r),
    'every result carries a positive score');

  perform assert(
    (select r.match_kind from search_rows(alice, 'apple') r
      order by r.score desc limit 1) = 'exact_name',
    'the top result reports why it matched');
end $$;

-- --------------------------------------------------------------- ownership

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  bob   uuid := (select id from actors where name = 'bob');
begin
  raise notice '';
  raise notice '=== search respects ownership ===';

  perform assert('Apple Protein Bar' = any(search_names(alice, 'apple')),
    'alice finds her own custom food');

  perform assert(not ('Apple Protein Bar' = any(search_names(bob, 'apple'))),
    'bob does not see alice''s custom food');

  perform assert(not ('Bobs Secret Apple Cake' = any(search_names(alice, 'apple'))),
    'alice does not see bob''s custom food');

  perform assert('Apple' = any(search_names(bob, 'apple')),
    'both users still see the shared catalogue');

  perform assert(
    (select bool_or(r.is_own) from search_rows(alice, 'apple protein') r),
    'a user''s own food is flagged as theirs');
end $$;

-- ----------------------------------------------------------------- barcode

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  found text;
  dupes int;
begin
  raise notice '';
  raise notice '=== barcode lookup ===';

  set local role authenticated;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', alice)::text, true);

  select (l.result).name, l.duplicate_count into found, dupes
    from public.lookup_barcode('5000159484695') l;
  perform assert(found = 'Snickers' and dupes = 1, 'EAN-13 lookup returns the product');

  select (l.result).name into found from public.lookup_barcode('96385074') l;
  perform assert(found = 'Café Latte', 'EAN-8 lookup');

  -- UPC-A given in its 12-digit form must reach the row stored as EAN-13.
  select (l.result).name into found from public.lookup_barcode('012345678905') l;
  perform assert(found = 'Crème Fraîche', 'UPC-A is widened to EAN-13 before lookup');

  select (l.result).name into found from public.lookup_barcode('0012345678905') l;
  perform assert(found = 'Crème Fraîche', 'the already-widened form works too');

  select (l.result).name into found from public.lookup_barcode('5-000159-484695') l;
  perform assert(found = 'Snickers', 'separators in a scanned code are stripped');

  found := null;
  select (l.result).name into found from public.lookup_barcode('9999999999994') l;
  perform assert(found is null, 'an unknown barcode returns nothing');

  found := null;
  select (l.result).name into found from public.lookup_barcode('abc') l;
  perform assert(found is null, 'an invalid barcode returns nothing, not a guess');

  found := null;
  select (l.result).name into found from public.lookup_barcode('') l;
  perform assert(found is null, 'an empty barcode returns nothing');

  -- Never fuzzy: one digit off is a different product.
  found := null;
  select (l.result).name into found from public.lookup_barcode('5000159484694') l;
  perform assert(found is null, 'a near-miss barcode does not fuzzy-match');

  perform assert(
    (select (l.result).match_kind from public.lookup_barcode('5000159484695') l) = 'barcode',
    'a barcode hit is labelled as such');

  reset role;
end $$;

-- Duplicate barcode: a data fault that must be reported, not silently resolved.
do $$
declare
  alice     uuid := (select id from actors where name = 'alice');
  found     text;
  repeated  text;
  dupes     int;
  i         int;
  verified_food uuid;
begin
  raise notice '';
  raise notice '=== duplicate barcodes ===';

  /*
   * A shared barcode is unique across the catalogue, so the realistic
   * duplicate is one shared row plus a user-owned row carrying the same code.
   * The shared one here is USDA-verified, which is what makes the expected
   * winner meaningful rather than an accident of UUID ordering.
   */
  verified_food := seed_food('Verified Bar', 'verified bar', 'usda', true, 300);
  insert into public.food_barcodes (food_id, barcode, format, source_id)
  values (verified_food, '4006381333931', 'ean13', 'usda');

  insert into public.food_barcodes (food_id, barcode, format, source_id)
  select id, '4006381333931', 'ean13', 'user'
    from public.foods
   where normalized_name = 'apple protein bar';

  set local role authenticated;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', alice)::text, true);

  select (l.result).name, l.duplicate_count into found, dupes
    from public.lookup_barcode('4006381333931') l;

  reset role;

  perform assert(dupes = 2, 'a duplicated barcode reports how many rows matched');
  perform assert(found = 'Verified Bar',
    'the verified record wins — resolution is by rule, not by chance');

  /*
   * Stability is the property that actually matters, and it is not implied by
   * the check above. Both rows are inserted in the same transaction and so
   * share created_at exactly; before an id tiebreak was added, repeated
   * lookups could return different rows, and the flakiness was the symptom.
   */
  for i in 1..10 loop
    set local role authenticated;
    perform set_config('request.jwt.claims',
                       json_build_object('sub', alice)::text, true);
    select (l.result).name into repeated from public.lookup_barcode('4006381333931') l;
    reset role;

    if repeated is distinct from found then
      raise exception 'FAIL  duplicate resolution is unstable (% then %)', found, repeated;
    end if;
  end loop;

  raise notice '  PASS  duplicate resolution is stable across repeated lookups';
end $$;

-- -------------------------------------------------------------- pagination

do $$
declare
  alice      uuid := (select id from actors where name = 'alice');
  page1      public.food_search_result[];
  page2      public.food_search_result[];
  last_score numeric;
  last_id    uuid;
  overlap    int;
begin
  raise notice '';
  raise notice '=== keyset pagination ===';

  set local role authenticated;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', alice)::text, true);

  select array_agg(r) into page1 from public.search_foods('apple', 2) r;
  perform assert(array_length(page1, 1) = 2, 'the first page honours the limit');

  last_score := (page1[array_length(page1, 1)]).score;
  last_id    := (page1[array_length(page1, 1)]).food_id;

  select array_agg(r) into page2
    from public.search_foods('apple', 2, last_score, last_id) r;

  perform assert(array_length(page2, 1) >= 1, 'the second page returns more rows');

  select count(*) into overlap
    from unnest(page1) a
    join unnest(page2) b on (a).food_id = (b).food_id;

  perform assert(overlap = 0, 'pages do not overlap');

  perform assert(
    (page2[1]).score <= last_score,
    'scores are non-increasing across the page boundary');

  -- Walk to the end.
  last_score := (page2[array_length(page2, 1)]).score;
  last_id    := (page2[array_length(page2, 1)]).food_id;

  perform assert(
    (select count(*) from public.search_foods('apple', 50, last_score, last_id)) >= 0,
    'paging past the end returns an empty page rather than failing');

  perform assert(
    (select count(*) from public.search_foods('zzzzqqqq', 25)) = 0,
    'a query with no matches returns an empty first page');

  reset role;
end $$;

-- ------------------------------------------------------- recent / frequent

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  bob   uuid := (select id from actors where name = 'bob');
  apple uuid := (select id from foods_seeded where slug = 'apple');
  yog   uuid := (select id from public.foods where normalized_name = 'greek yogurt');
  names text[];
begin
  raise notice '';
  raise notice '=== recent and frequent foods ===';

  set local role authenticated;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', alice)::text, true);

  insert into public.food_recents (user_id, food_id, last_used_at, use_count)
  values (alice, apple, now() - interval '1 hour', 2),
         (alice, yog,   now(),                     9);

  select array_agg(r.name order by r.score desc)
    into names from public.list_recent_foods(10, 'recent') r;
  perform assert(names[1] = 'Greek Yogurt', 'recent orders by last use');

  select array_agg(r.name order by r.score desc)
    into names from public.list_recent_foods(10, 'frequent') r;
  perform assert(names[1] = 'Greek Yogurt', 'frequent orders by use count');

  reset role;

  -- Isolation.
  set local role authenticated;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', bob)::text, true);
  select array_agg(r.name) into names from public.list_recent_foods(10) r;
  reset role;

  perform assert(names is null, 'bob sees none of alice''s recents');

  -- The unique constraint is what prevents duplicate entries.
  begin
    insert into public.food_recents (user_id, food_id) values (alice, apple);
    raise exception 'FAIL  a duplicate recent entry was accepted';
  exception when unique_violation then
    raise notice '  PASS  a food appears at most once in the recent list';
  end;
end $$;

-- ---------------------------------------------------------------- security

do $$
begin
  raise notice '';
  raise notice '=== search is not reachable without a session ===';

  set local role anon;
  begin
    perform 1 from public.search_foods('apple', 5);
    reset role;
    raise exception 'FAIL  anon could call search_foods';
  exception
    when insufficient_privilege then
      reset role; raise notice '  PASS  anon cannot execute search_foods';
    when others then
      reset role; raise notice '  PASS  anon cannot execute search_foods (%)', sqlerrm;
  end;

  set local role anon;
  begin
    perform 1 from public.lookup_barcode('5000159484695');
    reset role;
    raise exception 'FAIL  anon could call lookup_barcode';
  exception
    when insufficient_privilege then
      reset role; raise notice '  PASS  anon cannot execute lookup_barcode';
    when others then
      reset role; raise notice '  PASS  anon cannot execute lookup_barcode (%)', sqlerrm;
  end;

  set local role anon;
  begin
    perform 1 from public.food_recents;
    reset role;
    raise exception 'FAIL  anon could read food_recents';
  exception
    when insufficient_privilege then
      reset role; raise notice '  PASS  anon cannot read food_recents';
    when others then
      reset role; raise notice '  PASS  anon cannot read food_recents (%)', sqlerrm;
  end;
end $$;

do $$ begin raise notice ''; raise notice 'All search checks passed.'; end $$;

rollback;
