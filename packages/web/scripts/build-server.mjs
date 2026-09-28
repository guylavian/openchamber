#!/usr/bin/env node
/**
 * build:server: the one command that produces the server artifact.
 *
 * server/ and bin/ hold the sources, JavaScript and TypeScript side by side.
 * This compiles them with TypeScript (tsconfig.server.build.json) into
 * dist-node/server and dist-node/bin, copies the files that are not code, and
 * verifies the result: every source module has its compiled module, and every
 * file that is neither code nor documentation is a known asset. npm, the CLI,
 * Electron and Docker all run dist-node; nothing ships the sources.
 *
 * The output is rebuilt from scratch every time, so a module that was renamed
 * or deleted cannot linger in dist-node.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBunExecutable } from '../../../scripts/lib/bun-executable.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(webRoot, '../..');
const outDir = path.join(webRoot, 'dist-node');
const SOURCE_ROOTS = ['server', 'bin'];
const BUILT_IN_EXTENSIONS = path.join('server', 'built-in-extensions');

// Files that are neither compiled nor documentation, by kind. Anything else
// under server/ or bin/ fails the build until it is classified here.
const isTest = (file) => /\.test\.[cm]?[jt]sx?$/.test(file);
const isDeclaration = (file) => /\.d\.[cm]?ts$/.test(file);
const isSourceModule = (file) => /\.([cm]?js|[cm]?ts)$/.test(file) && !isDeclaration(file) && !/\.cjs$/.test(file);
const isDocumentation = (file) => /\.md$/.test(file);
const ASSET_RULES = [
  { test: isDeclaration, why: 'hand-written type declaration sidecar' },
  { test: (file) => file.endsWith('.json'), why: 'data loaded at runtime (require/readFile)' },
  { test: (file) => file.endsWith('.cjs'), why: 'program read as text and run elsewhere; must stay byte-identical' },
];

const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(directory, entry.name);
  return entry.isDirectory() ? walk(full) : [full];
});
const relative = (file) => path.relative(webRoot, file);

const run = (label, command, args, options = {}) => {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: webRoot, stdio: 'inherit', ...options });
  if (result.status !== 0) {
    console.error(`[build:server] ${label} failed`);
    process.exit(result.status ?? 1);
  }
  console.log(`[build:server] ${label} (${Date.now() - started} ms)`);
};

fs.rmSync(outDir, { recursive: true, force: true });

// Under Bun, like every other caller: the script imports server sources, which
// may be TypeScript.
run('built-in extensions', resolveBunExecutable(), [path.join(repoRoot, 'scripts/build-builtin-extensions.mjs')]);

// @typescript/native is TypeScript 7 (see docs/platform-toolchain.md); its
// exports map hides bin/, so the binary is found through its manifest.
const nativeManifest = createRequire(import.meta.url).resolve('@typescript/native/package.json');
const tsc = path.join(path.dirname(nativeManifest), JSON.parse(fs.readFileSync(nativeManifest, 'utf8')).bin.tsc);
run('compile', process.execPath, [tsc, '-p', 'tsconfig.server.build.json']);

const problems = [];
let assets = 0;
for (const root of SOURCE_ROOTS) {
  for (const file of walk(path.join(webRoot, root)).map(relative)) {
    if (file.startsWith(BUILT_IN_EXTENSIONS + path.sep)) continue;
    if (isTest(file) || isDocumentation(file)) continue;
    if (isSourceModule(file)) {
      const compiled = path.join(outDir, file.replace(/\.([cm]?)ts$/, '.$1js'));
      if (!fs.existsSync(compiled)) problems.push(`${file}: no compiled module at ${relative(compiled)}`);
      continue;
    }
    if (ASSET_RULES.some((rule) => rule.test(file))) {
      fs.mkdirSync(path.dirname(path.join(outDir, file)), { recursive: true });
      fs.copyFileSync(path.join(webRoot, file), path.join(outDir, file));
      assets += 1;
      continue;
    }
    problems.push(`${file}: not code, documentation or a known asset kind; classify it in scripts/build-server.mjs`);
  }
}

const builtInSource = path.join(webRoot, BUILT_IN_EXTENSIONS);
if (fs.existsSync(builtInSource)) fs.cpSync(builtInSource, path.join(outDir, BUILT_IN_EXTENSIONS), { recursive: true });

for (const file of walk(outDir)) {
  if (/\.[cm]?tsx?$/.test(file) && !isDeclaration(file)) problems.push(`${relative(file)}: TypeScript source in the artifact`);
}

if (problems.length > 0) {
  console.error(`[build:server] ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`[build:server] dist-node ready: ${walk(outDir).length} files (${assets} assets copied)`);
