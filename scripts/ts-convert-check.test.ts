import { expect, test } from 'bun:test';
import { forbiddenIn } from './ts-convert-check.ts';

test('forbidden syntax is found whatever the lint coverage', () => {
  const text = [
    'const a: any = 1;',
    'const b = a as unknown;',
    'const c = (a as string) as number;',
    'const d = <string>a;',
    'const e: Function = () => 1;',
    '// @ts-expect-error',
    '// eslint-disable-next-line no-console',
    'const ok = a as string;',
  ].join('\n');
  expect(forbiddenIn('x.ts', text)).toEqual([
    'line 1: any',
    'line 2: as unknown',
    'line 3: double assertion',
    'line 4: <T>x cast',
    'line 5: Function type',
    '@ts-ignore / @ts-expect-error / @ts-nocheck comment',
    'ESLint directive comment: eslint-disable-next-line no-console',
  ]);
  expect(forbiddenIn('y.ts', 'const s: string = String(1);\nconst n = value!;\nconst t = x as Settings;\n')).toEqual([]);
});
