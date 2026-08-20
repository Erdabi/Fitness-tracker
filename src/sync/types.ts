import type { Database } from '@/api/database.types';
import type { SqlDatabase } from '@/db/types';
import type { RemoteAdapter } from './remote';

/** Tables that participate in sync. Extended as features land. */
export type SyncableTable =
  | 'profiles'
  | 'user_settings'
  | 'food_recents'
  | 'food_logs';

/** Postgres tables the engine may address, taken from the generated types. */
export type RemoteTable = keyof Database['public']['Tables'];

export type OutboxOperation = 'upsert' | 'delete';

export interface OutboxEntry {
  readonly id: number;
  readonly table_name: SyncableTable;
  readonly row_id: string;
  readonly operation: OutboxOperation;
  /** JSON-encoded row as it should appear on the server. */
  readonly payload: string;
  readonly created_at: number;
  readonly attempts: number;
  readonly next_attempt_at: number;
  readonly last_error: string | null;
}

/** An untyped row, as the engine sees it. */
export type AnyRow = Record<string, unknown>;

/**
 * Per-table sync rules.
 *
 * Registering a table is all that is needed to sync it — the engine itself
 * stays generic, so Phase 1 adds `food_logs` by adding a descriptor here
 * rather than by touching the engine.
 *
 * Rows are untyped at this boundary on purpose: the engine iterates over a
 * heterogeneous registry, so it cannot be generic over one row type. Type
 * safety is recovered inside each descriptor via `describeTable`, which types
 * the mapping functions and erases them only at the registry edge.
 */
export interface TableDescriptor {
  readonly table: SyncableTable;
  /** Remote table name, when it differs from the local one. */
  readonly remoteTable: RemoteTable;
  /** Column holding the owning user's id. Used to scope pulls. */
  readonly userColumn: 'id' | 'user_id';
  /** Maps a local row to the shape the server expects. */
  readonly toRemote: (local: AnyRow) => AnyRow;
  /** Maps a server row to the local shape. */
  readonly fromRemote: (remote: AnyRow) => AnyRow;
}

/**
 * Builds a descriptor with the mapping functions fully typed.
 *
 * The single cast lives here rather than being repeated at every call site in
 * the engine, so the dynamic boundary is declared in one place.
 */
export function describeTable<TLocal extends object>(descriptor: {
  table: SyncableTable;
  remoteTable: RemoteTable;
  userColumn: 'id' | 'user_id';
  toRemote: (local: TLocal) => AnyRow;
  fromRemote: (remote: AnyRow) => TLocal;
}): TableDescriptor {
  return descriptor as unknown as TableDescriptor;
}

export interface SyncContext {
  readonly db: SqlDatabase;
  readonly userId: string;
  /** Injected so the engine can be driven end-to-end in tests. */
  readonly remote: RemoteAdapter;
}

export type SyncPhase = 'idle' | 'pushing' | 'pulling';

export interface SyncStatus {
  readonly phase: SyncPhase;
  readonly pendingCount: number;
  readonly lastSyncedAt: number | null;
  /** Set when the last attempt failed. Cleared on the next success. */
  readonly lastError: string | null;
}
