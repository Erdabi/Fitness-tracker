/**
 * Setup for the `node` jest project.
 *
 * Pure-logic tests exercise repositories, the outbox and the sync engine
 * directly, always passing an explicit better-sqlite3 database. Those modules
 * still import Expo native packages for their default arguments, and Expo
 * ships untranspiled ESM that the node environment cannot parse — so the
 * native surface is stubbed here rather than in every test file.
 */

jest.mock('expo-sqlite', () => ({
  openDatabaseSync: () => {
    throw new Error(
      'openDatabaseSync is unavailable under the node test project. Pass an ' +
        'explicit database (see src/db/__tests__/testDb.ts).',
    );
  },
}));

jest.mock('expo-crypto', () => {
  let counter = 0;
  return {
    randomUUID: () => {
      // Deterministic and well-formed, so id-shaped assertions stay stable.
      counter += 1;
      const suffix = counter.toString(16).padStart(12, '0');
      return `00000000-0000-4000-8000-${suffix}`;
    },
  };
});

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: {
      extra: {
        supabaseUrl: 'https://test-project.supabase.co',
        supabaseAnonKey: 'test-anon-key-that-is-long-enough-to-pass-validation',
        appEnv: 'test',
      },
    },
  },
}));
