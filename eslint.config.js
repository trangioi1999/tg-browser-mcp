import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', '**/node_modules/**', 'coverage/**', '.tg-browser/**', '**/.wrangler/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    files: ['src/cli/**', 'scripts/**', 'examples/**', 'tests/**'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        document: 'readonly',
        window: 'readonly',
        fetch: 'readonly',
        URLSearchParams: 'readonly',
        localStorage: 'readonly',
      },
    },
  },
);
