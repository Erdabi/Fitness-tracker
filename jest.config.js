/**
 * Two projects run under one command:
 *
 *  - `node`  — pure logic (sync merge rules, migrations against real SQLite via
 *              better-sqlite3, units, dates, validation). No React Native, so
 *              these are fast and can use native node modules.
 *  - `react-native` — component and hook tests through the jest-expo preset.
 *
 * Splitting them keeps the pure-logic suite free of the RN transform cost and
 * lets the migration tests use better-sqlite3, which cannot load under the
 * jest-expo environment.
 */
module.exports = {
  projects: [
    {
      displayName: 'node',
      preset: undefined,
      testEnvironment: 'node',
      setupFiles: ['<rootDir>/jest.setup.node.ts'],
      testMatch: [
        '<rootDir>/src/**/__tests__/**/*.node.test.ts',
        '<rootDir>/supabase/**/__tests__/**/*.node.test.ts',
      ],
      transform: {
        '^.+\\.tsx?$': ['babel-jest', { configFile: './babel.config.js' }],
      },
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
      },
    },
    {
      displayName: 'react-native',
      preset: 'jest-expo',
      testMatch: ['<rootDir>/src/**/__tests__/**/*.rn.test.{ts,tsx}'],
      setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
      },
      transformIgnorePatterns: [
        'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg)',
      ],
    },
  ],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/__tests__/**', '!src/**/*.d.ts'],
};
