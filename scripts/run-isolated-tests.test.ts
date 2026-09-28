import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collect, runnerFor } from './run-isolated-tests.mjs';
import { renamed } from './ts-census.ts';

const ROOT = path.resolve(import.meta.dir, '..');
// Every root a package `test` script hands to run-isolated-tests.
const ROOTS = ['scripts', 'packages/sdk/src', 'packages/sdk/scripts', 'packages/ui/src', 'packages/vscode/src', 'packages/vscode/webview', 'packages/electron'];

test('renaming a JavaScript test to TypeScript keeps its runner (Stage D)', () => {
  const javascript = ROOTS.flatMap((root) => collect(path.join(ROOT, root))).filter((file) => /\.(js|mjs|cjs|jsx)$/.test(file));
  expect(javascript.length).toBeGreaterThan(0);
  for (const file of javascript) {
    const source = fs.readFileSync(file, 'utf8');
    expect({ file, runner: runnerFor(renamed(file, source), source) }).toEqual({ file, runner: runnerFor(file, source) });
  }
});

test('runner choice', () => {
  expect(runnerFor('a.test.ts', "import { test } from 'node:test';\nimport { f } from './f.js';")).toBe('node');
  expect(runnerFor('a.test.cts', "const { test } = require('node:test');\nconst f = require('./f.cjs');")).toBe('node');
  expect(runnerFor('a.test.ts', "import { test } from 'node:test';\nimport { f } from './f';")).toBe('bun');
  expect(runnerFor('a.test.ts', "import { test } from 'node:test';\nconst s = \"import x from './looks-like-an-import'\";")).toBe('node');
  expect(runnerFor('packages/vscode/src/a.test.ts', "import { test } from 'node:test';")).toBe('bun');
  expect(runnerFor('a.test.tsx', "import { test } from 'node:test';")).toBe('bun');
  expect(runnerFor('a.test.ts', "import { test } from 'bun:test';")).toBe('bun');
  expect(runnerFor('a.test.ts', '')).toBe('bun');
  expect(runnerFor('a.test.mjs', "import { test } from 'node:test';")).toBe('node');
  expect(runnerFor('a.test.mjs', '')).toBeNull();
});

test('Node runs a converted node:test file: types stripped, specifiers as written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-runner-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }');
    fs.writeFileSync(path.join(dir, 'f.mjs'), 'export const f = (x) => x + 1;\n');
    fs.writeFileSync(path.join(dir, 'a.test.ts'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { f } from './f.mjs';\n\ntest('f', () => {\n  const n: number = f(1);\n  assert.equal(n, 2);\n});\n");
    fs.writeFileSync(path.join(dir, 'b.test.cts'), "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\n\ntest('b', () => {\n  const n: number = 1;\n  assert.equal(n, 1);\n});\n");
    for (const file of ['a.test.ts', 'b.test.cts']) {
      const result = spawnSync('node', ['--test', file], { cwd: dir, encoding: 'utf8' });
      expect({ file, status: result.status, output: result.status === 0 ? '' : `${result.stdout}${result.stderr}` }).toEqual({ file, status: 0, output: '' });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
