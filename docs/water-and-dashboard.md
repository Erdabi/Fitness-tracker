# Water, dashboard and progress

Milestone 5 adds one genuinely new thing — water tracking — and two screens that
summarise what the earlier milestones already store.

The guiding constraint: **the dashboard is a summary, not a source of truth.**
Every figure comes from the repository that owns it. A dashboard that did its
own arithmetic would eventually disagree with the diary, and the diary is the
one people would believe.

---

## 1. Reuse, not a second implementation

Water is the diary with one number instead of eight, and its goals are goal
periods with one target instead of four. Both mechanisms already existed and
both are subtle — the local-date rule has DST and travel behind it, the period
chain has a same-day supersession rule that took a concurrency test to get
right.

So the first half of the migration is generalisation:

| Was | Now | Used by |
|---|---|---|
| `resolve_food_log_day()` | `resolve_local_date(instant, zone, date)` | `food_logs`, `water_logs` |
| body of `resync_goal_periods` | `resync_period_chain(table, user)` | `nutrition_goals`, `water_goals` |
| local `resyncGoalPeriods` | `resyncPeriodChain(table, …)` | both, on the device |

The existing suites are the proof this is behaviour-preserving: 63 food-log
assertions (including every DST, travel and rejection case) and 66 goal
assertions run against the generalised code unchanged. `resolve_food_log_day`
is **dropped**, not left beside its replacement — a second copy is exactly how
two features that must agree stop agreeing.

A test asserts both tables share one resolver, and that the old one is gone.

---

## 2. Water data model

```
water_logs   id · user_id · amount_ml · consumed_at · time_zone · local_date
             note · created_at · updated_at · deleted_at
```

Millilitres, always. A column holding both ml and fluid ounces cannot be
repaired after the fact, so the unit a user reads is a display preference and
`formatVolume` is the only place a conversion happens.

`amount_ml` is bounded to 1–5,000. The upper bound is a **typo guard, not a
health opinion**: five litres in one entry is a slipped decimal on a 500 ml
glass. Larger daily totals stay possible — they are simply more than one entry.

`local_date` goes through the shared resolver, so a glass at 23:30 in Auckland
belongs to that day and flying to Honolulu does not re-date it.

Deletion is soft, matching every other user-owned table: a hard delete cannot
be synchronised, and the other device would push the row straight back.

---

## 3. Water goals

```
water_goals  id · user_id · effective_from · effective_to (derived)
             target_ml · source · calculated_ml · basis_weight_kg
```

Goal periods, identical in mechanics to nutrition goals. Only `effective_from`
is authored; `effective_to` is derived on both sides and never pushed, so
changing a target is exactly one row and two devices cannot produce overlapping
periods.

`source` is `calculated` or `manual` — there is no third case, because a water
target is one figure, so "calculated then modified" is just a manual target with
the recommendation kept beside it, which `calculated_ml` already records.

### The recommendation

```
35 ml per kg of body weight, clamped to 1,500–4,000 ml, rounded to 50 ml
```

**A product heuristic, not medical advice**, and the UI says so wherever it
appears. There is no single correct number: real requirements move with climate,
activity, diet and health, none of which this app knows. 35 ml/kg is the common
consumer-software convention and gives a plausible starting point — about 2.4 L
at 70 kg.

It lives as one named constant (`ML_PER_KG_PER_DAY`) so changing it later is a
one-line decision. It is deterministic, monotone in weight, bounded, and total:
an unknown weight returns a plausible default rather than nothing, so the
dashboard can always offer a starting target.

**A weight change never rewrites a historical water goal.** The recommendation
depends on weight, which is precisely why the goal is a period with
`basis_weight_kg` snapshotted on it. A SQL test records a new weight, changes the
profile, and asserts not one column of the August goal moved.

---

## 4. Quick actions

`QUICK_ADD_ML = [250, 500, 750, 1000]` — sized to real containers rather than to
round numbers: a glass, a large glass, a small bottle, a litre bottle.

Every button, and the custom amount, calls `logWater`. There is no per-button
logic anywhere; adding a fifth preset is a change to that array. A parameterised
test drives all four and asserts each reaches the one handler with its own
number and nothing else.

---

## 5. Aggregation

Computed on the device, from rows it already holds. No server-side view.

```
waterDay(user, day)  →  { consumedMl, entryCount, targetMl, progress }
```

Two reads: one `SUM` over the covering index, one goal lookup. `progress` comes
from `goalProgress` — the same function the calorie goal uses — so "remaining"
and "over by" cannot be worded inconsistently between the two.

**Going over is never a negative remainder.** `describeWaterProgress` renders
`750 ml remaining` or `+300 ml over goal`, and a property test sweeps the whole
range asserting no negative volume is ever printed.

`waterHistory` returns every day in a range including blank ones, each against
**its own day's goal** — one pass over the logs and one over the goals, joined in
memory, rather than a goal lookup per day.

Water averages divide by days in the range; calories divide by days logged. That
asymmetry is deliberate: a blank water day genuinely is a day of no water, while
a blank food day means "not tracked" — nobody ate nothing.

---

## 6. Dashboard architecture

One composed read, `loadDashboard`, rather than a hook per card. Six database
operations, whatever the day contains:

1. the day's food totals, grouped by meal
2. the calorie/macro goal for that day
3. the day's water total
4. the water goal for that day
5. the latest weight
6. the weight a month before

**Measured, not asserted.** A counting wrapper around `SqlDatabase` records
every read, and the test pins the count at exactly six — loosely bounding it
would let a card added later quietly take it to seven. Two further tests prove
the count is flat: 80 entries on the day, and 120 days of history behind it,
both still cost six.

Timing with a year of history: **under 10 ms per render**, measured over 50
renders.

### Isolation

Each card is wrapped in a `DashboardSection` with its own error boundary. React
unmounts the whole tree on an uncaught render error, so one broken card would
blank the dashboard, the header and the tab bar with it. A test throws inside
the water card and asserts the calorie card beside it still renders.

### Offline

Reads come from SQLite, so the dashboard renders with the radio off and water
logged on a plane appears in the total immediately. `SyncNotice` shows pending
changes as a note, never as a blocker — the server is not treated as
authoritative for what the device already knows.

---

## 7. Local dates

Every dashboard and progress query resolves days through the established
`LocalDay` logic. `toISOString().slice(0, 10)` appears nowhere.

The boundary tests use instants where the local and UTC answers genuinely
disagree, in both directions:

| Instant (UTC) | Zone | Local day | UTC day |
|---|---|---|---|
| 2026-06-14 23:00 | Pacific/Auckland | 2026-06-**15** | 2026-06-14 |
| 2026-06-15 08:00 | Pacific/Honolulu | 2026-06-**14** | 2026-06-15 |

One test asserts the UTC truncation explicitly, then asserts the dashboard
returns the opposite — a suite that only logged mid-afternoon would pass with a
UTC truncation in place.

---

## 8. Progress

Three summaries over a 30- or 90-day window, all local.

**Weight** — starting, current, change, and a rate in kg/week. The rate divides
by the days the readings actually *span*, not by the window: two readings a week
apart inside a 90-day window describe a weekly rate, and dividing by 90 would
understate it tenfold. A single reading reports no change at all — "0.0 kg over
30 days" for somebody who weighed themselves once states a fact nobody
established.

**Calories** — daily average, days logged, and adherence: days within
`ADHERENCE_TOLERANCE` (10%) of **that day's** goal. The tolerance is one named
constant because "adherence" needs a definition, and 10% is roughly 200 kcal on
a 2,000 kcal goal — inside the noise of portion estimation, which is the point.

**Water** — daily average, days logged, days the goal was met.

The chart is a sparkline of positioned bars, not a charting dependency. It is
never the only way to read the data: the view carries a spoken summary, each bar
is individually labelled, and the same facts appear as text beside it.

---

## 9. Sync

Both water tables are ordinary syncable tables — a descriptor each, and no
change to the engine. 19 scenarios in `waterSync.node.test.ts` cover the same
ground the diary was held to: offline creation, reconnection with backoff,
several offline edits collapsing to one final state, cross-device delivery,
deletion not resurrecting, retry after rejection, concurrent edits settling on
one version, idempotence, and another user's water never being pulled.

One scenario is worth naming: **logging offline and logging online produce the
same logical state**, asserted by doing both and comparing.

---

## 10. RLS

`USING` and `WITH CHECK` on every write policy for both tables, no `DELETE`
policy and no `DELETE` grant, nothing for `anon`. The cross-user matrix is
asserted in full: read, insert, update and delete, in both directions.

---

## 11. Decisions worth revisiting

**35 ml/kg.** A convention, not a finding. One constant, easy to change.

**No reminders or notifications.** Water tracking is where a reminder feature
usually appears; notifications are a later milestone and adding them here would
have pulled in permissions, scheduling and background delivery.

**No server-side aggregation.** Same conclusion as the diary: the device answers
every question in single-digit milliseconds. Revisit when a client appears that
does not hold the rows.

**Scan and Train tabs remain placeholders.** They exist from Phase 0 and are out
of scope for this milestone; the navigation was extended, not replaced.
