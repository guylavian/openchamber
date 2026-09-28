#!/usr/bin/env node
// TypeScript convertibility census (Stage D).
//
// Checks every handwritten JavaScript file in the JS-debt baseline as if it
// alone had been renamed to TypeScript, without touching the working tree: a
// compiler host presents `x.js` as `x.ts` (`.mjs` -> `.ts`, `.cjs` -> `.cts`,
// `.jsx` -> `.tsx`, and `.js` holding JSX -> `.tsx`) with the same text and
// hides the original, so imports that name `./x.js` resolve to the renamed
// file exactly as they would after `git mv`. Each file is checked under the
// compiler options of the project that would own it, with strict on.
//
// Every file gets a grade:
//   A  zero-touch: no diagnostic, same emitted JavaScript, no boundary
//   B  mechanical: only diagnostics in the MECHANICAL set (annotation-only fixes)
//   C  boundary: a .d.ts sidecar, an importer in another package, a runtime
//      path reference (manifest, workflow, spawn), Electron main/preload run
//      from source, a configuration file, a test the isolated runner would
//      drop or move from node:test to bun test, or a module Node runs from
//      source that other files import (Node does not map ./x.js to x.ts, so
//      each importer's specifier must change)
//   D  semantic: any other diagnostic, or the emitted JavaScript would change
//
// Usage: node scripts/ts-census.ts [--json <file>] [--report <file.md>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { importEdges, inventory } from './check-js-debt.ts';
import type { Category, Entry } from './check-js-debt.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const abs = (file: string): string => path.join(ROOT, file);
const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');

/** Diagnostics a rename leaves that are fixed by annotating, without deciding anything about behaviour. */
export const MECHANICAL: ReadonlyMap<number, string> = new Map([
  [7006, 'parameter implicitly any'],
  [7031, 'binding element implicitly any'],
  [7019, 'rest parameter implicitly any'],
  [7034, 'variable implicitly any (some locations)'],
  [7005, 'variable implicitly any'],
  [7008, 'member implicitly any'],
  [7018, 'object literal property implicitly any'],
  [7010, 'function lacks return type (implicit any)'],
  [7023, 'recursive function implicitly any return'],
  [7022, 'variable implicitly any (circular initializer)'],
  [2307, 'module not found (e.g. bun:test types not installed)'],
  [7016, 'untyped module (no declaration file)'],
]);

type Grade = 'A' | 'B' | 'C' | 'D';

export interface CensusEntry {
  file: string;
  category: Category | null;
  lines: number;
  grade: Grade;
  renamedTo: string;
  diagnostics: Record<string, number>;
  /** The same diagnostics grouped by recurring pattern (see patternOf). */
  patterns: Record<string, number>;
  boundaries: string[];
  emitChanges: boolean;
  /** After TypeScript's inferFromUsage codefix, applied in memory (only with --infer). */
  inferred?: { diagnostics: Record<string, number>; anyInserted: number; grade: Grade };
}

const IMPLICIT_ANY = new Set([7006, 7031, 7019, 7034, 7005, 7008, 7018]);

/** A recurring-pattern key for one diagnostic, from its code, message and the node it sits on. */
export const patternOf = (diagnostic: ts.Diagnostic, sourceFile: ts.SourceFile): string => {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
  const code = diagnostic.code;
  const start = diagnostic.start ?? 0;
  let token: ts.Node = sourceFile;
  const visit = (node: ts.Node): void => {
    if (start >= node.getStart(sourceFile) && start < node.getEnd()) {
      token = node;
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(sourceFile, visit);
  const inCatch = (): boolean => {
    let node: ts.Node | undefined = token;
    while (node !== undefined && !ts.isSourceFile(node)) {
      if (ts.isCatchClause(node)) return true;
      if (ts.isIdentifier(node) && ts.isBlock(node.parent)) break;
      node = node.parent;
    }
    const symbolName = token.getText(sourceFile);
    return /^(err|error|e|cause|failure|reason)$/.test(symbolName);
  };
  if (code === 7006) return 'implicit any: parameter';
  if (code === 7031) return 'implicit any: destructured parameter';
  if (code === 7019) return 'implicit any: rest parameter';
  if (code === 7005 || code === 7034) return 'implicit any: variable';
  if (code === 7008 || code === 7018) return 'implicit any: member/property';
  if (code === 18046) return inCatch() ? 'catch variable is unknown' : 'unknown value used';
  if (code === 2307) return /bun:test/.test(message) ? 'bun:test types not installed' : 'module not found';
  if (code === 7016) return 'untyped third-party module';
  if (code === 7053) return 'dynamic key index (implicit any)';
  if (code === 2554 || code === 2555) return 'call omits parameters the JS treats as optional';
  if (code === 2532 || code === 18048 || code === 2531 || code === 18047 || code === 2722) return 'possibly null/undefined';
  if (code === 2339) {
    if (/on type '\{\}'/.test(message)) return 'property on object built from {}';
    if (/on type 'never'/.test(message)) return 'property on never (narrowing)';
    if (/process\.env|ProcessEnv/.test(message)) return 'process.env property';
    if (/on type 'Error'/.test(message)) return 'custom property on Error';
    return 'property not in inferred type';
  }
  if (code === 2345 || code === 2322) {
    if (/undefined/.test(message)) return 'argument/assignment possibly undefined';
    if (/'never\[\]'|never/.test(message)) return 'empty array literal inferred never[]';
    return 'argument/assignment type mismatch';
  }
  if (code === 2353) return 'excess property in object literal';
  if (code === 2794) return 'Promise resolve() without value';
  if (code === 2740 || code === 2739) return 'missing properties (structural)';
  if (code === 2769) return 'no matching overload';
  return `TS${String(code)}`;
};

const JSX_HINT = /<\/[A-Za-z][\w.]*>|\/>/;
export const renamed = (file: string, text: string): string => {
  if (file.endsWith('.jsx')) return file.replace(/\.jsx$/, '.tsx');
  // Every package that holds .mjs is "type": "module", so .ts keeps it ESM (and
  // matches the test runners' patterns, which do not list .mts).
  if (file.endsWith('.mjs')) return file.replace(/\.mjs$/, JSX_HINT.test(text) && /\breturn\s*\(?\s*</.test(text) ? '.tsx' : '.ts');
  if (file.endsWith('.cjs')) return file.replace(/\.cjs$/, '.cts');
  return file.replace(/\.js$/, JSX_HINT.test(text) && /\breturn\s*\(?\s*</.test(text) ? '.tsx' : '.ts');
};

/** The project whose options would check a file once converted. */
const contextOf = (file: string): string => {
  if (/^packages\/web\/(server|bin)\//.test(file)) return 'packages/web/tsconfig.server.json';
  if (file.startsWith('packages/ui/')) return 'packages/ui/tsconfig.json';
  if (file.startsWith('packages/vscode/')) return 'packages/vscode/tsconfig.json';
  if (file.startsWith('packages/electron/')) return 'packages/electron/tsconfig.json';
  return 'node-strict';
};

const NODE_STRICT: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  types: ['node', 'bun-types/test'],
  skipLibCheck: true,
  noEmit: true,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  // Node runs these from source by stripping types: only erasable syntax, and
  // type-only imports written as such.
  verbatimModuleSyntax: true,
  erasableSyntaxOnly: true,
  // As in the server project: JavaScript not converted yet is imported with its inferred types, not checked.
  allowJs: true,
  checkJs: false,
};

/** Run by Node (or Electron) straight from source, not compiled or bundled first. */
export const NODE_RUN = /^(scripts\/|packages\/[^/]+\/scripts\/|packages\/electron\/)/;

const optionsFor = (context: string): ts.CompilerOptions => {
  if (context === 'node-strict') return NODE_STRICT;
  const configPath = abs(context);
  const read = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
  // The project's own allowJs: a converted file keeps importing JavaScript that is not converted yet.
  return { ...parsed.options, strict: true, noEmit: true, skipLibCheck: true, checkJs: false };
};

const emitOf = (text: string, fileName: string): string => ts.transpileModule(text, {
  fileName,
  reportDiagnostics: false,
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.Preserve, jsx: ts.JsxEmit.Preserve, removeComments: true, verbatimModuleSyntax: true, allowJs: true },
}).outputText;

/**
 * Files loaded by path rather than imported: a path token (in a manifest,
 * workflow, Dockerfile, shell script or source string) that resolves exactly
 * to the file, relative to the referencing file, its package root or the
 * repository root. Import specifiers are module edges, not path references.
 */
const pathReferences = (debt: readonly Entry[]): Map<string, string[]> => {
  const targets = new Set(debt.map((entry) => entry.file));
  const refs = new Map<string, string[]>();
  const haystacks = [
    ...Object.keys(JSON.parse(fs.readFileSync(abs('scripts/js-debt-baseline.json'), 'utf8')) as Record<string, number>),
    'package.json', 'Dockerfile',
    ...fs.readdirSync(abs('packages')).map((p) => `packages/${p}/package.json`),
    ...fs.readdirSync(abs('.github/workflows')).map((w) => `.github/workflows/${w}`),
    ...fs.readdirSync(abs('scripts')).filter((f) => f.endsWith('.sh')).map((f) => `scripts/${f}`),
  ].filter((file) => fs.existsSync(abs(file)));
  for (const file of haystacks) {
    const text = fs.readFileSync(abs(file), 'utf8');
    const imported = new Set(/\.[cm]?[jt]sx?$/.test(file) ? ts.preProcessFile(text, true, true).importedFiles.map((i) => i.fileName) : []);
    const packageRoot = file.startsWith('packages/') ? file.split('/').slice(0, 2).join('/') : '.';
    for (const match of text.matchAll(/[\w@./-]+\.[cm]?jsx?\b/g)) {
      const token = match[0];
      if (imported.has(token)) continue;
      const bases = [path.posix.dirname(file), packageRoot, '.'];
      for (const base of bases) {
        const candidate = path.posix.normalize(path.posix.join(base, token.replace(/^\/+/, '')));
        if (candidate !== file && targets.has(candidate)) {
          refs.set(candidate, [...new Set([...(refs.get(candidate) ?? []), file])]);
          break;
        }
      }
    }
  }
  return refs;
};

// scripts/run-isolated-tests.mjs (root scripts, sdk, ui, electron, vscode) finds
// tests by this pattern and runs every TypeScript test with `bun test`.
const ISOLATED_TEST_FILE = /\.(test|spec)\.(js|cjs|mjs|jsx|ts|tsx)$/;

/** Why renaming a test run by the isolated runner would drop it or change its runner, or null. */
export const isolatedRunnerBoundary = (file: string, target: string, text: string): string | null => {
  if (file.startsWith('packages/web/') || !ISOLATED_TEST_FILE.test(file)) return null;
  if (!ISOLATED_TEST_FILE.test(target)) return `the isolated test runner does not find ${path.posix.extname(target)}`;
  if (/(?:from\s+|require\(\s*)['"]node:test['"]/.test(text)) return 'node:test file would move to bun test (isolated runner)';
  return null;
};

/**
 * Splits files into sets with no import edge inside a set (greedy colouring,
 * most-connected first), so that checking one set as TypeScript leaves every
 * import of each renamed file as the JavaScript it will still be after a
 * single `git mv`.
 */
export const independentSets = (files: readonly string[], edges: ReadonlyMap<string, readonly string[]>): string[][] => {
  const inSet = new Set(files);
  const adjacent = new Map<string, Set<string>>(files.map((file) => [file, new Set<string>()]));
  for (const [importer, targets] of edges) {
    for (const target of targets) {
      if (importer !== target && inSet.has(importer) && inSet.has(target)) {
        adjacent.get(importer)?.add(target);
        adjacent.get(target)?.add(importer);
      }
    }
  }
  const colour = new Map<string, number>();
  const sets: string[][] = [];
  const order = [...files].sort((a, b) => (adjacent.get(b)?.size ?? 0) - (adjacent.get(a)?.size ?? 0) || a.localeCompare(b));
  for (const file of order) {
    const taken = new Set([...(adjacent.get(file) ?? [])].map((other) => colour.get(other)));
    let index = 0;
    while (taken.has(index)) index += 1;
    colour.set(file, index);
    (sets[index] ??= []).push(file);
  }
  return sets;
};

const packageOf = (file: string): string => (file.startsWith('packages/') ? file.split('/').slice(0, 2).join('/') : '.');

export const census = (infer = false): CensusEntry[] => {
  const entries = inventory();
  const debt = entries.filter((entry) => entry.category !== null && entry.category !== 'generated' && entry.category !== 'vendor');
  const texts = new Map(debt.map((entry) => [entry.file, fs.readFileSync(abs(entry.file), 'utf8')]));
  // The files presented as TypeScript in the program being checked (one independent set at a time).
  let virtualToReal = new Map<string, string>();
  let hidden = new Set<string>();
  const refs = pathReferences(debt);
  const crossPackage = new Map<string, string[]>();
  const debtFiles = new Set(debt.map((entry) => entry.file));
  const edges = importEdges();
  const importedBy = new Map<string, string[]>();
  for (const [importer, targets] of edges) {
    for (const target of targets) {
      importedBy.set(target, [...(importedBy.get(target) ?? []), importer]);
      if (debtFiles.has(target) && packageOf(importer) !== packageOf(target)) crossPackage.set(target, [...(crossPackage.get(target) ?? []), importer]);
    }
  }
  const byContext = new Map<string, Entry[]>();
  for (const entry of debt) byContext.set(contextOf(entry.file), [...(byContext.get(contextOf(entry.file)) ?? []), entry]);

  const results: CensusEntry[] = [];
  for (const [context, files] of byContext) {
    const options = optionsFor(context);
    const host = ts.createCompilerHost(options, true);
    const originalRead = host.readFile.bind(host);
    const originalExists = host.fileExists.bind(host);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    const parsed = new Map<string, ts.SourceFile | undefined>();
    host.fileExists = (file) => virtualToReal.has(file) || (!hidden.has(file) && originalExists(file));
    host.readFile = (file) => {
      const real = virtualToReal.get(file);
      if (real !== undefined) return originalRead(real);
      return hidden.has(file) ? undefined : originalRead(file);
    };
    host.getSourceFile = (file, language, onError, create) => {
      const real = virtualToReal.get(file);
      if (real === undefined) {
        if (hidden.has(file)) return undefined;
        if (!parsed.has(file)) parsed.set(file, originalGetSourceFile(file, language, onError, create));
        return parsed.get(file);
      }
      const text = originalRead(real);
      return text === undefined ? undefined : ts.createSourceFile(file, text, language, true);
    };
    const byFile = new Map(files.map((entry) => [entry.file, entry]));
    for (const set of independentSets(files.map((entry) => entry.file), edges)) {
      const setEntries = set.map((file) => byFile.get(file)).filter((entry) => entry !== undefined);
      virtualToReal = new Map(setEntries.map((entry) => [abs(renamed(entry.file, texts.get(entry.file) ?? '')), abs(entry.file)]));
      hidden = new Set(setEntries.map((entry) => abs(entry.file)));
      const roots = [...virtualToReal.keys()];
      const program = ts.createProgram({ rootNames: roots, options, host });
      for (const entry of setEntries) {
        const virtual = abs(renamed(entry.file, texts.get(entry.file) ?? ''));
        const sourceFile = program.getSourceFile(virtual);
        const diagnostics: Record<string, number> = {};
        const patterns: Record<string, number> = {};
        if (sourceFile !== undefined) {
          for (const diagnostic of [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)]) {
            diagnostics[String(diagnostic.code)] = (diagnostics[String(diagnostic.code)] ?? 0) + 1;
            const key = patternOf(diagnostic, sourceFile);
            patterns[key] = (patterns[key] ?? 0) + 1;
          }
        } else {
          diagnostics['missing'] = 1;
        }
        const text = texts.get(entry.file) ?? '';
        const target = renamed(entry.file, text);
        const emitChanges = emitOf(text, path.basename(entry.file)) !== emitOf(text, path.basename(target));
        const boundaries: string[] = [];
        if (fs.existsSync(abs(entry.file.replace(/\.[cm]?jsx?$/, '.d.ts')))) boundaries.push('d.ts sidecar');
        if (entry.category === 'electron') boundaries.push('Electron runs this source directly');
        if (entry.category === 'config') boundaries.push('configuration loaded by its tool');
        const sourceImporters = importedBy.get(entry.file) ?? [];
      if (NODE_RUN.test(entry.file) && sourceImporters.length > 0) boundaries.push(`Node runs it from source; importers must name ${path.posix.extname(target)}: ${sourceImporters.slice(0, 2).join(', ')}`);
      const runnerBoundary = isolatedRunnerBoundary(entry.file, target, text);
        if (runnerBoundary !== null) boundaries.push(runnerBoundary);
        const importers = crossPackage.get(entry.file) ?? [];
        if (importers.length > 0) boundaries.push(`imported by another package: ${importers.slice(0, 2).join(', ')}`);
        const referencedBy = refs.get(entry.file) ?? [];
        if (referencedBy.length > 0) boundaries.push(`path referenced by ${referencedBy.slice(0, 3).join(', ')}${referencedBy.length > 3 ? ', ...' : ''}`);
        const codes = Object.keys(diagnostics).map(Number);
        const grade: Grade = boundaries.length > 0 ? 'C'
          : emitChanges || codes.some((code) => Number.isNaN(code) || !MECHANICAL.has(code)) ? 'D'
            : codes.length > 0 ? 'B' : 'A';
        results.push({ file: entry.file, category: entry.category, lines: entry.lines, grade, renamedTo: target, diagnostics, patterns, boundaries, emitChanges });
      }
      if (infer) inferPass(options, host, roots, results.filter((result) => set.includes(result.file)), virtualToReal);
    }
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
};

/** Import-graph structure of the remaining JavaScript: cycles (SCCs) and independent groups. */
export const graphReport = (results: readonly CensusEntry[]): string[] => {
  const files = new Set(results.map((result) => result.file));
  const edges = importEdges();
  const out = new Map<string, string[]>();
  for (const file of files) out.set(file, (edges.get(file) ?? []).filter((target) => files.has(target)));
  // Tarjan's strongly connected components.
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  const connect = (node: string): void => {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of out.get(node) ?? []) {
      if (!indices.has(next)) {
        connect(next);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? 0, indices.get(next) ?? 0));
      }
    }
    if (low.get(node) === indices.get(node)) {
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      sccs.push(component);
    }
  };
  for (const file of files) if (!indices.has(file)) connect(file);
  // Weakly connected groups (undirected).
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root) ?? root;
    parent.set(x, root);
    return root;
  };
  for (const file of files) parent.set(file, file);
  for (const [from, targets] of out) for (const to of targets) parent.set(find(from), find(to));
  const groups = new Map<string, string[]>();
  for (const file of files) groups.set(find(file), [...(groups.get(find(file)) ?? []), file]);
  const gradeOf = new Map(results.map((result) => [result.file, result.inferred?.grade ?? result.grade]));
  const cycles = sccs.filter((component) => component.length > 1).sort((a, b) => b.length - a.length);
  const groupList = [...groups.values()];
  const allA = (members: readonly string[]): boolean => members.every((member) => gradeOf.get(member) === 'A');
  return [
    `import edges between remaining JS files: ${String([...out.values()].reduce((sum, targets) => sum + targets.length, 0))}`,
    `SCCs: ${String(sccs.length)} (${String(cycles.length)} cycles of 2+ files; the rest are single files)`,
    ...cycles.slice(0, 8).map((component) => `  cycle of ${String(component.length)}: ${component.slice(0, 4).join(', ')}${component.length > 4 ? ', ...' : ''}`),
    `independent groups (weakly connected): ${String(groupList.length)}; singletons: ${String(groupList.filter((g) => g.length === 1).length)}; largest: ${String(Math.max(...groupList.map((g) => g.length)))} files`,
    `groups whose every file is zero-touch: ${String(groupList.filter(allA).length)} (${String(groupList.filter(allA).reduce((sum, g) => sum + g.length, 0))} files)`,
  ];
};

/** Applies TypeScript's own inferFromUsage codefix in memory and re-grades from what remains. */
const inferPass = (options: ts.CompilerOptions, host: ts.CompilerHost, roots: string[], results: CensusEntry[], virtualToReal: ReadonlyMap<string, string>): void => {
  const texts = new Map<string, string>();
  const versions = new Map<string, number>();
  const read = (file: string): string | undefined => texts.get(file) ?? host.readFile(file);
  const lsHost: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => roots,
    getScriptVersion: (file) => String(versions.get(file) ?? 0),
    getScriptSnapshot: (file) => {
      const text = read(file);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => ROOT,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (file) => host.fileExists(file),
    readFile: (file) => read(file),
    readDirectory: (dir, extensions, exclude, include, depth) => ts.sys.readDirectory(dir, extensions, exclude, include, depth),
    directoryExists: (dir) => ts.sys.directoryExists(dir),
    getDirectories: (dir) => ts.sys.getDirectories(dir),
  };
  const ls = ts.createLanguageService(lsHost, ts.createDocumentRegistry());
  const virtualOf = new Map<string, string>();
  for (const [virtual, real] of virtualToReal) virtualOf.set(rel(real), virtual);
  const original = new Map<string, string>();
  for (const result of results) {
    if (!Object.keys(result.diagnostics).some((code) => IMPLICIT_ANY.has(Number(code)))) continue;
    const fileName = virtualOf.get(result.file);
    if (fileName === undefined) continue;
    let fix: ts.CombinedCodeActions;
    try {
      fix = ls.getCombinedCodeFix({ type: 'file', fileName }, 'inferFromUsage', ts.getDefaultFormatCodeSettings(), {});
    } catch {
      continue;
    }
    for (const change of fix.changes) {
      const before = read(change.fileName);
      if (before === undefined) continue;
      if (!original.has(change.fileName)) original.set(change.fileName, before);
      let text = before;
      for (const edit of [...change.textChanges].sort((a, b) => b.span.start - a.span.start)) {
        text = text.slice(0, edit.span.start) + edit.newText + text.slice(edit.span.start + edit.span.length);
      }
      texts.set(change.fileName, text);
      versions.set(change.fileName, (versions.get(change.fileName) ?? 0) + 1);
    }
  }
  const anyCount = (text: string): number => (text.match(/\bany\b/g) ?? []).length;
  for (const result of results) {
    const fileName = virtualOf.get(result.file);
    if (fileName === undefined) continue;
    const diagnostics: Record<string, number> = {};
    for (const diagnostic of [...ls.getSyntacticDiagnostics(fileName), ...ls.getSemanticDiagnostics(fileName)]) {
      diagnostics[String(diagnostic.code)] = (diagnostics[String(diagnostic.code)] ?? 0) + 1;
    }
    const before = original.get(fileName);
    const after = texts.get(fileName);
    const anyInserted = before !== undefined && after !== undefined ? Math.max(0, anyCount(after) - anyCount(before)) : 0;
    const codes = Object.keys(diagnostics).map(Number);
    const grade: Grade = result.grade === 'C' ? 'C'
      : codes.some((code) => !MECHANICAL.has(code)) ? 'D'
        : codes.length > 0 || anyInserted > 0 ? 'B' : 'A';
    result.inferred = { diagnostics, anyInserted, grade };
  }
};

const main = (): void => {
  const args = process.argv.slice(2);
  const results = census(args.includes('--infer'));
  const jsonIndex = args.indexOf('--json');
  const target = jsonIndex === -1 ? undefined : args[jsonIndex + 1];
  if (target !== undefined) fs.writeFileSync(target, `${JSON.stringify(results, null, 1)}\n`);
  const totals = new Map<string, { files: number; lines: number }>();
  for (const result of results) {
    for (const key of [`${result.grade}`, `${result.grade} ${result.category ?? '?'}`]) {
      const t = totals.get(key) ?? { files: 0, lines: 0 };
      totals.set(key, { files: t.files + 1, lines: t.lines + result.lines });
    }
  }
  for (const [key, t] of [...totals].sort(([a], [b]) => a.localeCompare(b))) console.log(`${key.padEnd(14)} ${String(t.files).padStart(4)} files ${String(t.lines).padStart(7)} lines`);
  if (args.includes('--graph')) for (const line of graphReport(results)) console.log(line);
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
