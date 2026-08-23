-- ===========================================================================
-- Phase 1 — water tracking
--
-- Two tables, and almost no new ideas: a water log is a diary entry with one
-- number instead of a nutrition snapshot, and a water goal is a goal period
-- with one target instead of four.
--
-- So the first half of this migration is REUSE rather than addition. Both of
-- those mechanisms already exist and are subtle — the local-date rule has DST
-- and travel cases behind it, and the period chain has a same-day supersession
-- rule that took a concurrency test to get right. Writing a second copy of
-- either is how two copies drift. Instead each is generalised in place, the
-- existing caller is re-pointed at the general version, and water uses the
-- same code. The existing suites prove the generalisation is behaviour-
-- preserving: 63 food-log assertions and 66 goal assertions run against it
-- unchanged.
-- ===========================================================================

-- =========================================================================
-- 1. Generalise the local-date rule
-- =========================================================================

/*
 * The diary-day rule, for any table that has one.
 *
 * Identical in behaviour to `resolve_food_log_day()`, which it replaces: the
 * stored calendar day must be the local day of the event's instant in the
 * zone recorded beside it, a null day is derived rather than rejected, and
 * revalidation happens only when one of the three columns actually changes —
 * a timezone-database update can legitimately change what a *past* instant
 * maps to, and that must not turn an unrelated edit into an error.
 *
 * Column names come from the trigger arguments, so one function serves
 * food_logs (logged_at / time_zone / diary_date) and water_logs
 * (consumed_at / time_zone / local_date) alike.
 *
 *   create trigger … execute function
 *     public.resolve_local_date('<instant>', '<zone>', '<date>');
 */
create or replace function public.resolve_local_date()
returns trigger
language plpgsql
as $$
declare
  instant_col constant text := tg_argv[0];
  zone_col    constant text := tg_argv[1];
  date_col    constant text := tg_argv[2];

  incoming jsonb := to_jsonb(new);
  previous jsonb;

  instant  timestamptz;
  zone     text;
  supplied date;
  derived  date;
begin
  if tg_op = 'UPDATE' then
    previous := to_jsonb(old);
    if incoming -> instant_col is not distinct from previous -> instant_col
       and incoming -> zone_col is not distinct from previous -> zone_col
       and incoming -> date_col is not distinct from previous -> date_col then
      return new;
    end if;
  end if;

  instant  := (incoming ->> instant_col)::timestamptz;
  zone     := incoming ->> zone_col;
  supplied := (incoming ->> date_col)::date;

  begin
    derived := (instant at time zone zone)::date;
  exception
    when invalid_parameter_value then
      raise exception 'Unknown time zone "%" on %.%', zone, tg_table_name, date_col
        using errcode = 'check_violation';
  end;

  if supplied is null then
    -- Only the one key is supplied, so every other column keeps its value.
    return jsonb_populate_record(new, jsonb_build_object(date_col, derived));
  end if;

  if supplied <> derived then
    raise exception
      '%.% is % but % in % is %; a local day is the local day of its instant',
      tg_table_name, date_col, supplied, instant_col, zone, derived
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.resolve_local_date() is
  'Derives and validates a local calendar day from an instant and an IANA zone. Trigger args: instant column, zone column, date column. Never a UTC truncation.';

-- Re-point the diary at the general version. Same rule, same guarantees; the
-- food_logs suite runs against it unchanged.
drop trigger food_logs_resolve_day on public.food_logs;

create trigger food_logs_resolve_day
  before insert or update on public.food_logs
  for each row
  execute function public.resolve_local_date('logged_at', 'time_zone', 'diary_date');

-- One implementation, so drop the one it replaced rather than leaving a second
-- copy behind for someone to reach for later.
drop function public.resolve_food_log_day();

-- =========================================================================
-- 2. Generalise the goal-period chain
-- =========================================================================

/*
 * Closes every period the day before the next one starts, leaving the newest
 * open — for any table with (user_id, effective_from, effective_to, created_at).
 *
 * Lifted verbatim from `resync_goal_periods`, including the rule that matters
 * most: periods sharing a start date are ordered by creation, and all but the
 * last get an empty range. That is what two devices opening a period on the
 * same day produces, and it is the reason this logic should exist once.
 */
create or replace function public.resync_period_chain(
  p_table regclass,
  p_user  uuid
)
returns void
language plpgsql
as $$
begin
  execute format($sql$
    with ordered as (
      select
        id,
        effective_from,
        lead(effective_from) over (
          partition by user_id
          order by effective_from, created_at, id
        ) as next_from
      from %1$s
      where user_id = $1 and deleted_at is null
    )
    update %1$s g
       set effective_to = case
                            when o.next_from is null then null
                            when o.next_from <= o.effective_from then o.effective_from - 1
                            else o.next_from - 1
                          end
      from ordered o
     where g.id = o.id
       and g.effective_to is distinct from case
                            when o.next_from is null then null
                            when o.next_from <= o.effective_from then o.effective_from - 1
                            else o.next_from - 1
                          end
  $sql$, p_table)
  using p_user;
end;
$$;

-- The nutrition-goal entry point keeps its name and signature — its trigger is
-- untouched — and now delegates instead of holding a second copy.
create or replace function public.resync_goal_periods(p_user uuid)
returns void
language plpgsql
as $$
begin
  perform public.resync_period_chain('public.nutrition_goals', p_user);
end;
$$;

-- =========================================================================
-- 3. water_logs
-- =========================================================================

/*
 * One row per drink.
 *
 * Millilitres, always. A column holding both ml and fluid ounces cannot be
 * repaired after the fact, so the unit the user reads is a display preference
 * and nothing else — `formatVolume` in src/lib/units.ts is the only place the
 * conversion happens.
 *
 * `local_date` follows the diary's rule exactly, through the same trigger
 * function: a glass at 23:30 in Auckland belongs to that day, not to the UTC
 * day, and flying to Honolulu does not re-date it.
 */
create table public.water_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,

  /*
   * Upper bound is a typo guard, not a health opinion: five litres in a single
   * entry is a slipped decimal on a 500 ml glass. Larger daily totals remain
   * possible — they are simply more than one entry.
   */
  amount_ml   integer not null check (amount_ml > 0 and amount_ml <= 5000),

  consumed_at timestamptz not null default clock_timestamp(),
  time_zone   text not null check (length(time_zone) between 1 and 64),
  local_date  date not null,

  note        text check (note is null or length(note) <= 200),

  created_at  timestamptz not null default clock_timestamp(),
  updated_at  timestamptz not null default clock_timestamp(),
  deleted_at  timestamptz
);

comment on column public.water_logs.local_date is
  'The user''s calendar day in time_zone at the moment of drinking. Never a UTC truncation.';

/*
 * The day read and the daily total are one access pattern: one user, one day.
 * Covering `amount_ml` keeps the total off the table itself.
 */
create index water_logs_day_idx
  on public.water_logs (user_id, local_date)
  include (amount_ml)
  where deleted_at is null;

-- Sync cursor. Unfiltered on purpose: deletions have to travel too.
create index water_logs_sync_idx
  on public.water_logs (user_id, updated_at);

create trigger water_logs_resolve_day
  before insert or update on public.water_logs
  for each row
  execute function public.resolve_local_date('consumed_at', 'time_zone', 'local_date');

create trigger water_logs_set_updated_at
  before insert or update on public.water_logs
  for each row execute function public.set_updated_at();

-- =========================================================================
-- 4. water_goals
-- =========================================================================

/*
 * `calculated` means the app's own recommendation, accepted as offered;
 * `manual` means the user chose the number. There is no third case here — a
 * water target has one figure, so "calculated then modified" is just a manual
 * target with the recommendation kept beside it, which `calculated_ml`
 * already records.
 */
create type public.water_goal_source as enum ('calculated', 'manual');

/*
 * Goal periods, exactly as nutrition goals work: only `effective_from` is
 * authored, `effective_to` is derived, and changing a target opens a new
 * period rather than editing the old one. A weight change therefore never
 * rewrites the goal that was in force last month, even though the
 * recommendation is computed from weight.
 */
create table public.water_goals (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,

  effective_from date not null,
  -- Derived by trigger. NULL = current. effective_from - 1 = superseded
  -- before it took effect. See resync_period_chain.
  effective_to   date,

  target_ml      integer not null check (target_ml between 500 and 10000),
  source         public.water_goal_source not null,

  -- What the app suggested, kept even when the user chose otherwise.
  calculated_ml  integer check (calculated_ml between 500 and 10000),
  -- What that suggestion was computed from, snapshotted so a historical goal
  -- explains itself after the profile has moved on.
  basis_weight_kg numeric(6,2) check (basis_weight_kg between 25 and 400),

  note           text check (note is null or length(note) <= 200),

  created_at     timestamptz not null default clock_timestamp(),
  updated_at     timestamptz not null default clock_timestamp(),
  deleted_at     timestamptz,

  constraint water_goal_range_ordered
    check (effective_to is null or effective_to >= effective_from - 1),

  /* A calculated goal has to carry the recommendation it claims to be. */
  constraint calculated_water_goals_match_their_recommendation
    check (source <> 'calculated' or calculated_ml = target_ml)
);

create index water_goals_lookup_idx
  on public.water_goals (user_id, effective_from desc)
  include (effective_to, target_ml)
  where deleted_at is null;

create index water_goals_sync_idx
  on public.water_goals (user_id, updated_at);

alter table public.water_goals
  add constraint water_goals_no_overlap
  exclude using gist (
    user_id with =,
    public.goal_period_range(effective_from, effective_to) with &&
  ) where (deleted_at is null)
  deferrable initially deferred;

create trigger water_goals_set_updated_at
  before insert or update on public.water_goals
  for each row execute function public.set_updated_at();

create or replace function public.resync_water_goal_periods()
returns trigger
language plpgsql
as $$
begin
  perform public.resync_period_chain(
    'public.water_goals', coalesce(new.user_id, old.user_id));
  return null;
end;
$$;

create trigger water_goals_resync_periods
  after insert or delete on public.water_goals
  for each row execute function public.resync_water_goal_periods();

create trigger water_goals_resync_periods_on_change
  after update of effective_from, deleted_at, user_id on public.water_goals
  for each row execute function public.resync_water_goal_periods();

/*
 * The water goal in force on a given day.
 *
 * Mirrored exactly by the client's local query, so "which goal applied on
 * 5 August" has one answer wherever it is asked. It never consults the profile:
 * a historical goal is a stored fact, not a function of today's weight.
 */
create or replace function public.water_goal_for_date(p_user uuid, p_date date)
returns setof public.water_goals
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select *
    from public.water_goals
   where user_id = p_user
     and deleted_at is null
     and effective_from <= p_date
     and (effective_to is null or effective_to >= p_date)
   order by effective_from desc, created_at desc, id desc
   limit 1;
$$;

grant execute on function public.water_goal_for_date(uuid, date) to authenticated;
revoke execute on function public.water_goal_for_date(uuid, date) from anon, public;

-- =========================================================================
-- 5. RLS
-- =========================================================================

alter table public.water_logs enable row level security;

create policy "Read own water logs"
  on public.water_logs for select
  to authenticated
  using (user_id = auth.uid());

create policy "Create own water logs"
  on public.water_logs for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Update own water logs"
  on public.water_logs for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.water_goals enable row level security;

create policy "Read own water goals"
  on public.water_goals for select
  to authenticated
  using (user_id = auth.uid());

create policy "Create own water goals"
  on public.water_goals for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Update own water goals"
  on public.water_goals for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

/*
 * No DELETE policy or grant on either, matching every other user-owned table:
 * removing an entry is a soft delete, because a hard delete cannot be
 * synchronised — the other device would have nothing to learn from and would
 * push the row straight back.
 */
grant select, insert, update on public.water_logs  to authenticated;
grant select, insert, update on public.water_goals to authenticated;
revoke all on public.water_logs  from anon;
revoke all on public.water_goals from anon;
