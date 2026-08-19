# Applying the migrations to a Supabase project

Procedure for taking `supabase/migrations` from an empty Supabase project to a
verified schema. Verify locally first — a broken RLS policy in production is a
data-exposure incident, not a failed script.

---

## 1. Verify locally before touching Supabase

This applies every migration to a throwaway PostgreSQL database and runs the
RLS suite against it. It needs a local PostgreSQL 16 you can create databases
on; nothing here touches your Supabase project.

```bash
# Any local Postgres works. With Docker:
docker run --rm -d --name ft-verify -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16
sleep 5

PGHOST=localhost PGPORT=55432 PGUSER=postgres PGPASSWORD=postgres ./scripts/verify-db.sh

docker rm -f ft-verify
```

Expected: 26 checks, ending in `✓ database verification passed`. If anything
fails, **stop** — do not push to Supabase.

The same job runs in CI on every push (`.github/workflows/ci.yml`).

---

## 2. Link the project

```bash
npm i -g supabase          # or: brew install supabase/tap/supabase
supabase login
supabase link --project-ref <your-project-ref>
```

The project ref is in your Supabase dashboard URL:
`https://supabase.com/dashboard/project/<project-ref>`.

---

## 3. Review what will run

```bash
supabase db diff --linked      # what the CLI thinks differs
ls supabase/migrations         # applied in filename (timestamp) order
```

Current migrations, in order:

| File | Creates |
|---|---|
| `20260819000001_initial_schema.sql` | enums, `profiles`, `user_settings`, `set_updated_at()`, `handle_new_user()` and its trigger on `auth.users`, sync indexes |
| `20260819000002_rls_policies.sql` | RLS enablement, six policies, grants |

Ordering is by filename, and the timestamps are strictly increasing. The second
migration depends on tables from the first, so the order matters.

---

## 4. Apply

```bash
supabase db push
```

On a project that already has data, take a backup first
(Dashboard → Database → Backups).

---

## 5. Confirm against the live project

Run these in the Supabase SQL editor.

**RLS is on both tables** — expect two rows, both `rowsecurity = true`:

```sql
select tablename, rowsecurity
  from pg_tables
 where schemaname = 'public'
   and tablename in ('profiles', 'user_settings');
```

**Six policies, and every write policy constrains the resulting row.** A policy
with `with_check = null` on INSERT or UPDATE lets a user reassign a row to
someone else:

```sql
select tablename, policyname, cmd,
       (with_check is not null) as has_with_check
  from pg_policies
 where schemaname = 'public'
 order by tablename, cmd;
```

**The signup trigger exists:**

```sql
select tgname from pg_trigger where tgname = 'on_auth_user_created';
```

**End-to-end signup.** Create a user in Dashboard → Authentication → Users, then:

```sql
select p.id, p.email, p.time_zone, s.water_goal_ml
  from public.profiles p
  join public.user_settings s on s.user_id = p.id
 where p.email = '<the address you used>';
```

One row means the trigger fired and both records were created. **No row means
signup is silently broken** — check that `FORCE ROW LEVEL SECURITY` has not
been re-enabled on these tables, which blocks the trigger (see the note in
`20260819000002_rls_policies.sql`).

**Cross-user isolation.** Create two users, then run as the first one:

```sql
set local role authenticated;
set local request.jwt.claims = '{"sub": "<first-user-uuid>"}';

select count(*) from public.profiles;        -- expect 1
select count(*) from public.user_settings;   -- expect 1

reset role;
```

Anything above 1 means a policy is too permissive. Stop and fix it.

---

## 6. Point the app at the project

Copy the URL and anon key from Project Settings → API into `.env.local`:

```bash
EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon key>
```

Both are safe to ship in the binary — the anon key grants only what RLS allows.
The **service role key is not one of these** and must never appear in the app,
this repo, or `.env.local`.

Restart the dev server so the values are picked up.

---

## Rolling back

The CLI has no down-migrations. To reset a development project:

```bash
supabase db reset --linked      # destroys all data
```

For production, restore from a backup. Write migrations to be additive so a
rollback is rarely needed.

---

## Adding migrations later

```bash
supabase migration new <descriptive_name>
```

Rules that keep the schema safe to sync against:

1. **Append only.** Never edit a migration that has been applied anywhere real.
   Correct a mistake with a new migration.
2. **Every user-owned table gets RLS**, with `USING` *and* `WITH CHECK` on
   every write policy.
3. **Every synced table gets** `updated_at` with a `set_updated_at` trigger,
   `deleted_at` for soft deletes, and an index on `(owner_column, updated_at)`
   for the sync cursor.
4. **Never let the client set `updated_at`.** The trigger is what makes the
   sync cursor trustworthy.
5. **Add assertions to `supabase/tests/rls.test.sql`** for each new table, then
   re-run `scripts/verify-db.sh`.
