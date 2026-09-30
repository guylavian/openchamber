import { describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import path from 'path';
import type { Express } from 'express';

import type { SanitizedProject } from './settings-normalization-runtime.js';

import { registerProjectIconRoutes } from './project-icon-routes.js';

interface FakeRequest {
  params: Record<string, string>;
  query: unknown;
}

interface MockResponse {
  setHeader: (name: string, value: string) => void;
  getHeader: (name: string) => string | undefined;
  status: (code: number) => MockResponse;
  json: (payload: unknown) => MockResponse;
  send: (payload: unknown) => MockResponse;
  readonly statusCode: number;
  readonly body?: unknown;
}

type RouteHandler = (req: FakeRequest, res: MockResponse) => unknown;

type FakeApp = Record<'get' | 'post' | 'put' | 'delete', (routePath: string, ...handlers: RouteHandler[]) => void>;

interface RouteRegistry {
  app: FakeApp;
  getRoute: (method: string, routePath: string) => RouteHandler | undefined;
}

const createRouteRegistry = (): RouteRegistry => {
  const routes = new Map<string, RouteHandler>();

  return {
    app: {
      get(routePath: string, handler: RouteHandler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath: string, handler: RouteHandler) {
        routes.set(`POST ${routePath}`, handler);
      },
      put(routePath: string, handler: RouteHandler) {
        routes.set(`PUT ${routePath}`, handler);
      },
      delete(routePath: string, handler: RouteHandler) {
        routes.set(`DELETE ${routePath}`, handler);
      },
    },
    getRoute(method: string, routePath: string) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = (): MockResponse => {
  const headers = new Map<string, string>();
  let statusCode = 200;
  let body: unknown = null;

  return {
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
    send(payload: unknown) {
      body = payload;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

describe('project icon routes', () => {
  it('uses fallback file extension MIME when metadata points to a missing icon', async () => {
    const { app, getRoute } = createRouteRegistry();
    const jpgBytes = Buffer.from('jpg-bytes');
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const fsPromises = {
      readFile: vi.fn(async (iconPath: string): Promise<Buffer | string> => {
        if (iconPath.endsWith('.jpg')) {
          return jpgBytes;
        }
        throw enoent;
      }) as typeof import('node:fs/promises').readFile,
    } as typeof import('node:fs/promises');

    registerProjectIconRoutes(app as Express, {
      fsPromises,
      path,
      crypto,
      openchamberDataDir: '/tmp/openchamber-test',
      sanitizeProjects: (projects) => projects as SanitizedProject[],
      readSettingsFromDiskMigrated: async () => ({
        projects: [{
          id: 'proj-1',
          path: '/repo',
          iconImage: { mime: 'image/png', updatedAt: 1, source: 'custom' },
        }],
      }),
      persistSettings: async () => ({}),
      createFsSearchRuntime: () => ({ searchFilesystemFiles: async () => [] }),
      spawn: vi.fn<() => never>(),
      resolveGitBinaryForSpawn: vi.fn<() => string>(),
    });

    const res = createMockResponse();
    await getRoute('GET', '/api/projects/:projectId/icon')!({
      params: { projectId: 'proj-1' },
      query: {},
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('Content-Type')).toBe('image/jpeg');
    expect(res.body).toBe(jpgBytes);
  });
});
