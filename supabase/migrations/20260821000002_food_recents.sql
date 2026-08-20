-- ===========================================================================
-- Phase 1 — recently and frequently used foods
--
-- One row per (user, food), updated in place rather than appended to. That
-- shape does three jobs at once:
--
--   • "Recent"   — order by last_used_at
--   • "Frequent" — order by use_count
--   • No duplicate entries, because a repeat use is an UPDATE
--
-- Logging a food must never touch the shared catalogue, so usage lives here,
-- owned by the user, and syncs like any other user-owned table.
--
-- NOTE ON WINDOWED FREQUENCY. True "most logged in the last 30 days" needs
-- per-event rows, which is what `food_logs` will be in the next milestone.
-- Building an events table now, before the diary that produces the events,
-- would be a second source of truth to keep in step. `use_count` is an
-- all-time tally and is enough to order a shortlist; the windowed version
-- becomes a query over food_logs once that exists. See docs/food-search.md.
-- ===========================================================================

create table public.food_recents (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  food_id      uuid not null references public.foods(id) on delete cascade,

  last_used_at timestamptz not null default now(),
  use_count    integer not null default 1 check (use_count > 0),

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,

  -- The constraint that makes "no duplicate recents" structural rather than
  -- a rule the client has to remember.
  constraint food_recents_one_per_food unique (user_id, food_id)
);

-- The two list queries, both index-only for the ordering column.
create index food_recents_recent_idx
  on public.food_recents (user_id, last_used_at desc)
  where deleted_at is null;

create index food_recents_frequent_idx
  on public.food_recents (user_id, use_count desc)
  where deleted_at is null;

-- Sync cursor.
create index food_recents_sync_idx
  on public.food_recents (user_id, updated_at);

create trigger food_recents_set_updated_at
  before update on public.food_recents
  for each row execute function public.set_updated_at();

-- --------------------------------------------------------------------- RLS

alter table public.food_recents enable row level security;

create policy "Read own recents"
  on public.food_recents for select
  to authenticated
  using (user_id = auth.uid());

create policy "Create own recents"
  on public.food_recents for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Update own recents"
  on public.food_recents for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update on public.food_recents to authenticated;
revoke all on public.food_recents from anon;

-- ------------------------------------------------------------- read helpers

/*
 * Recent and frequent foods, in the same lightweight shape search returns, so
 * the food-picker renders one row component regardless of where the row came
 * from.
 *
 * SECURITY INVOKER: RLS restricts the recents to the caller, and the joined
 * foods to the shared catalogue plus their own.
 */
create or replace function public.list_recent_foods(
  p_limit int default 20,
  p_order text default 'recent'
)
returns setof public.food_search_result
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  return query
  select
    f.id, f.name, b.name, f.source_id, f.is_verified,
    (f.owner_id is not null), f.base_unit, f.base_amount,
    n.calories, n.protein_g, n.carbohydrates_g, n.fat_g,
    s.label, s.amount, s.unit,
    case when p_order = 'frequent' then 'frequent' else 'recent' end,
    -- Ordering is done by the ORDER BY below; the score field carries the
    -- ranking signal so the client can display a consistent model.
    case when p_order = 'frequent' then r.use_count::numeric
         else extract(epoch from r.last_used_at)::numeric end
  from public.food_recents r
  join public.foods f          on f.id = r.food_id and f.deleted_at is null
  join public.food_nutrition n on n.food_id = f.id
  left join public.food_brands b on b.id = f.brand_id and b.deleted_at is null
  left join lateral (
    select fs.label, fs.amount, fs.unit
      from public.food_servings fs
     where fs.food_id = f.id and fs.deleted_at is null
     order by fs.is_default desc, fs.sort_order
     limit 1
  ) s on true
  where r.deleted_at is null
  order by
    case when p_order = 'frequent' then r.use_count end desc nulls last,
    case when p_order = 'frequent' then null else r.last_used_at end desc nulls last,
    f.id
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
end;
$$;

grant execute on function public.list_recent_foods(int, text) to authenticated;
revoke execute on function public.list_recent_foods(int, text) from anon, public;
