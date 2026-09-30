import { describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { registerPwaManifestRoute } from './pwa-manifest-routes.js';

const createResponse = () => ({
  headers: new Map<string, string>(),
  contentType: '',
  body: '',
  setHeader(name: string, value: string) {
    this.headers.set(name, value);
    return this;
  },
  type(value: string) {
    this.contentType = value;
    return this;
  },
  send(value: string) {
    this.body = value;
    return this;
  },
});

type FakeResponse = ReturnType<typeof createResponse>;
type ManifestHandler = (req: { query: object }, res: FakeResponse) => Promise<void>;

describe('PWA manifest route', () => {
  it('does not fall back to unrelated global session shortcuts for scoped manifests', async () => {
    const routes = new Map<string, ManifestHandler>();
    const app = {
      get(route: string, handler: ManifestHandler) {
        routes.set(route, handler);
      },
    };
    const originalFetch = globalThis.fetch;
    const fetchCalls: string[] = [];
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      const sessions = String(url).includes('?directory=')
        ? []
        : [
            {
              id: 'other-session',
              title: 'Other project',
              directory: '/workspace/other',
              time: { updated: 2 },
            },
          ];
      // v2 pages the session list as `{ data, cursor }`.
      return {
        ok: true,
        json: async () => ({ data: sessions, cursor: {} }),
      } as Response;
    };

    try {
      registerPwaManifestRoute(app as Express, {
        process: { platform: 'darwin' },
        resolveProjectDirectory: async () => ({ directory: '/workspace/app' }),
        buildOpenCodeUrl: (route) => route,
        getOpenCodeAuthHeaders: () => ({}),
        readSettingsFromDiskMigrated: async () => ({}),
        normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
      });

      const handler = routes.get('/manifest.webmanifest');
      const res = createResponse();
      await handler!({ query: {} }, res);

      const manifest = JSON.parse(res.body) as { shortcuts: unknown };
      expect(fetchCalls).toHaveLength(2);
      expect(manifest.shortcuts).toEqual([
        {
          name: 'Appearance Settings',
          short_name: 'Settings',
          description: 'Open appearance settings',
          url: '/?settings=appearance',
          icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('includes child session shortcuts for root-scoped manifests', async () => {
    const routes = new Map<string, ManifestHandler>();
    const app = {
      get(route: string, handler: ManifestHandler) {
        routes.set(route, handler);
      },
    };
    const originalFetch = globalThis.fetch;
    const fetchCalls: string[] = [];
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      return {
        ok: true,
        json: async () => [
          {
            id: 'root-child',
            title: 'Root child',
            directory: '/workspace/app',
            time: { updated: 2 },
          },
        ],
      } as Response;
    };

    try {
      registerPwaManifestRoute(app as Express, {
        process: { platform: 'darwin' },
        resolveProjectDirectory: async () => ({ directory: '/' }),
        buildOpenCodeUrl: (route) => route,
        getOpenCodeAuthHeaders: () => ({}),
        readSettingsFromDiskMigrated: async () => ({}),
        normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
      });

      const handler = routes.get('/manifest.webmanifest');
      const res = createResponse();
      await handler!({ query: {} }, res);

      const manifest = JSON.parse(res.body) as { shortcuts: unknown };
      expect(fetchCalls).toEqual(['/api/session?directory=%2F']);
      expect(manifest.shortcuts).toContainEqual({
        name: 'Root child',
        short_name: 'Root child',
        description: 'Open recent session',
        url: '/?session=root-child',
        icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
