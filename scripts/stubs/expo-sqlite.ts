/**
 * Node stub for expo-sqlite.
 *
 * Benchmarks run the real repositories against better-sqlite3, always passing
 * an explicit database, so the device handle is never opened. Stubbing it
 * here — rather than making the app import lazily — keeps the production
 * module structure exactly as it ships.
 */
export function openDatabaseSync(): never {
  throw new Error('expo-sqlite is unavailable outside the app; pass a database.');
}
