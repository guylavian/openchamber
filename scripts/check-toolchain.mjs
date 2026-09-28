#!/usr/bin/env node
/**
 * Warns when the local toolchain differs from the one the repository pins:
 * Bun from `packageManager`, Node from `engines.node`. It only warns, because
 * an install should still finish; the message says what to install instead.
 * Runs from the root `postinstall`.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const parseVersion = (value) => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''));
  return match ? match.slice(1, 4).map(Number) : null;
};

const compare = (a, b) => {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
};

// The Bun that runs `bun install` names itself in the user agent: "bun/1.4.2 npm/? node/…".
export const runningBunVersion = (env) => /\bbun\/(\d+\.\d+\.\d+)/.exec(env.npm_config_user_agent ?? '')?.[1] ?? null;

export const toolchainWarnings = ({ manifest, nodeVersion, bunVersion }) => {
  const warnings = [];
  const pinnedBun = /^bun@(.+)$/.exec(manifest.packageManager ?? '')?.[1];
  if (pinnedBun && bunVersion && bunVersion !== pinnedBun) {
    warnings.push(`Bun ${bunVersion} is running, but this repository pins Bun ${pinnedBun} (package.json "packageManager"). Install Bun ${pinnedBun}: https://bun.sh/docs/installation`);
  }
  const nodeFloor = parseVersion(/>=\s*(\S+)/.exec(manifest.engines?.node ?? '')?.[1]);
  const node = parseVersion(nodeVersion);
  if (nodeFloor && node && compare(node, nodeFloor) < 0) {
    warnings.push(`Node ${nodeVersion} is below the supported ${manifest.engines.node} (package.json "engines"). Use the version in .nvmrc: nvm install`);
  }
  return warnings;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const warning of toolchainWarnings({ manifest, nodeVersion: process.version, bunVersion: runningBunVersion(process.env) })) {
    console.warn(`[toolchain] ${warning}`);
  }
}
