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
}

export function createFakeRemote(options: { startAt?: number } = {}): FakeRemote {
  const tables = new Map<string, Map<string, AnyRow>>();
  const stats = { fetches: 0, upserts: 0, deletes: 0 };

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

  return {
    stats,

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
      tableOf(table).set(id, { ...row, updated_at: row.updated_at ?? stamp() });
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
      const existing = tableOf(table).get(id);
      // `updated_at` is server-assigned; a client-supplied value is discarded,
      // mirroring the set_updated_at trigger.
      tableOf(table).set(id, { ...existing, ...row, updated_at: stamp() });
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
