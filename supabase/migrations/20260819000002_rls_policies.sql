-- ===========================================================================
-- Phase 0 — Row Level Security
--
-- RLS is the security boundary in this app, not a backstop. The anon key ships
-- inside the binary and anyone can extract it and call the REST API directly,
-- so "the app only requests its own rows" guarantees nothing. These policies
-- are what actually stop one user reading another's data.
--
-- Rules followed by every policy below, and by every table added later:
--
--   • Both USING and WITH CHECK are set on writes. USING decides which rows
--     you may act on; WITH CHECK decides what the row may look like afterwards.
--     Setting only USING lets a user hand their row to someone else by
--     changing `user_id` on update.
--
--   • No policy grants access to `anon`. Everything requires an authenticated
--     session.
--
--   • RLS is ENABLED but deliberately NOT FORCED. `force` makes the table
--     owner subject to policies too, which sounds stricter but breaks the
--     `handle_new_user` SECURITY DEFINER trigger: it runs as the table owner
--     with no JWT, so `auth.uid()` is null and no policy matches. Verified
--     against PostgreSQL 16 — with `force` the trigger's insert fails with
--     "new row violates row-level security policy", and signup dies with it.
--
--     Nothing is lost. Only the table owner is affected by `force`, and the
--     owner is an administrative role that never serves API traffic. The
--     roles that do — `anon` and `authenticated` — own nothing, so policies
--     always apply to them either way. `supabase/tests/rls.test.sql` proves
--     that empirically rather than by assertion.
-- ===========================================================================

alter table public.profiles      enable row level security;
alter table public.user_settings enable row level security;

-- ------------------------------------------------------------------ profiles

create policy "Users read their own profile"
  on public.profiles for select
  to authenticated
  using (auth.uid() = id);

-- Sign-up is handled by the handle_new_user trigger, but an offline-first
-- client may upsert its profile before the trigger's row has been pulled.
-- Constrained to the caller's own id.
create policy "Users create their own profile"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id);

create policy "Users update their own profile"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- No DELETE policy: deletes are soft (an UPDATE setting `deleted_at`), and
-- account deletion cascades from auth.users. A row nothing can hard-delete is
-- a row a sync bug cannot destroy.

-- ------------------------------------------------------------- user_settings

create policy "Users read their own settings"
  on public.user_settings for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users create their own settings"
  on public.user_settings for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users update their own settings"
  on public.user_settings for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ------------------------------------------------------------------- grants

-- Policies filter rows; grants decide whether the role may touch the table at
-- all. Both are required — a policy alone does not grant access.
grant usage on schema public to authenticated;

grant select, insert, update on public.profiles      to authenticated;
grant select, insert, update on public.user_settings to authenticated;

-- Explicitly withhold everything from anonymous callers.
revoke all on public.profiles      from anon;
revoke all on public.user_settings from anon;
