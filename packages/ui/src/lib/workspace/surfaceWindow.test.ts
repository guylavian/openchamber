import { describe, expect, test } from 'bun:test';

import {
  buildSurfaceWindowSearch,
  canDetachSurface,
  modeForSurface,
  readSurfaceWindowParams,
} from './surfaceWindow';

describe('surface window URL', () => {
  test('round-trips the surface and its project', () => {
    const search = buildSurfaceWindowSearch({ surfaceId: 'terminal', directory: '/Users/me/project one' });

    expect(readSurfaceWindowParams(search)).toEqual({ surfaceId: 'terminal', directory: '/Users/me/project one' });
  });

  test('an ordinary page is not a surface window', () => {
    expect(readSurfaceWindowParams('')).toBe(null);
    expect(readSurfaceWindowParams('?surface=terminal&directory=/repo')).toBe(null);
  });

  test('refuses a surface that cannot be detached or a missing project', () => {
    expect(readSurfaceWindowParams(buildSurfaceWindowSearch({ surfaceId: 'chat', directory: '/repo' }))).toBe(null);
    expect(readSurfaceWindowParams(buildSurfaceWindowSearch({ surfaceId: 'ghost', directory: '/repo' }))).toBe(null);
    expect(readSurfaceWindowParams('?ocWindow=surface&surface=terminal')).toBe(null);
  });
});

describe('which surfaces can be detached', () => {
  test('every panel surface can, the session conversation cannot', () => {
    expect(canDetachSurface('terminal')).toBe(true);
    expect(canDetachSurface('editor')).toBe(true);
    expect(canDetachSurface('git')).toBe(true);
    expect(canDetachSurface('chat')).toBe(false);
    expect(canDetachSurface('ghost')).toBe(false);
  });

  test('plugin panels can, and keep their own mode', () => {
    expect(canDetachSurface('plugin:acme')).toBe(true);
    expect(modeForSurface('plugin:acme')).toBe('plugin:acme');
    expect(modeForSurface('editor')).toBe('file');
  });
});
