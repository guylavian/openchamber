#!/usr/bin/env bun
/**
 * Verifies the server artifact (dist-node) after `bun run build:server`.
 *
 * Parses modules with Bun's transpiler (an AST scan, not pattern matching) and
 * checks:
 *   1. every relative import in dist-node (static, and dynamic with a literal
 *      specifier) points at a file that exists in dist-node, and none names a
 *      TypeScript file;
 *   2. every `@openchamber/web/...` specifier the repository's consumers use
 *      (Electron's main process and early startup) resolves through the
 *      package's exports map to a file in dist-node, never to the sources.
 *
 *   bun scripts/verify-server-artifact.mjs
 *
 * Exit code 1 on any failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (typeof Bun === 'undefined') {
  console.error('verify-server-artifact: run with bun (it parses modules with Bun.Transpiler)');
  process.exit(2);
}

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(webRoot, '../..');
const outDir = path.join(webRoot, 'dist-node');
const CONSUMERS = ['packages/electron/main.mjs', 'packages/electron/early-startup.mjs', 'packages/electron/entry.mjs', 'packages/electron/preload.mjs'];

const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(directory, entry.name);
  return entry.isDirectory() ? walk(full) : [full];
});
const transpiler = new Bun.Transpiler({ loader: 'js' });
// The scanner rejects a hashbang line; blank it so line numbers stay put.
const importsOf = (file) => transpiler.scanImports(fs.readFileSync(file, 'utf8').replace(/^#!.*/, ''));

const problems = [];
if (!fs.existsSync(outDir)) {
  console.error('verify-server-artifact: dist-node is missing; run bun run build:server');
  process.exit(1);
}

// 1. Relative imports inside the artifact.
let modules = 0;
let relativeImports = 0;
for (const file of walk(outDir).filter((entry) => /\.[cm]?js$/.test(entry) && !entry.includes(`${path.sep}built-in-extensions${path.sep}`))) {
  modules += 1;
  for (const { path: specifier } of importsOf(file)) {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
    relativeImports += 1;
    const where = path.relative(outDir, file);
    if (/\.[cm]?tsx?$/.test(specifier)) problems.push(`${where}: imports TypeScript '${specifier}'`);
    const target = path.resolve(path.dirname(file), specifier);
    if (!fs.existsSync(target)) problems.push(`${where}: '${specifier}' does not exist in dist-node`);
    else if (!target.startsWith(outDir + path.sep)) problems.push(`${where}: '${specifier}' leaves dist-node`);
  }
}

// 2. Deep imports used by consumers, resolved the way Node resolves the package.
const deepSpecifiers = new Set();
for (const consumer of CONSUMERS) {
  const file = path.join(repoRoot, consumer);
  if (!fs.existsSync(file)) continue;
  for (const { path: specifier } of importsOf(file)) {
    if (specifier === '@openchamber/web' || specifier.startsWith('@openchamber/web/')) deepSpecifiers.add(specifier);
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(webRoot, 'package.json'), 'utf8'));
const exportTarget = (subpath) => {
  for (const [pattern, value] of Object.entries(manifest.exports ?? {})) {
    const target = typeof value === 'string' ? value : value.default;
    if (pattern === subpath) return target;
    if (pattern.endsWith('*') && subpath.startsWith(pattern.slice(0, -1))) return target.replace('*', subpath.slice(pattern.length - 1));
  }
  return null;
};
for (const specifier of [...deepSpecifiers].sort()) {
  const subpath = specifier === '@openchamber/web' ? '.' : `.${specifier.slice('@openchamber/web'.length)}`;
  const target = exportTarget(subpath);
  if (!target) { problems.push(`${specifier}: not exported by @openchamber/web`); continue; }
  const resolved = path.resolve(webRoot, target);
  if (!resolved.startsWith(outDir + path.sep)) problems.push(`${specifier}: exports map points outside dist-node (${target})`);
  else if (!fs.existsSync(resolved)) problems.push(`${specifier}: ${target} does not exist`);
}

console.log(`modules: ${modules}, relative imports: ${relativeImports}, consumer deep imports: ${deepSpecifiers.size}`);
if (problems.length > 0) {
  console.error(`${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('server artifact verified');
