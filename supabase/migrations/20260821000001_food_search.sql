-- ===========================================================================
-- Phase 1 — food search
--
-- Search runs in PostgreSQL. The catalogue is hundreds of thousands to
-- millions of rows and must never be shipped to a device, so the client sends
-- a query and receives at most a page of lightweight results.
--
-- Two functions, because the two jobs are genuinely different:
--
--   search_foods()   ranked, fuzzy, paginated text search
--   lookup_barcode() exact, unranked, single-row lookup
--
-- Both are SECURITY DEFINER with an EXPLICIT ownership predicate, and that
-- choice is forced by measurement rather than preference.
--
-- Under RLS the planner abandoned every index and sequentially scanned the
-- whole catalogue: 233 ms for one search over 100k rows, and linear from
-- there. The cause is that `LIKE` (~~) and trigram `%` are not LEAKPROOF, so
-- PostgreSQL refuses to evaluate them before the RLS security qual — the
-- index quals cannot be pushed below the barrier, and every row must be
-- fetched and checked. (Wrapping auth.uid() in a scalar subquery, the usual
-- Supabase fix for per-row function cost, does not help: the barrier is the
-- problem, not the call.)
--
-- So these functions run as their owner and apply the *same* predicate RLS
-- would — `owner_id is null or owner_id = auth.uid()` — as an ordinary,
-- indexable qual. auth.uid() still reads the caller's JWT claim, because that
-- is a session setting rather than a property of the executing role.
--
-- What keeps this safe, and what the tests in supabase/tests/food_search.sql
-- assert directly:
--   • the ownership predicate is applied to every candidate branch;
--   • a null uid returns nothing at all;
--   • the return type is the lightweight result — no raw source payloads;
--   • EXECUTE is granted to `authenticated` only, and revoked from public.
-- ===========================================================================

-- Accent folding inside the function body. The client already folds the query
-- with the shared normaliser (tools/ingestion/normalize.ts), but the function
-- must not depend on a well-behaved caller.
create extension if not exists unaccent;

-- ------------------------------------------------------------- normalisation

/*
 * SQL mirror of normalizeForSearch(). Deliberately a *fallback*: the stored
 * `normalized_name` is written by the application so both sides agree, and
 * this exists so a query arriving unfolded still matches.
 *
 * Not IMMUTABLE — unaccent() is only STABLE — which is precisely why
 * normalized_name is a stored column written by the app rather than a
 * generated one.
 */
create or replace function public.normalize_search_text(raw text)
returns text
language sql
stable
as $$
  select nullif(
    trim(regexp_replace(lower(unaccent(coalesce(raw, ''))), '[^a-z0-9%]+', ' ', 'g')),
    ''
  );
$$;

-- ------------------------------------------------------------------ indexes

-- Prefix search: `normalized_name LIKE 'appl%'`. text_pattern_ops makes this
-- an index range scan regardless of the database collation.
-- (created in the schema migration; repeated here as documentation only)

-- Brand name prefix and fuzzy search.
create index if not exists food_brands_name_trgm_idx
  on public.food_brands using gin (normalized_name gin_trgm_ops);

create index if not exists food_brands_name_prefix_idx
  on public.food_brands (normalized_name text_pattern_ops);

-- Ranking prefers verified rows, and the planner benefits from being able to
-- find them without touching the heap.
create index if not exists foods_verified_idx
  on public.foods (is_verified)
  where deleted_at is null and owner_id is null;

-- Barcode lookup is an equality probe on a small, highly selective column.
-- The unique indexes from the schema migration already serve it; this one
-- covers the join back to the food so the lookup stays index-only.
create index if not exists food_barcodes_lookup_idx
  on public.food_barcodes (barcode, food_id)
  where deleted_at is null;

-- ------------------------------------------------------------- result shape

/*
 * The lightweight search result.
 *
 * Enough to render a result row and to open the serving screen; nothing more.
 * Full nutrition, micronutrients and raw source payloads stay on the server —
 * a search that returned them would move megabytes per keystroke and hand the
 * client a bulk copy of the catalogue.
 */
create type public.food_search_result as (
  food_id            uuid,
  name               text,
  brand_name         text,
  source_id          text,
  is_verified        boolean,
  is_own             boolean,
  base_unit          public.food_base_unit,
  base_amount        numeric,
  calories           numeric,
  protein_g          numeric,
  carbohydrates_g    numeric,
  fat_g              numeric,
  serving_label      text,
  serving_amount     numeric,
  serving_unit       public.food_base_unit,
  match_kind         text,
  score              numeric
);

-- ------------------------------------------------------------------ ranking

/*
 * RANKING
 *
 * Relevance decides the tier; quality only orders within it. The tiers are
 * 100 apart and every quality/ownership bonus together tops out well below
 * that, so a USDA row can never outrank a genuinely better match from a
 * weaker source — which is the stated requirement.
 *
 *   700  exact name match
 *   600  exact "brand name" match
 *   500  name starts with the query
 *   400  brand starts with the query
 *   300  every query word appears in the name (full-text)
 *   100..300  trigram similarity (100 + similarity * 200)
 *
 * Within a tier:
 *   + quality_rank / 4   (USDA +25, OFF +17.5, user +15, AI +2.5)
 *   + 10 if verified
 *   + 15 if the row belongs to the caller — someone's own "Protein Pancake"
 *        should beat a stranger's packaged one at equal relevance
 *   + shorter names first, as a tiebreak: "Apple" beats
 *     "Apple, raw, with skin, cooked" for the query "apple"
 *
 * Ties are broken by id so keyset pagination is deterministic.
 */
create or replace function public.search_foods(
  p_query        text,
  p_limit        int     default 25,
  p_cursor_score numeric default null,
  p_cursor_id    uuid    default null
)
returns setof public.food_search_result
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  q            text := public.normalize_search_text(p_query);
  page_size    int  := least(greatest(coalesce(p_limit, 25), 1), 100);
  -- Candidates gathered per strategy before ranking. Generous enough that
  -- ranking has real choice, bounded so a one-letter query cannot scan the
  -- whole catalogue.
  candidate_cap int := greatest(page_size * 8, 200);
begin
  if q is null or length(q) < 2 then
    return;
  end if;

  return query
  with candidates as (
    -- Exact and prefix on the food name (index range scan).
    (
      select f.id
        from public.foods f
       where f.deleted_at is null
         and f.normalized_name like q || '%'
       limit candidate_cap
    )
    union
    -- Fuzzy on the food name (trigram GIN).
    (
      select f.id
        from public.foods f
       where f.deleted_at is null
         and f.normalized_name % q
       order by similarity(f.normalized_name, q) desc
       limit candidate_cap
    )
    union
    -- Full-text: every word present, in any order. "greek yog" reaches
    -- "Greek Yogurt" even though it is not a prefix of the whole name.
    (
      select f.id
        from public.foods f
       where f.deleted_at is null
         and f.search_tsv @@ plainto_tsquery('simple', q)
       limit candidate_cap
    )
    union
    -- Brand prefix and fuzzy.
    (
      select f.id
        from public.foods f
        join public.food_brands b on b.id = f.brand_id
       where f.deleted_at is null
         and b.deleted_at is null
         and (b.normalized_name like q || '%' or b.normalized_name % q)
       limit candidate_cap
    )
  ),
  scored as (
    select
      f.id                                            as food_id,
      f.name,
      b.name                                          as brand_name,
      f.source_id,
      f.is_verified,
      (f.owner_id is not null)                        as is_own,
      f.base_unit,
      f.base_amount,
      n.calories,
      n.protein_g,
      n.carbohydrates_g,
      n.fat_g,
      s.label                                         as serving_label,
      s.amount                                        as serving_amount,
      s.unit                                          as serving_unit,
      case
        when f.normalized_name = q                                  then 'exact_name'
        when b.normalized_name is not null
             and b.normalized_name || ' ' || f.normalized_name = q  then 'exact_brand_name'
        when f.normalized_name like q || '%'                        then 'prefix_name'
        when b.normalized_name like q || '%'                        then 'prefix_brand'
        when f.search_tsv @@ plainto_tsquery('simple', q)           then 'all_words'
        else 'fuzzy'
      end                                             as match_kind,
      (
        case
          when f.normalized_name = q                                 then 700
          when b.normalized_name is not null
               and b.normalized_name || ' ' || f.normalized_name = q then 600
          when f.normalized_name like q || '%'                       then 500
          when b.normalized_name like q || '%'                       then 400
          when f.search_tsv @@ plainto_tsquery('simple', q)          then 300
          else 100 + (similarity(f.normalized_name, q) * 200)
        end
        + (src.quality_rank / 4.0)
        + (case when f.is_verified then 10 else 0 end)
        + (case when f.owner_id is not null then 15 else 0 end)
        -- Shorter names are usually the more generic, more useful entry.
        + greatest(0, 20 - (length(f.normalized_name) / 8.0))
      )::numeric                                      as score
    from candidates c
    join public.foods f          on f.id = c.id
    join public.food_sources src on src.id = f.source_id
    -- Inner join: a food with no nutrition cannot be logged, so it must not
    -- appear in results the user is meant to pick from.
    join public.food_nutrition n on n.food_id = f.id
    left join public.food_brands b on b.id = f.brand_id and b.deleted_at is null
    left join lateral (
      select fs.label, fs.amount, fs.unit
        from public.food_servings fs
       where fs.food_id = f.id
         and fs.deleted_at is null
       order by fs.is_default desc, fs.sort_order
       limit 1
    ) s on true
  )
  select
    scored.food_id, scored.name, scored.brand_name, scored.source_id,
    scored.is_verified, scored.is_own, scored.base_unit, scored.base_amount,
    scored.calories, scored.protein_g, scored.carbohydrates_g, scored.fat_g,
    scored.serving_label, scored.serving_amount, scored.serving_unit,
    scored.match_kind, scored.score
  from scored
  -- Keyset pagination. OFFSET would re-scan and re-rank everything before the
  -- page; this resumes from the last row seen, so page 40 costs what page 1
  -- costs. The id tiebreak is what makes it exact under equal scores.
  where p_cursor_score is null
     or (scored.score, scored.food_id) < (p_cursor_score, p_cursor_id)
  order by scored.score desc, scored.food_id desc
  limit page_size;
end;
$$;

comment on function public.search_foods is
  'Ranked food search. Relevance sets the tier (100 apart); source quality and ownership only order within a tier, so quality can never override relevance.';

-- ---------------------------------------------------------- barcode lookup

/*
 * Exact barcode lookup. Never fuzzy: a barcode is an identifier, and a
 * near-miss is a different product.
 *
 * The client normalises first (UPC-A widened to EAN-13), and this function
 * repeats the digit-stripping so a raw scan still works.
 *
 * `duplicate_count` exists because a barcode mapping to more than one shared
 * food is a data-quality fault, not something to resolve by picking at random.
 * The row returned is deterministic — verified first, then oldest — and the
 * count lets the client flag the problem instead of silently choosing.
 */
create or replace function public.lookup_barcode(p_barcode text)
returns table (
  result          public.food_search_result,
  duplicate_count int
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  digits text := regexp_replace(coalesce(p_barcode, ''), '\D', '', 'g');
begin
  -- A UPC-A is the same number as its EAN-13 with a leading zero.
  if length(digits) = 12 then
    digits := '0' || digits;
  end if;

  if length(digits) < 6 or length(digits) > 14 then
    return;
  end if;

  return query
  with matches as (
    select f.id, f.is_verified, f.created_at
      from public.food_barcodes bc
      join public.foods f on f.id = bc.food_id
     where bc.barcode = digits
       and bc.deleted_at is null
       and f.deleted_at is null
  )
  select
    (
      f.id, f.name, b.name, f.source_id, f.is_verified,
      (f.owner_id is not null), f.base_unit, f.base_amount,
      n.calories, n.protein_g, n.carbohydrates_g, n.fat_g,
      s.label, s.amount, s.unit,
      'barcode', 1000::numeric
    )::public.food_search_result,
    (select count(*)::int from matches)
  from matches m
  join public.foods f          on f.id = m.id
  join public.food_nutrition n on n.food_id = f.id
  left join public.food_brands b on b.id = f.brand_id and b.deleted_at is null
  left join lateral (
    select fs.label, fs.amount, fs.unit
      from public.food_servings fs
     where fs.food_id = f.id and fs.deleted_at is null
     order by fs.is_default desc, fs.sort_order
     limit 1
  ) s on true
  -- Deterministic: a verified record wins, then the oldest. Never arbitrary.
  order by f.is_verified desc, f.created_at asc
  limit 1;
end;
$$;

comment on function public.lookup_barcode is
  'Exact barcode lookup. Returns at most one row plus duplicate_count, so a barcode mapping to several foods is reported rather than silently resolved.';

-- ------------------------------------------------------------------- grants

-- Only signed-in callers may search. anon gets nothing.
grant execute on function public.normalize_search_text(text) to authenticated;
grant execute on function public.search_foods(text, int, numeric, uuid) to authenticated;
grant execute on function public.lookup_barcode(text) to authenticated;

revoke execute on function public.search_foods(text, int, numeric, uuid) from anon, public;
revoke execute on function public.lookup_barcode(text) from anon, public;
