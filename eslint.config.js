// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/node_modules/**',
      '**/*.config.js',
      '**/*.config.ts',
      'solver/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.tsx'],
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/no-danger': 'error',
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // Supertest's `response.body` is untyped (`any`) by design — assertions in integration
      // tests routinely index into it. Treated as acceptable only in test files.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  {
    // `apps/api/src/engine/**` is the pure scheduling engine (validator + solver problem I/O): it
    // must operate on plain data only, never on Express/Prisma/pg-boss, so the API, the
    // background worker, and unit tests all exercise identical code (see the design doc's
    // "server/src/engine/ imports nothing from Express, Prisma, or pg-boss" decision).
    //
    // NOTE: flat-config `files` glob patterns are matched against paths relative to
    // `process.cwd()`, not this config file's directory. Every workspace's own `lint` script runs
    // `eslint . --config ../../eslint.config.js` with cwd set to that workspace's own directory
    // (e.g. `apps/api`), so a pattern anchored at the repo-root-relative `apps/api/src/engine/**`
    // would never match in that invocation — only `pnpm eslint` run from the repo root against an
    // explicit `apps/api/...` path would see it. Matching both the workspace-relative and
    // repo-root-relative forms keeps the rule live under both invocation styles.
    files: ['apps/api/src/engine/**/*.ts', 'src/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'express', message: 'engine/ must stay framework-free — no Express imports.' },
            {
              name: '@prisma/client',
              message: 'engine/ must stay persistence-free — no Prisma imports.',
            },
            { name: 'pg-boss', message: 'engine/ must stay queue-free — no pg-boss imports.' },
          ],
          patterns: [
            {
              group: ['**/generated/prisma/**'],
              message: 'engine/ must stay persistence-free — no generated Prisma client imports.',
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
);
