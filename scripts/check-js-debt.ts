#!/usr/bin/env node
// JavaScript debt gate.
//
// First-party code converges on TypeScript (docs/platform-toolchain.md, Stage
// D). Every handwritten .js/.jsx/.mjs/.cjs file that still exists is listed in
// scripts/js-debt-baseline.json. This gate fails when
// - a handwritten JavaScript file appears that is not in the baseline,
// - a baseline entry no longer exists (shrink it: `--update`), or
// - a JavaScript file matches none of the classification rules below.
// So the baseline only shrinks, and reaches zero at the end of Stage D.
//
// Files are those git knows: tracked, plus untracked files that are not
// ignored. Build output (dist, dist-node, node_modules) is ignored by git and
// never counted. Generated and vendored JavaScript is not debt; each exclusion
// below names what produces it.
//
// Usage: node scripts/check-js-debt.ts [--update] [--report <file.md>]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export type Category = 'server' | 'cli' | 'electron' | 'tooling' | 'test' | 'config' | 'generated' | 'vendor';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, 'scripts/js-debt-baseline.json');
const JS_FILE = /\.(js|jsx|mjs|cjs)$/;
const SOURCE_FILE = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/;
const DEBT: ReadonlySet<Category> = new Set<Category>(['server', 'cli', 'electron', 'tooling', 'test', 'config']);

interface Exclusion {
  pattern: RegExp;
  reason: string;
}

/** Not debt: produced by a generator. */
export const GENERATED: readonly Exclusion[] = [
  {
    pattern: /^packages\/sdk\/examples\/.+\.js$/,
    reason: 'bundled from the .ts beside it by packages/sdk/scripts/bundle-guest.ts; packages/sdk/scripts/examples.test.ts rebuilds and compares every bundle',
  },
];

/** Not debt: third-party code kept in the repository. None today. */
export const VENDOR: readonly Exclusion[] = [];

/** The category of a repository-relative path, or null when no rule covers it. */
export const classify = (file: string): Category | null => {
  if (GENERATED.some((rule) => rule.pattern.test(file))) return 'generated';
  if (VENDOR.some((rule) => rule.pattern.test(file))) return 'vendor';
  if (/\.(test|spec|bench)\.[cm]?jsx?$/.test(file) || /(^|\/)(__tests__|test|tests)\//.test(file) || /\.browser\.mjs$/.test(file)) return 'test';
  if (/(^|\/)[^/]*\.config\.[cm]?js$/.test(file)) return 'config';
  if (file.startsWith('packages/web/bin/')) return 'cli';
  if (/^packages\/electron\/(?!scripts\/)/.test(file)) return 'electron';
  if (file.startsWith('scripts/') || /^packages\/[^/]+\/scripts\//.test(file) || !file.includes('/')) return 'tooling';
  if (file.startsWith('packages/web/server/')) return 'server';
  return null;
};

export const lineCount = (text: string): number => {
  if (text.length === 0) return 0;
  const newlines = text.split('\n').length - 1;
  return text.endsWith('\n') ? newlines : newlines + 1;
};

const gitFiles = (): string[] => execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter((file) => file.length > 0 && fs.existsSync(path.join(ROOT, file)));

/** Repository-relative targets of a file's relative imports, resolved against the known source files. */
const resolveImports = (file: string, text: string, known: ReadonlySet<string>): string[] => {
  const targets: string[] = [];
  for (const { fileName: specifier } of ts.preProcessFile(text, true, true).importedFiles) {
    if (!specifier.startsWith('.')) continue;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    const stem = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
    const candidates = [base, ...['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'].map((ext) => stem + ext), `${base}/index.js`, `${base}/index.ts`];
    const hit = candidates.find((candidate) => known.has(candidate));
    if (hit !== undefined) targets.push(hit);
  }
  return targets;
};

export interface Entry {
  file: string;
  category: Category | null;
  lines: number;
  importers: number;
  importsFirstPartyJs: boolean;
  runtime: string;
  risk: 'low' | 'medium' | 'high';
  wave: string;
}

const testRunner = (text: string): string => {
  if (/['"]vitest['"]/.test(text)) return 'vitest (Node)';
  if (/['"]bun:test['"]/.test(text)) return 'bun test';
  if (/['"]node:test['"]/.test(text)) return 'node --test';
  if (/playwright|puppeteer/.test(text)) return 'browser harness';
  return 'test helper';
};

const RUNTIME: Record<Category, string> = {
  server: 'Node/Bun via dist-node (Bun runs source in dev)',
  cli: 'Node/Bun via dist-node/bin',
  electron: 'Electron main/preload (Node 24)',
  tooling: 'Node/Bun script',
  test: '',
  config: 'loaded by its tool',
  generated: 'generated output',
  vendor: 'third-party',
};

const WAVE: Record<Category, string> = { server: '', cli: 'D4', electron: 'D5', tooling: 'D6', test: 'D7', config: 'D8', generated: '-', vendor: '-' };

/** Relative import edges between first-party source files: importer -> resolved targets. */
export const importEdges = (): Map<string, string[]> => {
  const sources = gitFiles().filter((file) => SOURCE_FILE.test(file));
  const known = new Set(sources);
  return new Map(sources.map((file) => [file, [...new Set(resolveImports(file, fs.readFileSync(path.join(ROOT, file), 'utf8'), known))]]));
};

export const inventory = (): Entry[] => {
  const files = gitFiles();
  const sources = files.filter((file) => SOURCE_FILE.test(file));
  const known = new Set(sources);
  const texts = new Map(sources.map((file) => [file, fs.readFileSync(path.join(ROOT, file), 'utf8')]));
  const importers = new Map<string, number>();
  const importsJs = new Map<string, boolean>();
  for (const file of sources) {
    const targets = resolveImports(file, texts.get(file) ?? '', known);
    for (const target of new Set(targets)) importers.set(target, (importers.get(target) ?? 0) + 1);
    importsJs.set(file, targets.some((target) => JS_FILE.test(target) && DEBT.has(classify(target) ?? 'generated')));
  }
  return sources.filter((file) => JS_FILE.test(file)).sort().map((file) => {
    const text = texts.get(file) ?? '';
    const category = classify(file);
    const lines = lineCount(text);
    const count = importers.get(file) ?? 0;
    const risk = lines >= 800 || count >= 10 ? 'high' : lines >= 250 || count >= 3 ? 'medium' : 'low';
    const leaf = !(importsJs.get(file) ?? false);
    const wave = category === null ? '?' : category === 'server' ? (risk === 'high' ? 'D3' : leaf ? 'D1' : 'D2') : WAVE[category];
    const runtime = category === null ? '?' : category === 'test' ? testRunner(text) : RUNTIME[category];
    return { file, category, lines, importers: count, importsFirstPartyJs: !leaf, runtime, risk, wave };
  });
};

export const compare = (baseline: Readonly<Record<string, number>>, debt: readonly Entry[]): { added: string[]; stale: string[] } => {
  const present = new Set(debt.map((entry) => entry.file));
  return {
    added: debt.filter((entry) => !(entry.file in baseline)).map((entry) => entry.file),
    stale: Object.keys(baseline).filter((file) => !present.has(file)),
  };
};

const summaryLine = (debt: readonly Entry[]): string => `Handwritten JS: ${String(debt.length)} files / ${String(debt.reduce((sum, entry) => sum + entry.lines, 0))} lines`;

const report = (entries: readonly Entry[]): string => {
  const debt = entries.filter((entry) => entry.category !== null && DEBT.has(entry.category));
  const group = (key: (entry: Entry) => string): string[] => {
    const totals = new Map<string, { files: number; lines: number }>();
    for (const entry of debt) {
      const k = key(entry);
      const t = totals.get(k) ?? { files: 0, lines: 0 };
      totals.set(k, { files: t.files + 1, lines: t.lines + entry.lines });
    }
    return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([k, t]) => `| ${k} | ${String(t.files)} | ${String(t.lines)} |`);
  };
  const excluded = entries.filter((entry) => entry.category === 'generated' || entry.category === 'vendor');
  return [
    '# Stage D: handwritten JavaScript inventory',
    '',
    'Generated by `node scripts/check-js-debt.ts --report docs/stage-d-js-inventory.md`; do not edit by hand.',
    '',
    `${summaryLine(debt)} (not counted: ${String(excluded.length)} generated/vendored).`,
    '',
    '| Category | Files | Lines |',
    '|---|---|---|',
    ...group((entry) => entry.category ?? '?'),
    '',
    '| Wave | Files | Lines |',
    '|---|---|---|',
    ...group((entry) => entry.wave),
    '',
    'Waves: D1 server leaves (import no first-party JS), D2 server services/domain, D3 high-risk server (>= 800 lines or >= 10 importers), D4 CLI, D5 Electron, D6 build/repository scripts, D7 tests/helpers, D8 configuration. Risk: high >= 800 lines or >= 10 importers; medium >= 250 lines or >= 3 importers. Importers: first-party files that import the file (TypeScript import scan).',
    '',
    '| Path | Category | Lines | Importers | Runtime | Risk | Wave |',
    '|---|---|---|---|---|---|---|',
    ...debt.map((entry) => `| \`${entry.file}\` | ${entry.category ?? '?'} | ${String(entry.lines)} | ${String(entry.importers)} | ${entry.runtime} | ${entry.risk} | ${entry.wave} |`),
    '',
    '## Not counted',
    '',
    ...[...GENERATED, ...VENDOR].map((rule) => `- \`${rule.pattern.source}\` (${String(excluded.filter((entry) => rule.pattern.test(entry.file)).length)} files): ${rule.reason}`),
    '',
  ].join('\n');
};

const main = (): void => {
  const entries = inventory();
  const unclassified = entries.filter((entry) => entry.category === null);
  const debt = entries.filter((entry) => entry.category !== null && DEBT.has(entry.category));
  const reportIndex = process.argv.indexOf('--report');
  if (reportIndex !== -1) {
    const target = process.argv[reportIndex + 1];
    if (target === undefined) throw new Error('--report needs a file');
    fs.writeFileSync(path.join(ROOT, target), report(entries));
    console.log(`[js-debt] report written: ${target}`);
  }
  for (const entry of unclassified) console.error(`[js-debt] unclassified JavaScript: ${entry.file} (add a rule in scripts/check-js-debt.ts)`);
  if (process.argv.includes('--update')) {
    if (unclassified.length > 0) process.exit(1);
    const baseline = Object.fromEntries(debt.map((entry) => [entry.file, entry.lines]));
    fs.writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`[js-debt] baseline rewritten. ${summaryLine(debt)}`);
    return;
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const baseline: Record<string, number> = {};
  if (typeof parsed === 'object' && parsed !== null) {
    for (const [file, lines] of Object.entries(parsed)) if (typeof lines === 'number') baseline[file] = lines;
  }
  const { added, stale } = compare(baseline, debt);
  for (const file of added) console.error(`[js-debt] new handwritten JavaScript: ${file} (write it in TypeScript)`);
  for (const file of stale) console.error(`[js-debt] listed but gone: ${file} (shrink the baseline: node scripts/check-js-debt.ts --update)`);
  console.log(`[js-debt] ${summaryLine(debt)}`);
  if (added.length > 0 || stale.length > 0 || unclassified.length > 0) process.exit(1);
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
