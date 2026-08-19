import Database from 'better-sqlite3';

import type { SqlDatabase } from '../types';

/**
 * A real SQLite database for tests.
 *
 * Migrations that only ever run inside the app are migrations nobody has
 * verified. better-sqlite3 shares SQLite's engine with expo-sqlite, so the
 * statements exercised here are the ones that will run on device.
 */
export function createTestDatabase(): SqlDatabase & { close: () => void } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  return {
    exec: (sql) => {
      db.exec(sql);
    },
    run: (sql, params = []) => {
      db.prepare(sql).run(...(params as unknown[]));
    },
    all: <T>(sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).all(...(params as unknown[])) as T[],
    get: <T>(sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).get(...(params as unknown[])) as T | undefined,
    transaction: (fn) => {
      db.transaction(fn)();
    },
    close: () => db.close(),
  };
}
