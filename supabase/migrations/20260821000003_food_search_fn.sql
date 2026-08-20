-- ===========================================================================
-- Phase 1 — search function, second cut
--
-- Replaces the SECURITY INVOKER definitions from 20260821000001 with
-- SECURITY DEFINER equivalents carrying an explicit ownership predicate, and
-- adds word-prefix matching. Both changes are driven by measurement; the
-- reasoning is recorded at each site below.
--
-- Kept as a separate migration rather than an edit, because migrations are
-- append-only once they have left this machine.
-- ===========================================================================

-- ------------------------------------------------------- word-prefix query

/*
 * Builds a tsquery where every word is a prefix: "greek yog" becomes
 * `greek:* & yog:*`.
 *
 * Whole-string prefix (`normalized_name LIKE 'yogur%'`) only matches names
 * that *begin* with the query, so "yogur" missed "Bench Yogurt 500" — a real
 * gap, since people type the distinctive word rather than the first one.
 * A prefix tsquery matches word-initially anywhere in the name and is served
 * by the existing GIN index.
 *
 * Tokens are reduced to [a-z0-9] before assembly. normalize_search_text
 * already strips most punctuation but leaves `%`, which is a tsquery
 * metacharacter — passing it through unescaped would raise a syntax error on
 * a query as ordinary as "milk 1.5%".
 */
create or replace function public.build_prefix_tsquery(q text)
returns tsquery
language plpgsql
immutable
as $$
declare
  cleaned text;
begin
  select string_agg(token || ':*', ' & ')
    into cleaned
    from (
      select regexp_replace(t, '[^a-z0-9]', '', 'g') as token
        from regexp_split_to_table(coalesce(q, ''), '\s+') t
    ) tokens
   where token <> '';

  if cleaned is null then
    return null;
  end if;

  return to_tsquery('simple', cleaned);
exception when others then
  -- A query that cannot be parsed is not an error the user should see; the
  -- other candidate strategies still run.
  return null;
end;
$$;

grant execute on function public.build_prefix_tsquery(text) to authenticated;

-- ------------------------------------------------------------ search_foods

create or replace function public.search_foods(
  p_query        text,
  p_limit        int     default 25,
  p_cursor_score numeric default null,
  p_cursor_id    uuid    default null
)
returns setof public.food_search_result
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid         uuid    := auth.uid();
  q             text    := public.normalize_search_text(p_query);
  tsq           tsquery := public.build_prefix_tsquery(
                             public.normalize_search_text(p_query));
  page_size     int     := least(greatest(coalesce(p_limit, 25), 1), 100);
  -- Enough candidates that ranking has real choice, bounded so a two-letter
  -- query cannot drag the whole catalogue through the scorer.
  candidate_cap int     := greatest(page_size * 4, 100);
  -- The fuzzy branch is the expensive one; it gets a tighter budget.
  fuzzy_cap     int     := greatest(page_size * 2, 50);
  -- Brand search is bounded on both sides: how many brands may match, and how
  -- many of each brand's foods are considered.
  brand_cap      constant int := 20;
  brand_food_cap constant int := 40;

  cheap_ids     uuid[];
  fuzzy_ids     uuid[];
  all_ids       uuid[];
begin
  -- No session, no results. The function runs as its owner, so this is the
  -- check that stands in for "you must be signed in".
  if v_uid is null then
    return;
  end if;

  if q is null or length(q) < 2 then
    return;
  end if;

  -- Cheap candidates first: index range scan and GIN lookups, ~3 ms.
  select array_agg(id) into cheap_ids
    from (
      (
        select f.id
          from public.foods f
         where f.deleted_at is null
           and (f.owner_id is null or f.owner_id = v_uid)
           and f.normalized_name like q || '%'
         limit candidate_cap
      )
      union
      (
        select f.id
          from public.foods f
         where f.deleted_at is null
           and (f.owner_id is null or f.owner_id = v_uid)
           and tsq is not null
           and f.search_tsv @@ tsq
         limit candidate_cap
      )
      union
      /*
       * Brands are resolved FIRST and foods fetched per brand through a
       * bounded lateral.
       *
       * The obvious join (foods JOIN brands WHERE brand.name LIKE ...) let the
       * planner pick a merge join that walked 100,100 rows of foods_brand_idx
       * to return 100 — 276 ms at a million rows, and linear from there. This
       * shape starts from the small side and can never scan more than
       * brand_cap × brand_food_cap rows, whatever a popular brand's catalogue
       * looks like.
       */
      (
        select bf.id
          from (
            select b.id
              from public.food_brands b
             where b.deleted_at is null
               and b.normalized_name like q || '%'
             limit brand_cap
          ) mb
          cross join lateral (
            select f.id
              from public.foods f
             where f.brand_id = mb.id
               and f.deleted_at is null
               and (f.owner_id is null or f.owner_id = v_uid)
             limit brand_food_cap
          ) bf
      )
    ) cheap;

  /*
   * Fuzzy matching is a FALLBACK, and running it unconditionally was the
   * single most expensive thing this function did: 70 ms of a 75 ms search on
   * 100k rows, because `%` has to compute similarity across every trigram
   * candidate and then sort them.
   *
   * It runs only when the cheap branches found *nothing at all*, and that is
   * a precise trigger rather than a rough one: the word-prefix query ANDs its
   * terms, so a single mistyped word ("snikers", "aple juice") already yields
   * zero candidates and drops through to here. A search that found real
   * matches never pays for typo tolerance it does not need.
   */
  if cheap_ids is null then
    select array_agg(id) into fuzzy_ids
      from (
        (
          select f.id
            from public.foods f
           where f.deleted_at is null
             and (f.owner_id is null or f.owner_id = v_uid)
             and f.normalized_name % q
           order by similarity(f.normalized_name, q) desc
           limit fuzzy_cap
        )
        union
        (
          select bf.id
            from (
              select b.id
                from public.food_brands b
               where b.deleted_at is null
                 and b.normalized_name % q
               limit brand_cap
            ) mb
            cross join lateral (
              select f.id
                from public.foods f
               where f.brand_id = mb.id
                 and f.deleted_at is null
                 and (f.owner_id is null or f.owner_id = v_uid)
               limit brand_food_cap
            ) bf
        )
      ) fuzzy;
  end if;

  all_ids := coalesce(cheap_ids, '{}') || coalesce(fuzzy_ids, '{}');
  if array_length(all_ids, 1) is null then
    return;
  end if;

  return query
  with candidates as (
    select distinct unnest(all_ids) as id
  ),
  scored as (
    select
      f.id                     as food_id,
      f.name,
      b.name                   as brand_name,
      f.source_id,
      f.is_verified,
      (f.owner_id is not null) as is_own,
      f.base_unit,
      f.base_amount,
      n.calories,
      n.protein_g,
      n.carbohydrates_g,
      n.fat_g,
      s.label                  as serving_label,
      s.amount                 as serving_amount,
      s.unit                   as serving_unit,
      case
        when f.normalized_name = q                                 then 'exact_name'
        when b.normalized_name is not null
             and b.normalized_name || ' ' || f.normalized_name = q then 'exact_brand_name'
        when f.normalized_name like q || '%'                       then 'prefix_name'
        when b.normalized_name like q || '%'                       then 'prefix_brand'
        when tsq is not null and f.search_tsv @@ tsq               then 'all_words'
        else 'fuzzy'
      end                      as match_kind,
      (
        case
          when f.normalized_name = q                                 then 700
          when b.normalized_name is not null
               and b.normalized_name || ' ' || f.normalized_name = q then 600
          when f.normalized_name like q || '%'                       then 500
          when b.normalized_name like q || '%'                       then 400
          when tsq is not null and f.search_tsv @@ tsq               then 300
          else 100 + (similarity(f.normalized_name, q) * 200)
        end
        -- Quality and ownership only order *within* a tier: the tiers are 100
        -- apart and these together cannot reach 70, so a well-sourced but
        -- irrelevant row can never outrank a better match.
        + (src.quality_rank / 4.0)
        + (case when f.is_verified then 10 else 0 end)
        + (case when f.owner_id is not null then 15 else 0 end)
        + greatest(0, 20 - (length(f.normalized_name) / 8.0))
      )::numeric               as score
    from candidates c
    join public.foods f          on f.id = c.id
    join public.food_sources src on src.id = f.source_id
    -- Inner join: a food with no nutrition cannot be logged, so it must not
    -- be offered as something to pick.
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
  -- Keyset pagination: resumes from the last row seen, so page 40 costs what
  -- page 1 costs. The id tiebreak keeps it exact when scores are equal.
  where p_cursor_score is null
     or (scored.score, scored.food_id) < (p_cursor_score, p_cursor_id)
  order by scored.score desc, scored.food_id desc
  limit page_size;
end;
$$;

-- ---------------------------------------------------------- lookup_barcode

create or replace function public.lookup_barcode(p_barcode text)
returns table (
  result          public.food_search_result,
  duplicate_count int
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  digits text := regexp_replace(coalesce(p_barcode, ''), '\D', '', 'g');
begin
  if v_uid is null then
    return;
  end if;

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
       and (f.owner_id is null or f.owner_id = v_uid)
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
  /*
   * Deterministic: verified first, then oldest, then by id.
   *
   * The id tiebreak is not decoration. `created_at` defaults to now(), which
   * is transaction time, so two rows inserted in the same transaction share it
   * exactly — and without a final tiebreak the "winner" was whichever the
   * planner happened to emit first. That is precisely the arbitrary choice
   * this function exists to avoid, and it showed up as a test that passed or
   * failed run to run.
   */
  order by f.is_verified desc, f.created_at asc, f.id asc
  limit 1;
end;
$$;

-- -------------------------------------------------------- list_recent_foods

create or replace function public.list_recent_foods(
  p_limit int default 20,
  p_order text default 'recent'
)
returns setof public.food_search_result
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return;
  end if;

  return query
  select
    f.id, f.name, b.name, f.source_id, f.is_verified,
    (f.owner_id is not null), f.base_unit, f.base_amount,
    n.calories, n.protein_g, n.carbohydrates_g, n.fat_g,
    s.label, s.amount, s.unit,
    case when p_order = 'frequent' then 'frequent' else 'recent' end,
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
    -- The definer equivalent of the RLS policy on food_recents.
    and r.user_id = v_uid
    and (f.owner_id is null or f.owner_id = v_uid)
  order by
    case when p_order = 'frequent' then r.use_count end desc nulls last,
    case when p_order = 'frequent' then null else r.last_used_at end desc nulls last,
    f.id
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
end;
$$;

-- ------------------------------------------------------------------- grants

-- A SECURITY DEFINER function is executable by PUBLIC unless revoked, so the
-- revoke is what actually restricts these — not the grant.
revoke execute on function public.search_foods(text, int, numeric, uuid) from public, anon;
revoke execute on function public.lookup_barcode(text) from public, anon;
revoke execute on function public.list_recent_foods(int, text) from public, anon;
revoke execute on function public.build_prefix_tsquery(text) from public, anon;

grant execute on function public.search_foods(text, int, numeric, uuid) to authenticated;
grant execute on function public.lookup_barcode(text) to authenticated;
grant execute on function public.list_recent_foods(int, text) to authenticated;
grant execute on function public.build_prefix_tsquery(text) to authenticated;
