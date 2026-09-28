#!/usr/bin/env node
// Checks JavaScript files converted to TypeScript by hand (Stage D).
//
// The gate a conversion must pass before it is committed, for files already
// renamed with `git mv` and then typed:
//   - every affected project type-checks strictly (errors in files you did not
//     convert mean the new types are narrower than an existing caller needs);
//   - runtime parity: the emitted JavaScript is identical to the original at
//     --rev (default HEAD);
//   - lint: server files through the migration lint budget. A violation of an
//     eligible rule (one whose fix would change the JavaScript, e.g. removing
//     its own String(x)) is a candidate for the budget and must be reported
//     with its reason; any other violation fails. Other linted trees must be
//     clean;
//   - no `any`, `as unknown`, double assertion, `<T>x` cast, `Function` type,
//     or @ts-*/ESLint directive comment, whatever the file's lint coverage;
//   - the affected tests pass (on the runner run-isolated-tests would pick).
// It lists every type or non-null assertion in the converted files, which the
// conversion must report with the invariant that justifies it. The reviewed
// budgets are updated only when the conversion is integrated.
//
// Usage: node scripts/ts-convert-check.ts [--rev <git-rev>] [--no-test] [--report-skeleton <out.json>] <file.ts> [...]
//   --report-skeleton writes { assertions: [{ file, expression, invariant: "" }], lint: [{ file, rule, text, reason: "" }] }
//   for the conversion to fill in.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { assertionsIn, eslintDirectivesIn } from './check-assertion-budget.mjs';
import { compare, lint, loadBudget } from './check-migration-lint-budget.ts';
import { LINTED, run, testSteps, typecheckSteps } from './ts-bulk-convert.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUDGETED = /^packages\/web\/server\//;

const unwrap = (node: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node);

/** Syntax a conversion must not contain, with line numbers. */
export const forbiddenIn = (fileName: string, text: string): string[] => {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const at = (node: ts.Node): string => String(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) found.push(`line ${at(node)}: any`);
    if (ts.isAsExpression(node)) {
      if (node.type.kind === ts.SyntaxKind.UnknownKeyword) found.push(`line ${at(node)}: as unknown`);
      if (ts.isAsExpression(unwrap(node.expression)) || ts.isTypeAssertionExpression(unwrap(node.expression))) found.push(`line ${at(node)}: double assertion`);
    }
    if (ts.isTypeAssertionExpression(node)) found.push(`line ${at(node)}: <T>x cast`);
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === 'Function') found.push(`line ${at(node)}: Function type`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (/@ts-(ignore|expect-error|nocheck)\b/.test(text)) found.push('@ts-ignore / @ts-expect-error / @ts-nocheck comment');
  for (const directive of eslintDirectivesIn(text)) found.push(`ESLint directive comment: ${directive}`);
  return found;
};

interface Skeleton {
  assertions: { file: string; expression: string; invariant: string }[];
  lint: { file: string; rule: string; text: string; reason: string }[];
}

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const valueOf = (flag: string): string | undefined => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };
  const rev = valueOf('--rev') ?? 'HEAD';
  const skeletonPath = valueOf('--report-skeleton');
  const flagValues = new Set([valueOf('--rev'), skeletonPath]);
  const files = args.filter((arg) => !arg.startsWith('--') && !flagValues.has(arg));
  if (files.length === 0) throw new Error('usage: node scripts/ts-convert-check.ts [--rev <rev>] [--no-test] [--report-skeleton <out.json>] <file.ts> [...]');
  let ok = true;
  const skeleton: Skeleton = { assertions: [], lint: [] };

  for (const file of files) {
    for (const problem of forbiddenIn(file, fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
      console.log(`[convert-check] FAIL forbidden in ${file}: ${problem}`);
      ok = false;
    }
  }
  for (const step of typecheckSteps(files)) ok = run(step, 400) && ok;
  ok = run({ label: `runtime parity (${String(files.length)} file(s) against ${rev})`, command: process.execPath, args: ['scripts/ts-parity.ts', '--rev', rev, ...files] }, 400) && ok;

  const linted = files.filter((file) => LINTED.test(file));
  if (linted.length > 0) {
    const { violations, linted: lintedSet, fatal } = await lint(linted);
    const { unbudgeted, ineligible } = compare(loadBudget(), violations, lintedSet);
    const failing = [...ineligible, ...unbudgeted.filter((v) => !BUDGETED.test(v.file))];
    const candidates = unbudgeted.filter((v) => BUDGETED.test(v.file));
    for (const f of fatal) console.log(`[convert-check] FAIL parse error ${f}`);
    for (const v of failing) console.log(`[convert-check] FAIL lint ${v.file}:${String(v.line)} ${v.rule}: ${v.message}`);
    if (fatal.length > 0 || failing.length > 0) ok = false;
    else console.log(`[bulk] ok   lint on ${String(linted.length)} file(s)${candidates.length > 0 ? ` (${String(candidates.length)} migration-lint candidate(s) to report)` : ''}`);
    for (const v of candidates) {
      console.log(`[convert-check]   migration-lint candidate ${v.file}:${String(v.line)} ${v.rule}: ${v.text}`);
      skeleton.lint.push({ file: v.file, rule: v.rule, text: v.text, reason: '' });
    }
  }

  let assertionCount = 0;
  for (const file of files) {
    const counts = new Map<string, number>();
    for (const expression of assertionsIn(file, fs.readFileSync(path.join(ROOT, file), 'utf8'))) counts.set(expression, (counts.get(expression) ?? 0) + 1);
    for (const [expression, count] of counts) {
      assertionCount += count;
      console.log(`[convert-check]   assertion ${file}${count > 1 ? ` (x${String(count)})` : ''}: ${expression}`);
      skeleton.assertions.push({ file, expression, invariant: '' });
    }
  }
  console.log(`[convert-check] assertions in these files: ${String(assertionCount)} (report each with the invariant that justifies it)`);

  if (!args.includes('--no-test')) for (const step of testSteps(files)) ok = run(step, 200) && ok;
  if (skeletonPath !== undefined) fs.writeFileSync(skeletonPath, `${JSON.stringify(skeleton, null, 2)}\n`);
  console.log(ok ? '[convert-check] PASS' : '[convert-check] FAIL');
  if (!ok) process.exit(1);
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
