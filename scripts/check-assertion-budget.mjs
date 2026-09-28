#!/usr/bin/env node
// Assertion budget for server and CLI TypeScript.
//
// `x!` and `x as T` are allowed by lint in packages/web/server only so that
// modules converted from JavaScript keep its runtime behaviour exactly (see the
// server block in eslint.config.js). They are not a style for new code: new
// code narrows, parses with a schema, or improves the API's types instead.
//
// This gate holds the reviewed set in scripts/assertion-budget.json, per file
// and per expression. A new assertion fails, and so does one that is gone but
// still listed, so the budget only shrinks. After a reviewed change, rewrite
// the baseline with `--update` and review its diff.
//
// It also fails on any ESLint directive comment (`eslint-disable`, `eslint
// rule: off`, ...) in server TypeScript. Lint already ignores them there
// (noInlineConfig), but only warns; here they are an error.
//
// Usage: node scripts/check-assertion-budget.mjs [--update]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Server and CLI TypeScript (tsconfig.server.json compiles both into dist-node).
const SCANNED = ['packages/web/server', 'packages/web/bin'];
const BASELINE = path.join(ROOT, 'scripts/assertion-budget.json');

/** Every non-null assertion and type assertion (other than `as const`) in one file, as normalised source text. */
export const assertionsIn = (fileName, text) => {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = [];
  const visit = (node) => {
    const isAssertion = ts.isNonNullExpression(node)
      || ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && !ts.isConstTypeReference(node.type));
    if (isAssertion) found.push(node.getText(source).replace(/\s+/g, ' '));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

/** ESLint directive comments in one file, found by the TypeScript scanner (comment tokens only). */
export const eslintDirectivesIn = (text) => {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const found = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const body = scanner.getTokenText().replace(/^\/\/|^\/\*|\*\/$/g, '').trim();
    if (/^(eslint(-disable(-next-line|-line)?|-enable|-env)?|global|globals)\b/.test(body)) found.push(body.split('\n')[0]);
  }
  return found;
};

/** Files under the scanned root with the ESLint directives they contain. */
export const scanDirectives = (root = ROOT) => {
  const directives = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        for (const directive of eslintDirectivesIn(fs.readFileSync(full, 'utf8'))) directives.push({ file: path.relative(root, full).split(path.sep).join('/'), directive });
      }
    }
  };
  for (const scanned of SCANNED) if (fs.existsSync(path.join(root, scanned))) walk(path.join(root, scanned));
  return directives;
};

/** { file: { expression: count } } for every server TypeScript file. */
export const scan = (root = ROOT) => {
  const budget = {};
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        const counts = {};
        for (const expression of assertionsIn(full, fs.readFileSync(full, 'utf8'))) counts[expression] = (counts[expression] ?? 0) + 1;
        if (Object.keys(counts).length > 0) budget[path.relative(root, full).split(path.sep).join('/')] = counts;
      }
    }
  };
  for (const scanned of SCANNED) if (fs.existsSync(path.join(root, scanned))) walk(path.join(root, scanned));
  return budget;
};

/** New assertions (over budget) and listed ones no longer present (stale). */
export const compare = (baseline, actual) => {
  const over = [];
  const stale = [];
  for (const file of new Set([...Object.keys(baseline), ...Object.keys(actual)])) {
    const allowed = baseline[file] ?? {};
    const present = actual[file] ?? {};
    for (const expression of new Set([...Object.keys(allowed), ...Object.keys(present)])) {
      const difference = (present[expression] ?? 0) - (allowed[expression] ?? 0);
      if (difference > 0) over.push({ file, expression, count: difference });
      if (difference < 0) stale.push({ file, expression, count: -difference });
    }
  }
  return { over, stale };
};

const sorted = (budget) => Object.fromEntries(Object.keys(budget).sort().map((file) => [
  file,
  Object.fromEntries(Object.keys(budget[file]).sort().map((expression) => [expression, budget[file][expression]])),
]));

const main = () => {
  const actual = scan();
  if (process.argv.includes('--update')) {
    fs.writeFileSync(BASELINE, `${JSON.stringify(sorted(actual), null, 2)}\n`);
    console.log(`[assertion-budget] baseline rewritten: ${path.relative(ROOT, BASELINE)}`);
    return;
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const { over, stale } = compare(baseline, actual);
  const directives = scanDirectives();
  for (const { file, directive } of directives) {
    console.error(`[assertion-budget] ESLint directive comment in ${file}: ${directive} (not allowed in server TypeScript)`);
  }
  for (const { file, expression, count } of over) {
    console.error(`[assertion-budget] new assertion (${count}) in ${file}: ${expression}`);
  }
  for (const { file, expression, count } of stale) {
    console.error(`[assertion-budget] listed but gone (${count}) in ${file}: ${expression}`);
  }
  if (over.length > 0) {
    console.error('[assertion-budget] New server TypeScript narrows, parses with a schema, or improves the types instead of asserting. A parity assertion from a JavaScript conversion is added only after review: `node scripts/check-assertion-budget.mjs --update`.');
  }
  if (stale.length > 0) console.error('[assertion-budget] Shrink the baseline: `node scripts/check-assertion-budget.mjs --update`.');
  if (over.length > 0 || stale.length > 0 || directives.length > 0) process.exit(1);
  const total = Object.values(actual).reduce((sum, counts) => sum + Object.values(counts).reduce((a, b) => a + b, 0), 0);
  console.log(`[assertion-budget] ${total} assertions, all in the reviewed baseline`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
