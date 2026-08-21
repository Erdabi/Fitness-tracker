-- ===========================================================================
-- The sync timestamp invariant
--
--   Every synchronised row receives a PostgreSQL wall-clock timestamp for
--   `updated_at` on BOTH insert and update.
--
-- ── The defect ─────────────────────────────────────────────────────────────
--
-- `set_updated_at()` has always used `clock_timestamp()`, but it was attached
-- BEFORE UPDATE only. On insert, `updated_at` fell through to the column
-- default `now()` — which is TRANSACTION START time, not wall-clock time.
--
-- Measured on a transaction held open two seconds before writing:
--
--     insert  →  updated_at = txn_start + 0.00 s   ← frozen
--     update  →  updated_at = txn_start + 2.01 s   ← correct
--
-- `updated_at` is the sync pull cursor. A row stamped at transaction start can
-- therefore be committed *behind* a cursor that has already advanced past it,
-- and a strict `> cursor` pull would never see that row again. The engine's
-- overlap window (SYNC_CURSOR_LAG_MS, src/sync/engine.ts) rewinds five seconds
-- and hides this for any transaction shorter than that — but a mitigation that
-- depends on transactions being fast is not the same as correct timestamp
-- semantics, and the two halves of one column disagreeing is a trap for every
-- table added later.
--
-- ── The fix ────────────────────────────────────────────────────────────────
--
-- Re-attach the existing trigger as BEFORE INSERT OR UPDATE, everywhere it is
-- already used. Driven from the catalogue rather than written out twelve
-- times: the tables are found by asking which ones already call
-- `set_updated_at()`, so this cannot miss one, cannot touch a table that never
-- opted in, and needs no edit if the set changes.
--
-- Nothing else moves. The function is unchanged, `created_at` is unchanged,
-- and no table definition is rewritten — the already-pushed migrations stay
-- exactly as they were.
-- ===========================================================================

do $$
declare
  covered  text[] := '{}';
  affected record;
begin
  for affected in
    select tg.tgname as trigger_name,
           c.relname as table_name
      from pg_trigger tg
      join pg_class c     on c.oid = tg.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where tg.tgfoid = 'public.set_updated_at'::regproc
       and n.nspname = 'public'
       and not tg.tgisinternal
     order by c.relname
  loop
    /*
     * Dropped and recreated rather than altered: PostgreSQL has no
     * `ALTER TRIGGER … BEFORE INSERT OR UPDATE`, and the event list is part of
     * the trigger's definition. The name is reused, so the schema reads
     * identically afterwards.
     */
    execute format(
      'drop trigger %I on public.%I',
      affected.trigger_name, affected.table_name);

    execute format(
      'create trigger %I before insert or update on public.%I
         for each row execute function public.set_updated_at()',
      affected.trigger_name, affected.table_name);

    covered := covered || affected.table_name;
  end loop;

  raise notice 'set_updated_at now fires on insert and update for: %',
    array_to_string(covered, ', ');

  /*
   * Guard: every table carrying `updated_at` must be covered.
   *
   * The loop above can only reach tables that already had the trigger. If one
   * was ever created without it, `updated_at` there would be a transaction
   * timestamp on insert and never move on update — which is exactly the class
   * of bug this migration exists to close, so it fails loudly here rather than
   * being discovered as missing rows months later.
   */
  perform 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
                       and a.attname = 'updated_at'
                       and a.attnum > 0
                       and not a.attisdropped
   where n.nspname = 'public'
     and c.relkind = 'r'
     and not (c.relname = any (covered));

  if found then
    raise exception
      'These tables carry updated_at with no set_updated_at trigger: %',
      (select string_agg(c.relname, ', ' order by c.relname)
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid
                            and a.attname = 'updated_at'
                            and a.attnum > 0
                            and not a.attisdropped
        where n.nspname = 'public'
          and c.relkind = 'r'
          and not (c.relname = any (covered)));
  end if;
end $$;

/*
 * Restate the contract next to the function, since this is now the single
 * place the whole schema's sync semantics are decided.
 */
comment on function public.set_updated_at() is
  'Stamps updated_at with clock_timestamp() on INSERT and UPDATE. updated_at is the sync pull cursor, so it must be wall-clock time — now() is transaction-start time and would strand rows written in long transactions behind an advanced cursor.';
