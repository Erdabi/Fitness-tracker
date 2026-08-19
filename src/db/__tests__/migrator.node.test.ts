import { TABLE_COLUMNS } from '../schema';
import { LATEST_VERSION, MIGRATIONS, type Migration } from '../migrations';
import { assertSupportedVersion, currentVersion, migrate } from '../migrator';
import { createTestDatabase } from './testDb';

describe('migrate', () => {
  let db: ReturnType<typeof createTestDatabase>;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('brings a fresh database to the latest version', () => {
    const result = migrate(db);

    expect(result.from).toBe(0);
    expect(result.to).toBe(LATEST_VERSION);
    expect(currentVersion(db)).toBe(LATEST_VERSION);
  });

  it('is idempotent', () => {
    migrate(db);
    const second = migrate(db);

    expect(second.applied).toEqual([]);
    expect(currentVersion(db)).toBe(LATEST_VERSION);
  });

  /**
   * The guard against schema drift: `TABLE_COLUMNS` describes what the
   * TypeScript row types assume, and this asserts the shipped SQL actually
   * produces it. Without this, a mismatch surfaces as a runtime error on a
   * user's device.
   */
  it.each(Object.entries(TABLE_COLUMNS))(
    'creates %s with the columns the code expects',
    (table, expectedColumns) => {
      migrate(db);

      const actual = db
        .all<{ name: string }>(`PRAGMA table_info(${table})`)
        .map((column) => column.name)
        .sort();

      expect(actual).toEqual([...expectedColumns].sort());
    },
  );

  it('enforces the foreign key from user_settings to profiles', () => {
    migrate(db);

    expect(() => {
      db.run(
        `INSERT INTO user_settings (id, user_id, created_at, updated_at)
         VALUES ('s1', 'nonexistent-user', 1, 1)`,
      );
    }).toThrow();
  });

  it('rejects an invalid unit_system via the CHECK constraint', () => {
    migrate(db);

    expect(() => {
      db.run(
        `INSERT INTO profiles (id, unit_system, time_zone, created_at, updated_at)
         VALUES ('u1', 'furlongs', 'UTC', 1, 1)`,
      );
    }).toThrow();
  });

  it('allows only one settings row per user', () => {
    migrate(db);
    db.run(
      `INSERT INTO profiles (id, unit_system, time_zone, created_at, updated_at)
       VALUES ('u1', 'metric', 'UTC', 1, 1)`,
    );
    db.run(
      `INSERT INTO user_settings (id, user_id, created_at, updated_at)
       VALUES ('s1', 'u1', 1, 1)`,
    );

    expect(() => {
      db.run(
        `INSERT INTO user_settings (id, user_id, created_at, updated_at)
         VALUES ('s2', 'u1', 1, 1)`,
      );
    }).toThrow();
  });

  it('rolls back a failing migration rather than leaving it half applied', () => {
    const broken: Migration[] = [
      {
        version: 1,
        name: 'broken',
        statements: ['CREATE TABLE ok_table (id TEXT)', 'THIS IS NOT SQL'],
      },
    ];

    expect(() => migrate(db, broken)).toThrow();
    expect(currentVersion(db)).toBe(0);

    const tables = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ok_table'",
    );
    expect(tables).toHaveLength(0);
  });

  it('refuses a non-contiguous version sequence', () => {
    const gapped: Migration[] = [
      { version: 1, name: 'first', statements: ['CREATE TABLE a (id TEXT)'] },
      { version: 3, name: 'third', statements: ['CREATE TABLE b (id TEXT)'] },
    ];

    expect(() => migrate(db, gapped)).toThrow(/contiguous/i);
  });

  it('applies only migrations newer than the current version', () => {
    const first: Migration[] = [
      { version: 1, name: 'first', statements: ['CREATE TABLE a (id TEXT)'] },
    ];
    const both: Migration[] = [
      ...first,
      { version: 2, name: 'second', statements: ['CREATE TABLE b (id TEXT)'] },
    ];

    migrate(db, first);
    const result = migrate(db, both);

    expect(result.applied).toEqual([2]);
  });
});

describe('assertSupportedVersion', () => {
  it('rejects a database migrated by a newer build', () => {
    const db = createTestDatabase();
    migrate(db);
    db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
      LATEST_VERSION + 5,
      'from-the-future',
      Date.now(),
    ]);

    expect(() => assertSupportedVersion(db)).toThrow(/Update the app/);
    db.close();
  });

  it('accepts a database at the expected version', () => {
    const db = createTestDatabase();
    migrate(db);
    expect(() => assertSupportedVersion(db)).not.toThrow();
    db.close();
  });
});

describe('MIGRATIONS', () => {
  it('has unique version numbers', () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(new Set(versions).size).toBe(versions.length);
  });
});
