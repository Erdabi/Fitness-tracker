-- ===========================================================================
-- Phase 1 — the food diary
--
-- One row per logged item. Three decisions carry the whole design.
--
-- 1. THE SNAPSHOT IS THE RECORD. A log stores its own copy of the food's
--    name, brand, provenance and nutrition *basis*. It never reads
--    food_nutrition to answer "what did I eat on 3 March". This is
--    structural, not a convention: correcting a catalogue food tomorrow
--    cannot rewrite what someone ate last year, because the numbers are not
--    there to be rewritten. `food_id` is provenance only, and is
--    ON DELETE SET NULL rather than CASCADE — the history outlives the
--    catalogue row it came from.
--
-- 2. TOTALS ARE GENERATED, NOT SUPPLIED. The client sends what the user
--    chose (quantity, portion size) and the frozen basis; Postgres computes
--    calories and macros from them. A client cannot post a total that
--    disagrees with its own basis, and an edit re-derives from the basis the
--    log was created with — so changing 200 g to 300 g of a food logged at
--    52 kcal/100 g gives 156 kcal, even if that food now says 60.
--
-- 3. THE DIARY DAY IS THE USER'S DAY. `diary_date` is a stored calendar day
--    in the timezone the entry was made in, recorded alongside that zone. It
--    is NEVER a UTC truncation: a 23:30 snack in Zurich belongs to that
--    evening, not to the next morning. Flying to Tokyo changes which day new
--    entries land on and leaves every historical date exactly where it was.
-- ===========================================================================

create type public.meal_slot as enum ('breakfast', 'lunch', 'dinner', 'snack');

create table public.food_logs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,

  /*
   * Provenance only — never the source of the numbers below.
   *
   * SET NULL, not CASCADE. A food removed from the catalogue (a bad import,
   * a merged duplicate, a user deleting their own food) must not take a
   * year of someone's history with it. The log keeps rendering from its
   * snapshot with no visible change.
   */
  food_id           uuid references public.foods(id) on delete set null,
  serving_id        uuid references public.food_servings(id) on delete set null,

  meal              public.meal_slot not null,

  -- ---------------------------------------------------------------- when --

  -- The instant the food was eaten. Editing this is how an entry moves to
  -- another day; `diary_date` follows from it rather than being set apart.
  logged_at         timestamptz not null default now(),
  -- The IANA zone the entry was made in, kept so a historical date can be
  -- explained later. Validated by trigger against the timezone database.
  time_zone         text not null check (length(time_zone) between 1 and 64),
  -- The user's calendar day. Stored, not derived on read: deriving it later
  -- would silently re-date history whenever the user travels.
  diary_date        date not null,

  -- ------------------------------------------------------------ how much --

  -- What the user chose: "2" of the portion described below.
  quantity          numeric(10,3) not null check (quantity > 0 and quantity <= 100000),
  -- The portion's label and its size in `basis_unit`. Logging a raw weight
  -- is the same shape with amount 1: 150 × "g".
  serving_label     text not null check (length(trim(serving_label)) between 1 and 100),
  serving_amount    numeric(10,3) not null check (serving_amount > 0),

  amount_in_base    numeric generated always as (quantity * serving_amount) stored,

  -- ------------------------------------------------- snapshot: identity --

  food_name         text not null check (length(trim(food_name)) between 1 and 300),
  brand_name        text check (brand_name is null or length(trim(brand_name)) between 1 and 200),
  food_source_id    text not null references public.food_sources(id),
  food_is_verified  boolean not null default false,

  -- ---------------------------------------------------- snapshot: basis --

  /*
   * Nutrition for `basis_amount` of `basis_unit`, copied from the food at the
   * moment of logging and immutable thereafter (see guard_food_log_snapshot).
   * Every total below is derived from these, which is what makes an edit
   * preserve the original nutritional basis.
   */
  basis_unit        public.food_base_unit not null,
  basis_amount      numeric(10,3) not null check (basis_amount > 0),

  basis_calories        numeric(10,2) not null check (basis_calories >= 0 and basis_calories <= 1000),
  basis_protein_g       numeric(10,3) not null default 0 check (basis_protein_g >= 0),
  basis_carbohydrates_g numeric(10,3) not null default 0 check (basis_carbohydrates_g >= 0),
  basis_fat_g           numeric(10,3) not null default 0 check (basis_fat_g >= 0),

  -- Null means the source never reported it, which is not zero and must not
  -- be totalled as zero.
  basis_fiber_g         numeric(10,3) check (basis_fiber_g is null or basis_fiber_g >= 0),
  basis_sugar_g         numeric(10,3) check (basis_sugar_g is null or basis_sugar_g >= 0),
  basis_saturated_fat_g numeric(10,3) check (basis_saturated_fat_g is null or basis_saturated_fat_g >= 0),
  basis_sodium_mg       numeric(10,2) check (basis_sodium_mg is null or basis_sodium_mg >= 0),

  -- ------------------------------------------------------------- totals --

  /*
   * Derived by the database from the frozen basis and the chosen portion.
   *
   * Generated columns cannot reference other generated columns, so each one
   * spells out `quantity * serving_amount` rather than reusing
   * `amount_in_base`. The duplication is the price of having the totals be
   * unforgeable, which is worth it: no client can write a calorie figure that
   * disagrees with the basis it claims to come from.
   *
   * Null basis values stay null through the arithmetic, so an unreported
   * nutrient stays unreported.
   */
  calories          numeric generated always as
                      (basis_calories * quantity * serving_amount / basis_amount) stored,
  protein_g         numeric generated always as
                      (basis_protein_g * quantity * serving_amount / basis_amount) stored,
  carbohydrates_g   numeric generated always as
                      (basis_carbohydrates_g * quantity * serving_amount / basis_amount) stored,
  fat_g             numeric generated always as
                      (basis_fat_g * quantity * serving_amount / basis_amount) stored,
  fiber_g           numeric generated always as
                      (basis_fiber_g * quantity * serving_amount / basis_amount) stored,
  sugar_g           numeric generated always as
                      (basis_sugar_g * quantity * serving_amount / basis_amount) stored,
  saturated_fat_g   numeric generated always as
                      (basis_saturated_fat_g * quantity * serving_amount / basis_amount) stored,
  sodium_mg         numeric generated always as
                      (basis_sodium_mg * quantity * serving_amount / basis_amount) stored,

  note              text check (note is null or length(note) <= 500),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

comment on table public.food_logs is
  'One logged item. Carries its own immutable nutrition snapshot; totals are generated from it. Never reads food_nutrition on the way out.';
comment on column public.food_logs.diary_date is
  'The user''s calendar day in time_zone at the moment of logging. Never a UTC truncation.';
comment on column public.food_logs.food_id is
  'Provenance only. SET NULL on catalogue deletion; the snapshot keeps the log intact.';

-- ------------------------------------------------------------------ indexes

/*
 * The diary read and the daily rollup are the same access pattern: one user,
 * one day (or a small range), grouped by meal. This index answers both, and
 * the INCLUDE list makes the rollup index-only — a day's totals never touch
 * the heap.
 */
create index food_logs_day_idx
  on public.food_logs (user_id, diary_date, meal)
  include (calories, protein_g, carbohydrates_g, fat_g)
  where deleted_at is null;

-- Sync cursor: "everything of mine that changed since X", including deletions,
-- so this one deliberately does not filter deleted_at.
create index food_logs_sync_idx
  on public.food_logs (user_id, updated_at);

-- "What do I log most often, recently" — the windowed frequent-foods query.
create index food_logs_food_idx
  on public.food_logs (user_id, food_id, diary_date desc)
  where deleted_at is null and food_id is not null;

-- ----------------------------------------------------------------- triggers

/*
 * Resolves and validates the diary day.
 *
 * The client computes the day and sends it; this recomputes it from the
 * instant and the zone and refuses a mismatch. Belt and braces on purpose —
 * the day is the key every dashboard, streak and goal reads by, and a client
 * bug that mis-dated entries would be discovered months later, in data.
 *
 * A null diary_date is derived rather than rejected, which is what lets a
 * server-side or SQL-level insert stay correct without duplicating the
 * calendar logic.
 *
 * Revalidation happens only when one of the three columns actually changes.
 * A timezone-database update can legitimately change what a *past* instant
 * maps to, and that must not turn an unrelated edit (renaming the meal) into
 * an error, nor silently re-date the entry.
 */
create or replace function public.resolve_food_log_day()
returns trigger
language plpgsql
as $$
declare
  derived date;
begin
  if tg_op = 'UPDATE'
     and new.logged_at is not distinct from old.logged_at
     and new.time_zone is not distinct from old.time_zone
     and new.diary_date is not distinct from old.diary_date then
    return new;
  end if;

  begin
    derived := (new.logged_at at time zone new.time_zone)::date;
  exception
    when invalid_parameter_value then
      raise exception 'Unknown time zone "%" on food log %', new.time_zone, new.id
        using errcode = 'check_violation';
  end;

  if new.diary_date is null then
    new.diary_date := derived;
  elsif new.diary_date <> derived then
    raise exception
      'diary_date % does not match % in %; a diary day is the local day of logged_at',
      new.diary_date, new.logged_at, new.time_zone
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger food_logs_resolve_day
  before insert or update on public.food_logs
  for each row execute function public.resolve_food_log_day();

/*
 * The snapshot invariant, enforced by the database rather than by whichever
 * client happens to be writing.
 *
 * What a user may edit: how much, which meal, when, the note, and whether the
 * entry is deleted. What nobody may edit: what the food *was* and what it
 * contained. Those are the columns the totals are derived from, and letting
 * them move would mean a historical log could be made to say something other
 * than what it said when it was written.
 *
 * `food_id` may only move in one direction — to null — because that is what
 * the ON DELETE SET NULL foreign key does when a catalogue row is removed.
 * Repointing a log at a *different* food is refused: the snapshot would then
 * describe one food while claiming provenance from another.
 */
create or replace function public.guard_food_log_snapshot()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'A food log cannot change owner'
      using errcode = 'check_violation';
  end if;

  if new.food_id is distinct from old.food_id and new.food_id is not null then
    raise exception 'A food log cannot be repointed at a different food'
      using errcode = 'check_violation';
  end if;

  if new.food_name             is distinct from old.food_name
     or new.brand_name         is distinct from old.brand_name
     or new.food_source_id     is distinct from old.food_source_id
     or new.food_is_verified   is distinct from old.food_is_verified
     or new.basis_unit         is distinct from old.basis_unit
     or new.basis_amount       is distinct from old.basis_amount
     or new.basis_calories     is distinct from old.basis_calories
     or new.basis_protein_g    is distinct from old.basis_protein_g
     or new.basis_carbohydrates_g is distinct from old.basis_carbohydrates_g
     or new.basis_fat_g        is distinct from old.basis_fat_g
     or new.basis_fiber_g      is distinct from old.basis_fiber_g
     or new.basis_sugar_g      is distinct from old.basis_sugar_g
     or new.basis_saturated_fat_g is distinct from old.basis_saturated_fat_g
     or new.basis_sodium_mg    is distinct from old.basis_sodium_mg
  then
    raise exception
      'The nutrition snapshot on food log % is immutable; edit quantity or serving instead',
      old.id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger food_logs_guard_snapshot
  before update on public.food_logs
  for each row execute function public.guard_food_log_snapshot();

create trigger food_logs_set_updated_at
  before update on public.food_logs
  for each row execute function public.set_updated_at();

-- --------------------------------------------------------------------- RLS

alter table public.food_logs enable row level security;

create policy "Read own food logs"
  on public.food_logs for select
  to authenticated
  using (user_id = auth.uid());

create policy "Create own food logs"
  on public.food_logs for insert
  to authenticated
  with check (user_id = auth.uid());

/*
 * USING and WITH CHECK both, and both required. USING alone would let a user
 * edit a row of theirs and hand it to someone else; WITH CHECK alone would let
 * them edit rows they cannot see.
 */
create policy "Update own food logs"
  on public.food_logs for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

/*
 * No DELETE policy and no DELETE grant. Removing an entry is a soft delete —
 * an UPDATE setting deleted_at — because a hard delete cannot be synced: the
 * other device would have nothing to learn from, and the row would return on
 * its next push. Deletion is a fact that has to travel.
 */
grant select, insert, update on public.food_logs to authenticated;
revoke all on public.food_logs from anon;
