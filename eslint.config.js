const expoConfig = require('eslint-config-expo/flat');

module.exports = [
  ...expoConfig,
  {
    ignores: [
      'dist/*',
      'node_modules/*',
      '.expo/*',
      'coverage/*',
      // Deno runtime: npm: specifiers, the Deno global, .ts import extensions.
      // Linted by its own toolchain, not by the app's.
      'supabase/functions/*',
    ],
  },
  {
    rules: {
      // The offline layer deliberately fires sync without awaiting it; the
      // engine owns its own error handling and must not block the UI.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Command-line tools: printing to stdout is the whole job, and their code
    // never ships in the app bundle.
    files: ['scripts/**/*.ts', 'tools/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    /*
     * The server boundary.
     *
     * Application code must never import from `supabase/functions` or from the
     * ingestion tools. Both hold server-only credentials — the Anthropic key
     * and the database service role — and a single stray import would pull
     * that code, and the environment reads that go with it, into the Metro
     * bundle. The bundle is also checked for those symbols after every build,
     * but a lint error names the offending line, which a `strings` grep cannot.
     */
    files: ['src/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/supabase/functions/**', '**/tools/ingestion/**'],
              message:
                'Server-only code. It holds the Anthropic key and the service role, and must never enter the app bundle. Call the Edge Function through AIProvider instead.',
            },
          ],
        },
      ],
    },
  },
];
