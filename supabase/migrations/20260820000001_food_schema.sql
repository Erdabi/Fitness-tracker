-- ===========================================================================
-- Phase 1 — food catalogue
--
-- Seven entities: sources, categories, brands, foods, nutrition, servings,
-- barcodes. Three decisions drive the rest of the design.
--
-- 1. CANONICAL BASE UNITS. Every food declares `base_unit` (g / ml / item)
--    and `base_amount`, and its nutrition row holds the values for exactly
--    that quantity — per 100 g for solids, per 100 ml for liquids, per item
--    for countable foods. Human portions ("1 slice") live in food_servings
--    with an explicit gram equivalent. Everything logged resolves to the base
--    unit before any arithmetic, so scaling, recipes and daily totals are all
--    one multiplication.
--
-- 2. FIXED NUTRIENT COLUMNS, NOT EAV. The eight core nutrients are typed
--    columns: they are always queried together, always present in a diary
--    snapshot, and an EAV table would turn every total into an aggregate over
--    eight rows. `micronutrients jsonb` absorbs vitamins and minerals later
--    without a migration and without touching the hot path.
--
-- 3. SOURCE QUALITY IS ENFORCED, NOT ADVISORY. Nutrition carries its own
--    source, separate from the food's. A trigger refuses any update that
--    would replace a higher-ranked source with a lower one, so an AI estimate
--    can never silently overwrite USDA data — the guarantee is in the
--    database, not in whichever importer happens to be running.
-- ===========================================================================

create extension if not exists pg_trgm;

-- --------------------------------------------------------------------- enums

-- What a food *is*, which decides whether a brand is meaningful.
create type public.food_kind as enum ('generic', 'branded', 'packaged');

-- The quantity a nutrition row describes.
create type public.food_base_unit as enum ('g', 'ml', 'item');

create type public.barcode_format as enum ('ean13', 'ean8', 'upca', 'upce', 'other');

-- ------------------------------------------------------------- food_sources

/*
 * Reference data, not user data. `quality_rank` is the whole point: it is what
 * `guard_nutrition_quality` compares to decide whether an incoming row is
 * allowed to replace what is already stored.
 *
 * Licensing lives here too, because an ODbL obligation has to travel with the
 * rows it applies to — an attribution requirement recorded only in a README
 * is one refactor away from being lost.
 */
create table public.food_sources (
  id                   text primary key
                       check (id ~ '^[a-z0-9_]+$'),
  name                 text not null,
  homepage             text,

  license              text not null,
  attribution_required boolean not null default false,
  attribution_text     text,

  -- Higher wins. Verified databases outrank user entry, which outranks
  -- anything a model estimated from a photograph.
  quality_rank         smallint not null check (quality_rank between 0 and 100),

  created_at           timestamptz not null default now(),

  constraint attribution_text_present
    check (not attribution_required or attribution_text is not null)
);

comment on column public.food_sources.quality_rank is
  'Higher wins. Enforced by guard_nutrition_quality() on food_nutrition.';

insert into public.food_sources
  (id, name, homepage, license, attribution_required, attribution_text, quality_rank)
values
  ('usda', 'USDA FoodData Central',
   'https://fdc.nal.usda.gov/',
   'Public domain (U.S. Government work)', false, null, 100),

  ('openfoodfacts', 'Open Food Facts',
   'https://world.openfoodfacts.org/',
   'ODbL-1.0', true,
   'Contains information from Open Food Facts, made available under the Open Database License (ODbL).',
   70),

  ('user', 'User entered', null,
   'Owned by the user who created it', false, null, 60),

  ('ai_estimated', 'AI estimate', null,
   'Derived; not a measurement', false, null, 10);

-- ---------------------------------------------------------- food_categories

create table public.food_categories (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name       text not null,
  parent_id  uuid references public.food_categories(id) on delete set null,
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index food_categories_parent_idx on public.food_categories (parent_id);

-- ------------------------------------------------------------- food_brands

create table public.food_brands (
  id              uuid primary key default gen_random_uuid(),
  -- Null for the shared catalogue; set for a brand a user typed themselves.
  owner_id        uuid references public.profiles(id) on delete cascade,

  name            text not null check (length(trim(name)) between 1 and 200),
  -- Lowercased and accent-folded by the application, so client and importer
  -- normalise identically. See tools/ingestion/normalize.ts.
  normalized_name text not null,

  source_id       text not null references public.food_sources(id),
  external_id     text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

-- One shared brand per normalized name; a user's own brands are theirs alone.
create unique index food_brands_global_name_key
  on public.food_brands (normalized_name)
  where owner_id is null and deleted_at is null;

create unique index food_brands_owner_name_key
  on public.food_brands (owner_id, normalized_name)
  where owner_id is not null and deleted_at is null;

create index food_brands_owner_idx on public.food_brands (owner_id, updated_at);

-- -------------------------------------------------------------------- foods

create table public.foods (
  id                uuid primary key default gen_random_uuid(),

  -- Null means the shared catalogue. Custom foods are ordinary rows with an
  -- owner rather than a parallel table, so search, logging and recipes have
  -- one code path instead of two that drift apart.
  owner_id          uuid references public.profiles(id) on delete cascade,

  brand_id          uuid references public.food_brands(id) on delete set null,
  category_id       uuid references public.food_categories(id) on delete set null,

  name              text not null check (length(trim(name)) between 1 and 300),
  normalized_name   text not null,
  name_i18n         jsonb not null default '{}',
  description       text,

  kind              public.food_kind not null default 'generic',

  base_unit         public.food_base_unit not null,
  base_amount       numeric(10,3) not null default 100 check (base_amount > 0),

  -- Provenance of the food record itself. The nutrition row carries its own,
  -- because a USDA food can legitimately hold a user-corrected nutrition set.
  source_id         text not null references public.food_sources(id),
  -- The source's own identifier: FDC id, OFF barcode, etc. The dedup key that
  -- makes re-running an import an update rather than a duplicate.
  external_id       text,
  source_url        text,
  -- When the *source* last changed the record, so an importer can skip rows
  -- it has already seen at that version.
  source_updated_at timestamptz,
  imported_at       timestamptz,

  -- Curated/trusted rather than merely present.
  is_verified       boolean not null default false,

  search_tsv        tsvector generated always as (
                      to_tsvector('simple', coalesce(name, ''))
                    ) stored,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,

  -- An item-based food measured in 100s makes no sense; countable foods are
  -- described one at a time.
  constraint item_base_amount_is_one
    check (base_unit <> 'item' or base_amount = 1),

  -- Only the shared catalogue can claim to be verified. A user marking their
  -- own food verified would let it outrank real data in search.
  constraint only_global_foods_are_verified
    check (not is_verified or owner_id is null),

  -- Nothing a user typed is attributed to an external database.
  constraint user_foods_use_user_source
    check (owner_id is null or source_id in ('user', 'ai_estimated'))
);

-- Idempotent import: a second run of the same source updates rather than
-- inserts. This is what makes the pipeline safe to re-run.
create unique index foods_source_external_key
  on public.foods (source_id, external_id)
  where owner_id is null and external_id is not null;

create index foods_search_tsv_idx on public.foods using gin (search_tsv);
create index foods_name_trgm_idx  on public.foods using gin (normalized_name gin_trgm_ops);
-- Supports `normalized_name LIKE 'prefix%'` regardless of collation.
create index foods_name_prefix_idx on public.foods (normalized_name text_pattern_ops);
create index foods_owner_idx       on public.foods (owner_id, updated_at);
create index foods_brand_idx       on public.foods (brand_id) where brand_id is not null;
create index foods_category_idx    on public.foods (category_id) where category_id is not null;

-- ----------------------------------------------------------- food_nutrition

/*
 * One row per food, holding the values for `foods.base_amount` of
 * `foods.base_unit`.
 *
 * Core nutrients are typed columns because every read wants all of them at
 * once and every diary snapshot copies all of them. `micronutrients` is the
 * extension point: vitamins, minerals, cholesterol, potassium and anything
 * else can arrive without a migration, and without slowing the columns that
 * the dashboard reads on every render.
 */
create table public.food_nutrition (
  food_id          uuid primary key references public.foods(id) on delete cascade,

  calories         numeric(10,2) not null check (calories >= 0 and calories <= 1000),
  protein_g        numeric(10,3) not null default 0 check (protein_g >= 0),
  carbohydrates_g  numeric(10,3) not null default 0 check (carbohydrates_g >= 0),
  fat_g            numeric(10,3) not null default 0 check (fat_g >= 0),

  -- Nullable: absent means "the source did not say", which is different from
  -- zero and must not be presented as zero.
  fiber_g          numeric(10,3) check (fiber_g is null or fiber_g >= 0),
  sugar_g          numeric(10,3) check (sugar_g is null or sugar_g >= 0),
  saturated_fat_g  numeric(10,3) check (saturated_fat_g is null or saturated_fat_g >= 0),
  sodium_mg        numeric(10,2) check (sodium_mg is null or sodium_mg >= 0),

  micronutrients   jsonb not null default '{}',

  -- Provenance of these numbers specifically, and what guards them.
  source_id        text not null references public.food_sources(id),
  -- Only meaningful for estimates; a measurement has no confidence score.
  confidence       numeric(4,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Components cannot exceed the whole.
  constraint saturated_fat_within_fat
    check (saturated_fat_g is null or saturated_fat_g <= fat_g + 0.5),
  constraint sugar_within_carbohydrates
    check (sugar_g is null or sugar_g <= carbohydrates_g + 0.5),
  constraint fiber_within_carbohydrates
    check (fiber_g is null or fiber_g <= carbohydrates_g + 0.5),

  constraint confidence_only_for_estimates
    check (source_id = 'ai_estimated' or confidence is null)
);

-- Every "what did I eat" query reads nutrition by food; keep it a PK lookup.
comment on table public.food_nutrition is
  'Nutrition per foods.base_amount of foods.base_unit. Core nutrients are typed columns; micronutrients is the extension point.';

-- ------------------------------------------------------------ food_servings

/*
 * Human-readable portions. `amount` is the gram/ml equivalent and is
 * REQUIRED — a serving that cannot be converted to the base unit cannot be
 * logged, and inventing a gram value for "1 slice" would fabricate data.
 * Importers drop servings whose source gives no weight rather than guess.
 */
create table public.food_servings (
  id          uuid primary key default gen_random_uuid(),
  food_id     uuid not null references public.foods(id) on delete cascade,

  label       text not null check (length(trim(label)) between 1 and 100),
  amount      numeric(10,3) not null check (amount > 0),
  unit        public.food_base_unit not null,

  is_default  boolean not null default false,
  sort_order  smallint not null default 0,

  source_id   text not null references public.food_sources(id),

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index food_servings_food_idx
  on public.food_servings (food_id, sort_order)
  where deleted_at is null;

create unique index food_servings_one_default
  on public.food_servings (food_id)
  where is_default and deleted_at is null;

-- ------------------------------------------------------------ food_barcodes

create table public.food_barcodes (
  id         uuid primary key default gen_random_uuid(),
  food_id    uuid not null references public.foods(id) on delete cascade,

  -- Denormalised from foods so barcode uniqueness can be scoped without a
  -- cross-table subquery in an index predicate. Maintained by trigger.
  owner_id   uuid references public.profiles(id) on delete cascade,

  barcode    text not null check (barcode ~ '^[0-9]{6,14}$'),
  format     public.barcode_format not null default 'other',
  source_id  text not null references public.food_sources(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- One shared product per barcode; a user may still attach the same barcode to
-- their own food without colliding with the catalogue.
create unique index food_barcodes_global_key
  on public.food_barcodes (barcode)
  where owner_id is null and deleted_at is null;

create unique index food_barcodes_owner_key
  on public.food_barcodes (owner_id, barcode)
  where owner_id is not null and deleted_at is null;

create index food_barcodes_food_idx on public.food_barcodes (food_id);

-- ----------------------------------------------------------------- triggers

create trigger food_categories_set_updated_at
  before update on public.food_categories
  for each row execute function public.set_updated_at();

create trigger food_brands_set_updated_at
  before update on public.food_brands
  for each row execute function public.set_updated_at();

create trigger foods_set_updated_at
  before update on public.foods
  for each row execute function public.set_updated_at();

create trigger food_nutrition_set_updated_at
  before update on public.food_nutrition
  for each row execute function public.set_updated_at();

create trigger food_servings_set_updated_at
  before update on public.food_servings
  for each row execute function public.set_updated_at();

create trigger food_barcodes_set_updated_at
  before update on public.food_barcodes
  for each row execute function public.set_updated_at();

/*
 * The quality guard.
 *
 * Refuses any update that would replace nutrition from a higher-ranked source
 * with a lower-ranked one. Enforced in the database rather than in the
 * importer, so it holds no matter which pipeline, script or client is writing
 * — an AI estimate cannot overwrite USDA data even by accident.
 *
 * Re-stating the same source is always allowed: that is a refresh, not a
 * downgrade.
 */
create or replace function public.guard_nutrition_quality()
returns trigger
language plpgsql
as $$
declare
  incoming_rank smallint;
  existing_rank smallint;
begin
  if new.source_id = old.source_id then
    return new;
  end if;

  select quality_rank into incoming_rank
    from public.food_sources where id = new.source_id;
  select quality_rank into existing_rank
    from public.food_sources where id = old.source_id;

  if incoming_rank < existing_rank then
    raise exception
      'Refusing to replace % nutrition (rank %) with % (rank %) for food %',
      old.source_id, existing_rank, new.source_id, incoming_rank, new.food_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger food_nutrition_guard_quality
  before update on public.food_nutrition
  for each row execute function public.guard_nutrition_quality();

/*
 * Keeps food_barcodes.owner_id in step with its food. Denormalised only so
 * the two partial unique indexes above can exist; never set by clients.
 */
create or replace function public.sync_barcode_owner()
returns trigger
language plpgsql
as $$
begin
  select owner_id into new.owner_id from public.foods where id = new.food_id;
  return new;
end;
$$;

create trigger food_barcodes_sync_owner
  before insert or update of food_id on public.food_barcodes
  for each row execute function public.sync_barcode_owner();
