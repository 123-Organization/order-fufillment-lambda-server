const js = require('@eslint/js');
const eslintPluginN = require('eslint-plugin-n').default;
const eslintConfigPrettier = require('eslint-config-prettier');
const globals = require('globals');

const platformControllerFiles = [
  'src/controllers/shopify-*.js',
  'src/controllers/squarespace-*.js',
  'src/controllers/wix-*.js',
  'src/controllers/platform-order-sync.js',
  'src/controllers/disconnect-store.js',
];

const platformHelperFiles = [
  'src/helpers/shopify-*.js',
  'src/helpers/squarespace-*.js',
  'src/helpers/wix-*.js',
  'src/helpers/platform-connections.js',
];

const platformFiles = [...platformControllerFiles, ...platformHelperFiles];

const nodeRecommendedRules = eslintPluginN.configs['flat/recommended-script'].rules;

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
  {
    ignores: [
      'node_modules/**',
      '.aws-sam/**',
      'packaged.yaml',
      'coverage/**',
      'dist/**',
    ],
  },
  {
    files: platformFiles,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      n: eslintPluginN,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...nodeRecommendedRules,
      ...eslintConfigPrettier.rules,
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-throw-literal': 'error',
      'no-console': 'off',
      complexity: 'off',
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
];
