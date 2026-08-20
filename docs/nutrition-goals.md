# Calorie and macro goals

Two things live here: a **calculator**, which is pure arithmetic over a
population regression, and **goal periods**, which are a record of what somebody
was aiming at and when.

The line between them is the point of the design. The calculator produces a
*recommendation*; a period stores the *target actually in force*; and the two
are kept side by side so a screen can never quietly present one as the other.

---

## 1. What the numbers are

Estimates. Mifflin-St Jeor predicts resting metabolic rate to within roughly
±10% for most people and further off for some; activity multipliers are coarser
still. Every screen that shows one says so, and `src/lib/energy.ts` has no way
to express it as anything else.

**Nothing here is medical advice.** The safety floor below is a product rule
about what this app will suggest on its own — not a claim about what is safe for
any particular person.

### BMR — Mifflin-St Jeor

```
male:   10 × weight_kg + 6.25 × height_cm − 5 × age + 5
female: 10 × weight_kg + 6.25 × height_cm − 5 × age − 161
```

`basalMetabolicRate` returns a **result**, not a number, because two states are
genuinely not a number:

| State | Returned |
|---|---|
| Sex not given | `{ ok: false, reason: 'sex-unspecified' }` |
| Metrics that are not a person | `{ ok: false, reason: 'invalid-metrics' }` |

The equation has no term for an unspecified sex. Substituting a default would
produce a confident figure with nothing behind it, so the calculator asks — and
offers to skip to a hand-set target instead. `other` on the profile maps to
`unspecified`; it is a legitimate answer, not an error.

### TDEE — activity

`TDEE = BMR × multiplier`, with the multipliers as named constants in
`ACTIVITY_LEVELS`, each carrying the description the UI shows:

| Level | × | Description |
|---|---:|---|
| Sedentary | 1.2 | Desk work, little or no deliberate exercise |
| Lightly active | 1.375 | Light exercise 1–3 days a week |
| Moderately active | 1.55 | Moderate exercise 3–5 days a week |
| Very active | 1.725 | Hard exercise 6–7 days a week |
| Extra active | 1.9 | Hard daily exercise, or a physical job |

The gap between "moderate" and "very" is 11% of a day's energy and no four-word
label resolves that — which is exactly why the descriptions travel with the
constants rather than being retyped at the call site.

### Rounding

Calorie figures round to the nearest **10 kcal**. The equation's own error is
measured in hundreds, so a target of 2,047 would imply an accuracy the number
does not have; rounding to 10 also makes recalculations comparable, since a
kilogram of weight change moves the figure visibly.

BMR and TDEE round to whole calories for display but are carried at full
precision through the arithmetic, so rounding never compounds.

---

## 2. Goal adjustments

```
lose:     −500 kcal/day   (≈ 0.45 kg a week)
maintain:    0
gain:     +300 kcal/day
```

Conservative by default, and overridable in the calculation layer
(`TargetOptions.calorieAdjustment`) rather than by editing a screen.

The adjustment is also **capped as a share of maintenance** — 25% for a deficit,
20% for a surplus. A flat 500 off a 3,000 kcal maintenance is 17%; off 1,600 it
is 31%, which is a different proposition entirely. Capping the proportion is
what stops one number from meaning two things.

The results screen shows all three figures separately, never just the last one:

```
Estimated maintenance   2,759 kcal
Suggested target        2,260 kcal
Your target             2,400 kcal   ← only after you choose
```

---

## 3. The safety floor

**This is a product rule, documented as one.**

It is not a claim that these figures are safe for any given person, and the app
never says so. It is a statement about what this software will put on screen
unprompted: below these numbers, an automatically generated target stops being a
suggestion and starts being an instruction nobody qualified has looked at.

Two floors, and the higher wins:

| Rule | Value |
|---|---|
| Table (`CALORIE_FLOOR_KCAL`) | 1,200 female · 1,500 male · 1,200 unspecified |
| Personal | the user's own BMR |

For a tall or heavy person the personal floor binds long before 1,200 does,
which is why both exist.

When the floor moves a recommendation:

- the raw figure is kept (`rawTarget`) so the UI can show the difference;
- `floorApplied` is set, and the results screen explains it in the app's own
  terms — *"below the lowest target this app will suggest"*, not *"unsafe"*;
- the target is **rounded up** to the step, never down. Rounding to the nearest
  10 would push a floored 1,561 to 1,560 — a calorie under the bound that had
  just raised it. A rule rounding can cross is not a rule.

A user may still set a lower target **by hand**. That path warns, records
`acknowledged_below_floor`, and stores `source = 'manual'`. The app will not
arrive there on its own and will not present it as a recommendation.

---

## 4. Macro targets

Protein and fat first, carbohydrate takes the remainder:

```
protein_g = weight_kg × (1.8 losing · 1.6 maintaining · 1.8 gaining)
fat_g     = max(25% of target ÷ 9, weight_kg × 0.5)
carbs_g   = (target − protein×4 − fat×9) ÷ 4
```

Only one of the three absorbs the remainder, so only one can be off — and it is
the one with the widest sensible range. Protein and fat are **rounded to whole
grams before carbohydrate is computed**, so the numbers on screen add up to the
target rather than to an unrounded figure behind it.

### Reconciliation

Three whole-gram numbers cannot always hit a multiple of ten exactly. The gap is
bounded at **±2 kcal** — half a gram either way — and a property test sweeps
every direction, weight 45–160 kg and target 1,200–4,000 kcal to prove it.

`GoalSummary` states the gap when it exceeds that, rather than letting somebody
add the numbers up and wonder which one is wrong.

### When a target cannot hold both

A heavy person on a hand-entered low target: 160 kg of minimum protein and fat
is 1,488 kcal against a 1,200 kcal target. Fat gives way to its floor first
(0.5 g/kg), then protein to its own (1.2 g/kg), and if both minimums still do
not fit, the target is split between them in the ratio of those minimums —
carbohydrate at zero.

It fits rather than overshooting, because three numbers that visibly exceed the
target printed above them are wrong on screen whatever the target's own merits.
That the target is below what the app will recommend is a separate fact,
reported separately.

This is unreachable from the calculated path: the floor is the person's own BMR,
which for a 160 kg body is far above 1,200.

---

## 5. Goal periods

A goal is a **period**, not a setting.

```
1 – 10 August     2,000 kcal
11 August –       2,200 kcal
```

The diary for 5 August reads 2,000. The diary for 15 August reads 2,200. Neither
is computed from the current profile.

### Only `effective_from` is authored

`effective_to` is **derived** — by trigger in Postgres (`resync_goal_periods`),
by `resyncGoalPeriods` on the device — and never sent.

That is a sync decision before it is a modelling one. If a client had to close
the previous period itself, a change of target would be *two* writes that must
land in order, and an offline outbox cannot promise that: a partially applied
push would leave two periods claiming the same day. Deriving it means a change
of target is exactly one row, and there is no ordering to get wrong.

The sync descriptor omits the column on push; a test asserts no pushed row ever
carries it.

### Supersession

`effective_to = effective_from − 1` marks a period **superseded before it took
effect** — what two devices opening a period on the same day produces. The range
is empty, so it covers no date and every lookup skips it, while the row survives
because it is still a record of something the user did.

`goal_period_range()` maps that encoding to `'empty'::daterange`, because
`daterange()` refuses inverted bounds rather than normalising them.

### One goal per user per date

Enforced, not asserted:

```sql
exclude using gist (
  user_id with =,
  public.goal_period_range(effective_from, effective_to) with &&
) where (deleted_at is null)
deferrable initially deferred
```

`DEFERRABLE` because the resync trigger settles the chain inside the same
transaction — an insert momentarily overlaps the period it supersedes, and
checking at commit is what lets the correction land first.

A test walks every day across a two-month range and asserts no date is ever
covered twice.

### Resolution

```sql
select * from nutrition_goals
 where user_id = ? and deleted_at is null and effective_from <= :day
 order by effective_from desc, created_at desc, id desc
 limit 1
```

Identical in `goal_for_date()` and in `goalForDate()`, so "which goal applies to
5 August" has one answer wherever it is asked. The ordering *is* the rule — it
needs no `effective_to` to be correct, which is why a superseded period resolves
away naturally rather than needing to be filtered.

`created_at` defaults to **`clock_timestamp()`**, not `now()`. It is a tiebreak
here, not just a record: two rows written in one transaction under `now()` would
tie exactly and the winner would fall to whichever random UUID sorted higher.
The same reasoning put `clock_timestamp()` behind `set_updated_at()` in Phase 0.

---

## 6. History is never rewritten

Changing weight, height, age, activity or direction has **no effect on any goal
that already exists**. A recalculation opens a new period from today.

Each period snapshots what it was calculated from — `basis_bmr`, `basis_tdee`,
`basis_activity`, `basis_direction`, `basis_weight_kg`, `basis_height_cm`,
`basis_age_years`, `basis_sex` — the same way a diary entry snapshots its
nutrition. A period from March still explains itself in December, after the
profile has moved on several times.

The SQL test changes height, activity and birth date on the profile and then
asserts that **not one column** of the August goal moved, by comparing the whole
row as JSON.

---

## 7. Manual targets keep the recommendation

```
Calculated recommendation   2,050 kcal   ← stored
Active target               2,200 kcal   ← stored
source                      calculated_then_modified
```

`source` is **derived from the numbers**, never declared by the caller:

| Condition | Source |
|---|---|
| No recommendation exists | `manual` |
| Target identical to the recommendation | `calculated` |
| Target differs in any of the four figures | `calculated_then_modified` |

A caller that said "calculated" while holding a different target would have
produced a row nobody could interpret — so three database checks reject exactly
that, including a `calculated_then_modified` row identical to its own
recommendation.

A macro-only change counts: same calories, different split, still a
modification. Both splits are stored.

Editing a target later keeps the original recommendation and the original basis,
and moves the source accordingly.

---

## 8. Offline and sync

Both tables are ordinary syncable tables. Everything works with the radio off:
reading the current goal, recalculating, setting a target by hand, editing one,
recording a weight.

Sixteen scenarios in `src/sync/__tests__/goalSync.node.test.ts`, including the
one the schema is shaped around:

> Two devices, both offline, both opening a period on the same day. A unique
> constraint would reject one forever. Here both rows survive the round trip and
> **both devices resolve the day to the same period** — the later creation — with
> exactly one live period covering it on each.

### `afterPull`

A period arriving from another device changes where the period *before* it ends.
The engine gained one general hook for this — `TableDescriptor.afterPull` — and
knows nothing about goals; it calls whatever the descriptor declares, only when
rows actually landed. The hook must be idempotent, must not touch `updated_at`,
and must not enqueue anything, since it runs on data that just arrived.

Local resync writes are deliberately **outside** the outbox and deliberately do
not bump `updated_at`, or a purely local recomputation would look like a user
edit to the conflict resolver and be pushed straight back.

---

## 9. Weight history

A table, not a column. A single mutable `profiles.weight_kg` would lose every
previous measurement the first time somebody stepped on a scale — and the
calculator needs a current weight anyway, so the history costs one table and
buys progress tracking outright.

Re-recording the same day **updates** that day's entry: correcting a typo should
not leave two readings behind. Two *devices* recording the same morning offline
is different — each creates a row, both survive, and the later one reads back.
There is deliberately no uniqueness on `(user_id, measured_on)`, because
rejecting the second forever would lose a real measurement to a constraint.

`weightOn(day)` carries the last known reading forward. A person who did not
weigh themselves on Tuesday still had a weight on Tuesday; interpolating would
invent measurements nobody took.

---

## 10. Diary integration

The header shows consumed against the goal **resolved for the diary's own
date**, never today's:

```
1,760 / 2,000 kcal          240 remaining
P 90/144 g   C 200/200 g   F 60/63 g
```

Exceeding the target renders as an **overage**, not a negative remaining figure.
`goalProgress` returns `remaining` (signed), `isOver`, and `overBy` (never
negative) so no screen has to negate anything and none can accidentally print
"−240" under a label reading *remaining*, which a user reads as an allowance
they still have.

The integration test logs the same 2,100 kcal on two days either side of a goal
change and asserts one is over and the other under — a diary using today's goal
for both would call them identical, and one of those would be a lie.

---

## 11. Performance

Goal lookup is indexed on `(user_id, effective_from desc)` with
`include (effective_to, calorie_target)`.

Postgres, 200 periods, after `VACUUM`:

```
Index Scan using nutrition_goals_lookup_idx  (rows=1)
  Index Cond: user_id = … AND effective_from <= '2024-01-15'
  Execution Time: 0.126 ms
```

Locally, measured by `npm run bench:diary` against the real repository:

| Query | 100 entries | 1,000 | 10,000 |
|---|---:|---:|---:|
| Goal for today (200 periods) | 0.068 ms | 0.099 ms | **0.265 ms** |
| Goal for a date years back | 0.063 ms | 0.074 ms | **0.076 ms** |

Flat, because the index is scanned descending and stopped at the first hit — the
number of periods behind it does not matter. No materialised views.

---

## 12. Validation

All of it in `src/lib/bodyInputs.ts`, shared by the calculator, the goal screen
and the repositories. Validation split across screens is validation that
disagrees with itself.

| Field | Accepted |
|---|---|
| Age | 13–120, whole years |
| Weight | 25–400 kg (entered as kg or lb) |
| Height | 100–250 cm (entered as cm, or feet + inches) |
| Calorie target | 800–10,000, whole |
| Protein / carbs / fat | 0–500 / 0–1500 / 0–500 g |

Bounds are generous on purpose: they catch a slipped decimal or a pound typed
into a kilogram field, not people who are the wrong shape.

Two distinctions worth naming:

- **The input bound and the recommendation floor are different rules.** 900 kcal
  is an acceptable thing to type; whether the app will *recommend* it is decided
  elsewhere. Conflating them would either block a legitimate choice or hide a
  warning.

- **Imperial height is two fields.** "5.9" is ambiguous — five foot nine, or
  five and nine tenths of a foot — and the app should not guess about somebody's
  own body.

Storage is always canonical: kilograms and centimetres. The entered unit is a
display preference and is never stored as a second source of truth.

---

## 13. Decisions worth revisiting

**Weight history shipped rather than being deferred.** The calculator needs a
current weight, and the alternative — a mutable column on the profile — would
have destroyed measurement history on first use. One table, two indexes, no goal
architecture weakened.

**No BMI, no body-fat estimate, no goal-date projection.** Each would need
claims this app is not in a position to make. "You will reach 75 kg on 4 March"
is a prediction from a linear model over a process that is not linear.

**Activity level lives on the profile, not on a settings row.** It is a property
of the person and prefills the calculator; the value each goal was calculated
from is snapshotted on the goal, so changing it never rewrites history.
