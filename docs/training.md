# Training: workouts, sets and progression

Four tables, one new idea, and a deliberate refusal.

---

## 1. What was reused rather than rebuilt

Almost none of this milestone is new machinery. It is worth stating explicitly
what it stands on, because the temptation in a training feature is to build a
second everything:

| Need | Reused |
|---|---|
| Offline writes | `withOutbox` — the same local-write-plus-queue transaction the diary uses |
| Sync | The same engine and registry. Four descriptors, no new code paths |
| Push ordering | The outbox's insertion order. Nothing sequences anything by hand |
| The user's day | `localDayFor` on the device, `resolve_local_date()` on the server |
| Shared-vs-owned catalogue | The `foods` model: `owner_id is null` is shared and read-only |
| Historical integrity | The diary's snapshot invariant, applied to exercise names |
| RLS shape | `USING` + `WITH CHECK` on every write, no DELETE policy, soft deletes |
| UI | The existing primitives and theme. No second styling system |

The one generalisation: `resolve_local_date()` gained an explicit null-instant
branch so a **planned** workout can carry a day before it has a start time.
Behaviour is unchanged for `food_logs` and `water_logs`, whose instants are
`NOT NULL` — their 93 existing assertions run against the new version untouched.

---

## 2. The one new idea: `load_type`

```
weighted    Bench press, squat.      External load + reps.   1RM: yes
bodyweight  Push-ups, pull-ups.      Reps + optional load.   1RM: no
duration    Plank, dead hang.        Time held.              1RM: no
distance    Running, rowing.         Distance (+ time).      1RM: no
```

It decides three things at once: what the set editor asks for, what the volume
calculation means, and whether an estimated one-rep max is a meaningful number
at all. Section H asks for 1RM "where appropriate" — this column is what makes
"appropriate" a property of the data rather than a guess in the UI.

Four enum values rather than independent flags, because these are the four ways
the set editor lays itself out. A flag combination no editor renders is a state
nothing can display.

### Zero is not null

`weight_kg = 0` means **no added weight** — a set of push-ups.
`weight_kg = NULL` means **weight is not how this is measured** — a plank.

They are preserved separately in SQLite, in Postgres and across the wire.
Collapsing them would silently rewrite what the user recorded.

---

## 3. Canonical units

`weight_kg` is always kilograms. `weight_unit` records what the user was typing
in, so 155 lb reads back as 155 lb rather than 70.31 kg.

A display string is not storable — there is no text column to put one in. That
is the point: a unit mistake is a rendering bug that can be fixed later, whereas
a stored `"155 lb"` is data loss that cannot. Conversion happens at exactly two
functions, `toCanonicalKg` and `fromCanonicalKg`.

---

## 4. Historical integrity

`workout_exercises` snapshots `exercise_name` and `load_type` when the exercise
is added, and history renders from those — never from a join to the catalogue.
The same invariant `food_logs` has, for the same reason.

So a session performed in March survives all of:

- the exercise being **renamed** → history keeps March's name
- its **load type** being changed → March still renders as weight × reps
- the exercise being **soft-deleted** → every set stays
- the catalogue row being **hard-deleted** → sets stay, `exercise_id` drops to
  null, and only the provenance link is lost

Deleting a custom exercise cannot delete a set. There is no DELETE policy and no
DELETE grant on any training table, and removal is a soft delete — which is also
what makes it synchronise.

**Previous performance is matched on the catalogue id, not the name**, so
renaming an exercise does not sever a user from their own history.

---

## 5. Containment is declarative, not merely policed

A workout exercise belonging to someone else's workout, or a set belonging to
someone else's exercise, are not prevented by an RLS policy here. They are
prevented by **composite foreign keys**:

```sql
foreign key (workout_id, user_id) references public.workouts (id, user_id)
foreign key (workout_exercise_id, user_id)
  references public.workout_exercises (id, user_id)
```

That makes the bad row unrepresentable rather than denied — including for the
service role, which bypasses RLS entirely. A policy alone would only stop a
client. `training.test.sql` asserts it as the migration role, precisely to prove
the difference.

---

## 6. What the database refuses

Not TypeScript validation — CHECK constraints, verified against a real
PostgreSQL 16:

- negative reps, negative weight, set number below 1
- a weight above 1,000 kg (a slipped decimal, not a lift)
- a set that measures **nothing at all**
- two "Set 2"s in one exercise, two exercises at one position
- a completion before its start, or a session still open 24 hours later
- a status that disagrees with its timestamps (a `planned` session that has
  already started; a `completed` one that never did)
- an owned exercise attributed to the system, or a shared one to a user

The client mirrors these in `SET_LIMITS` so the user gets a message under the
field instead of a rejected insert. The database is the authority; drift there
costs a worse error message, never bad data.

---

## 7. Offline, and why there is no second queue

Everything is a local write plus an outbox entry, in one transaction, through
the same `withOutbox` as everything else. A session recorded in a basement is
queued exactly like a glass of water.

**Dependency order comes free.** The outbox drains by insertion id, and the
repositories create a parent before its children:

```
custom exercise → workout → workout exercise → set
```

Nothing sequences that by hand, nothing sleeps, and nothing retries in a
special way. `trainingSync.node.test.ts` asserts the arrival order against an
in-memory server, and it is failure-injected: making the outbox drain
newest-first turns four of its tests red.

The **pull** direction is ordered by the registry array instead, since the
engine walks it in order and the local foreign keys need parents first.

### The starter catalogue is seeded, not downloaded

Browsing exercises must work on a first run with no network. So the 16 shared
exercises are written by migration on **both** sides, with **identical fixed
ids** — `src/lib/exerciseCatalogue.ts` for SQLite,
`20260827000001_training.sql` for Postgres.

Identical ids are not cosmetic. A workout references a catalogue exercise by id;
if the device invented its own, the push would be rejected by the foreign key
and the session would sync as far as the workout and then stop. A drift test
compares the two lists field by field and is failure-injected.

The exercise pull therefore scopes on `owner_id`, carrying only what the user
made.

---

## 8. Progression

```
volume   = Σ (weight × reps) over completed sets
1RM      ≈ weight × (1 + reps / 30)          (Epley)
```

Epley was chosen because it is **transparent** — one multiplication a user can
check on paper — not because it is the most accurate of the several published
formulas. They disagree with each other by more than the choice between them
matters.

It is **an estimate, never a measurement**, and it is labelled that way
wherever it appears.

It returns null — rendered as nothing, never as 0 — when it would not mean
anything:

- an exercise that is not `weighted`
- an incomplete set, or one with no load
- **more than 12 reps**: Epley was fitted to low-rep work, and at 20 reps it
  claims a max 67% above the bar, which is a statement about endurance

Volume is likewise null rather than zero for held and distance work: charting a
plank session as zero would make it look like a rest day. An *unloaded*
bodyweight set is zero, because it genuinely happened and moved no external
load; an added belt weight counts as real load.

---

## 9. Calories burned: deliberately absent

**There is no exercise-calorie figure anywhere in this milestone, and that is a
decision rather than an omission.**

An honest estimate of the energy cost of resistance training needs a MET value
for the movement, the user's bodyweight, and the working time. Even with all
three, the published MET tables for weight training are coarse enough that the
answer is a range, not a number. This schema records none of them reliably:
`load_type` is not a MET class, bodyweight is a separate time series that may be
weeks stale, and the gap between `started_at` and `completed_at` includes
changing, chatting and resting.

Producing a figure anyway would put a fabricated number next to real measured
food data and let it be eaten back. That is worse than showing nothing.

`user_settings.exercise_adds_calories` has existed since Phase 0, defaults to
false, and **has no consumer**. It is the switch a defensible model would
attach to. Because nothing reads it, recording a workout cannot change a calorie
goal or a diary total — and `training.test.sql` asserts exactly that, along with
the absence of any `%calor%`, `%kcal%`, `%energy%` or `%met_%` column on a
training table. Adding one later fails the database gate, so whoever does it has
to read the reasoning first.

If a defensible model is ever added, the three figures must stay visually
separate: **consumed**, **estimated burned**, **net**. Never summed into the
diary's totals.

---

## 10. Accessibility

The set row is the control this feature is judged on, and it is used standing
up, mid-set, one-handed.

- **The tick is the largest target on the row** — 56 pt, full height, on the
  edge — because marking a set done is the commonest action and the one most
  often done in a hurry.
- **Every control names its subject.** "Set 2: 70 kilograms, 8 reps" rather than
  "done"; "Move Barbell Bench Press up" rather than "move up". Four sets all
  announcing "done" would be unusable.
- **No multiplication sign in spoken text.** `describeSet` says "70 kilograms,
  8 reps" because `×` is skipped or read as "x" depending on the reader.
- **The timer announces as words.** `4:09` is read "four hundred nine" by some
  screen readers, so the accessible label is "4 minutes 9 seconds".
- **Reordering is buttons, not a drag.** A drag needs a sustained press and a
  steady hand, and is unusable with a screen reader or a switch control. Two
  arrows do the same job for everyone — section O's non-gesture alternative is
  the *only* mechanism, not a fallback.
- **Completion is a checkbox state**, not only a fill colour.
- **Errors are words under the field**, and never clear what was typed —
  wiping a mistyped rep count is how a set gets lost.

---

## 11. What is and is not verified

**Verified in this environment:**

- 1,161 Jest tests across two projects (baseline 981; +180 for training)
- 428 SQL assertions against a real PostgreSQL 16, 13 migrations (baseline 350)
- Failure-injected: containment FKs, negative reps, catalogue write protection,
  outbox ordering, registry ordering, catalogue drift, a second local-date
  implementation, `FORCE ROW LEVEL SECURITY`, and a repository bypassing the
  outbox — each makes the guarding test fail
- A real Android Metro bundle exported and grepped: no keys, no server code
- `npx expo prebuild --platform android` completes, so the project still
  generates a valid native project

**Not verified here:**

- **No APK was built.** There is no Android SDK in this environment
  (`ANDROID_HOME` unset, no `sdkmanager`); Gradle fails at SDK resolution. The
  native project generates correctly, which is as far as this environment goes.
- **LDPlayer cannot be driven from here.** No emulator, no `adb`. Commands for
  running it locally are in the README.
- **No real gym session.** The set editor is tested as a component and the
  repositories against real SQLite, but nobody has used this with chalk on
  their hands.
