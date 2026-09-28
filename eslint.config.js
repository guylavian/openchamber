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
    // Fast refresh concerns modules the dev server hot-reloads in the browser;
    // tests and their fixtures never are.
    files: ['**/*.test.{ts,tsx}', '**/*.fixture.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // Server TypeScript: typed lint, zero `any` and nothing that defeats the
    // checker. No `any` (explicit, flowing in, or `as any`), no `as unknown`
    // or double assertions, no angle-bracket assertions, no @ts- directives,
    // and no eslint-disable comments to switch any of it off.
    // Modules converted from JavaScript keep its runtime behaviour exactly, so:
    // - `x as T` and `x!` are allowed. Both are erased; each marks a place the
    //   JavaScript relies on an invariant the checker cannot see (state loaded,
    //   an index found, an object finished field by field).
    // - no-unnecessary-condition is off: it would delete defensive `?.`, `??`
    //   and branches the types call unreachable.
    // - restrict-template-expressions is off: it would replace `${value}` with
    //   `${String(value)}`, which differs for a symbol.
    // - no-deprecated and no-confusing-void-expression are off: they would
    //   rewrite calls the JavaScript makes (Zod's no-op `.finite()`, an arrow
    //   that returns `console.warn(...)`).
    // - require-await is off: dropping `async` from a function without `await`
    //   changes what it returns (a value instead of a promise).
    // - no-useless-default-assignment is off: `= undefined` defaults are the
    //   JavaScript's own text.
    // Uses the TypeScript 6 API (see docs/platform-toolchain.md).
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
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'as', objectLiteralTypeAssertions: 'allow' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-syntax': ['error',
        { selector: "TSAsExpression[typeAnnotation.type='TSUnknownKeyword']", message: 'No `as unknown`: narrow with a guard or describe the contract.' },
        { selector: 'TSAsExpression > TSAsExpression.expression', message: 'No double assertions.' },
      ],
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-deprecated': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-useless-default-assignment': 'off',
    },
  },
])
