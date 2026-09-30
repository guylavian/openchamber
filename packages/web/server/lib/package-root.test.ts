import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { findPackageRoot, PACKAGE_JSON_PATH, PACKAGE_ROOT } from './package-root.js';

describe('package root', () => {
  it('is the @openchamber/web package', () => {
    expect((JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as { name?: unknown }).name).toBe('@openchamber/web');
    expect(fs.existsSync(path.join(PACKAGE_ROOT, 'server', 'index.js'))).toBe(true);
  });

  it('is found from the build layout too, one directory deeper than the sources', () => {
    const files = new Map<string, string | undefined>([
      ['/pkg/package.json', JSON.stringify({ name: '@openchamber/web' })],
      ['/pkg/dist-node/package.json', undefined],
    ]);
    const readFile = (file: string): string => {
      if (!files.has(file) || files.get(file) === undefined) throw new Error('ENOENT');
      return files.get(file)!;
    };
    expect(findPackageRoot('/pkg/dist-node/server/lib', { readFile })).toBe('/pkg');
    expect(findPackageRoot('/pkg/server/lib', { readFile })).toBe('/pkg');
  });

  it('skips package.json files that belong to other packages', () => {
    const readFile = (file: string): string => {
      if (file === '/root/package.json') return JSON.stringify({ name: 'openchamber-monorepo' });
      if (file === '/root/packages/web/package.json') return JSON.stringify({ name: '@openchamber/web' });
      throw new Error('ENOENT');
    };
    expect(findPackageRoot('/root/packages/web/server', { readFile })).toBe('/root/packages/web');
    expect(() => findPackageRoot('/elsewhere/dir', { readFile })).toThrow(/package root not found/);
  });
});
