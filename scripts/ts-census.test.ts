import { expect, test } from 'bun:test';
import { isolatedRunnerBoundary, renamed } from './ts-census.ts';

test('renames keep the module kind and mark JSX', () => {
  expect(renamed('a/x.js', 'export const x = 1;')).toBe('a/x.ts');
  expect(renamed('a/x.mjs', 'export const x = 1;')).toBe('a/x.ts');
  expect(renamed('a/x.cjs', 'module.exports = 1;')).toBe('a/x.cts');
  expect(renamed('a/x.jsx', 'export const x = 1;')).toBe('a/x.tsx');
  expect(renamed('a/x.js', 'export const X = () => {\n  return (<div />);\n};')).toBe('a/x.tsx');
});

test('tests the isolated runner would drop or move are a boundary; web tests (vitest) are not', () => {
  expect(isolatedRunnerBoundary('scripts/a.test.cjs', 'scripts/a.test.cts', '')).toContain('does not find .cts');
  expect(isolatedRunnerBoundary('scripts/a.test.mjs', 'scripts/a.test.ts', "import test from 'node:test';")).toContain('bun test');
  expect(isolatedRunnerBoundary('scripts/a.test.mjs', 'scripts/a.test.ts', "import { test } from 'bun:test';")).toBeNull();
  expect(isolatedRunnerBoundary('packages/web/a.test.js', 'packages/web/a.test.ts', "import test from 'node:test';")).toBeNull();
  expect(isolatedRunnerBoundary('scripts/a.mjs', 'scripts/a.ts', "import test from 'node:test';")).toBeNull();
});
