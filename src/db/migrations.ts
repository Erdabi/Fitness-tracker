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

  {
    version: 3,
    name: 'food_logs',
    statements: [
      /*
       * The diary.
       *
       * Mirrors public.food_logs, with two deliberate differences.
       *
       *   • The `basis_*` columns are the frozen nutrition snapshot; the
       *     unprefixed nutrient columns are that basis scaled to the logged
       *     quantity. Postgres computes those as GENERATED columns so no
       *     client can post a total that contradicts its own basis. SQLite
       *     could do the same, but the sync engine writes every column it is
       *     given, and a generated column cannot be written — so locally they
       *     are ordinary columns filled by `scaleNutrition`, the one
       *     arithmetic path the whole app shares.
       *
       *   • `diary_date` is a `YYYY-MM-DD` string, not a date type. It is the
       *     user's calendar day, computed at write time in their zone, and it
       *     never changes afterwards — not when they travel, and not when the
       *     device's zone changes underneath them.
       */
      `CREATE TABLE food_logs (
         id                    TEXT    PRIMARY KEY NOT NULL,
         user_id               TEXT    NOT NULL,

         -- Provenance only. Nullable, because a log outlives the catalogue
         -- row it came from; the snapshot below is what renders it.
         food_id               TEXT,
         serving_id            TEXT,

         meal                  TEXT    NOT NULL
                                       CHECK (meal IN ('breakfast', 'lunch', 'dinner', 'snack')),

         logged_at             INTEGER NOT NULL,
         time_zone             TEXT    NOT NULL,
         diary_date            TEXT    NOT NULL
                                       CHECK (diary_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),

         quantity              REAL    NOT NULL CHECK (quantity > 0),
         serving_label         TEXT    NOT NULL,
         serving_amount        REAL    NOT NULL CHECK (serving_amount > 0),
         amount_in_base        REAL    NOT NULL CHECK (amount_in_base > 0),

         food_name             TEXT    NOT NULL,
         brand_name            TEXT,
         food_source_id        TEXT    NOT NULL,
         food_is_verified      INTEGER NOT NULL DEFAULT 0
                                       CHECK (food_is_verified IN (0, 1)),

         basis_unit            TEXT    NOT NULL CHECK (basis_unit IN ('g', 'ml', 'item')),
         basis_amount          REAL    NOT NULL CHECK (basis_amount > 0),
         basis_calories        REAL    NOT NULL CHECK (basis_calories >= 0),
         basis_protein_g       REAL    NOT NULL DEFAULT 0,
         basis_carbohydrates_g REAL    NOT NULL DEFAULT 0,
         basis_fat_g           REAL    NOT NULL DEFAULT 0,
         basis_fiber_g         REAL,
         basis_sugar_g         REAL,
         basis_saturated_fat_g REAL,
         basis_sodium_mg       REAL,

         calories              REAL    NOT NULL,
         protein_g             REAL    NOT NULL,
         carbohydrates_g       REAL    NOT NULL,
         fat_g                 REAL    NOT NULL,
         fiber_g               REAL,
         sugar_g               REAL,
         saturated_fat_g       REAL,
         sodium_mg             REAL,

         note                  TEXT,

         created_at            INTEGER NOT NULL,
         updated_at            INTEGER NOT NULL,
         server_updated_at     TEXT,
         deleted_at            INTEGER
       )`,

      /*
       * The diary read and the daily rollup are one access pattern: one user,
       * one day, ordered by meal. Covering the summed columns keeps a day's
       * totals off the table itself, which is what holds the cost flat as
       * years of history accumulate on the device.
       */
      `CREATE INDEX idx_food_logs_day
         ON food_logs(user_id, diary_date, meal, logged_at)
         WHERE deleted_at IS NULL`,

      // "What do I log most often lately" — the windowed frequent-foods query.
      `CREATE INDEX idx_food_logs_frequent
         ON food_logs(user_id, diary_date, food_id)
         WHERE deleted_at IS NULL AND food_id IS NOT NULL`,
    ],
  },
];

/** Highest migration version known to this build. */
export const LATEST_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);
