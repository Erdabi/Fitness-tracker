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
  {
    version: 4,
    name: 'nutrition_goals_and_weight',
    statements: [
      /*
       * Activity level on the profile: a property of the person, prefilling
       * the calculator. The value each goal was calculated from is snapshotted
       * on the goal, so changing this never rewrites a past target.
       */
      `ALTER TABLE profiles ADD COLUMN activity_level TEXT
         CHECK (activity_level IS NULL
                OR activity_level IN ('sedentary', 'light', 'moderate', 'very', 'extra'))`,

      /*
       * Goal periods.
       *
       * Mirrors public.nutrition_goals. `effective_to` is DERIVED — on the
       * server by trigger, here by `resyncGoalPeriods` — and is never pushed,
       * so a client only ever writes one row per change and there is no pair
       * of updates that has to reach the server in order.
       *
       * `effective_to = effective_from - 1 day` marks a period superseded
       * before it took effect, which is what two devices opening a period on
       * the same day produces. The row is kept; it just covers no dates.
       */
      `CREATE TABLE nutrition_goals (
         id                        TEXT    PRIMARY KEY NOT NULL,
         user_id                   TEXT    NOT NULL,

         effective_from            TEXT    NOT NULL
                                           CHECK (effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
         effective_to              TEXT
                                           CHECK (effective_to IS NULL
                                                  OR effective_to GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),

         calorie_target            INTEGER NOT NULL CHECK (calorie_target BETWEEN 800 AND 10000),
         protein_target_g          REAL    NOT NULL CHECK (protein_target_g >= 0),
         carbohydrate_target_g     REAL    NOT NULL CHECK (carbohydrate_target_g >= 0),
         fat_target_g              REAL    NOT NULL CHECK (fat_target_g >= 0),

         source                    TEXT    NOT NULL
                                           CHECK (source IN ('calculated', 'manual', 'calculated_then_modified')),

         calculated_calories       INTEGER,
         calculated_protein_g      REAL,
         calculated_carbohydrate_g REAL,
         calculated_fat_g          REAL,

         basis_bmr                 INTEGER,
         basis_tdee                INTEGER,
         basis_activity            TEXT,
         basis_direction           TEXT,
         basis_weight_kg           REAL,
         basis_height_cm           REAL,
         basis_age_years           INTEGER,
         basis_sex                 TEXT,

         acknowledged_below_floor  INTEGER NOT NULL DEFAULT 0
                                           CHECK (acknowledged_below_floor IN (0, 1)),
         note                      TEXT,

         created_at                INTEGER NOT NULL,
         updated_at                INTEGER NOT NULL,
         server_updated_at         TEXT,
         deleted_at                INTEGER
       )`,

      /*
       * The resolution index: the latest period starting on or before a date.
       * Scanned in descending order and stopped at the first hit, so the cost
       * does not grow with the number of periods behind it.
       */
      `CREATE INDEX idx_nutrition_goals_lookup
         ON nutrition_goals(user_id, effective_from DESC, created_at DESC)
         WHERE deleted_at IS NULL`,

      /*
       * Weight over time rather than a column on the profile, which would lose
       * every previous measurement the first time somebody weighed themselves.
       *
       * No uniqueness on (user_id, measured_on): two devices recording the
       * same morning offline would each produce a row, and rejecting the
       * second forever is worse than keeping both and reading the later one.
       */
      `CREATE TABLE weight_entries (
         id                TEXT    PRIMARY KEY NOT NULL,
         user_id           TEXT    NOT NULL,
         measured_on       TEXT    NOT NULL
                                   CHECK (measured_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
         weight_kg         REAL    NOT NULL CHECK (weight_kg BETWEEN 25 AND 400),
         note              TEXT,
         created_at        INTEGER NOT NULL,
         updated_at        INTEGER NOT NULL,
         server_updated_at TEXT,
         deleted_at        INTEGER
       )`,

      `CREATE INDEX idx_weight_entries_lookup
         ON weight_entries(user_id, measured_on DESC, created_at DESC)
         WHERE deleted_at IS NULL`,
    ],
  },
  {
    version: 5,
    name: 'water',
    statements: [
      /*
       * Water logs.
       *
       * A diary entry with one number. `local_date` follows the same rule as
       * `food_logs.diary_date` — the user's calendar day in the zone the entry
       * was made in, computed at write time and never re-derived — and on the
       * server both tables share one resolver function so the two cannot
       * disagree about DST or travel.
       *
       * Millilitres only. The unit a user reads is a display preference.
       */
      `CREATE TABLE water_logs (
         id                TEXT    PRIMARY KEY NOT NULL,
         user_id           TEXT    NOT NULL,
         amount_ml         INTEGER NOT NULL
                                   CHECK (amount_ml > 0 AND amount_ml <= 5000),
         consumed_at       INTEGER NOT NULL,
         time_zone         TEXT    NOT NULL,
         local_date        TEXT    NOT NULL
                                   CHECK (local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
         note              TEXT,
         created_at        INTEGER NOT NULL,
         updated_at        INTEGER NOT NULL,
         server_updated_at TEXT,
         deleted_at        INTEGER
       )`,

      // The day read and the daily total are one access pattern.
      `CREATE INDEX idx_water_logs_day
         ON water_logs(user_id, local_date, consumed_at)
         WHERE deleted_at IS NULL`,

      /*
       * Water goal periods.
       *
       * Same shape as nutrition_goals: only `effective_from` is authored and
       * `effective_to` is derived, so changing a target is one row to push and
       * two devices cannot produce overlapping periods. The recommendation is
       * kept beside the target, and `basis_weight_kg` snapshots what it was
       * computed from — which is what stops a weight change from rewriting
       * last month's goal.
       */
      `CREATE TABLE water_goals (
         id                TEXT    PRIMARY KEY NOT NULL,
         user_id           TEXT    NOT NULL,
         effective_from    TEXT    NOT NULL
                                   CHECK (effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
         effective_to      TEXT
                                   CHECK (effective_to IS NULL
                                          OR effective_to GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
         target_ml         INTEGER NOT NULL
                                   CHECK (target_ml BETWEEN 500 AND 10000),
         source            TEXT    NOT NULL CHECK (source IN ('calculated', 'manual')),
         calculated_ml     INTEGER,
         basis_weight_kg   REAL,
         note              TEXT,
         created_at        INTEGER NOT NULL,
         updated_at        INTEGER NOT NULL,
         server_updated_at TEXT,
         deleted_at        INTEGER
       )`,

      `CREATE INDEX idx_water_goals_lookup
         ON water_goals(user_id, effective_from DESC, created_at DESC)
         WHERE deleted_at IS NULL`,
    ],
  },
  {
    version: 6,
    name: 'cached_food_barcodes',
    statements: [
      /*
       * The barcode a cached food was found by.
       *
       * Scanning is most useful exactly where connectivity is worst — the back
       * of a supermarket — so a product scanned once should resolve from the
       * device forever after. Without this, `food_cache` could render a food
       * offline but could not be *reached* offline, because the only route in
       * was a server lookup.
       *
       * A column on the existing cache rather than a table of its own: it is a
       * property of the cached food, it is written by the same code path, and
       * it is cleared by the same eviction.
       */
      `ALTER TABLE food_cache ADD COLUMN barcode TEXT`,

      /*
       * Not unique. Two of a user's foods may legitimately carry the same code
       * — an own-brand product and a custom food created from it — and a
       * unique index would make caching the second one fail rather than simply
       * resolve to the first.
       */
      `CREATE INDEX idx_food_cache_barcode
         ON food_cache(barcode)
         WHERE barcode IS NOT NULL`,
    ],
  },
];

/** Highest migration version known to this build. */
export const LATEST_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);
