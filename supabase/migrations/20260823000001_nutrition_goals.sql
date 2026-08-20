-- ===========================================================================
-- Phase 1 — calorie and macro goals, and weight history
--
-- A goal is a period, not a setting. Changing your target does not edit a row;
-- it opens a new period, and every period that came before stays exactly as it
-- was. That is what lets the diary for 5 August show the target that was in
-- force on 5 August rather than the one in force today.
--
-- Three decisions carry the design.
--
-- 1. ONLY `effective_from` IS AUTHORED. `effective_to` is derived by trigger
--    from the next period's start and never supplied by a client. Ranges that
--    are computed cannot overlap by accident, and — more importantly — two
--    devices syncing goals they created offline cannot push a pair of rows
--    that contradict each other. A client that had to close the previous
--    period itself would need two writes to land in order, which is exactly
--    the guarantee an offline outbox cannot make.
--
-- 2. THE RECOMMENDATION IS KEPT ALONGSIDE THE TARGET. When someone overrides
--    a suggested 2,050 with 2,200, both numbers are stored. Losing the
--    recommendation would make it impossible to say later what the app had
--    actually suggested, or to notice that the two have drifted apart.
--
-- 3. THE BASIS IS SNAPSHOTTED, like a diary entry's nutrition. A goal records
--    the weight, height, age, activity and BMR it was calculated from, so a
--    period from March still explains itself in December — after the profile
--    it came from has changed several times over.
-- ===========================================================================

create extension if not exists btree_gist;

-- --------------------------------------------------------------------- enums

create type public.activity_level as enum
  ('sedentary', 'light', 'moderate', 'very', 'extra');

create type public.goal_direction as enum ('lose', 'maintain', 'gain');

/*
 * Where the active target came from.
 *
 *   calculated              — the app's recommendation, accepted as offered
 *   manual                  — typed by the user, no recommendation involved
 *   calculated_then_modified — calculated, then adjusted; both are stored
 *
 * The third is worth distinguishing from `manual`: it is the case where a
 * recommendation exists and was deliberately not taken, which is a different
 * thing from never having asked for one.
 */
create type public.goal_source as enum
  ('calculated', 'manual', 'calculated_then_modified');

-- ------------------------------------------------------- profile additions

/*
 * Activity level lives on the profile because it is a property of the person,
 * not of a goal period — it prefills the calculator and survives between
 * recalculations. The value each goal was actually calculated from is
 * snapshotted on the goal itself, so changing this never rewrites history.
 *
 * Weight deliberately does NOT live here. It belongs to weight_entries below:
 * a single mutable column would lose every previous measurement the first time
 * someone stepped on a scale.
 */
alter table public.profiles
  add column activity_level public.activity_level;

comment on column public.profiles.activity_level is
  'Prefills the calculator. The value a goal was calculated from is snapshotted on the goal.';

-- --------------------------------------------------------- nutrition_goals

create table public.nutrition_goals (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles(id) on delete cascade,

  -- ------------------------------------------------------------- validity --

  -- The only boundary a client sets.
  effective_from        date not null,

  /*
   * Derived by `resync_goal_periods()`: the day before the next period starts,
   * or null for the current period. Never written by a client.
   *
   * `effective_to = effective_from - 1` is a deliberate encoding, not a bug: it
   * marks a period that was superseded before it ever took effect, which
   * happens when two devices each open a period on the same day. The range is
   * empty, so it covers no date and is skipped by every lookup — while the row
   * itself survives, because it is still a record of something the user did.
   */
  effective_to          date,

  -- ------------------------------------------------------- active target --

  -- What the diary compares against. Always present, whatever the source.
  calorie_target        integer not null check (calorie_target between 800 and 10000),
  protein_target_g      numeric(6,1) not null check (protein_target_g between 0 and 500),
  carbohydrate_target_g numeric(6,1) not null check (carbohydrate_target_g between 0 and 1500),
  fat_target_g          numeric(6,1) not null check (fat_target_g between 0 and 500),

  source                public.goal_source not null,

  -- ---------------------------------------------- the recommendation kept --

  /*
   * What the app suggested, preserved even when the user chose otherwise.
   * Null only for a purely manual goal, where there was no recommendation.
   */
  calculated_calories        integer check (calculated_calories between 800 and 10000),
  calculated_protein_g       numeric(6,1),
  calculated_carbohydrate_g  numeric(6,1),
  calculated_fat_g           numeric(6,1),

  -- ------------------------------------------------- the basis, snapshotted --

  basis_bmr             integer check (basis_bmr > 0),
  basis_tdee            integer check (basis_tdee > 0),
  basis_activity        public.activity_level,
  basis_direction       public.goal_direction,
  basis_weight_kg       numeric(6,2) check (basis_weight_kg between 25 and 400),
  basis_height_cm       numeric(5,1) check (basis_height_cm between 100 and 250),
  basis_age_years       smallint check (basis_age_years between 13 and 120),
  basis_sex             public.sex,

  /*
   * Set when the user knowingly chose a target below the app's recommendation
   * floor. The app never arrives there on its own — see docs/nutrition-goals.md
   * — so a row carrying a low target without this flag is a bug, and the check
   * below says so.
   */
  acknowledged_below_floor boolean not null default false,

  note                  text check (note is null or length(note) <= 500),

  /*
   * `clock_timestamp()`, not `now()`.
   *
   * Creation time is a tiebreak here, not just a record: when two periods
   * share a start date, the later-created one takes effect. `now()` is
   * transaction time, so two rows written in one transaction would tie
   * exactly and the winner would fall to whichever id sorted higher — a
   * resolution rule that depends on a random UUID. The same reasoning put
   * `clock_timestamp()` behind `set_updated_at()` in Phase 0.
   */
  created_at            timestamptz not null default clock_timestamp(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,

  /*
   * A period may end the day before it starts (superseded, above) but never
   * earlier than that. Anything more inverted is a corrupt range rather than a
   * meaningful state.
   */
  constraint goal_range_ordered
    check (effective_to is null or effective_to >= effective_from - 1),

  /*
   * A calculated goal has to say what it was calculated from. Without this a
   * row could claim to be a recommendation while carrying nothing that
   * produced it, and no later screen could explain the number.
   */
  constraint calculated_goals_carry_their_basis
    check (
      source = 'manual'
      or (
        calculated_calories is not null
        and basis_bmr is not null
        and basis_tdee is not null
        and basis_activity is not null
        and basis_direction is not null
        and basis_weight_kg is not null
        and basis_sex in ('male', 'female')
      )
    ),

  /*
   * A goal that merely matches its recommendation is `calculated`; one that
   * differs must say so. Otherwise "the app suggested this" and "the app
   * suggested something else and I chose this" become indistinguishable.
   */
  constraint modified_goals_differ_from_their_recommendation
    check (
      source <> 'calculated_then_modified'
      or calculated_calories is distinct from calorie_target
      or calculated_protein_g is distinct from protein_target_g
      or calculated_carbohydrate_g is distinct from carbohydrate_target_g
      or calculated_fat_g is distinct from fat_target_g
    ),

  constraint plain_calculated_goals_match_their_recommendation
    check (source <> 'calculated' or calculated_calories = calorie_target)
);

comment on table public.nutrition_goals is
  'One row per goal period. effective_to is derived by trigger; only effective_from is authored.';
comment on column public.nutrition_goals.effective_to is
  'Derived. NULL = current period. effective_from - 1 = superseded before taking effect.';

/*
 * The resolution index: "the goal in force on day D for this user".
 *
 * `effective_from desc` is the order the lookup scans in — it wants the latest
 * period that starts on or before the date, and stops at the first hit.
 */
create index nutrition_goals_lookup_idx
  on public.nutrition_goals (user_id, effective_from desc)
  include (effective_to, calorie_target)
  where deleted_at is null;

-- Sync cursor. Deliberately unfiltered: deletions have to travel too.
create index nutrition_goals_sync_idx
  on public.nutrition_goals (user_id, updated_at);

/*
 * One goal per user per date, enforced rather than asserted.
 *
 * DEFERRABLE because the trigger below fixes the chain within the same
 * transaction: an insert momentarily overlaps the period it supersedes, and
 * checking at commit rather than per-statement is what lets the correction
 * land first. An empty range — the superseded encoding — overlaps nothing, so
 * those rows sit outside the constraint entirely.
 */
/*
 * The range a period actually covers.
 *
 * A superseded period stores `effective_to = effective_from - 1`, and
 * `daterange()` refuses inverted bounds outright rather than normalising them
 * to the empty range — so the case is spelled out here instead. Immutable, as
 * an index expression must be.
 */
create or replace function public.goal_period_range(p_from date, p_to date)
returns daterange
language sql
immutable
parallel safe
as $$
  select case
           when p_to is not null and p_to < p_from then 'empty'::daterange
           else daterange(p_from, p_to, '[]')
         end;
$$;

alter table public.nutrition_goals
  add constraint nutrition_goals_no_overlap
  exclude using gist (
    user_id with =,
    public.goal_period_range(effective_from, effective_to) with &&
  ) where (deleted_at is null)
  deferrable initially deferred;

-- ----------------------------------------------------------- weight_entries

/*
 * Weight over time, rather than a single column on the profile.
 *
 * A mutable `profiles.weight_kg` would lose every previous measurement the
 * first time somebody weighed themselves, and the calculator needs a current
 * weight anyway — so the history costs one table and buys progress tracking
 * outright.
 *
 * No uniqueness on (user_id, measured_on). Two devices recording the same
 * morning offline would each produce a row, and a unique index would reject
 * the second one forever rather than resolving it. Both are kept; the lookup
 * takes the most recent, which is the honest answer to "what did the scale say
 * that day" when it was read twice.
 */
create table public.weight_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,

  -- A calendar day in the user's zone, not an instant: a weigh-in is "Tuesday
  -- morning", and the diary's day rules apply here for the same reason.
  measured_on date not null,
  weight_kg   numeric(6,2) not null check (weight_kg between 25 and 400),

  note        text check (note is null or length(note) <= 500),

  -- Also a tiebreak: two readings on one day resolve to the later. See above.
  created_at  timestamptz not null default clock_timestamp(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index weight_entries_lookup_idx
  on public.weight_entries (user_id, measured_on desc)
  where deleted_at is null;

create index weight_entries_sync_idx
  on public.weight_entries (user_id, updated_at);

-- ----------------------------------------------------------------- triggers

create trigger nutrition_goals_set_updated_at
  before update on public.nutrition_goals
  for each row execute function public.set_updated_at();

create trigger weight_entries_set_updated_at
  before update on public.weight_entries
  for each row execute function public.set_updated_at();

/*
 * Rebuilds a user's goal chain.
 *
 * Every live period is closed the day before the next one starts; the newest
 * is left open. Periods sharing a start date are ordered by creation, and all
 * but the last get an empty range — superseded before taking effect.
 *
 * Deriving this rather than accepting it is what makes the table safe to sync.
 * A client only ever writes one row per change, so there is no pair of updates
 * that has to arrive in order, and no way for a partially-applied push to
 * leave two periods claiming the same day.
 */
create or replace function public.resync_goal_periods(p_user uuid)
returns void
language plpgsql
as $$
begin
  with ordered as (
    select
      id,
      effective_from,
      lead(effective_from) over (
        partition by user_id
        order by effective_from, created_at, id
      ) as next_from
    from public.nutrition_goals
    where user_id = p_user and deleted_at is null
  )
  update public.nutrition_goals g
     set effective_to = case
                          when o.next_from is null then null
                          -- Same-day successor: this period never applied.
                          when o.next_from <= o.effective_from then o.effective_from - 1
                          else o.next_from - 1
                        end
    from ordered o
   where g.id = o.id
     and g.effective_to is distinct from case
                          when o.next_from is null then null
                          when o.next_from <= o.effective_from then o.effective_from - 1
                          else o.next_from - 1
                        end;
end;
$$;

create or replace function public.resync_goal_periods_trigger()
returns trigger
language plpgsql
as $$
begin
  perform public.resync_goal_periods(coalesce(new.user_id, old.user_id));
  return null;
end;
$$;

/*
 * AFTER, and statement-level per row, so the recomputation sees the row that
 * caused it. `effective_to` is excluded from the UPDATE OF list — otherwise the
 * function's own writes would re-fire the trigger.
 */
create trigger nutrition_goals_resync_periods
  after insert or delete on public.nutrition_goals
  for each row execute function public.resync_goal_periods_trigger();

create trigger nutrition_goals_resync_periods_on_change
  after update of effective_from, deleted_at, user_id on public.nutrition_goals
  for each row execute function public.resync_goal_periods_trigger();

/*
 * The goal in force on a given day.
 *
 * One function, used by the server and mirrored exactly by the client's local
 * query, so "which goal applies to 5 August" has one answer wherever it is
 * asked. Note what it does NOT do: it never looks at the profile. A historical
 * goal is a stored fact, not something recomputed from who the user is now.
 */
create or replace function public.goal_for_date(p_user uuid, p_date date)
returns setof public.nutrition_goals
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select *
    from public.nutrition_goals
   where user_id = p_user
     and deleted_at is null
     and effective_from <= p_date
     and (effective_to is null or effective_to >= p_date)
   order by effective_from desc, created_at desc, id desc
   limit 1;
$$;

grant execute on function public.goal_for_date(uuid, date) to authenticated;
revoke execute on function public.goal_for_date(uuid, date) from anon, public;

-- --------------------------------------------------------------------- RLS

alter table public.nutrition_goals enable row level security;

create policy "Read own goals"
  on public.nutrition_goals for select
  to authenticated
  using (user_id = auth.uid());

create policy "Create own goals"
  on public.nutrition_goals for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Update own goals"
  on public.nutrition_goals for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

/*
 * No DELETE policy or grant, on either table. Removing a goal period is a soft
 * delete, for the same reason a diary entry's is: a hard delete cannot be
 * synchronised, and a goal that was in force for a fortnight is a historical
 * fact even after the user stops wanting it.
 */
grant select, insert, update on public.nutrition_goals to authenticated;
revoke all on public.nutrition_goals from anon;

alter table public.weight_entries enable row level security;

create policy "Read own weight entries"
  on public.weight_entries for select
  to authenticated
  using (user_id = auth.uid());

create policy "Create own weight entries"
  on public.weight_entries for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Update own weight entries"
  on public.weight_entries for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update on public.weight_entries to authenticated;
revoke all on public.weight_entries from anon;
