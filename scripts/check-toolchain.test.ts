import { expect, test } from 'bun:test';
import { runningBunVersion, toolchainWarnings } from './check-toolchain.mjs';

const manifest = { packageManager: 'bun@1.4.2', engines: { node: '>=24.11.0' } };

test('the pinned toolchain produces no warning', () => {
  expect(toolchainWarnings({ manifest, nodeVersion: 'v24.21.0', bunVersion: '1.4.2' })).toEqual([]);
});

test('a different Bun and an older Node are both named', () => {
  const warnings = toolchainWarnings({ manifest, nodeVersion: 'v22.14.0', bunVersion: '1.3.14' });
  expect(warnings).toHaveLength(2);
  expect(warnings[0]).toContain('pins Bun 1.4.2');
  expect(warnings[1]).toContain('below the supported >=24.11.0');
});

test('a newer Node minor is supported', () => {
  expect(toolchainWarnings({ manifest, nodeVersion: 'v24.30.1', bunVersion: '1.4.2' })).toEqual([]);
});

test('the running Bun is read from the install user agent', () => {
  expect(runningBunVersion({ npm_config_user_agent: 'bun/1.3.14 npm/? node/v24.21.0 darwin arm64' })).toBe('1.3.14');
  expect(runningBunVersion({ npm_config_user_agent: 'npm/11.19.0 node/v24.21.0' })).toBeNull();
});
