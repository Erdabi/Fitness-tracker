import * as SQLite from 'expo-sqlite';

import { assertSupportedVersion, migrate } from './migrator';
import type { SqlDatabase } from './types';

const DATABASE_NAME = 'fitness-tracker.db';

let instance: SqlDatabase | null = null;

/**
 * Adapts expo-sqlite to the narrow `SqlDatabase` interface the rest of the
 * data layer is written against.
 */
function adapt(db: SQLite.SQLiteDatabase): SqlDatabase {
  return {
    exec: (sql) => db.execSync(sql),
    run: (sql, params = []) => {
      db.runSync(sql, params as SQLite.SQLiteBindValue[]);
    },
    all: <T>(sql: string, params: readonly unknown[] = []) =>
      db.getAllSync(sql, params as SQLite.SQLiteBindValue[]) as T[],
    get: <T>(sql: string, params: readonly unknown[] = []) =>
      (db.getFirstSync(sql, params as SQLite.SQLiteBindValue[]) ?? undefined) as
        T | undefined,
    transaction: (fn) => db.withTransactionSync(fn),
  };
}

/**
 * Opens the local database, applying any pending migrations.
 *
 * Called once during app start, before the first screen renders — every read
 * in the app goes through this database, so it must be ready synchronously
 * rather than racing the first query.
 */
export function openDatabase(): SqlDatabase {
  if (instance) return instance;

  const native = SQLite.openDatabaseSync(DATABASE_NAME);

  // Write-ahead logging keeps reads from blocking during a sync write.
  native.execSync('PRAGMA journal_mode = WAL');
  // Enforce the FK declared on user_settings; SQLite defaults this to off.
  native.execSync('PRAGMA foreign_keys = ON');

  const db = adapt(native);
  assertSupportedVersion(db);
  migrate(db);

  instance = db;
  return db;
}

/** The open database. Throws if called before `openDatabase()`. */
export function getDatabase(): SqlDatabase {
  if (!instance) {
    throw new Error('Local database used before openDatabase() was called.');
  }
  return instance;
}

/**
 * Drops every row owned by the signed-in user.
 *
 * Runs on sign-out. Two devices sharing one phone must not see each other's
 * data, and the outbox must not push a previous user's pending writes under a
 * new session's token.
 */
export function clearLocalUserData(db: SqlDatabase = getDatabase()): void {
  db.transaction(() => {
    db.exec('DELETE FROM sync_outbox');
    db.exec('DELETE FROM sync_state');
    db.exec('DELETE FROM food_logs');
    db.exec('DELETE FROM food_recents');
    // The cache holds catalogue data rather than personal data, but it still
    // reveals what the previous user ate. Two people can share a phone.
    db.exec('DELETE FROM food_cache_servings');
    db.exec('DELETE FROM food_cache');
    db.exec('DELETE FROM user_settings');
    db.exec('DELETE FROM profiles');
  });
}

/** Test seam: resets the memoised handle. */
export function __resetDatabaseForTests(): void {
  instance = null;
}
