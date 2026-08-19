/**
 * Setup for the react-native jest project.
 *
 * Native modules are mocked here rather than in individual tests so that any
 * component pulling in the Supabase client or the local database does not need
 * to know how those are wired.
 */

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
  isAvailableAsync: jest.fn(async () => true),
}));

jest.mock('expo-sqlite', () => ({
  openDatabaseSync: jest.fn(() => ({
    execSync: jest.fn(),
    runSync: jest.fn(() => ({ changes: 0, lastInsertRowId: 0 })),
    getAllSync: jest.fn(() => []),
    getFirstSync: jest.fn(() => null),
    withTransactionSync: jest.fn((fn: () => void) => fn()),
    closeSync: jest.fn(),
  })),
}));

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Europe/Zurich' }]),
  getLocales: jest.fn(() => [{ languageTag: 'en-CH', measurementSystem: 'metric' }]),
}));

jest.mock('expo-network', () => ({
  getNetworkStateAsync: jest.fn(async () => ({
    isConnected: true,
    isInternetReachable: true,
  })),
  addNetworkStateListener: jest.fn(() => ({ remove: jest.fn() })),
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

// Silence the reanimated warning about the mock in the test environment.
// jest.mock factories are hoisted above imports, so require is the only option.
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
