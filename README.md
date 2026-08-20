# Fitness Tracker

Cross-platform nutrition, hydration and training tracker for iOS and Android.
Offline-first, built with Expo and Supabase.

**Status: Phase 0 — foundation.** Authentication, the local database, the sync
engine, the design system and navigation are in place. Food logging, workouts,
barcode scanning and the AI features are not built yet.

Full architecture: [`docs/architecture.html`](docs/architecture.html).

---

## Getting started

Requires Node 20+ and a Supabase project.

```bash
npm install
cp .env.example .env.local     # fill in your Supabase URL and anon key
```

Apply the database schema (Supabase CLI):

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

Then start the app:

```bash
npm start
```

### You need a development build, not Expo Go

`expo-camera`, `expo-sqlite` and `expo-secure-store` include native code that
Expo Go does not ship. Build a development client once per platform:

```bash
npx expo run:ios      # or: npx expo run:android
```

After that, `npm start` connects to the development build as usual.

---

## Commands

| Command | Does |
|---|---|
| `npm start` | Start the dev server |
| `npm run verify` | Typecheck, lint and test — run before every commit |
| `npm test` | Jest, both projects |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |

---

## How it fits together

### Offline-first

**SQLite is the source of truth for every read.** Screens query the local
database and render immediately, online or not. The server is a sync target,
not a dependency.

A mutation writes the row and appends to `sync_outbox` **in one transaction**
(`withOutbox`). If the transaction commits, the change is durable and will
eventually reach the server; if the app dies mid-flight, the outbox survives.

The engine (`src/sync/engine.ts`) has two halves:

- **Push** drains the outbox oldest-first, so a create never lands after its
  own update. Failures back off exponentially; an entry that fails eight times
  is abandoned rather than blocking everything queued behind it.
- **Pull** fetches only rows newer than the per-table cursor in `sync_state`.

Conflicts resolve last-write-wins on `updated_at`, with one guard that matters:
**a row with an unsent outbox entry is never overwritten by remote data.** That
rule lives in `src/sync/merge.ts` as a pure function, and is the most heavily
tested code in the repo — getting it wrong loses what the user just typed.

`updated_at` is set by a Postgres trigger, never by the client: device clocks
drift, and a skewed one would corrupt the cursor and cause other devices to
skip rows permanently.

Sync runs on app foreground, on connectivity regain, and after each mutation.

### Authentication

Sessions persist in **expo-secure-store**, behind a chunking adapter
(`src/api/secureStorage.ts`). SecureStore caps values at ~2048 bytes on
Android and a Supabase session exceeds that — without chunking, the write
fails and the user is silently signed out on next launch.

`AuthProvider` exposes status as an explicit state machine —
`restoring | signedIn | signedOut` — rather than a nullable user. Route guards
depend on the distinction: "we don't know yet" must not look like "signed out",
or the app flashes the sign-in screen before restoring a valid session.

A Postgres trigger on `auth.users` creates the `profiles` and `user_settings`
rows, so a profile always exists. Sign-out clears local data, the outbox and
the cursors — two people can share a phone.

### Security

- **RLS is the security boundary, not a backstop.** The anon key ships in the
  binary; anyone can extract it and call the REST API directly. Policies are
  what actually stop one user reading another's data.
- Every policy sets both `USING` and `WITH CHECK`. Without `WITH CHECK`, a user
  can reassign their row to someone else on update.
- RLS is `FORCE`d, so the table owner does not bypass it.
- Deletes are soft. A hard delete is invisible to a delta pull, so offline
  clients would keep their copy forever.
- `EXPO_PUBLIC_*` values are compiled into the binary. Only the Supabase URL
  and anon key belong there. The service-role key and model provider keys are
  Edge Function secrets and must never appear in this repo.

---

## Layout

```
app/                    Routes (expo-router). Thin — they compose features.
src/
  api/                  Supabase client, chunked session storage, DB types
  components/ui/        Design system primitives
  config/               Validated environment
  db/                   SQLite: migrations, migrator, schema, repositories
  features/
    ai/                 AIProvider interface + Zod schemas (Phase 4)
    auth/               Session state, auth operations, error mapping
    diary/              The day view, logging, editing, frequent foods
    food/               Search, food detail, serving selection
    profile/            Profile reads and writes
  lib/                  Dates, units, ids, Result type, logging
  state/                React Query client
  sync/                 Outbox, merge rules, engine, registry
  theme/                Tokens and theme provider
supabase/migrations/    Postgres schema — the source of truth
docs/architecture.html  Full architecture and roadmap
docs/food-search.md     Ranking, matching, pagination, search performance
docs/food-diary.md      The snapshot invariant, diary dates, aggregation
docs/food-data-sources.md  Sources, licensing, import procedure
docs/database-setup.md  Applying migrations to a Supabase project
```

Two rules keep this from rotting:

1. **Features do not import from each other.** Shared logic moves down into
   `lib/` or `components/ui/`.
2. **Nutrition maths lives in exactly one place** (`lib/nutrition`), imported by
   the diary, the serving selector and — as they arrive — recipes, AI confirm
   screens and the dashboard alike.

---

## Testing

Two Jest projects:

- **`node`** — pure logic. Migrations run against real SQLite via
  better-sqlite3, so the statements exercised in CI are the ones that run on
  device. Fast, no React Native transform.
- **`react-native`** — components and hooks through `jest-expo`.

Naming decides the project: `*.node.test.ts` or `*.rn.test.tsx`.

A schema-drift test asserts that the shipped migration SQL actually produces
the columns the TypeScript row types assume — otherwise a mismatch surfaces as
a runtime error on someone's phone.

---

## Roadmap

| Phase | Scope |
|---|---|
| **0** | ✅ Foundation — auth, local DB, sync, design system, navigation |
| 1 | Onboarding, calorie calculator, food catalogue, diary, dashboard |
| 2 | Hydration and recipes |
| 3 | Barcode scanning |
| 4 | AI nutrition label extraction, then meal photo estimation |
| 5 | Workout tracker |
| 6 | Progress charts, health platform sync, sync hardening |
| 7 | Accessibility audit, polish, store submission |
