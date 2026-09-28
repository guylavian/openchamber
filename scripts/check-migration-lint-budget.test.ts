import { expect, test } from 'bun:test';
import { compare, rebuild, textAt } from './check-migration-lint-budget.ts';
import type { Budget, Violation } from './check-migration-lint-budget.ts';

const budget = (entries: Budget['entries']): Budget => ({ eligibleRules: { 'r/eligible': 'changes emit' }, entries });
const v = (file: string, rule: string, text: string): Violation => ({ file, rule, text, line: 1, message: 'm' });
// Files that do not exist on disk: their entries are always in scope.
const A = 'nowhere/a.ts';

test('a violation is identified by its normalised line, or its range when multi-line', () => {
  const source = 'const a  =  String(b);\nconst s = String(\n  value);\n';
  expect(textAt(source, 1, 12, 1, 18)).toBe('const a = String(b);');
  expect(textAt(source, 1, 1)).toBe('const a = String(b);');
  expect(textAt(source, 2, 11, 3, 9)).toBe('String( value)');
});

test('budgeted violations pass; extra, ineligible and stale ones fail', () => {
  const b = budget({ [A]: [{ rule: 'r/eligible', text: 'String(x)', count: 1, reason: 'parity' }] });
  const linted = new Set([A]);
  expect(compare(b, [v(A, 'r/eligible', 'String(x)')], linted)).toEqual({ unbudgeted: [], ineligible: [], stale: [] });
  const twice = compare(b, [v(A, 'r/eligible', 'String(x)'), v(A, 'r/eligible', 'String(x)')], linted);
  expect(twice.unbudgeted).toHaveLength(1);
  expect(compare(b, [v(A, 'r/eligible', 'String(x)'), v(A, 'r/other', 'x')], linted).ineligible).toHaveLength(1);
  expect(compare(b, [], linted).stale).toEqual([{ file: A, entry: { rule: 'r/eligible', text: 'String(x)', count: 1, reason: 'parity' }, missing: 1 }]);
});

test('rebuild keeps known reasons, takes new ones from the reasons file, and refuses a new entry without one', () => {
  const b = budget({ [A]: [{ rule: 'r/eligible', text: 'String(x)', count: 1, reason: 'kept' }] });
  const linted = new Set([A]);
  const found = [v(A, 'r/eligible', 'String(x)'), v(A, 'r/eligible', 'void p')];
  expect(rebuild(b, found, linted, []).missingReasons).toEqual([v(A, 'r/eligible', 'void p')]);
  const next = rebuild(b, found, linted, [{ file: A, rule: 'r/eligible', text: 'void  p', reason: 'new' }]);
  expect(next.missingReasons).toEqual([]);
  expect(next.budget.entries[A]).toEqual([
    { rule: 'r/eligible', text: 'String(x)', count: 1, reason: 'kept' },
    { rule: 'r/eligible', text: 'void p', count: 1, reason: 'new' },
  ]);
});
