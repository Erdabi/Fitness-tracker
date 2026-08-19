import { supabase } from '@/api/supabase';
import type { AnyRow, RemoteTable } from './types';

/**
 * The remote side of sync, as three operations.
 *
 * Declared as an interface rather than calling Supabase directly so the engine
 * can be driven end-to-end in tests: offline behaviour, retry after a failed
 * request, and conflict resolution are exactly the paths that cannot be
 * verified against a live server, and they are the ones that lose data when
 * they are wrong.
 *
 * Deliberately not a mirror of the PostgREST query builder — the engine only
 * ever needs these three shapes, and a narrow interface is a cheap fake.
 */
export interface RemoteAdapter {
  /**
   * Rows the user owns whose `updated_at` is at or after `since`, oldest
   * first. `since` is null on a first sync, meaning "everything".
   */
  fetchChanged(params: {
    table: RemoteTable;
    userColumn: string;
    userId: string;
    since: string | null;
    limit: number;
  }): Promise<AnyRow[]>;

  /** Inserts or replaces a row. Returns a failure reason, or null on success. */
  upsert(table: RemoteTable, row: AnyRow): Promise<string | null>;

  /** Marks a row deleted. Returns a failure reason, or null on success. */
  softDelete(table: RemoteTable, id: string): Promise<string | null>;
}

/**
 * Supabase-backed adapter.
 *
 * The engine addresses tables by name at runtime, so the per-table generated
 * types (which need a literal name at the call site) cannot apply. The cast is
 * confined to this file; table names still come from `RemoteTable`, and every
 * row crossing the boundary is shaped by a typed descriptor mapping.
 */
/** The slice of the PostgREST builder this adapter drives. */
interface UntypedPostgrest {
  from(table: string): {
    select(columns: string): PostgrestFilter;
    upsert(row: AnyRow, options: { onConflict: string }): Promise<{ error: PostgrestError }>;
    update(patch: AnyRow): { eq(column: string, value: unknown): Promise<{ error: PostgrestError }> };
  };
}

interface PostgrestFilter extends Promise<{ data: AnyRow[] | null; error: PostgrestError }> {
  eq(column: string, value: unknown): PostgrestFilter;
  gte(column: string, value: unknown): PostgrestFilter;
  order(column: string, options: { ascending: boolean }): PostgrestFilter;
  limit(count: number): PostgrestFilter;
}

type PostgrestError = { message: string } | null;

export function createSupabaseRemote(
  client: typeof supabase = supabase,
): RemoteAdapter {
  // Deliberately untyped: see the note above.
  const untyped = client as unknown as UntypedPostgrest;

  return {
    async fetchChanged({ table, userColumn, userId, since, limit }) {
      let query = untyped
        .from(table)
        .select('*')
        .eq(userColumn, userId)
        .order('updated_at', { ascending: true })
        .limit(limit);

      if (since) query = query.gte('updated_at', since);

      const { data, error } = await query;
      if (error) throw new Error(`Pull failed for ${table}: ${error.message}`);
      return (data ?? []) as AnyRow[];
    },

    async upsert(table, row) {
      const { error } = await untyped.from(table).upsert(row, { onConflict: 'id' });
      return error?.message ?? null;
    },

    async softDelete(table, id) {
      const { error } = await untyped
        .from(table)
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id);
      return error?.message ?? null;
    },
  };
}
