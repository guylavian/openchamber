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
//   5. lints the renamed files (typed server rules included); on failure it
//      names each failing file and writes the others to <list>.lint-pass, so
//      the retry is deterministic; then the assertion budget must pass
//      unchanged: no new assertion;
//   6. rebuilds dist-node when server or CLI sources moved;
//   7. with --test, runs the renamed tests and the tests that import renamed
//      modules;
//   8. only then shrinks the JS-debt baseline and regenerates its report.
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
import { runnerFor } from './run-isolated-tests.mjs';
import { census, renamed } from './ts-census.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The trees the package `lint` scripts cover; files elsewhere are not linted by the repository either. */
export const LINTED = /^packages\/(web\/(src|server)|ui\/src)\//;

export interface Step {
  label: string;
  command: string;
  args: string[];
  cwd?: string;
}

/** Runs a step; on failure prints the last `tail` lines of its output. */
export const run = ({ label, command, args, cwd }: Step, tail = 40): boolean => {
  const result = spawnSync(command, args, { cwd: cwd ?? ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const ok = result.status === 0;
  console.log(`[bulk] ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) console.log(`${result.stdout}${result.stderr}`.split('\n').filter((line) => !/ExperimentalWarning|--trace-warnings/.test(line)).slice(-tail).join('\n'));
  return ok;
};

const tscBin = (): string => {
  const pkg = spawnSync(process.execPath, ['-p', "require.resolve('@typescript/native/package.json')"], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  return path.join(path.dirname(pkg), 'bin', 'tsc');
};

interface LintResult {
  filePath: string;
  errorCount: number;
  fatalErrorCount: number;
}

/** Renamed files ESLint reports errors in (repo-relative). */
export const lintFailuresOf = (files: readonly string[]): string[] => {
  const result = spawnSync('bunx', ['eslint', '--config', 'eslint.config.js', '--format', 'json', ...files], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const report = JSON.parse(result.stdout) as LintResult[];
  return report.filter((entry) => entry.errorCount + entry.fatalErrorCount > 0).map((entry) => path.relative(ROOT, entry.filePath).split(path.sep).join('/'));
};

export const typecheckSteps = (targets: readonly string[]): Step[] => {
  const tsc = tscBin();
  const steps: Step[] = [];
  if (targets.some((file) => /^packages\/web\/(server|bin)\//.test(file))) steps.push({ label: 'type-check packages/web (server)', command: tsc, args: ['-p', 'packages/web/tsconfig.server.json', '--noEmit'] });
  for (const pkg of ['ui', 'vscode', 'electron']) {
    if (targets.some((file) => file.startsWith(`packages/${pkg}/`))) steps.push({ label: `type-check packages/${pkg}`, command: tsc, args: ['-p', `packages/${pkg}/tsconfig.json`, '--noEmit'] });
  }
  const loose = targets.filter((file) => !/^packages\/(web\/(server|bin)|ui|vscode|electron)\//.test(file));
  if (loose.length > 0) {
    steps.push({ label: `type-check ${String(loose.length)} file(s) outside a project (strict Node settings)`, command: tsc, args: ['--ignoreConfig', '--noEmit', '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', '--types', 'node,bun-types/test', '--allowImportingTsExtensions', '--verbatimModuleSyntax', '--erasableSyntaxOnly', '--allowJs', '--checkJs', 'false', '--skipLibCheck', ...loose] });
  }
  return steps;
};

export const testSteps = (targets: readonly string[]): Step[] => {
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
    // The runner run-isolated-tests would pick, so a converted node:test file is tested on Node.
    const runner: unknown = runnerFor(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
    steps.push(runner === 'node' ? { label: `node --test ${file}`, command: process.execPath, args: ['--test', file] } : { label: `bun test ${file}`, command: 'bun', args: ['test', `./${file}`] });
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
  const linted = targets.filter((file) => LINTED.test(file));
  const steps: Step[] = [
    ...typecheckSteps(targets),
    { label: `runtime parity (${String(targets.length)} file(s) against HEAD)`, command: process.execPath, args: ['scripts/ts-parity.ts', ...targets] },
    { label: 'assertion budget unchanged (no new assertion)', command: process.execPath, args: ['scripts/check-assertion-budget.mjs'] },
    ...(targets.some((file) => /^packages\/web\/(server|bin)\//.test(file)) ? [{ label: 'server build (dist-node) and artifact check', command: 'bun', args: ['run', 'build:server'], cwd: path.join(ROOT, 'packages/web') }] : []),
    ...(args.includes('--test') ? testSteps(targets) : []),
  ];
  const [checks, rest] = [steps.slice(0, steps.findIndex((step) => step.label.startsWith('runtime parity')) + 1), steps.slice(steps.findIndex((step) => step.label.startsWith('runtime parity')) + 1)];
  for (const step of checks) {
    if (!run(step)) {
      revert();
      process.exit(1);
    }
  }
  const lintFailures = linted.length > 0 ? lintFailuresOf(linted) : [];
  if (lintFailures.length > 0) {
    const failed = new Set(lintFailures);
    const passing = moves.filter(([, to]) => !failed.has(to)).map(([from]) => from);
    fs.writeFileSync(`${listFile}.lint-pass`, `${passing.join('\n')}\n`);
    console.log(`[bulk] FAIL eslint: ${String(lintFailures.length)} of ${String(linted.length)} linted file(s)`);
    for (const file of lintFailures) console.log(`[bulk]   ${file}`);
    console.log(`[bulk] the ${String(passing.length)} other file(s) are in ${listFile}.lint-pass`);
    revert();
    process.exit(1);
  }
  console.log(`[bulk] ok   eslint on ${String(linted.length)} renamed file(s) in linted trees`);
  for (const step of rest) {
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
