-- ===========================================================================
-- Phase 1 — Row Level Security for the food catalogue
--
-- The access model differs from the identity tables, because these hold two
-- kinds of row in one table:
--
--   • SHARED CATALOGUE (owner_id is null) — every signed-in user may read it;
--     nobody may write it. Imports run through the service role, which
--     bypasses RLS and is only ever available server-side. This is what
--     stops a user editing USDA data for everyone.
--
--   • USER-OWNED (owner_id = auth.uid()) — readable and writable only by
--     the owner.
--
-- The child tables (nutrition, servings, barcodes) have no owner of their own
-- and derive it from their food via EXISTS. That is a primary-key lookup, and
-- it keeps ownership defined in exactly one place rather than denormalised
-- into three tables that can drift.
--
-- As in Phase 0, RLS is enabled but NOT forced — see the note in
-- 20260819000002_rls_policies.sql.
-- ===========================================================================

alter table public.food_sources    enable row level security;
alter table public.food_categories enable row level security;
alter table public.food_brands     enable row level security;
alter table public.foods           enable row level security;
alter table public.food_nutrition  enable row level security;
alter table public.food_servings   enable row level security;
alter table public.food_barcodes   enable row level security;

-- ------------------------------------------------------- reference data --

-- Sources and categories are public reference data: readable by anyone signed
-- in, writable by no one. No insert/update/delete policy exists at all, so
-- even a compromised anon key cannot alter licensing metadata.
create policy "Anyone signed in can read food sources"
  on public.food_sources for select
  to authenticated
  using (true);

create policy "Anyone signed in can read food categories"
  on public.food_categories for select
  to authenticated
  using (true);

-- ------------------------------------------------------------- brands --

create policy "Read shared and own brands"
  on public.food_brands for select
  to authenticated
  using (owner_id is null or owner_id = auth.uid());

create policy "Create own brands"
  on public.food_brands for insert
  to authenticated
  with check (owner_id = auth.uid());

create policy "Update own brands"
  on public.food_brands for update
  to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- -------------------------------------------------------------- foods --

create policy "Read shared catalogue and own foods"
  on public.foods for select
  to authenticated
  using (owner_id is null or owner_id = auth.uid());

/*
 * WITH CHECK carries three separate guarantees here:
 *   • owner_id = auth.uid() — a user cannot create a food owned by someone
 *     else, and cannot create a shared (null-owner) food at all.
 *   • is_verified = false — verification is a curation decision, not
 *     something a client can claim for itself.
 *   • source_id in (user, ai_estimated) — nothing a user types may be
 *     attributed to USDA or Open Food Facts.
 */
create policy "Create own foods"
  on public.foods for insert
  to authenticated
  with check (
    owner_id = auth.uid()
    and is_verified = false
    and source_id in ('user', 'ai_estimated')
  );

create policy "Update own foods"
  on public.foods for update
  to authenticated
  using (owner_id = auth.uid())
  with check (
    owner_id = auth.uid()
    and is_verified = false
    and source_id in ('user', 'ai_estimated')
  );

-- No delete policy: deletes are soft (an update setting deleted_at), so a
-- sync pull can observe the removal. A hard delete would simply vanish.

-- ---------------------------------------------------------- nutrition --

create policy "Read nutrition for readable foods"
  on public.food_nutrition for select
  to authenticated
  using (
    exists (
      select 1 from public.foods f
       where f.id = food_nutrition.food_id
         and (f.owner_id is null or f.owner_id = auth.uid())
    )
  );

create policy "Write nutrition for own foods"
  on public.food_nutrition for insert
  to authenticated
  with check (
    exists (
      select 1 from public.foods f
       where f.id = food_nutrition.food_id
         and f.owner_id = auth.uid()
    )
  );

create policy "Update nutrition for own foods"
  on public.food_nutrition for update
  to authenticated
  using (
    exists (
      select 1 from public.foods f
       where f.id = food_nutrition.food_id
         and f.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.foods f
       where f.id = food_nutrition.food_id
         and f.owner_id = auth.uid()
    )
  );

-- ----------------------------------------------------------- servings --

create policy "Read servings for readable foods"
  on public.food_servings for select
  to authenticated
  using (
    exists (
      select 1 from public.foods f
       where f.id = food_servings.food_id
         and (f.owner_id is null or f.owner_id = auth.uid())
    )
  );

create policy "Write servings for own foods"
  on public.food_servings for insert
  to authenticated
  with check (
    exists (
      select 1 from public.foods f
       where f.id = food_servings.food_id
         and f.owner_id = auth.uid()
    )
  );

create policy "Update servings for own foods"
  on public.food_servings for update
  to authenticated
  using (
    exists (
      select 1 from public.foods f
       where f.id = food_servings.food_id
         and f.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.foods f
       where f.id = food_servings.food_id
         and f.owner_id = auth.uid()
    )
  );

-- ----------------------------------------------------------- barcodes --

create policy "Read barcodes for readable foods"
  on public.food_barcodes for select
  to authenticated
  using (
    exists (
      select 1 from public.foods f
       where f.id = food_barcodes.food_id
         and (f.owner_id is null or f.owner_id = auth.uid())
    )
  );

create policy "Write barcodes for own foods"
  on public.food_barcodes for insert
  to authenticated
  with check (
    exists (
      select 1 from public.foods f
       where f.id = food_barcodes.food_id
         and f.owner_id = auth.uid()
    )
  );

create policy "Update barcodes for own foods"
  on public.food_barcodes for update
  to authenticated
  using (
    exists (
      select 1 from public.foods f
       where f.id = food_barcodes.food_id
         and f.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.foods f
       where f.id = food_barcodes.food_id
         and f.owner_id = auth.uid()
    )
  );

-- ------------------------------------------------------------- grants --

grant select on public.food_sources    to authenticated;
grant select on public.food_categories to authenticated;

grant select, insert, update on public.food_brands    to authenticated;
grant select, insert, update on public.foods          to authenticated;
grant select, insert, update on public.food_nutrition to authenticated;
grant select, insert, update on public.food_servings  to authenticated;
grant select, insert, update on public.food_barcodes  to authenticated;

-- Nothing is readable without a session.
revoke all on public.food_sources    from anon;
revoke all on public.food_categories from anon;
revoke all on public.food_brands     from anon;
revoke all on public.foods           from anon;
revoke all on public.food_nutrition  from anon;
revoke all on public.food_servings   from anon;
revoke all on public.food_barcodes   from anon;
