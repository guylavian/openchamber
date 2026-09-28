import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { globalIgnores } from 'eslint/config'

export default tseslint.config([
  globalIgnores(['dist', '.openchamber']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    // Server TypeScript: typed lint, zero `any` and nothing that defeats the
    // checker. No `any` (explicit or flowing in), no type assertions other than
    // `as const`, no non-null assertions, no @ts- directives, and no
    // eslint-disable comments to switch any of it off. Data from outside
    // (JSON, HTTP bodies, events) enters as `unknown` and is narrowed by Zod or
    // type guards. Uses the TypeScript 6 API (see docs/platform-toolchain.md).
    // Patterns are relative to the directory ESLint runs in: the repo root, or
    // packages/web when its `lint` script passes --config.
    files: ['**/packages/web/server/**/*.ts', 'server/**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked],
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error',
    },
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: ['./packages/web/tsconfig.server.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', {
        'ts-expect-error': true,
        'ts-ignore': true,
        'ts-nocheck': true,
        'ts-check': false,
      }],
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
])
