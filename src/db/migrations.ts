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

  {
    version: 2,
    name: 'food_recents_and_cache',
    statements: [
      /*
       * Recently and frequently used foods. User-owned, so it syncs like any
       * other user table. One row per food — a repeat use is an UPDATE, which
       * is what keeps the list free of duplicates.
       */
      `CREATE TABLE food_recents (
         id                TEXT    PRIMARY KEY NOT NULL,
         user_id           TEXT    NOT NULL,
         food_id           TEXT    NOT NULL,
         last_used_at      INTEGER NOT NULL,
         use_count         INTEGER NOT NULL DEFAULT 1 CHECK (use_count > 0),
         created_at        INTEGER NOT NULL,
         updated_at        INTEGER NOT NULL,
         server_updated_at TEXT,
         deleted_at        INTEGER
       )`,

      `CREATE UNIQUE INDEX idx_food_recents_user_food
         ON food_recents(user_id, food_id)`,

      `CREATE INDEX idx_food_recents_recent
         ON food_recents(user_id, last_used_at DESC)`,

      `CREATE INDEX idx_food_recents_frequent
         ON food_recents(user_id, use_count DESC)`,

      /*
       * A local cache of catalogue foods the user has actually touched.
       *
       * NOT synced, and deliberately not a mirror of the catalogue: the global
       * database is hundreds of thousands to millions of rows and stays on the
       * server. This holds only what is needed to render a recent food and
       * open its serving screen without a connection, and is trimmed to a
       * bounded size.
       *
       * Because it is a cache of server-owned data, it has no outbox entries
       * and is safe to clear at any time.
       */
      `CREATE TABLE food_cache (
         food_id         TEXT    PRIMARY KEY NOT NULL,
         name            TEXT    NOT NULL,
         brand_name      TEXT,
         source_id       TEXT    NOT NULL,
         is_verified     INTEGER NOT NULL DEFAULT 0 CHECK (is_verified IN (0, 1)),
         is_own          INTEGER NOT NULL DEFAULT 0 CHECK (is_own IN (0, 1)),
         base_unit       TEXT    NOT NULL CHECK (base_unit IN ('g', 'ml', 'item')),
         base_amount     REAL    NOT NULL CHECK (base_amount > 0),
         calories        REAL    NOT NULL,
         protein_g       REAL    NOT NULL,
         carbohydrates_g REAL    NOT NULL,
         fat_g           REAL    NOT NULL,
         fiber_g         REAL,
         sugar_g         REAL,
         saturated_fat_g REAL,
         sodium_mg       REAL,
         cached_at       INTEGER NOT NULL
       )`,

      // Trimming the cache evicts the least recently touched entries.
      `CREATE INDEX idx_food_cache_cached_at ON food_cache(cached_at)`,

      /*
       * Servings for cached foods. Each carries its gram/ml equivalent, so the
       * serving selector can do real arithmetic offline rather than showing a
       * label it cannot convert.
       */
      `CREATE TABLE food_cache_servings (
         id          TEXT    PRIMARY KEY NOT NULL,
         food_id     TEXT    NOT NULL,
         label       TEXT    NOT NULL,
         amount      REAL    NOT NULL CHECK (amount > 0),
         unit        TEXT    NOT NULL CHECK (unit IN ('g', 'ml', 'item')),
         is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
         sort_order  INTEGER NOT NULL DEFAULT 0,
         FOREIGN KEY (food_id) REFERENCES food_cache(food_id) ON DELETE CASCADE
       )`,

      `CREATE INDEX idx_food_cache_servings_food
         ON food_cache_servings(food_id, sort_order)`,
    ],
  },
];

/** Highest migration version known to this build. */
export const LATEST_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);
