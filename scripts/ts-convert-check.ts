#!/usr/bin/env node
// Checks JavaScript files converted to TypeScript by hand (Stage D).
//
// The gate a conversion must pass before it is committed, for files already
// renamed with `git mv` and then typed:
//   - every affected project type-checks strictly (errors in files you did not
//     convert mean the new types are narrower than an existing caller needs);
//   - runtime parity: the emitted JavaScript is identical to the original at
//     --rev (default HEAD);
//   - ESLint passes on the converted files (full output);
//   - the affected tests pass (the converted tests and the tests importing a
//     converted module, on the runner run-isolated-tests would pick);
//   - no ESLint directive comment in server TypeScript.
// It also lists every new type or non-null assertion, which the conversion
// must report with the invariant that justifies it; the reviewed budget
// (scripts/assertion-budget.json) is updated by whoever integrates, not here.
//
// Usage: node scripts/ts-convert-check.ts [--rev <git-rev>] [--no-test] <file.ts> [...]

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LINTED, run, testSteps, typecheckSteps } from './ts-bulk-convert.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** New assertions and directive comments the assertion budget reports for the given files. */
export const budgetFindings = (output: string, files: ReadonlySet<string>): { assertions: string[]; directives: string[] } => {
  const assertions: string[] = [];
  const directives: string[] = [];
  for (const line of output.split('\n')) {
    const assertion = /^\[assertion-budget\] new assertion \((\d+)\) in (\S+): (.*)$/.exec(line);
    if (assertion?.[2] !== undefined && files.has(assertion[2])) assertions.push(`${assertion[2]} (${assertion[1] ?? '?'}x): ${assertion[3] ?? ''}`);
    const directive = /^\[assertion-budget\] ESLint directive comment in (\S+): (.*)$/.exec(line);
    if (directive?.[1] !== undefined) directives.push(`${directive[1]}: ${directive[2] ?? ''}`);
  }
  return { assertions, directives };
};

const main = (): void => {
  const args = process.argv.slice(2);
  const revIndex = args.indexOf('--rev');
  const rev = revIndex === -1 ? 'HEAD' : args[revIndex + 1];
  if (rev === undefined) throw new Error('--rev needs a revision');
  const files = args.filter((arg, index) => !arg.startsWith('--') && (revIndex === -1 || (index !== revIndex && index !== revIndex + 1)));
  if (files.length === 0) throw new Error('usage: node scripts/ts-convert-check.ts [--rev <rev>] [--no-test] <file.ts> [...]');
  let ok = true;
  for (const step of typecheckSteps(files)) ok = run(step, 400) && ok;
  ok = run({ label: `runtime parity (${String(files.length)} file(s) against ${rev})`, command: process.execPath, args: ['scripts/ts-parity.ts', '--rev', rev, ...files] }, 400) && ok;
  const linted = files.filter((file) => LINTED.test(file));
  if (linted.length > 0) ok = run({ label: `eslint on ${String(linted.length)} file(s)`, command: 'bunx', args: ['eslint', '--config', 'eslint.config.js', ...linted] }, 400) && ok;
  const budget = spawnSync(process.execPath, ['scripts/check-assertion-budget.mjs'], { cwd: ROOT, encoding: 'utf8' });
  const findings = budgetFindings(`${budget.stdout}${budget.stderr}`, new Set(files));
  for (const directive of findings.directives) console.log(`[convert-check] FAIL ESLint directive comment: ${directive}`);
  if (findings.directives.length > 0) ok = false;
  console.log(`[convert-check] new assertions in these files: ${String(findings.assertions.length)} (report each with the invariant that justifies it)`);
  for (const assertion of findings.assertions) console.log(`[convert-check]   ${assertion}`);
  if (!args.includes('--no-test')) for (const step of testSteps(files)) ok = run(step, 200) && ok;
  console.log(ok ? '[convert-check] PASS' : '[convert-check] FAIL');
  if (!ok) process.exit(1);
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
