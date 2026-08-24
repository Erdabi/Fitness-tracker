import type { RemoteAdapter } from '../remote';
import type { AnyRow, RemoteTable } from '../types';

/**
 * In-memory stand-in for the Supabase side of sync.
 *
 * Models the three behaviours the engine actually depends on:
 *
 *   • The server stamps `updated_at` itself, ignoring whatever the client
 *     sent. Getting this wrong in the fake would hide the class of bug the
 *     real trigger exists to prevent.
 *   • Rows are scoped to their owner, so a pull cannot see another user's data.
 *   • The network can be down, and requests can fail individually.
 *   • Generated columns are computed by the server, not accepted from the
 *     client. A fake that stored whatever it was handed would let a client
 *     that stopped sending totals look fine here and lose every calorie in
 *     production, which is precisely the bug the real GENERATED columns exist
 *     to make impossible.
 */
export interface FakeRemote extends RemoteAdapter {
  /** Fails every request until `goOnline()`, like a device with no signal. */
  goOffline(): void;
  goOnline(): void;
  /** Fails the next `count` write attempts, then behaves normally. */
  failWrites(count: number): void;
  /** Writes a row as if another device had synced it. */
  seed(table: RemoteTable, row: AnyRow): void;
  rows(table: RemoteTable): AnyRow[];
  find(table: RemoteTable, id: string): AnyRow | undefined;
  /** Requests served since construction, for asserting retry behaviour. */
  readonly stats: { fetches: number; upserts: number; deletes: number };
  /**
   * Accepted upserts, oldest first, for asserting arrival ORDER.
   *
   * Added for training, which is the first feature with a three-level
   * dependency chain — a set references a workout exercise references a
   * workout, and the server's foreign keys reject any other order. Nothing
   * sequences that by hand: the outbox drains by insertion id. This log is how
   * that guarantee is checked rather than assumed.
   *
   * Only successful writes are recorded; a rejected one never reached the
   * server, so it is not an arrival.
   */
  readonly upsertLog: readonly { table: RemoteTable; id: string }[];
}

export function createFakeRemote(options: { startAt?: number } = {}): FakeRemote {
  const tables = new Map<string, Map<string, AnyRow>>();
  const stats = { fetches: 0, upserts: 0, deletes: 0 };
  const upsertLog: { table: RemoteTable; id: string }[] = [];

  let online = true;
  let writeFailuresRemaining = 0;

  // A monotonic server clock. Distinct per write, so ordering by updated_at is
  // deterministic and the cursor logic is exercised exactly as in production.
  let clock = options.startAt ?? Date.parse('2026-08-19T12:00:00.000Z');
  const stamp = (): string => new Date((clock += 1000)).toISOString();

  const tableOf = (table: RemoteTable): Map<string, AnyRow> => {
    let rows = tables.get(table);
    if (!rows) {
      rows = new Map();
      tables.set(table, rows);
    }
    return rows;
  };

  const requireOnline = (): void => {
    if (!online) throw new Error('Network request failed');
  };

  /**
   * Mirrors the GENERATED columns on public.food_logs.
   *
   * Kept in step with supabase/migrations/20260822000001_food_logs.sql: the
   * totals are the frozen basis scaled by the logged portion, and a null basis
   * value stays null all the way through.
   */
  const applyGenerated = (table: RemoteTable, row: AnyRow): AnyRow => {
    if (table !== 'food_logs') return row;

    const number = (value: unknown): number => Number(value ?? 0);
    const factor =
      (number(row.quantity) * number(row.serving_amount)) / number(row.basis_amount);

    const scale = (value: unknown): number | null =>
      value === null || value === undefined ? null : Number(value) * factor;

    return {
      ...row,
      amount_in_base: number(row.quantity) * number(row.serving_amount),
      calories: scale(row.basis_calories),
      protein_g: scale(row.basis_protein_g),
      carbohydrates_g: scale(row.basis_carbohydrates_g),
      fat_g: scale(row.basis_fat_g),
      fiber_g: scale(row.basis_fiber_g),
      sugar_g: scale(row.basis_sugar_g),
      saturated_fat_g: scale(row.basis_saturated_fat_g),
      sodium_mg: scale(row.basis_sodium_mg),
    };
  };

  return {
    stats,
    upsertLog,

    goOffline() {
      online = false;
    },
    goOnline() {
      online = true;
    },
    failWrites(count) {
      writeFailuresRemaining = count;
    },

    seed(table, row) {
      const id = String(row.id);
      tableOf(table).set(
        id,
        applyGenerated(table, { ...row, updated_at: row.updated_at ?? stamp() }),
      );
    },

    rows(table) {
      return [...tableOf(table).values()];
    },

    find(table, id) {
      return tableOf(table).get(id);
    },

    async fetchChanged({ table, userColumn, userId, since, limit }) {
      stats.fetches += 1;
      requireOnline();

      return [...tableOf(table).values()]
        .filter((row) => String(row[userColumn]) === userId)
        .filter((row) => {
          if (!since) return true;
          return Date.parse(String(row.updated_at)) >= Date.parse(since);
        })
        .sort(
          (a, b) =>
            Date.parse(String(a.updated_at)) - Date.parse(String(b.updated_at)),
        )
        .slice(0, limit)
        .map((row) => ({ ...row }));
    },

    async upsert(table, row) {
      stats.upserts += 1;

      if (!online) return 'Network request failed';
      if (writeFailuresRemaining > 0) {
        writeFailuresRemaining -= 1;
        return 'Server rejected the write';
      }

      const id = String(row.id);
      upsertLog.push({ table, id });
      const existing = tableOf(table).get(id);
      // `updated_at` is server-assigned; a client-supplied value is discarded,
      // mirroring the set_updated_at trigger.
      tableOf(table).set(
        id,
        applyGenerated(table, { ...existing, ...row, updated_at: stamp() }),
      );
      return null;
    },

    async softDelete(table, id) {
      stats.deletes += 1;

      if (!online) return 'Network request failed';
      if (writeFailuresRemaining > 0) {
        writeFailuresRemaining -= 1;
        return 'Server rejected the write';
      }

      const existing = tableOf(table).get(id);
      // A delete for a row the server never received is a no-op, not an error:
      // the row was created and deleted while offline.
      if (!existing) return null;

      tableOf(table).set(id, {
        ...existing,
        deleted_at: new Date(clock).toISOString(),
        updated_at: stamp(),
      });
      return null;
    },
  };
}
