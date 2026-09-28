import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The directory of the @openchamber/web package: its package.json, the built UI
 * (`dist`), `public`. Found by walking up from this file, so it is the same
 * whether the server runs from source (`server/lib`) or from the build
 * (`dist-node/server/lib`), in a checkout, under node_modules or inside an asar.
 * Code that needs a package-level file resolves it from here, never by counting
 * `..` from its own location.
 */
export const findPackageRoot = (start, { readFile = fs.readFileSync } = {}) => {
  let directory = start;
  for (;;) {
    try {
      const manifest = JSON.parse(readFile(path.join(directory, 'package.json'), 'utf8'));
      if (manifest?.name === '@openchamber/web') return directory;
    } catch {
      // no package.json here, or not readable; keep walking up
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`@openchamber/web package root not found above ${start}`);
    directory = parent;
  }
};

export const PACKAGE_ROOT = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
export const PACKAGE_JSON_PATH = path.join(PACKAGE_ROOT, 'package.json');
