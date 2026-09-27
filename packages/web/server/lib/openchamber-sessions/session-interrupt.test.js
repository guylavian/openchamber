import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createOpenChamberSessionService } from './routes.js';

/** The service with an injected OpenCode client that records what it was asked. */
const serviceWith = (interrupt) => {
  const clients = [];
  const service = createOpenChamberSessionService({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'oc-interrupt-')),
    buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
    getOpenCodeAuthHeaders: () => ({}),
    createOpenCodeClient: (options) => {
      clients.push(options);
      return { session: { interrupt } };
    },
  });
  return { service, clients };
};

describe('session service interrupt', () => {
  it('interrupts the given session in its directory and reports whether a turn was running', async () => {
    const calls = [];
    const { service, clients } = serviceWith(async (input) => { calls.push(input); return { interrupted: true }; });
    expect(await service.interrupt('ses_1', { directory: '/repo' })).toEqual({ interrupted: true, missing: false });
    expect(calls).toEqual([{ sessionID: 'ses_1' }]);
    expect(clients.at(-1).directory).toBe('/repo');
  });

  it('an idle session is not interrupted, and that is not an error', async () => {
    const { service } = serviceWith(async () => ({ interrupted: false }));
    expect(await service.interrupt('ses_1')).toEqual({ interrupted: false, missing: false });
  });

  it('a session OpenCode does not know is reported missing', async () => {
    const { service } = serviceWith(async () => { throw Object.assign(new Error('gone'), { _tag: 'SessionNotFoundError' }); });
    expect(await service.interrupt('ses_1')).toEqual({ interrupted: false, missing: true });
  });

  it('any other failure throws: "could not ask" is never "stopped"', async () => {
    const { service } = serviceWith(async () => { throw new Error('connection refused'); });
    await expect(service.interrupt('ses_1')).rejects.toThrow('connection refused');
  });

  it('needs a session id', async () => {
    const { service } = serviceWith(async () => ({ interrupted: true }));
    await expect(service.interrupt('  ')).rejects.toMatchObject({ statusCode: 400 });
  });
});
