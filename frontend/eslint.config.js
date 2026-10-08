// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
    rules: {
      // JSX text punctuation is safe in React Native and does not affect the
      // generated native/web bundles. Keep it visible without blocking CI.
      'react/no-unescaped-entities': 'warn',
    },
  },
]);
