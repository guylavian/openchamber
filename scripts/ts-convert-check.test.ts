import { expect, test } from 'bun:test';
import { budgetFindings } from './ts-convert-check.ts';

test('new assertions are listed for the checked files only; directive comments anywhere', () => {
  const output = [
    '[assertion-budget] new assertion (2) in packages/web/server/a.ts: value as number',
    '[assertion-budget] new assertion (1) in packages/web/server/other.ts: x!',
    '[assertion-budget] ESLint directive comment in packages/web/server/b.ts: eslint-disable-next-line',
    '[assertion-budget] 79 assertions, all in the reviewed baseline',
  ].join('\n');
  expect(budgetFindings(output, new Set(['packages/web/server/a.ts']))).toEqual({
    assertions: ['packages/web/server/a.ts (2x): value as number'],
    directives: ['packages/web/server/b.ts: eslint-disable-next-line'],
  });
});
