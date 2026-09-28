import { expect, test } from 'bun:test';
import { assertionsIn, compare, eslintDirectivesIn } from './check-assertion-budget.mjs';

test('finds non-null and type assertions, not `as const` or `satisfies`', () => {
  const found = assertionsIn('x.ts', [
    'const a = state!.jobs;',
    'const b = value as string;',
    'const c = <number>other;',
    "const d = ['x'] as const;",
    'const e = { a: 1 } satisfies object;',
  ].join('\n'));
  expect(found).toEqual(['state!', 'value as string', '<number>other']);
});

test('nested assertions are each counted, whitespace normalised', () => {
  expect(assertionsIn('x.ts', 'run.execution!\n  .id!;')).toEqual(['run.execution! .id!', 'run.execution!']);
});

test('a new assertion is over budget and a removed one is stale', () => {
  const baseline = { 'a.ts': { 'x!': 2, 'y as T': 1 } };
  const actual = { 'a.ts': { 'x!': 2, 'z!': 1 }, 'b.ts': { 'w as U': 1 } };
  expect(compare(baseline, actual)).toEqual({
    over: [{ file: 'a.ts', expression: 'z!', count: 1 }, { file: 'b.ts', expression: 'w as U', count: 1 }],
    stale: [{ file: 'a.ts', expression: 'y as T', count: 1 }],
  });
});

test('a second copy of an allowed expression is over budget', () => {
  expect(compare({ 'a.ts': { 'state!': 1 } }, { 'a.ts': { 'state!': 2 } }).over).toEqual([{ file: 'a.ts', expression: 'state!', count: 1 }]);
});

test('the same set passes', () => {
  expect(compare({ 'a.ts': { 'x!': 1 } }, { 'a.ts': { 'x!': 1 } })).toEqual({ over: [], stale: [] });
});

test('ESLint directive comments are found; ordinary comments and strings are not', () => {
  const text = [
    '// eslint-disable-next-line @typescript-eslint/no-explicit-any',
    '/* eslint-disable */',
    '/* eslint no-console: off */',
    '// Explains why eslint rules matter here.',
    "const s = '// eslint-disable';",
  ].join('\n');
  expect(eslintDirectivesIn(text)).toEqual([
    'eslint-disable-next-line @typescript-eslint/no-explicit-any',
    'eslint-disable',
    'eslint no-console: off',
  ]);
});
