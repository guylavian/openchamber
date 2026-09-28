#!/usr/bin/env node
// Migration lint budget (Stage D).
//
// Converting JavaScript to TypeScript must not change what the code does
// (runtime parity), but typed lint rules sometimes ask for exactly that: once
// `x` is typed `string`, no-unnecessary-type-conversion wants the JavaScript's
// own `String(x)` removed; no-floating-promises wants a `void` the JavaScript
// never had. During Stage D parity wins. Such a violation is recorded here,
// reviewed, instead of being fixed, suppressed inline or turned off globally.
//
// scripts/migration-lint-budget.json holds:
//   eligibleRules: rule -> why satisfying it changes the emitted JavaScript.
//     Only these rules can be budgeted; any other violation (no-unsafe-*,
//     no-explicit-any, ...) is fixed with types, never recorded.
//   entries: file -> [{ rule, text, count, reason }], `text` being the
//     normalised source line of the violation (its range when multi-line).
// The gate fails on any unbudgeted or ineligible violation, on an entry that
// no longer occurs (the budget only shrinks), and on any ESLint directive
// comment. Cleaning up the recorded expressions is separate work after Stage D.
//
// Usage:
//   node scripts/check-migration-lint-budget.ts             lint packages/web/server and check
//   node scripts/check-migration-lint-budget.ts --files a.ts b.ts
//                                                           check only these files (no stale check elsewhere)
//   node scripts/check-migration-lint-budget.ts --update [--reasons r.json] [--files ...]
//       rewrite the entries for the linted files from what lint finds now; a new entry
//       needs its reason in r.json ([{ file, rule, text, reason }]).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

import { eslintDirectivesIn } from './check-assertion-budget.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET = path.join(ROOT, 'scripts/migration-lint-budget.json');
const SCOPE = 'packages/web/server';

export interface Entry { rule: string; text: string; count: number; reason: string }
export interface Budget { eligibleRules: Record<string, string>; entries: Record<string, Entry[]> }
export interface Violation { file: string; rule: string; text: string; line: number; message: string }
export interface Reason { file: string; rule: string; text: string; reason: string }

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * The identity of a violation: the normalised source line it is on (a rule
 * often reports only a callee such as `String`, too short to tell calls
 * apart), or its whole range when that spans several lines.
 */
export const textAt = (source: string, line: number, column: number, endLine?: number, endColumn?: number): string => {
  const lines = source.split('\n');
  if (endLine === undefined || endColumn === undefined || endLine === line) return squash(lines[line - 1] ?? '');
  const parts = [(lines[line - 1] ?? '').slice(column - 1), ...lines.slice(line, endLine - 1), (lines[endLine - 1] ?? '').slice(0, endColumn - 1)];
  return squash(parts.join('\n'));
};

const key = (file: string, rule: string, text: string): string => `${file}\u0000${rule}\u0000${text}`;

/** Budget comparison for the linted files: violations beyond the budget, ineligible ones, and stale entries. */
export const compare = (budget: Budget, violations: readonly Violation[], lintedFiles: ReadonlySet<string>): { unbudgeted: Violation[]; ineligible: Violation[]; stale: { file: string; entry: Entry; missing: number }[] } => {
  const ineligible = violations.filter((v) => !(v.rule in budget.eligibleRules));
  const counts = new Map<string, Violation[]>();
  for (const v of violations.filter((x) => x.rule in budget.eligibleRules)) counts.set(key(v.file, v.rule, v.text), [...(counts.get(key(v.file, v.rule, v.text)) ?? []), v]);
  const unbudgeted: Violation[] = [];
  const stale: { file: string; entry: Entry; missing: number }[] = [];
  const allowed = new Map<string, Entry>();
  for (const [file, entries] of Object.entries(budget.entries)) for (const entry of entries) allowed.set(key(file, entry.rule, entry.text), entry);
  for (const [k, found] of counts) {
    const entry = allowed.get(k);
    const extra = found.length - (entry?.count ?? 0);
    if (extra > 0) unbudgeted.push(...found.slice(found.length - extra));
  }
  for (const [file, entries] of Object.entries(budget.entries)) {
    const exists = fs.existsSync(path.join(ROOT, file));
    if (exists && !lintedFiles.has(file)) continue;
    for (const entry of entries) {
      const missing = entry.count - (counts.get(key(file, entry.rule, entry.text))?.length ?? 0);
      if (missing > 0) stale.push({ file, entry, missing });
    }
  }
  return { unbudgeted, ineligible, stale };
};

/** Entries for the linted files rebuilt from the current eligible violations, keeping known reasons. */
export const rebuild = (budget: Budget, violations: readonly Violation[], lintedFiles: ReadonlySet<string>, reasons: readonly Reason[]): { budget: Budget; missingReasons: Violation[] } => {
  const known = new Map<string, string>();
  for (const [file, entries] of Object.entries(budget.entries)) for (const entry of entries) known.set(key(file, entry.rule, entry.text), entry.reason);
  for (const r of reasons) known.set(key(r.file, r.rule, squash(r.text)), r.reason);
  const entries: Record<string, Entry[]> = {};
  for (const [file, list] of Object.entries(budget.entries)) if (!lintedFiles.has(file) && fs.existsSync(path.join(ROOT, file))) entries[file] = list;
  const missingReasons: Violation[] = [];
  const grouped = new Map<string, Violation[]>();
  for (const v of violations.filter((x) => x.rule in budget.eligibleRules)) grouped.set(key(v.file, v.rule, v.text), [...(grouped.get(key(v.file, v.rule, v.text)) ?? []), v]);
  for (const [k, found] of grouped) {
    const first = found[0];
    if (first === undefined) continue;
    const reason = known.get(k);
    if (reason === undefined || reason.trim() === '') { missingReasons.push(first); continue; }
    entries[first.file] = [...(entries[first.file] ?? []), { rule: first.rule, text: first.text, count: found.length, reason }];
  }
  const sortedEntries = Object.fromEntries(Object.keys(entries).sort().map((file) => [file, (entries[file] ?? []).sort((a, b) => a.rule.localeCompare(b.rule) || a.text.localeCompare(b.text))]));
  return { budget: { eligibleRules: budget.eligibleRules, entries: sortedEntries }, missingReasons };
};

export const loadBudget = (): Budget => JSON.parse(fs.readFileSync(BUDGET, 'utf8')) as Budget;

/** Lint files (repo-relative paths or globs) with the repository config; every error, as a violation. */
export const lint = async (patterns: readonly string[]): Promise<{ violations: Violation[]; linted: Set<string>; fatal: string[] }> => {
  const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: path.join(ROOT, 'eslint.config.js'), errorOnUnmatchedPattern: false });
  const results = await eslint.lintFiles([...patterns]);
  const violations: Violation[] = [];
  const fatal: string[] = [];
  const linted = new Set<string>();
  for (const result of results) {
    const file = path.relative(ROOT, result.filePath).split(path.sep).join('/');
    linted.add(file);
    const source = fs.readFileSync(result.filePath, 'utf8');
    for (const message of result.messages) {
      if (message.severity !== 2) continue;
      if (message.ruleId === null) { fatal.push(`${file}:${String(message.line)}: ${message.message}`); continue; }
      violations.push({ file, rule: message.ruleId, text: textAt(source, message.line, message.column, message.endLine, message.endColumn), line: message.line, message: message.message });
    }
  }
  return { violations, linted, fatal };
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const filesIndex = args.indexOf('--files');
  const files = filesIndex === -1 ? [] : args.slice(filesIndex + 1).filter((a) => !a.startsWith('--'));
  const reasonsIndex = args.indexOf('--reasons');
  const reasonsFile = reasonsIndex === -1 ? undefined : args[reasonsIndex + 1];
  const patterns = files.length > 0 ? files : [`${SCOPE}/**/*.ts`];
  const { violations, linted, fatal } = await lint(patterns);
  const budget = loadBudget();
  let ok = true;
  for (const f of fatal) { console.error(`[migration-lint] parse error ${f}`); ok = false; }
  for (const file of linted) {
    for (const directive of eslintDirectivesIn(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
      console.error(`[migration-lint] ESLint directive comment in ${file}: ${directive} (not allowed)`);
      ok = false;
    }
  }
  if (args.includes('--update')) {
    const reasons = reasonsFile === undefined ? [] : JSON.parse(fs.readFileSync(reasonsFile, 'utf8')) as Reason[];
    const { ineligible } = compare(budget, violations, linted);
    for (const v of ineligible) { console.error(`[migration-lint] ${v.file}:${String(v.line)} ${v.rule} is not eligible for the budget: ${v.message}`); ok = false; }
    const { budget: next, missingReasons } = rebuild(budget, violations, linted, reasons);
    for (const v of missingReasons) { console.error(`[migration-lint] no reason given for ${v.file}:${String(v.line)} ${v.rule}: ${v.text}`); ok = false; }
    if (!ok) process.exit(1);
    fs.writeFileSync(BUDGET, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`[migration-lint] budget rewritten: ${String(Object.values(next.entries).flat().reduce((s, e) => s + e.count, 0))} entries`);
    return;
  }
  const { unbudgeted, ineligible, stale } = compare(budget, violations, linted);
  for (const v of ineligible) { console.error(`[migration-lint] ${v.file}:${String(v.line)} ${v.rule}: ${v.message}`); ok = false; }
  for (const v of unbudgeted) { console.error(`[migration-lint] not in budget ${v.file}:${String(v.line)} ${v.rule}: ${v.text} (${v.message})`); ok = false; }
  for (const s of stale) { console.error(`[migration-lint] listed but gone (${String(s.missing)}) in ${s.file}: ${s.entry.rule}: ${s.entry.text} (shrink: --update)`); ok = false; }
  const total = Object.values(budget.entries).flat().reduce((s, e) => s + e.count, 0);
  if (ok) console.log(`[migration-lint] ${String(linted.size)} files lint clean; ${String(total)} parity-preserving violations, all in the reviewed budget`);
  if (!ok) process.exit(1);
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
