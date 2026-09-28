import { expect, test } from 'bun:test';
import { classify, compare, lineCount } from './check-js-debt.ts';
import type { Entry } from './check-js-debt.ts';

test('generated SDK example bundles are not debt; their TypeScript sources are not JavaScript', () => {
  expect(classify('packages/sdk/examples/tasks-demo/panel/main.js')).toBe('generated');
});

test('each first-party area gets its category', () => {
  expect(classify('packages/web/server/lib/git/service.js')).toBe('server');
  expect(classify('packages/web/bin/cli.js')).toBe('cli');
  expect(classify('packages/electron/main.mjs')).toBe('electron');
  expect(classify('packages/electron/scripts/package.mjs')).toBe('tooling');
  expect(classify('scripts/oc-dev.mjs')).toBe('tooling');
  expect(classify('fix-deprecation.js')).toBe('tooling');
  expect(classify('eslint.config.js')).toBe('config');
});

test('tests and helpers are recognised anywhere, before their area', () => {
  expect(classify('packages/web/server/lib/git/service.test.js')).toBe('test');
  expect(classify('packages/electron/tray.test.mjs')).toBe('test');
  expect(classify('packages/ui/src/sync/__tests__/event-pipeline.bench.js')).toBe('test');
  expect(classify('packages/web/test/helpers.js')).toBe('test');
  expect(classify('packages/ui/tests/chat-history-scroll.browser.mjs')).toBe('test');
});

test('a path no rule covers is unclassified, so the gate fails instead of guessing', () => {
  expect(classify('packages/ui/src/something.js')).toBeNull();
});

test('lines count the last line with or without a trailing newline', () => {
  expect(lineCount('')).toBe(0);
  expect(lineCount('a\nb\n')).toBe(2);
  expect(lineCount('a\nb')).toBe(2);
});

const entry = (file: string): Entry => ({ file, category: 'server', lines: 1, importers: 0, importsFirstPartyJs: false, runtime: '', risk: 'low', wave: 'D1' });

test('a new JavaScript file is added debt; a converted one is stale until the baseline shrinks', () => {
  expect(compare({ 'a.js': 1, 'b.js': 2 }, [entry('a.js'), entry('c.js')])).toEqual({ added: ['c.js'], stale: ['b.js'] });
  expect(compare({ 'a.js': 1 }, [entry('a.js')])).toEqual({ added: [], stale: [] });
});
