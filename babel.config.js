module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { jsxImportSource: 'react' }]],
    plugins: [
      // react-native-worklets/reanimated must remain the final plugin.
      'react-native-worklets/plugin',
    ],
  };
};
