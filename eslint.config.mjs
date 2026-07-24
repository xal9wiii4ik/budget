import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/.expo/**',
      // Python is linted/formatted by ruff, not eslint.
      'apps/api/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // React hooks rules apply to both web (Vite) and mobile (Metro) — hook
  // violations are equally real bugs in React Native (grooming-review §1.5).
  {
    files: ['apps/{web,mobile}/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  // react-refresh is a Vite HMR concern only — meaningless for Metro, so
  // this block is scoped to web (grooming-review §1.5).
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-refresh': reactRefresh },
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  // CommonJS config files (e.g. apps/mobile/metro.config.js) are loaded via
  // require() by their tooling, so require()/module/__dirname are legitimate.
  // Treat them as CJS with Node globals so no per-file eslint-disable is needed.
  {
    files: ['**/*.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
