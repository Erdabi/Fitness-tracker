const expoConfig = require('eslint-config-expo/flat');

module.exports = [
  ...expoConfig,
  {
    ignores: ['dist/*', 'node_modules/*', '.expo/*', 'coverage/*'],
  },
  {
    rules: {
      // The offline layer deliberately fires sync without awaiting it; the
      // engine owns its own error handling and must not block the UI.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
];
