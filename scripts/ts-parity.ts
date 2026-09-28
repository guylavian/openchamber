#!/usr/bin/env node
// Runtime parity check for JavaScript -> TypeScript conversions (Stage D).
//
// For each converted .ts/.tsx file, takes the JavaScript it replaced from a git
// revision (same path, .js/.mjs/.cjs/.jsx; HEAD by default), puts both through
// the same TypeScript emitter (types erased, comments dropped, imports kept
// exactly as written thanks to verbatimModuleSyntax) and diffs the result.
// An empty diff means the TypeScript runs the JavaScript it replaced. Any
// difference is printed and fails the check, to be removed or justified.
//
// Usage: node scripts/ts-parity.ts [--rev <git-rev>] <file.ts> [...]

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The emitted JavaScript for a source text: types erased, comments dropped, imports as written. */
export const normalize = (text: string, fileName: string): string => ts.transpileModule(text, {
  fileName,
  reportDiagnostics: false,
  compilerOptions: {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.Preserve,
    jsx: ts.JsxEmit.Preserve,
    removeComments: true,
    verbatimModuleSyntax: true,
    allowJs: true,
  },
}).outputText;

/** The path and text of the JavaScript a converted file replaced, at `rev`. */
export const originalOf = (file: string, rev: string): { path: string; text: string } | null => {
  const stem = file.replace(/\.(ts|tsx|mts|cts)$/, '');
  const candidates = [`${stem}.js`, `${stem}.mjs`, `${stem}.cjs`, `${stem}.jsx`];
  for (const candidate of candidates) {
    try {
      const text = execFileSync('git', ['show', `${rev}:${candidate}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return { path: candidate, text };
    } catch {
      // not at this extension
    }
  }
  return null;
};

const diff = (left: string, right: string, label: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-parity-'));
  const a = path.join(dir, 'javascript.js');
  const b = path.join(dir, 'typescript.js');
  fs.writeFileSync(a, left);
  fs.writeFileSync(b, right);
  const result = spawnSync('git', ['diff', '--no-index', '--no-color', '-U2', a, b], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return result.stdout.replaceAll(a, `${label} (js)`).replaceAll(b, `${label} (ts)`);
};

const main = (): void => {
  const args = process.argv.slice(2);
  const revIndex = args.indexOf('--rev');
  const rev = revIndex === -1 ? 'HEAD' : args[revIndex + 1];
  if (rev === undefined) throw new Error('--rev needs a revision');
  const files = args.filter((arg, index) => arg !== '--rev' && index !== revIndex + 1);
  let failures = 0;
  for (const file of files) {
    const original = originalOf(file, rev);
    if (original === null) {
      console.error(`[ts-parity] ${file}: no .js/.mjs/.cjs/.jsx original at ${rev}`);
      failures += 1;
      continue;
    }
    const before = normalize(original.text, original.path);
    const after = normalize(fs.readFileSync(path.join(ROOT, file), 'utf8'), file);
    if (before === after) {
      console.log(`[ts-parity] ${file}: identical to ${original.path}@${rev}`);
    } else {
      console.error(diff(before, after, file));
      failures += 1;
    }
  }
  if (failures > 0) process.exit(1);
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
