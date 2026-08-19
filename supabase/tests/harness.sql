-- ===========================================================================
-- Local Supabase harness
--
-- Recreates just enough of a Supabase project for the migrations in
-- `supabase/migrations` to run against a plain PostgreSQL instance: the roles
-- PostgREST connects as, the `auth` schema, and `auth.uid()`.
--
-- This exists so RLS can be *tested* rather than reviewed. A policy is code;
-- reading it is not evidence that it works.
--
-- Not loaded in production — Supabase provides all of this already.
-- ===========================================================================

-- ------------------------------------------------------------------- roles

-- The three roles PostgREST assumes depending on the request's JWT.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- Mirrors Supabase: the service role bypasses RLS entirely.
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant anon, authenticated, service_role to postgres;

-- -------------------------------------------------------------- auth schema

create schema if not exists auth;

create table if not exists auth.users (
  id                uuid primary key default gen_random_uuid(),
  email             text unique,
  raw_user_meta_data jsonb not null default '{}',
  created_at        timestamptz not null default now()
);

/*
 * Supabase derives the caller's id from the request JWT. Here the same value
 * is read from a session setting, so a test can "become" a user with
 *   set local request.jwt.claims = '{"sub": "<uuid>"}';
 * which is exactly how PostgREST sets it.
 */
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
    ''
  )::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'role', ''),
    'anon'
  );
$$;

grant usage on schema auth to anon, authenticated, service_role;
