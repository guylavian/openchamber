#!/usr/bin/env node
// Bulk rename-only conversion of zero-touch JavaScript to TypeScript (Stage D).
//
// For a reviewed list of files the census grades A, this:
//   1. checks each file is in the JS-debt baseline, unmodified, graded A now,
//      and that its TypeScript name is free;
//   2. `git mv`s each file (x.js -> x.ts, .mjs -> .ts, .cjs -> .cts, JSX -> .tsx);
//      import specifiers are not touched (`./x.js` resolves to x.ts);
//   3. type-checks every affected project strictly;
//   4. checks runtime parity for each file (scripts/ts-parity.ts, against HEAD);
//   5. lints the renamed files (typed server rules included) and runs the
//      assertion budget, which must pass unchanged: no new assertion;
//   6. with --test, runs the renamed tests and the tests that import renamed
//      modules;
//   7. only then shrinks the JS-debt baseline and regenerates its report.
// Any failure reverts every rename in the batch and exits 1. It never edits
// file contents and never fixes a diagnostic.
//
// Usage: node scripts/ts-bulk-convert.ts --list <file-with-paths> [--test] [--preflight]
//   --preflight: validate the list and print the renames, change nothing.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importEdges } from './check-js-debt.ts';
import { census, renamed } from './ts-census.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Step {
  label: string;
  command: string;
  args: string[];
  cwd?: string;
}

const run = ({ label, command, args, cwd }: Step): boolean => {
  const result = spawnSync(command, args, { cwd: cwd ?? ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const ok = result.status === 0;
  console.log(`[bulk] ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) console.log(`${result.stdout}${result.stderr}`.split('\n').filter((line) => !/ExperimentalWarning|--trace-warnings/.test(line)).slice(-40).join('\n'));
  return ok;
};

const tscBin = (): string => {
  const pkg = spawnSync(process.execPath, ['-p', "require.resolve('@typescript/native/package.json')"], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  return path.join(path.dirname(pkg), 'bin', 'tsc');
};

const typecheckSteps = (targets: readonly string[]): Step[] => {
  const tsc = tscBin();
  const steps: Step[] = [];
  if (targets.some((file) => file.startsWith('packages/web/'))) steps.push({ label: 'type-check packages/web (server)', command: tsc, args: ['-p', 'packages/web/tsconfig.server.json', '--noEmit'] });
  for (const pkg of ['ui', 'vscode', 'electron']) {
    if (targets.some((file) => file.startsWith(`packages/${pkg}/`))) steps.push({ label: `type-check packages/${pkg}`, command: tsc, args: ['-p', `packages/${pkg}/tsconfig.json`, '--noEmit'] });
  }
  const loose = targets.filter((file) => !/^packages\/(web|ui|vscode|electron)\//.test(file));
  if (loose.length > 0) {
    steps.push({ label: `type-check ${String(loose.length)} file(s) outside a project (strict Node settings)`, command: tsc, args: ['--ignoreConfig', '--noEmit', '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', '--types', 'node', '--allowImportingTsExtensions', '--skipLibCheck', ...loose] });
  }
  return steps;
};

const testSteps = (targets: readonly string[]): Step[] => {
  const edges = importEdges();
  const targetSet = new Set(targets);
  const tests = new Set(targets.filter((file) => /\.test\.[cm]?tsx?$/.test(file)));
  for (const [importer, imported] of edges) {
    if (/\.test\.[cm]?[jt]sx?$/.test(importer) && imported.some((file) => targetSet.has(file))) tests.add(importer);
  }
  const web = [...tests].filter((file) => file.startsWith('packages/web/')).map((file) => path.relative('packages/web', file));
  const rest = [...tests].filter((file) => !file.startsWith('packages/web/'));
  const steps: Step[] = [];
  if (web.length > 0) steps.push({ label: `vitest: ${String(web.length)} affected web test file(s)`, command: 'bunx', args: ['vitest', 'run', ...web], cwd: path.join(ROOT, 'packages/web') });
  for (const file of rest) {
    const node = /\.[cm]?js$/.test(file) && /['"]node:test['"]/.test(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    steps.push(node ? { label: `node --test ${file}`, command: process.execPath, args: ['--test', file] } : { label: `bun test ${file}`, command: 'bun', args: ['test', `./${file}`] });
  }
  return steps;
};

const main = (): void => {
  const args = process.argv.slice(2);
  const listIndex = args.indexOf('--list');
  const listFile = listIndex === -1 ? undefined : args[listIndex + 1];
  if (listFile === undefined) throw new Error('usage: --list <file> [--test]');
  const files = fs.readFileSync(listFile, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('#'));
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/js-debt-baseline.json'), 'utf8')) as Record<string, number>;
  const grades = new Map(census().map((entry) => [entry.file, entry]));
  const problems: string[] = [];
  const moves: [string, string][] = [];
  for (const file of files) {
    const entry = grades.get(file);
    if (!(file in baseline)) problems.push(`${file}: not in the JS-debt baseline`);
    else if (entry === undefined || entry.grade !== 'A') problems.push(`${file}: census grade ${entry?.grade ?? '?'}, not A`);
    const dirty = spawnSync('git', ['status', '--porcelain', '--', file], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
    if (dirty.length > 0) problems.push(`${file}: has local changes`);
    const target = renamed(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
    if (fs.existsSync(path.join(ROOT, target))) problems.push(`${file}: ${target} already exists`);
    moves.push([file, target]);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[bulk] ${problem}`);
    process.exit(1);
  }
  if (args.includes('--preflight')) {
    for (const [from, to] of moves) console.log(`[bulk] ${from} -> ${to}`);
    return;
  }
  const revert = (): void => {
    for (const [from, to] of [...moves].reverse()) spawnSync('git', ['mv', to, from], { cwd: ROOT });
    spawnSync('git', ['checkout', '--', 'scripts/js-debt-baseline.json', 'docs/stage-d-js-inventory.md'], { cwd: ROOT });
    console.error('[bulk] batch reverted');
  };
  for (const [from, to] of moves) {
    if (spawnSync('git', ['mv', from, to], { cwd: ROOT }).status !== 0) {
      console.error(`[bulk] git mv failed for ${from}`);
      revert();
      process.exit(1);
    }
  }
  const targets = moves.map(([, to]) => to);
  // ponytail: only the trees package `lint` scripts cover; others are not linted by the repo either.
  const linted = targets.filter((file) => /^packages\/(web\/(src|server)|ui\/src)\//.test(file));
  const steps: Step[] = [
    ...typecheckSteps(targets),
    { label: `runtime parity (${String(targets.length)} file(s) against HEAD)`, command: process.execPath, args: ['scripts/ts-parity.ts', ...targets] },
    ...(linted.length > 0 ? [{ label: `eslint on ${String(linted.length)} renamed file(s) in linted trees`, command: 'bunx', args: ['eslint', '--config', 'eslint.config.js', ...linted] }] : []),
    { label: 'assertion budget unchanged (no new assertion)', command: process.execPath, args: ['scripts/check-assertion-budget.mjs'] },
    ...(args.includes('--test') ? testSteps(targets) : []),
  ];
  for (const step of steps) {
    if (!run(step)) {
      revert();
      process.exit(1);
    }
  }
  if (!run({ label: 'shrink the JS-debt baseline', command: process.execPath, args: ['scripts/check-js-debt.ts', '--update'] })
    || !run({ label: 'regenerate the inventory', command: process.execPath, args: ['scripts/check-js-debt.ts', '--report', 'docs/stage-d-js-inventory.md'] })) {
    revert();
    process.exit(1);
  }
  console.log(`[bulk] converted ${String(targets.length)} file(s); review and commit.`);
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
