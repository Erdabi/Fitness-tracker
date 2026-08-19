/**
 * The minimum surface the local database layer needs.
 *
 * Declared as an interface rather than importing `expo-sqlite` directly so the
 * migrator and repositories can run under plain Node against better-sqlite3 in
 * tests. Migrations that only ever execute inside the app are migrations that
 * are never actually verified.
 */
export interface SqlDatabase {
  /** Executes one or more statements. No parameters, no result. */
  exec(sql: string): void;
  /** Executes a parameterised statement. */
  run(sql: string, params?: readonly unknown[]): void;
  /** Returns every matching row. */
  all<T>(sql: string, params?: readonly unknown[]): T[];
  /** Returns the first matching row, or undefined. */
  get<T>(sql: string, params?: readonly unknown[]): T | undefined;
  /** Runs `fn` inside a transaction, rolling back if it throws. */
  transaction(fn: () => void): void;
}

/** Columns every synchronised table carries. See `src/sync` for why. */
export interface SyncColumns {
  /** Client-generated UUID, assigned before the row ever reaches the server. */
  id: string;
  /** Local logical modification time (epoch ms). Drives conflict resolution. */
  updated_at: number;
  /**
   * Server-assigned modification time (ISO 8601), echoed back on pull. Null
   * until the row has been confirmed by the server. Drives the pull cursor.
   */
  server_updated_at: string | null;
  /** Soft delete (epoch ms). Rows are never hard-deleted while unsynced. */
  deleted_at: number | null;
}
