import { LATEST_VERSION, MIGRATIONS, type Migration } from './migrations';
import type { SqlDatabase } from './types';
import { logger } from '@/lib/logger';

/**
 * Applies pending migrations in version order.
 *
 * Each migration runs inside its own transaction, so a failure leaves the
 * database at the last good version rather than half-migrated. Applied
 * versions are recorded in `schema_migrations`.
 */
export function migrate(
  db: SqlDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
): { from: number; to: number; applied: number[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY NOT NULL,
      name       TEXT    NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  const startingVersion = currentVersion(db);
  const pending = [...migrations]
    .filter((migration) => migration.version > startingVersion)
    .sort((a, b) => a.version - b.version);

  assertContiguous(startingVersion, pending);

  const applied: number[] = [];

  for (const migration of pending) {
    db.transaction(() => {
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      db.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        [migration.version, migration.name, Date.now()],
      );
    });
    applied.push(migration.version);
  }

  if (applied.length > 0) {
    logger.info('Local database migrated', {
      from: startingVersion,
      to: currentVersion(db),
      count: applied.length,
    });
  }

  return { from: startingVersion, to: currentVersion(db), applied };
}

/** Highest applied migration version, or 0 on a fresh database. */
export function currentVersion(db: SqlDatabase): number {
  const row = db.get<{ version: number | null }>(
    'SELECT MAX(version) AS version FROM schema_migrations',
  );
  return row?.version ?? 0;
}

/**
 * Guards against a downgrade: an older build must not run against a database
 * migrated by a newer one, because it cannot know what those migrations did.
 */
export function assertSupportedVersion(db: SqlDatabase): void {
  const version = currentVersion(db);
  if (version > LATEST_VERSION) {
    throw new Error(
      `The local database is at version ${version} but this build only knows ` +
        `up to ${LATEST_VERSION}. Update the app to continue.`,
    );
  }
}

/**
 * A gap in versions means a migration was removed or renumbered after
 * shipping. Failing loudly here beats silently skipping schema changes on
 * devices that never received them.
 */
function assertContiguous(startingVersion: number, pending: readonly Migration[]): void {
  let expected = startingVersion + 1;
  for (const migration of pending) {
    if (migration.version !== expected) {
      throw new Error(
        `Migration versions must be contiguous: expected ${expected}, ` +
          `found ${migration.version} ("${migration.name}").`,
      );
    }
    expected += 1;
  }
}
