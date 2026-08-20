-- ===========================================================================
-- Food catalogue: ownership, protection of shared data, and source quality
--
-- The shared catalogue is the part most worth proving. It is readable by
-- everyone and writable by no one, and "writable by no one" is a claim that
-- only a test can support — a missing policy and a correct one look identical
-- until someone tries the write.
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
  alice     uuid;
  bob       uuid;
  global_id uuid := '00000000-0000-4000-8000-00000000f001';
begin
  insert into auth.users (email) values ('alice@example.com') returning id into alice;
  insert into auth.users (email) values ('bob@example.com')   returning id into bob;

  create temp table actors (name text primary key, id uuid);
  insert into actors values ('alice', alice), ('bob', bob),
                            ('global_food', global_id);

  -- Shared catalogue rows, written as the service role would during an import.
  insert into public.foods
    (id, owner_id, name, normalized_name, kind, base_unit, base_amount,
     source_id, external_id, is_verified)
  values
    (global_id, null, 'Rolled Oats', 'rolled oats', 'generic', 'g', 100,
     'usda', '169705', true);

  insert into public.food_nutrition
    (food_id, calories, protein_g, carbohydrates_g, fat_g, fiber_g, source_id)
  values (global_id, 379, 13.2, 67.7, 6.5, 10.1, 'usda');

  insert into public.food_servings (food_id, label, amount, unit, is_default, source_id)
  values (global_id, '1 cup', 81, 'g', true, 'usda');

  insert into public.food_barcodes (food_id, barcode, format, source_id)
  values (global_id, '0123456789012', 'ean13', 'usda');
end $$;

-- ------------------------------------------------- shared catalogue reads

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  bob   uuid := (select id from actors where name = 'bob');
  food  uuid := (select id from actors where name = 'global_food');
begin
  raise notice '';
  raise notice '=== the shared catalogue is readable by everyone ===';

  perform assert(
    visible_rows(alice, format('select 1 from public.foods where id = %L', food)) = 1,
    'alice can read a shared food');

  perform assert(
    visible_rows(bob, format('select 1 from public.foods where id = %L', food)) = 1,
    'bob can read the same shared food');

  perform assert(
    visible_rows(alice, format(
      'select 1 from public.food_nutrition where food_id = %L', food)) = 1,
    'alice can read its nutrition');

  perform assert(
    visible_rows(alice, format(
      'select 1 from public.food_servings where food_id = %L', food)) = 1,
    'alice can read its servings');

  perform assert(
    visible_rows(alice, format(
      'select 1 from public.food_barcodes where food_id = %L', food)) = 1,
    'alice can read its barcodes');

  perform assert(
    visible_rows(alice, 'select 1 from public.food_sources') >= 4,
    'alice can read source and licensing metadata');
end $$;

-- --------------------------------------------- shared catalogue is read-only

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  food  uuid := (select id from actors where name = 'global_food');
begin
  raise notice '';
  raise notice '=== nobody can modify the shared catalogue ===';

  perform assert(
    denied(alice, format(
      'update public.foods set name = ''Tampered'' where id = %L', food)),
    'alice cannot rename a shared food');

  perform assert(
    (select name from public.foods where id = food) = 'Rolled Oats',
    'the shared food is untouched');

  perform assert(
    denied(alice, format(
      'update public.food_nutrition set calories = 1 where food_id = %L', food)),
    'alice cannot alter shared nutrition');

  perform assert(
    (select calories from public.food_nutrition where food_id = food) = 379,
    'shared nutrition is untouched');

  perform assert(
    denied(alice, format(
      'update public.food_servings set amount = 999 where food_id = %L', food)),
    'alice cannot alter a shared serving');

  perform assert(
    denied(alice, format(
      'update public.food_barcodes set barcode = ''9999999999999'' where food_id = %L',
      food)),
    'alice cannot alter a shared barcode');

  -- Creating a null-owner row would inject data into everyone's catalogue.
  perform assert(
    denied(alice,
      'insert into public.foods (owner_id, name, normalized_name, base_unit, source_id)
       values (null, ''Injected'', ''injected'', ''g'', ''user'')'),
    'alice cannot create a shared (unowned) food');

  perform assert(
    denied(alice, format(
      'insert into public.foods (owner_id, name, normalized_name, base_unit, source_id)
       values (%L, ''Fake USDA'', ''fake usda'', ''g'', ''usda'')', alice)),
    'alice cannot attribute her own food to USDA');

  perform assert(
    denied(alice, format(
      'insert into public.foods
         (owner_id, name, normalized_name, base_unit, source_id, is_verified)
       values (%L, ''Self Verified'', ''self verified'', ''g'', ''user'', true)', alice)),
    'alice cannot mark her own food verified');

  perform assert(
    denied(alice, 'delete from public.foods'),
    'there is no delete path for foods — removal is a soft delete');
end $$;

-- --------------------------------------------------------- own custom foods

do $$
declare
  alice     uuid := (select id from actors where name = 'alice');
  bob       uuid := (select id from actors where name = 'bob');
  alice_food uuid;
begin
  raise notice '';
  raise notice '=== users own their custom foods ===';

  set local role authenticated;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', alice)::text, true);

  insert into public.foods
    (owner_id, name, normalized_name, kind, base_unit, base_amount, source_id)
  values (alice, 'Protein Pancake', 'protein pancake', 'generic', 'g', 100, 'user')
  returning id into alice_food;

  insert into public.food_nutrition
    (food_id, calories, protein_g, carbohydrates_g, fat_g, source_id)
  values (alice_food, 210, 18, 22, 5, 'user');

  insert into public.food_servings (food_id, label, amount, unit, is_default, source_id)
  values (alice_food, '1 pancake', 85, 'g', true, 'user');

  reset role;

  insert into actors values ('alice_food', alice_food);

  perform assert(true, 'alice can create a food, its nutrition and a serving');

  perform assert(
    visible_rows(alice, format('select 1 from public.foods where id = %L', alice_food)) = 1,
    'alice can read her own food');

  perform assert(
    visible_rows(bob, format('select 1 from public.foods where id = %L', alice_food)) = 0,
    'bob cannot read alice''s food');

  perform assert(
    visible_rows(bob, format(
      'select 1 from public.food_nutrition where food_id = %L', alice_food)) = 0,
    'bob cannot read the nutrition of alice''s food');

  perform assert(
    visible_rows(bob, format(
      'select 1 from public.food_servings where food_id = %L', alice_food)) = 0,
    'bob cannot read the servings of alice''s food');

  perform assert(
    denied(bob, format(
      'update public.foods set name = ''Stolen'' where id = %L', alice_food)),
    'bob cannot modify alice''s food');

  perform assert(
    denied(bob, format(
      'update public.food_nutrition set calories = 1 where food_id = %L', alice_food)),
    'bob cannot modify the nutrition of alice''s food');

  -- USING alone would allow this: alice owns the row before the update.
  perform assert(
    denied(alice, format(
      'update public.foods set owner_id = %L where id = %L', bob, alice_food)),
    'alice cannot hand her food to bob (WITH CHECK holds)');

  perform assert(
    denied(alice, format(
      'update public.foods set is_verified = true where id = %L', alice_food)),
    'alice cannot promote her food to verified');

  perform assert(
    denied(alice, format(
      'update public.foods set source_id = ''usda'' where id = %L', alice_food)),
    'alice cannot relabel her food as USDA data');

  perform assert(
    not denied(alice, format(
      'update public.foods set name = ''Protein Pancake v2'' where id = %L', alice_food)),
    'alice can rename her own food');
end $$;

-- ------------------------------------------------ nutrition quality guard

do $$
declare
  food uuid := (select id from actors where name = 'global_food');
begin
  raise notice '';
  raise notice '=== source quality is enforced by the database ===';

  -- Runs as the table owner, i.e. with more privilege than any importer: if
  -- the guard holds here it holds everywhere.
  begin
    update public.food_nutrition
       set source_id = 'ai_estimated', confidence = 0.6, calories = 400
     where food_id = food;
    raise exception 'FAIL  an AI estimate replaced USDA nutrition';
  exception
    when check_violation then
      raise notice '  PASS  an AI estimate cannot replace USDA nutrition';
  end;

  perform assert(
    (select calories from public.food_nutrition where food_id = food) = 379,
    'the USDA values are intact after the rejected downgrade');

  -- Same source is a refresh, not a downgrade.
  update public.food_nutrition set calories = 380 where food_id = food;
  perform assert(
    (select calories from public.food_nutrition where food_id = food) = 380,
    'the same source may refresh its own values');

  -- Open Food Facts (70) is also below USDA (100), so it is refused too —
  -- the guard is about rank, not about AI specifically.
  begin
    update public.food_nutrition
       set source_id = 'openfoodfacts', calories = 381
     where food_id = food;
    raise exception 'FAIL  a lower-ranked source replaced USDA nutrition';
  exception
    when check_violation then
      raise notice '  PASS  Open Food Facts cannot replace USDA nutrition either';
  end;

  perform assert(
    (select source_id from public.food_nutrition where food_id = food) = 'usda',
    'nutrition still carries its USDA provenance');
end $$;

do $$
declare
  lower_food uuid := '00000000-0000-4000-8000-00000000f002';
begin
  -- The reverse direction: a better source may replace a weaker one.
  insert into public.foods
    (id, owner_id, name, normalized_name, base_unit, source_id, external_id)
  values (lower_food, null, 'Mystery Bar', 'mystery bar', 'g', 'ai_estimated', 'ai-1');

  insert into public.food_nutrition
    (food_id, calories, protein_g, carbohydrates_g, fat_g, source_id, confidence)
  values (lower_food, 300, 5, 40, 12, 'ai_estimated', 0.4);

  update public.food_nutrition
     set source_id = 'usda', calories = 288, confidence = null
   where food_id = lower_food;

  perform assert(
    (select source_id from public.food_nutrition where food_id = lower_food) = 'usda',
    'a verified source may replace an AI estimate');

  perform assert(
    (select confidence from public.food_nutrition where food_id = lower_food) is null,
    'confidence is cleared when a measurement replaces an estimate');
end $$;

-- ------------------------------------------------------ schema invariants

do $$
declare
  food uuid := (select id from actors where name = 'global_food');
begin
  raise notice '';
  raise notice '=== catalogue invariants ===';

  -- Re-running an import must update, not duplicate.
  begin
    insert into public.foods
      (owner_id, name, normalized_name, base_unit, source_id, external_id)
    values (null, 'Rolled Oats Again', 'rolled oats again', 'g', 'usda', '169705');
    raise exception 'FAIL  a duplicate (source, external_id) was accepted';
  exception when unique_violation then
    raise notice '  PASS  (source_id, external_id) is unique — imports are idempotent';
  end;

  begin
    insert into public.food_barcodes (food_id, barcode, source_id)
    values (food, '0123456789012', 'usda');
    raise exception 'FAIL  a duplicate global barcode was accepted';
  exception when unique_violation then
    raise notice '  PASS  a barcode maps to at most one shared food';
  end;

  -- A serving with no weight cannot be converted, so it cannot be logged.
  begin
    insert into public.food_servings (food_id, label, amount, unit, source_id)
    values (food, '1 handful', 0, 'g', 'usda');
    raise exception 'FAIL  a zero-weight serving was accepted';
  exception when check_violation then
    raise notice '  PASS  a serving must carry a positive gram/ml equivalent';
  end;

  begin
    insert into public.food_servings (food_id, label, amount, unit, is_default, source_id)
    values (food, '1 bowl', 200, 'g', true, 'usda');
    raise exception 'FAIL  a second default serving was accepted';
  exception when unique_violation then
    raise notice '  PASS  a food has at most one default serving';
  end;

  begin
    insert into public.food_nutrition
      (food_id, calories, protein_g, carbohydrates_g, fat_g, saturated_fat_g, source_id)
    values ('00000000-0000-4000-8000-00000000f003', 100, 1, 1, 2, 50, 'usda');
    raise exception 'FAIL  saturated fat above total fat was accepted';
  exception when others then
    raise notice '  PASS  a component nutrient cannot exceed its total';
  end;

  begin
    insert into public.foods (owner_id, name, normalized_name, base_unit, base_amount, source_id)
    values (null, 'Egg', 'egg', 'item', 100, 'usda');
    raise exception 'FAIL  an item-based food with base_amount 100 was accepted';
  exception when check_violation then
    raise notice '  PASS  countable foods are described one at a time';
  end;

  perform assert(
    (select count(*) from public.food_sources where attribution_required
       and attribution_text is null) = 0,
    'every source requiring attribution carries its attribution text');

  perform assert(
    (select quality_rank from public.food_sources where id = 'usda') >
    (select quality_rank from public.food_sources where id = 'ai_estimated'),
    'USDA outranks AI estimates');
end $$;

-- ---------------------------------------------------------------- anon --

do $$
begin
  raise notice '';
  raise notice '=== anonymous callers get nothing ===';

  set local role anon;
  begin
    perform 1 from public.foods limit 1;
    reset role;
    raise exception 'FAIL  anon could read foods';
  exception
    when insufficient_privilege then
      reset role;
      raise notice '  PASS  anon is refused on foods';
    when others then
      reset role;
      raise notice '  PASS  anon is refused on foods (%)', sqlerrm;
  end;
end $$;

do $$ begin raise notice ''; raise notice 'All food catalogue checks passed.'; end $$;

rollback;
