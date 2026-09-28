import { expect, test } from 'bun:test';
import { normalize, parseArgs } from './ts-parity.ts';

const js = (text: string): string => normalize(text, 'a.js');
const tsx = (text: string): string => normalize(text, 'a.ts');

test('type annotations, interfaces, type-only imports and comments erase to the JavaScript', () => {
  const before = js("import { a } from './a.js';\n// note\nexport const f = (x) => a(x) ?? 1;\n");
  const after = tsx("import { a } from './a.js';\nimport type { T } from './t.js';\ninterface I { x: number }\n/** doc */\nexport const f = (x: T): number => a(x) ?? 1;\n");
  expect(after).toBe(before);
});

test('an import used only as a type but written as a value import is kept, as the JavaScript had it', () => {
  expect(tsx("import { T } from './t.js';\nexport const f = (x: T) => x;\n")).toContain("import { T } from './t.js'");
});

test('a runtime change shows up', () => {
  expect(tsx('export const f = (x: number) => x ?? 2;\n')).not.toBe(js('export const f = (x) => x ?? 1;\n'));
  expect(tsx('export const f = (x: { a?: number }) => x.a!;\n')).toBe(js('export const f = (x) => x.a;\n'));
});

test('every file is checked, with or without --rev', () => {
  expect(parseArgs(['a.ts', 'b.ts'])).toEqual({ rev: 'HEAD', files: ['a.ts', 'b.ts'] });
  expect(parseArgs(['--rev', 'abc', 'a.ts'])).toEqual({ rev: 'abc', files: ['a.ts'] });
  expect(parseArgs(['a.ts', '--rev', 'abc', 'b.ts'])).toEqual({ rev: 'abc', files: ['a.ts', 'b.ts'] });
});
