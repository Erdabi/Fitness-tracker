# The food diary

One row per logged item, in `food_logs`. Everything else — day totals, streaks,
the dashboard that comes next — is an aggregate over that table.

Three properties carry the design. Each is enforced in the database rather than
by convention, because each fails silently and is discovered months later, in
somebody's history, where it cannot be repaired.

---

## 1. The snapshot is the record

A log stores **its own copy** of the food: the name, the brand, the provenance,
and the nutrition per base amount. It never reads `food_nutrition` to answer
"what did I eat on 3 March".

```
basis_unit, basis_amount            g, 100
basis_calories … basis_sodium_mg    52, 0.26, 13.81, 0.17, 2.4, …
food_name, brand_name               'Apple, raw', null
food_source_id, food_is_verified    'usda', true
```

This is structural, not a convention. Correcting a catalogue food tomorrow
cannot rewrite what someone ate last year, because the numbers are not there to
be rewritten.

`food_id` is provenance only, and the foreign key is **`ON DELETE SET NULL`**,
never `CASCADE`. A food removed from the catalogue — a bad import, a merged
duplicate, a user deleting their own food — must not take a year of somebody's
diary with it. The entry keeps rendering from its snapshot with no visible
change; only the link back to the catalogue goes.

A trigger, `guard_food_log_snapshot()`, refuses any update that moves the
identity or the basis. `food_id` may move in exactly one direction — to null —
because that is what the foreign key itself does; repointing a log at a
*different* food is refused, since the snapshot would then describe one food
while claiming provenance from another.

### What the tests prove

`supabase/tests/food_logs.test.sql` does not inspect the schema and conclude it
looks right. It mutates:

| Mutation | Assertion |
|---|---|
| `food_nutrition` corrected 52 → 60 kcal | the log still reads 104 kcal |
| food renamed, re-based, un-verified | name, basis and total all unchanged |
| food soft-deleted | entry intact |
| food, nutrition and servings **hard-deleted** | entry intact, `food_id` null, still 104 kcal |
| `update … set basis_calories = 999` | refused |
| `update … set food_name = 'Pear'` | refused |
| `update … set food_id = <other food>` | refused |

---

## 2. Totals are generated, not supplied

The client sends what the user chose — `quantity`, `serving_amount` — and the
frozen basis. Postgres computes the rest:

```sql
amount_in_base  generated always as (quantity * serving_amount) stored
calories        generated always as (basis_calories * quantity * serving_amount / basis_amount) stored
protein_g       …
```

Nine generated columns in total. Each spells out `quantity * serving_amount`
rather than reusing `amount_in_base`, because a generated column cannot
reference another generated column. The duplication buys something worth
having: **no client can post a total that disagrees with its own basis** —
Postgres rejects a supplied value outright. That includes an old build of this
app still installed on somebody's phone.

The sync descriptor therefore omits them on push and reads them back on pull.
`src/sync/__tests__/fakeRemote.ts` mirrors the same arithmetic, so a client that
stopped sending totals cannot look fine in tests and lose every calorie in
production.

### Editing preserves the original basis

This is the property that makes the snapshot worth having, and the one most
easily lost:

> A food logged at 52 kcal/100 g, later corrected to 60. Editing 200 g to
> 300 g gives **156 kcal**, not 180.

It holds because `editFoodLog` takes no nutrition at all. It reads
`basis_calories` off the row and rescales. There is nowhere for today's figure
to enter — not in the repository, not in the RPC surface, not in the table.

The edit screen says so in as many words, because someone who corrects a food
and then finds their old entries unchanged should already know why.

---

## 3. The diary day is the user's day

`diary_date` is a stored calendar day in the timezone the entry was made in,
recorded alongside that zone in `time_zone`. It is **never** a UTC truncation.

| Instant | Zone | Diary day | UTC day |
|---|---|---|---|
| 2026-06-15 21:30Z | Europe/Zurich | 2026-06-15 | 2026-06-15 |
| 2026-06-15 22:30Z | Europe/Zurich | 2026-06-**16** | 2026-06-15 |
| 2026-06-15 08:00Z | Pacific/Honolulu | 2026-06-**14** | 2026-06-15 |
| 2026-06-14 23:00Z | Pacific/Auckland | 2026-06-**15** | 2026-06-14 |

The last two bracket UTC in both directions, and the test asserts explicitly
that the stored day and the UTC day *disagree* — a suite that only ever logged
mid-afternoon would pass with a UTC truncation in place.

`resolve_food_log_day()` recomputes the day from the instant and the zone on the
way in and refuses a mismatch. A null `diary_date` is derived rather than
rejected, so a SQL-level insert stays correct without duplicating the calendar
logic. Revalidation happens only when `logged_at`, `time_zone` or `diary_date`
actually changes: a timezone-database update can legitimately change what a
*past* instant maps to, and that must not turn an unrelated edit into an error
nor silently re-date the entry.

### Travel

New entries use the zone the device is in now. **Historical entries do not
move** — they keep the date and the zone they were written with, and nothing
re-derives them. Someone who logs a week in Zurich and then flies to Tokyo sees
that week exactly where they left it.

The zone comes from the profile, falling back to the device. They are usually
the same; when they are not, it is because the user is travelling, and "which
day is this" should still be answered the way the rest of their history was
until they change it deliberately.

### Logging onto another day

Moving an entry means moving its instant — that is what keeps the invariant
checkable. Logging onto a day other than today places the entry at **midday**
in the user's zone. Midnight is the one local time that can fail to exist and
the one that sits a second from the neighbouring day; midday has twelve hours
of margin, which no DST shift comes close to.

### Daylight saving

Both halves of an ambiguous local hour (Zurich, 02:30 on the fall-back day)
resolve to the same diary day. A 23-hour spring-forward day still resolves to
one day, and midday still lands inside it.

---

## Deleting

Soft, always. `deleted_at` is set; the row stays.

A hard delete cannot be synchronised — the other device would have nothing to
learn from, and its own copy would push the row straight back on the next
cycle. Deletion is a fact that has to travel, so it is recorded as one. There
is no `DELETE` policy and no `DELETE` grant on `food_logs`.

The entry leaves the diary immediately, before the network is consulted and
whether or not there is one: every read filters `deleted_at IS NULL`.

Three orderings are covered by `src/sync/__tests__/diarySync.node.test.ts`:

- deleted after syncing → the other device drops it on its next pull;
- deleted while offline → repeated pulls do **not** resurrect it, because the
  outbox guard keeps the incoming row from overwriting the local deletion;
- created *and* deleted before ever reaching the server → the create is sent
  first and the delete immediately after, so the server never holds a live row
  it was never told about.

---

## Sync

`food_logs` is an ordinary syncable table: a descriptor in
`src/sync/registry.ts`, and no change to the engine. Fifteen scenarios are
driven end-to-end through the real engine, the real outbox and a real SQLite
database against an in-memory server — offline writes, reconnection, multiple
offline edits collapsing to one final state, cross-device delivery, concurrent
edits settling on one version without duplicating an entry, a rejected write
retried without duplication, idempotence, and another user's diary never being
pulled.

One point worth stating plainly: a failed push schedules a 2 s backoff, so a
sync fired the instant the radio returns finds nothing due yet and the entry
goes out on the next cycle. That is deliberate — reconnections flap — and the
test asserts it rather than papering over it.

### Local and server totals

Locally the totals are ordinary columns, computed by `scaleNutrition` —
SQLite could generate them, but the sync engine writes every column it is
given and a generated column cannot be written. The two sides therefore
compute the same product in `double precision` and `numeric` respectively, so
a pulled row can differ from the local one in the last bits of a float. That
is below display precision and never compounds, because both sides derive from
the same frozen basis rather than from each other.

---

## Aggregation

**Day totals are computed on the device**, by SQLite, from rows the device
already holds. The diary is offline-first; an aggregation that needed the
server would be an aggregation that fails on a plane.

`SUM` over a column where every contributing row is null returns null, which is
exactly right: a nutrient nobody reported has no total, and reporting one as
zero would understate the day while looking precise. A day where one food
reports fibre and another does not totals the fibre that *was* reported.

Measured with `scripts/benchmark-diary.ts` against the real migrations and the
real repository:

| Query | 100 entries | 1,000 | 10,000 |
|---|---:|---:|---:|
| One day's entries | 0.17 ms | 0.23 ms | **0.19 ms** |
| One day's totals, by meal | 0.11 ms | 0.14 ms | **0.07 ms** |
| 30-day rollup | 0.24 ms | 0.40 ms | **1.13 ms** |
| 365-day rollup | 0.30 ms | 1.73 ms | **3.36 ms** |
| Frequent foods (90-day window) | 0.29 ms | 0.60 ms | **0.66 ms** |

Everything on the interactive path is flat. The rollups grow with the rows
*inside the range*, which is the only thing they can grow with, and a year of
history still totals in single-digit milliseconds.

### The server-side index

Nothing on the interactive path runs server-side, but the index is built for
the rollup a web client or a multi-year chart would need next, and the claim
that it covers the query is checked rather than assumed:

```sql
create index food_logs_day_idx
  on public.food_logs (user_id, diary_date, meal)
  include (calories, protein_g, carbohydrates_g, fat_g)
  where deleted_at is null;
```

`scripts/benchmark-diary.sql` at 100,000 entries, after `VACUUM`:

```
Index Only Scan using food_logs_day_idx  (365 days, 1825 rows)
  Heap Fetches: 0
  Buffers: shared hit=35
  Execution Time: 1.371 ms
```

`Heap Fetches: 0` — the `INCLUDE` list does its job and a year's rollup never
touches the table.

### Decision: no server-side rollup table, yet

No materialised view, no nightly aggregate job. The device answers every
question the app currently asks, in under four milliseconds, over a decade of
data. A second source of truth for the same numbers would have to be kept in
step for no present benefit.

Revisit when a client appears that does not hold the rows — a web dashboard, a
shared coach view — or when a chart wants more history than a device sensibly
keeps.

---

## Frequent foods

Now that the diary exists, "frequent" has a real answer:

```sql
SELECT food_id, COUNT(*), MAX(logged_at), diary_date, food_name, brand_name, id
  FROM food_logs
 WHERE user_id = ? AND deleted_at IS NULL AND food_id IS NOT NULL
   AND diary_date >= ?          -- 90 days
 GROUP BY food_id
 ORDER BY COUNT(*) DESC, MAX(logged_at) DESC
```

This replaces `food_recents.use_count` for ranking. That column is an all-time
tally that never forgets, so a breakfast someone gave up two years ago outranks
the one they eat now; a 90-day window follows the person. `food_recents`
remains what it always was — the offline cache of catalogue details.

The bare columns come from the row `MAX(logged_at)` matched, which is a
documented SQLite guarantee for a query with exactly one min/max aggregate.
That is what makes the reported name the *latest* one rather than the
alphabetically largest. Adding a second aggregate over those columns would
silently break it, so there is only the one — and a test pins the behaviour.

### Log again

Because each entry carries its whole snapshot, repeating one is a local copy:
`repeatFoodLog` reads the source entry and writes a new one. No lookup, so it
works offline and works for a food that has since been deleted.

It repeats the nutrition *that entry* was written with, deliberately. Someone
repeating yesterday's breakfast is saying "the same thing again", and pulling
today's possibly-corrected figures would quietly make the two days
incomparable. The copy is independent from the moment it exists.

---

## Isolation

RLS with `USING` **and** `WITH CHECK` on every write policy. `USING` alone would
let a user edit a row of theirs and hand it to someone else; `WITH CHECK` alone
would let them edit rows they cannot see.

Asserted in the suite: another user sees nothing, cannot read a specific entry
even knowing its id, cannot edit one, cannot write into someone else's diary,
and cannot reassign their own entry to another user. `anon` has no grant at
all. Deleting an account removes its diary with it — that cascade is the one
that *should* fire.

---

## Screens

| Screen | Job |
|---|---|
| `app/(tabs)/diary.tsx` | The day: totals, four meals with subtotals, day navigation, "log again" |
| `app/food/[id].tsx` | Portion, quantity, meal — then write the entry |
| `app/diary/[id].tsx` | Edit or remove one entry |

Forward navigation stops at today. A diary records what happened, and offering
tomorrow invites entries that will be wrong by morning.

Empty meals still render their "Add …" row: a day with breakfast logged and
nothing else is a different thing from a day where lunch has not happened yet,
and that row is what makes logging the next meal one tap.

`SyncNotice` renders nothing when everything is settled, which is nearly
always. The two cases it does show are entries waiting to be sent and a sync
that failed — and it reports where the data is rather than raising an alarm,
because nothing is lost and nothing is the user's to fix.

No goal ring and no "remaining calories". Targets arrive with the calorie
calculator; inventing one here would mean showing somebody a budget nobody set.
