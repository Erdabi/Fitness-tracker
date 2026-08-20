# Food search

Search runs in PostgreSQL. The catalogue is hundreds of thousands to millions
of rows and never leaves the server — the client sends a query and receives at
most a page of lightweight results.

Three entry points, because the jobs are genuinely different:

| Function | Job |
|---|---|
| `search_foods(query, limit, cursor_score, cursor_id)` | Ranked, fuzzy, paginated text search |
| `lookup_barcode(barcode)` | Exact identifier lookup, never fuzzy |
| `list_recent_foods(limit, order)` | The user's own recent/frequent shortlist |

The app calls these through `src/features/food/searchService.ts`. Screens never
build queries and never see a Postgres row shape.

---

## Ranking

**Relevance decides the tier. Quality only orders within a tier.**

The tiers are 100 points apart, and every quality and ownership bonus together
tops out below 70. A well-sourced but irrelevant row therefore cannot outrank a
better match from a weaker source — which is the property that keeps search
useful rather than merely well-sourced.

| Score | Tier | Example for query `apple` |
|---:|---|---|
| 1000 | Exact barcode | (returned by `lookup_barcode`, never ranked against text) |
| 700 | Exact name | **Apple** |
| 600 | Exact `brand name` | **Mars Snickers** for `mars snickers` |
| 500 | Name starts with the query | **Apple** Juice |
| 400 | Brand starts with the query | **Chobani** Greek Yogurt |
| 300 | Every query word appears in the name | Green **Apple** Sauce |
| 100–300 | Trigram similarity (`100 + similarity × 200`) | Pine**apple** for `aple` |

Within a tier:

```
+ quality_rank / 4      USDA +25, Open Food Facts +17.5, user +15, AI +2.5
+ 10                    if verified
+ 15                    if the row belongs to the caller
+ max(0, 20 − len/8)    shorter names first
```

The ownership bonus exists because someone's own "Protein Pancake" should beat
a stranger's packaged one at equal relevance. The length term breaks the common
tie where a catalogue holds both `Apple` and `Apple, raw, with skin, cooked` —
the concise entry is nearly always the one meant.

Ties resolve by `id`, which is what makes keyset pagination exact.

### What the tests pin down

`supabase/tests/food_search.test.sql` asserts the properties, not the numbers:

- an exact match beats every prefix and fuzzy match;
- an exact Open Food Facts match outranks better-sourced but irrelevant USDA
  rows — **source quality does not override relevance**;
- verified USDA wins the tie against a similar unverified row at *equal*
  relevance;
- a user sees their own foods and never another user's.

---

## Matching

Accent- and case-insensitivity come from normalisation rather than from the
query. `foods.normalized_name` is written by the importer using
`normalizeForSearch` (`src/lib/search.ts`), and the client normalises the query
with **the same function** before sending it. `Café` and `cafe` both become
`cafe`, so they match.

That shared module is the reason search does not quietly degrade: if the two
sides ever normalised differently, stored names and typed queries would stop
agreeing. `tools/ingestion/normalize.ts` re-exports it rather than keeping a
copy. `normalize_search_text()` in SQL is a defensive fallback for a query that
arrives unfolded, not the primary path.

Three candidate strategies run, cheapest first:

1. **Whole-string prefix** — `normalized_name LIKE 'appl%'`, an index range scan.
2. **Word-prefix full text** — `greek:* & yog:*` against the GIN index. This is
   what lets `yogur` reach *Plain Yogurt*; a whole-string prefix only matches
   names that *begin* with the query, and people type the distinctive word.
3. **Trigram similarity** — typo tolerance, **only when the first two found
   nothing at all**. That trigger is precise rather than rough: the word-prefix
   query ANDs its terms, so a single mistyped word (`snikers`, `aple juice`)
   already yields zero candidates and drops through.

Brand search resolves brands first and fetches foods per brand through a
bounded lateral, so it can never scan more than `20 × 40` rows however large a
popular brand's catalogue grows.

---

## Barcode lookup

Exact, never fuzzy: a barcode is an identifier, and a near-miss is a different
product. UPC-A is widened to EAN-13 with a leading zero on both the client and
the server, so a product scanned in the US resolves to the same row as one
scanned in Europe.

A barcode is unique across the shared catalogue, but a user may attach the same
code to their own food. When more than one row matches, `duplicate_count`
reports it and the returned row is chosen **by rule**: verified first, then
oldest, then by id.

The id tiebreak is not decoration. `created_at` defaults to `now()`, which is
transaction time, so two rows inserted in one transaction share it exactly —
without a final tiebreak the winner was whichever the planner happened to emit
first, and that showed up as a test that passed or failed run to run.

---

## Pagination

Keyset, not `OFFSET`. The cursor is `(score, food_id)` and the next page
resumes from the last row seen, so page 40 costs what page 1 costs. `OFFSET`
would re-scan and re-rank everything before the page.

A full page returns a cursor; a short page returns `null`, which is how the
client knows it has reached the end. Pages cannot overlap, because the
`(score, id)` comparison is strict and `id` is unique.

---

## Security

`search_foods`, `lookup_barcode` and `list_recent_foods` are **`SECURITY
DEFINER` with an explicit ownership predicate**, and that is forced by
measurement rather than preference.

Under RLS the planner abandoned every index and sequentially scanned the
catalogue — **233 ms for one search over 100k rows**, and linear from there.
The cause is that `LIKE` (`~~`) and trigram `%` are **not `LEAKPROOF`**, so
PostgreSQL refuses to evaluate them before the RLS security qual: the index
quals cannot be pushed below the barrier and every row must be fetched and
checked. Wrapping `auth.uid()` in a scalar subquery — the usual Supabase fix
for per-row function cost — does not help, because the barrier is the problem
rather than the call.

So the functions run as their owner and apply the same predicate RLS would,
`owner_id is null or owner_id = auth.uid()`, as an ordinary indexable qual.
`auth.uid()` still reads the caller's JWT claim, because that is a session
setting rather than a property of the executing role.

What keeps it safe, all asserted in the test suite:

- the ownership predicate is applied to **every** candidate branch;
- a null uid returns nothing at all;
- the return type is the lightweight result — no raw source payloads;
- `EXECUTE` is revoked from `public` and `anon`, granted only to
  `authenticated`. A `SECURITY DEFINER` function is executable by `PUBLIC`
  unless revoked, so the revoke is what actually restricts these.

The tables themselves keep their ordinary RLS. Nothing here widens what a user
can reach; it changes only how the planner is allowed to reach it.

---

## Performance

Measured on PostgreSQL 16 with `scripts/benchmark-search.sql`, which generates
a synthetic catalogue and times the representative queries. Every generated row
is clearly marked test data; no real food is fabricated.

```bash
psql -d bench -v scale=1000000 -f scripts/benchmark-search.sql
```

| Query | 100k | 500k | 1M |
|---|---:|---:|---:|
| Exact barcode | 1.2 ms | 1.2 ms | **1.3 ms** |
| Exact name | 6–12 ms | 10–14 ms | **7–11 ms** |
| Prefix | 4.6 ms | 7.6 ms | **8.3 ms** |
| Prefix, no matches (worst case) | 5.3 ms | 7.7 ms | **1.4 ms** |
| Brand | 4.1 ms | 4.7 ms | **3.1 ms** |
| Paged (keyset, page 5) | 3.8 ms | 5.3 ms | **5.7 ms** |
| Fuzzy (fallback only) | 15 ms | 80–94 ms | **169–179 ms** |

Everything on the interactive path is flat to a million rows. Only fuzzy scales
linearly, and it runs solely when nothing else matched — a user typing a real
word never pays for it.

### Benchmark honesty

An earlier version of the generator embedded the row number in every food name,
producing **one distinct lexeme per row** — a 1,000,035-entry GIN lexicon. That
made a *non-matching* prefix scan cost 230 ms while a matching one cost 1.3 ms.
That is a property of the generator, not of the search, and reporting it would
have been misleading. A real million-food catalogue has tens of thousands of
distinct words, and the generator now produces roughly that shape.

### Decision: stay on PostgreSQL

No separate search engine. Elasticsearch, Typesense or Meilisearch would each
add a service to run, a schema to keep in step, and an indexing pipeline that
can silently fall behind — and the measurements above do not justify any of it.
Interactive queries are single-digit milliseconds at a million rows.

Revisit if any of these becomes true:

- the interactive path exceeds ~50 ms at the real catalogue size;
- multi-language search with per-language stemming is needed (Postgres can do
  this, but the configuration cost rises steeply);
- typo tolerance must be the *primary* path rather than a fallback.

---

## Offline

The global catalogue is server-side and is **never** synced to a device. What
works offline is what the device already has:

| Data | Offline | Why |
|---|---|---|
| Recent foods | ✅ | `food_recents` syncs; `food_cache` holds the details |
| Frequent foods | ✅ | Same rows, ordered by `use_count` |
| A previously selected food | ✅ | Cached on selection, with its servings |
| Searching for something new | ❌ | Requires the server, and the UI says so |

The UI states which it is showing rather than blurring the two. A recent list
is labelled *available offline*; a failed search says *search needs an internet
connection* while leaving the recents usable. Presenting cached data as if it
were a live search would be a lie of omission — a user offline is looking at
what their device had, not at everything that exists.

`food_cache` is bounded to 500 foods and evicts least-recently-used. It is a
cache of server-owned data: it never syncs, never pushes, and is safe to clear
at any time. The bound is deliberate — an unbounded cache drifts toward being a
partial copy of the catalogue, which is the thing that has to stay on the
server.

---

## Recent and frequent foods

One row per `(user, food)`, updated in place. That single shape does three jobs:
*recent* orders by `last_used_at`, *frequent* orders by `use_count`, and a
repeat use is an `UPDATE`, so duplicates are impossible — enforced by a unique
index rather than left to the caller to remember.

Recording a use never touches the shared catalogue.

### Windowed frequency — deferred here, delivered with the diary

True "most logged recently" needs per-event rows. Building an events table
before the diary that produces the events would have created a second source of
truth to keep in step for no present benefit, so this shipped with `use_count`,
an all-time tally, which is enough to order a shortlist.

`food_logs` now exists, and the windowed version is a 90-day query over it —
see [Frequent foods](food-diary.md#frequent-foods). That is what ranks the
"log again" shortcuts. `food_recents` stays what it always was: the
offline-capable cache of catalogue details.
