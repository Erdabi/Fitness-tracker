/**
 * Local SQLite migrations.
 *
 * Append-only: never edit a migration that has shipped, because it has already
 * run on real devices. Correct a mistake by adding a new migration.
 *
 * This is the *local* schema and it deliberately mirrors — but is not identical
 * to — the Postgres schema in `supabase/migrations`. Differences that are
 * intentional:
 *
 *   • Timestamps are epoch-millisecond integers locally (cheap to compare in
 *     SQLite) and `timestamptz` on the server.
 *   • Every table carries `server_updated_at` so the pull cursor can use the
 *     server's clock rather than the device's, which cannot be trusted.
 *   • Booleans are 0/1 integers; SQLite has no boolean type.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    statements: [
      `CREATE TABLE profiles (
         id                TEXT    PRIMARY KEY NOT NULL,
         email             TEXT,
         display_name      TEXT,
         sex               TEXT    CHECK (sex IN ('male', 'female', 'other')),
         birth_date        TEXT,
         height_cm         REAL    CHECK (height_cm IS NULL OR height_cm > 0),
         unit_system       TEXT    NOT NULL DEFAULT 'metric'
                                   CHECK (unit_system IN ('metric', 'imperial')),
         time_zone         TEXT    NOT NULL DEFAULT 'UTC',
         created_at        INTEGER NOT NULL,
         updated_at        INTEGER NOT NULL,
         server_updated_at TEXT,
         deleted_at        INTEGER
       )`,

      `CREATE TABLE user_settings (
         id                     TEXT    PRIMARY KEY NOT NULL,
         user_id                TEXT    NOT NULL,
         theme                  TEXT    NOT NULL DEFAULT 'system'
                                        CHECK (theme IN ('light', 'dark', 'system')),
         water_goal_ml          INTEGER NOT NULL DEFAULT 2500
                                        CHECK (water_goal_ml > 0),
         exercise_adds_calories INTEGER NOT NULL DEFAULT 0
                                        CHECK (exercise_adds_calories IN (0, 1)),
         created_at             INTEGER NOT NULL,
         updated_at             INTEGER NOT NULL,
         server_updated_at      TEXT,
         deleted_at             INTEGER,
         FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
       )`,

      `CREATE UNIQUE INDEX idx_user_settings_user
         ON user_settings(user_id)`,

      /*
       * The outbox records *operations*, not just current state. Ordering
       * matters: a create must reach the server before the update that
       * follows it, so entries drain by insertion order.
       */
      `CREATE TABLE sync_outbox (
         id          INTEGER PRIMARY KEY AUTOINCREMENT,
         table_name  TEXT    NOT NULL,
         row_id      TEXT    NOT NULL,
         operation   TEXT    NOT NULL CHECK (operation IN ('upsert', 'delete')),
         payload     TEXT    NOT NULL,
         created_at  INTEGER NOT NULL,
         attempts    INTEGER NOT NULL DEFAULT 0,
         next_attempt_at INTEGER NOT NULL DEFAULT 0,
         last_error  TEXT
       )`,

      `CREATE INDEX idx_outbox_drain
         ON sync_outbox(next_attempt_at, id)`,

      /*
       * Lets the engine ask "does this row have unsent local work?" without a
       * scan — the guard that stops a pull from clobbering a pending edit.
       */
      `CREATE INDEX idx_outbox_row
         ON sync_outbox(table_name, row_id)`,

      `CREATE TABLE sync_state (
         table_name     TEXT PRIMARY KEY NOT NULL,
         cursor         TEXT,
         last_pulled_at INTEGER
       )`,
    ],
  },
];

/** Highest migration version known to this build. */
export const LATEST_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);
