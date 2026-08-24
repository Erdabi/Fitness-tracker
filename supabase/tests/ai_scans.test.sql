-- ===========================================================================
-- The AI scan ledger
--
-- The interesting property is asymmetric: a user may READ their own usage but
-- may not WRITE it. A quota a client can write is a quota a client can erase,
-- so the absence of an insert grant is the whole mechanism and is asserted
-- directly rather than assumed from the migration.
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

do $$
declare alice uuid; bob uuid;
begin
  insert into auth.users (email) values ('alice@example.com') returning id into alice;
  insert into auth.users (email) values ('bob@example.com')   returning id into bob;
  create temp table actors (name text primary key, id uuid);
  insert into actors values ('alice', alice), ('bob', bob);

  -- Written as the Edge Function does: with the service role, bypassing RLS.
  insert into public.ai_scan_requests
    (user_id, operation, outcome, image_bytes, input_tokens, output_tokens)
  values
    (alice, 'analyzeNutritionLabel', 'success', 240000, 1500, 320),
    (alice, 'analyzeFoodPhoto', 'needs_review', 310000, 1800, 410),
    (bob, 'analyzeNutritionLabel', 'unable_to_extract', 180000, 1200, 90);
end $$;

\echo ''
\echo '=== a user can see their own usage and nobody else''s ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  bob   uuid := (select id from actors where name = 'bob');
begin
  perform assert(
    visible_rows(alice, 'select * from public.ai_scan_requests') = 2,
    'alice sees her two scans');
  perform assert(
    visible_rows(bob, 'select * from public.ai_scan_requests') = 1,
    'bob sees only his own');
  perform assert(
    visible_rows(bob, format(
      'select * from public.ai_scan_requests where user_id = %L', alice)) = 0,
    'bob cannot read alice''s usage even by asking for it directly');
end $$;

\echo ''
\echo '=== but nobody can write their own quota ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  bob   uuid := (select id from actors where name = 'bob');
  row_id uuid;
begin
  select id into row_id from public.ai_scan_requests where user_id = alice limit 1;

  /*
   * The mechanism. A client that could insert here could also stop inserting,
   * and the daily limit would be a suggestion.
   */
  perform assert(
    denied(alice, format(
      'insert into public.ai_scan_requests (user_id, operation, outcome)
       values (%L, ''analyzeFoodPhoto'', ''success'')', alice)),
    'a user cannot record their own scan, which is what makes the quota real');

  perform assert(
    denied(alice, format(
      'delete from public.ai_scan_requests where id = %L', row_id)),
    'and cannot delete a scan to free up allowance');

  perform assert(
    denied(alice, format(
      'update public.ai_scan_requests set created_at = now() - interval ''2 days''
        where id = %L', row_id)),
    'nor backdate one out of the rolling window');

  perform assert(
    denied(bob, format(
      'insert into public.ai_scan_requests (user_id, operation, outcome)
       values (%L, ''analyzeFoodPhoto'', ''success'')', alice)),
    'and certainly cannot spend another user''s allowance');

  perform assert(
    (select count(*) from public.ai_scan_requests where user_id = alice) = 2,
    'after all of that, alice''s ledger is unchanged');
end $$;

\echo ''
\echo '=== schema invariants ==='

do $$
begin
  perform assert(
    (select relrowsecurity from pg_class
      where oid = 'public.ai_scan_requests'::regclass),
    'RLS is enabled on the ledger');

  perform assert(
    (select count(*) from pg_policies
      where tablename = 'ai_scan_requests' and cmd <> 'SELECT') = 0,
    'the only policy is SELECT');

  perform assert(
    (select count(*) from information_schema.role_table_grants
      where table_name = 'ai_scan_requests'
        and grantee = 'authenticated'
        and privilege_type <> 'SELECT') = 0,
    'authenticated holds no grant beyond SELECT');

  perform assert(
    (select count(*) from information_schema.role_table_grants
      where table_name = 'ai_scan_requests' and grantee = 'anon') = 0,
    'anonymous callers have no grant at all');

  /*
   * The privacy assertion. If a column for an image, a storage path or an
   * extracted nutrient ever appears here, this fails — which is the point:
   * the decision not to keep those should not be quietly reversible.
   */
  perform assert(
    (select count(*) from information_schema.columns
      where table_name = 'ai_scan_requests'
        and (column_name like '%image_%' and column_name <> 'image_bytes'
             or column_name like '%storage%'
             or column_name like '%url%'
             or column_name like '%calor%'
             or column_name like '%protein%'
             or column_name like '%food%'
             or column_name like '%name%')) = 0,
    'the ledger stores no image, no storage reference and no extracted nutrition');

  perform assert(
    (select confdeltype from pg_constraint
      where conrelid = 'public.ai_scan_requests'::regclass
        and confrelid = 'public.profiles'::regclass) = 'c',
    'deleting an account removes its scan history');
end $$;

\echo ''
\echo '=== the rolling quota window ==='

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  recent int;
begin
  -- An older scan, outside the 24-hour window the function counts over.
  insert into public.ai_scan_requests (user_id, operation, outcome, created_at)
  values (alice, 'analyzeFoodPhoto', 'success', now() - interval '30 hours');

  select count(*) into recent
    from public.ai_scan_requests
   where user_id = alice and created_at >= now() - interval '24 hours';

  perform assert(recent = 2,
    'a scan older than the window does not count against the quota');
  perform assert(
    (select count(*) from public.ai_scan_requests where user_id = alice) = 3,
    'though it is still on the record');
end $$;

\echo ''
\echo 'All AI scan ledger checks passed.'

rollback;
