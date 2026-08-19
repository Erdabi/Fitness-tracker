-- ===========================================================================
-- Phase 0 — identity schema
--
-- Two tables: `profiles` (1:1 with auth.users) and `user_settings`.
--
-- Two invariants established here that every later migration must preserve:
--
--   1. `updated_at` is set by a trigger, never by the client. The sync pull
--      cursor is ordered by this column, and a device with a skewed clock
--      would otherwise write a timestamp that causes other devices to skip
--      rows permanently.
--
--   2. Deletes are soft (`deleted_at`). A hard delete is invisible to a delta
--      pull — the row simply stops appearing — so offline clients would keep
--      their copy forever.
-- ===========================================================================

create extension if not exists "pgcrypto";

-- --------------------------------------------------------------------- enums

create type public.sex as enum ('male', 'female', 'other');
create type public.unit_system as enum ('metric', 'imperial');
create type public.theme_pref as enum ('light', 'dark', 'system');

-- ------------------------------------------------------------------ triggers

-- Authoritative modification time. Also blocks a client from forging
-- `updated_at` to win a last-write-wins conflict it should have lost.
--
-- `clock_timestamp()`, not `now()`. `now()` is the transaction start time, so
-- a transaction that begins early and commits late stamps a row with a time
-- that may already be behind a cursor another device has advanced past — and
-- that row would then never be pulled again. clock_timestamp() narrows the
-- window to the commit path; `SYNC_CURSOR_LAG_MS` in src/sync/engine.ts closes
-- what remains.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

-- -------------------------------------------------------------------- tables

create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text        check (display_name is null or length(trim(display_name)) between 1 and 80),
  sex          public.sex,
  birth_date   date        check (birth_date is null or birth_date > '1900-01-01'),
  height_cm    numeric(5,1) check (height_cm is null or (height_cm > 0 and height_cm < 300)),
  unit_system  public.unit_system not null default 'metric',

  -- IANA zone. Every calendar-day calculation in the app resolves against
  -- this, so a logged item lands on the day the user experienced.
  time_zone    text        not null default 'UTC'
                           check (length(time_zone) between 1 and 64),

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

comment on column public.profiles.time_zone is
  'IANA timezone driving calendar-day resolution for logs.';

create table public.user_settings (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles(id) on delete cascade,

  theme                  public.theme_pref not null default 'system',
  water_goal_ml          integer not null default 2500
                         check (water_goal_ml between 250 and 20000),

  -- Product decision recorded in the schema: exercise does not add calories
  -- back to the budget by default, because burn estimates run high.
  exercise_adds_calories boolean not null default false,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz,

  constraint user_settings_one_per_user unique (user_id)
);

-- ------------------------------------------------------------------- indexes

-- The sync pull cursor: "rows for this user changed since X".
create index profiles_updated_at_idx
  on public.profiles (id, updated_at);

create index user_settings_sync_idx
  on public.user_settings (user_id, updated_at);

-- ------------------------------------------------------------ trigger wiring

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create trigger user_settings_set_updated_at
  before update on public.user_settings
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------ user creation

-- Creates both rows when an account is created, so a profile always exists.
-- Doing this client-side would race: the app can be offline immediately after
-- sign-up, and a screen that assumes a profile would crash.
--
-- SECURITY DEFINER because the trigger runs as the auth system, which has no
-- rights on public tables. `search_path` is pinned so a schema earlier on the
-- caller's path cannot shadow the tables this function writes to.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;

  insert into public.user_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
