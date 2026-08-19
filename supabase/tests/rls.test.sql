-- ===========================================================================
-- Row Level Security verification
--
-- Runs against a database that already has `harness.sql` and every migration
-- applied. Each check raises an exception on failure, so the script exits
-- non-zero under `psql -v ON_ERROR_STOP=1`.
--
-- Tests run as the `authenticated` role with `request.jwt.claims` set, which
-- is exactly how PostgREST executes a request. Running them as a superuser
-- would silently bypass RLS and prove nothing.
-- ===========================================================================

\set ON_ERROR_STOP on
\timing off

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

-- Runs a statement as a signed-in user and reports whether it was refused.
-- "Refused" covers both an explicit RLS error and a silent zero-row result,
-- because RLS expresses denial both ways depending on the verb.
create or replace function denied(claim_user uuid, statement text)
returns boolean language plpgsql as $$
declare
  affected int;
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
declare
  total int;
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
begin
  raise notice '';
  raise notice '=== signup trigger ===';

  -- This is the check that FORCE ROW LEVEL SECURITY used to break.
  insert into auth.users (email) values ('alice@example.com') returning id into alice;
  insert into auth.users (email) values ('bob@example.com')   returning id into bob;

  perform assert(
    (select count(*) from public.profiles where id in (alice, bob)) = 2,
    'handle_new_user creates a profile row for each new account');

  perform assert(
    (select count(*) from public.user_settings where user_id in (alice, bob)) = 2,
    'handle_new_user creates a settings row for each new account');

  perform assert(
    (select email from public.profiles where id = alice) = 'alice@example.com',
    'profile carries the email from auth.users');

  perform assert(
    (select water_goal_ml from public.user_settings where user_id = alice) = 2500,
    'settings default to a 2500 ml water goal');

  perform assert(
    (select exercise_adds_calories from public.user_settings where user_id = alice) = false,
    'exercise does not add calories back by default');

  -- Stash the ids for the checks below.
  create temp table actors (name text primary key, id uuid);
  insert into actors values ('alice', alice), ('bob', bob);
end $$;

-- ------------------------------------------------------------- own-row access

do $$
declare alice uuid := (select id from actors where name = 'alice');
begin
  raise notice '';
  raise notice '=== a user can reach their own data ===';

  perform assert(
    visible_rows(alice, 'select 1 from public.profiles') = 1,
    'alice sees exactly one profile — her own');

  perform assert(
    visible_rows(alice, 'select 1 from public.user_settings') = 1,
    'alice sees exactly one settings row — her own');

  perform assert(
    not denied(alice, format(
      'update public.profiles set display_name = ''Alice'' where id = %L', alice)),
    'alice can update her own profile');

  perform assert(
    (select display_name from public.profiles where id = alice) = 'Alice',
    'the update actually persisted');
end $$;

-- ------------------------------------------------------------- cross-user

do $$
declare
  alice uuid := (select id from actors where name = 'alice');
  bob   uuid := (select id from actors where name = 'bob');
begin
  raise notice '';
  raise notice '=== a user cannot reach anyone else''s data ===';

  perform assert(
    visible_rows(alice, format('select 1 from public.profiles where id = %L', bob)) = 0,
    'alice cannot read bob''s profile');

  perform assert(
    visible_rows(alice, format('select 1 from public.user_settings where user_id = %L', bob)) = 0,
    'alice cannot read bob''s settings');

  perform assert(
    denied(alice, format(
      'update public.profiles set display_name = ''hacked'' where id = %L', bob)),
    'alice cannot update bob''s profile');

  perform assert(
    (select display_name from public.profiles where id = bob) is distinct from 'hacked',
    'bob''s profile is untouched');

  perform assert(
    denied(alice, format(
      'update public.user_settings set water_goal_ml = 9999 where user_id = %L', bob)),
    'alice cannot update bob''s settings');

  perform assert(
    denied(alice, format(
      'insert into public.profiles (id) values (%L)', bob)),
    'alice cannot insert a profile owned by bob');

  /*
   * The WITH CHECK case. USING alone would permit this: alice legitimately
   * owns the row before the update, and only the post-update state is wrong.
   * Without WITH CHECK she could hand her settings row to bob.
   */
  perform assert(
    denied(alice, format(
      'update public.user_settings set user_id = %L where user_id = %L', bob, alice)),
    'alice cannot reassign her settings row to bob (WITH CHECK holds)');

  perform assert(
    (select count(*) from public.user_settings where user_id = alice) = 1,
    'alice still owns her settings row');
end $$;

-- ------------------------------------------------------------------- anon

do $$
declare alice uuid := (select id from actors where name = 'alice');
begin
  raise notice '';
  raise notice '=== anonymous callers get nothing ===';

  set local role anon;
  begin
    perform 1 from public.profiles limit 1;
    reset role;
    raise exception 'FAIL  anon could select from profiles';
  exception
    when insufficient_privilege then
      reset role;
      raise notice '  PASS  anon is refused on profiles';
    when others then
      reset role;
      raise notice '  PASS  anon is refused on profiles (%)', sqlerrm;
  end;

  set local role anon;
  begin
    perform 1 from public.user_settings limit 1;
    reset role;
    raise exception 'FAIL  anon could select from user_settings';
  exception
    when insufficient_privilege then
      reset role;
      raise notice '  PASS  anon is refused on user_settings';
    when others then
      reset role;
      raise notice '  PASS  anon is refused on user_settings (%)', sqlerrm;
  end;
end $$;

-- -------------------------------------------------------------- updated_at

do $$
declare
  alice   uuid := (select id from actors where name = 'alice');
  before  timestamptz;
  after   timestamptz;
  forged  timestamptz := '2000-01-01T00:00:00Z';
begin
  raise notice '';
  raise notice '=== updated_at is server-authoritative ===';

  select updated_at into before from public.profiles where id = alice;
  perform pg_sleep(0.02);

  set local role authenticated;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', alice)::text, true);
  update public.profiles set display_name = 'Alice 2' where id = alice;
  reset role;

  select updated_at into after from public.profiles where id = alice;

  /*
   * This only advances because the trigger uses clock_timestamp(). With now()
   * every statement in a transaction shares the transaction's start time, and
   * that same property lets a slow transaction stamp a row behind a cursor
   * another device has already passed — a row that is then never pulled again.
   */
  perform assert(after > before,
    'the trigger advances updated_at within a transaction (clock_timestamp)');

  /*
   * The sync cursor orders by updated_at. If a device with a skewed clock
   * could write its own value, other devices would skip rows permanently.
   */
  update public.profiles set updated_at = forged where id = alice;
  select updated_at into after from public.profiles where id = alice;
  perform assert(after > forged,
    'a client-supplied updated_at is overwritten by the trigger');
end $$;

-- ----------------------------------------------------------- schema shape

do $$
begin
  raise notice '';
  raise notice '=== schema invariants ===';

  perform assert(
    (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass),
    'RLS is enabled on profiles');

  perform assert(
    (select relrowsecurity from pg_class where oid = 'public.user_settings'::regclass),
    'RLS is enabled on user_settings');

  perform assert(
    (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'profiles') = 3,
    'profiles has select/insert/update policies and no delete policy');

  perform assert(
    (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'user_settings') = 3,
    'user_settings has select/insert/update policies and no delete policy');

  -- Every write policy must constrain the resulting row, not just the target.
  perform assert(
    not exists (
      select 1 from pg_policies
       where schemaname = 'public'
         and cmd in ('INSERT', 'UPDATE')
         and with_check is null),
    'every insert/update policy sets WITH CHECK');

  perform assert(
    (select confdeltype from pg_constraint
      where conrelid = 'public.user_settings'::regclass
        and contype = 'f'
        and confrelid = 'public.profiles'::regclass) = 'c',
    'user_settings cascades when its profile is deleted');

  perform assert(
    (select confdeltype from pg_constraint
      where conrelid = 'public.profiles'::regclass
        and contype = 'f'
        and confrelid = 'auth.users'::regclass) = 'c',
    'profiles cascades when the auth user is deleted');
end $$;

-- ------------------------------------------------------------ account delete

do $$
declare bob uuid := (select id from actors where name = 'bob');
begin
  raise notice '';
  raise notice '=== account deletion cascades ===';

  delete from auth.users where id = bob;

  perform assert(
    (select count(*) from public.profiles where id = bob) = 0,
    'deleting the auth user removes the profile');

  perform assert(
    (select count(*) from public.user_settings where user_id = bob) = 0,
    'deleting the auth user removes the settings row');
end $$;

do $$ begin raise notice ''; raise notice 'All RLS checks passed.'; end $$;

rollback;
