import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

interface SpawnSyncResult {
  stdout: string | Buffer | null;
  error?: Error | undefined;
}

type SpawnSyncFn = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncResult;

interface ClaudeAuthStatusPayload {
  loggedIn?: unknown;
}

const readStatus = (spawnSyncFn: SpawnSyncFn, command: string, env: NodeJS.ProcessEnv): SpawnSyncResult => spawnSyncFn(command, ['auth', 'status', '--json'], {
  encoding: 'utf8',
  timeout: 6000,
  env,
  windowsHide: true,
});

const resolveFromLoginShell = (spawnSyncFn: SpawnSyncFn, env: NodeJS.ProcessEnv, platform: string): string | null => {
  if (platform === 'win32') {
    const result = spawnSyncFn('where', ['claude'], {
      encoding: 'utf8',
      timeout: 6000,
      env,
      windowsHide: true,
    });
    return `${result.stdout || ''}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
  }

  const shell = env.SHELL || '/bin/zsh';
  const result = spawnSyncFn(shell, ['-lic', 'command -v claude'], {
    encoding: 'utf8',
    timeout: 6000,
    env,
    windowsHide: true,
  });
  return `${result.stdout || ''}`.trim().split(/\s+/).pop() || null;
};

interface GetClaudeCliAuthStatusOptions {
  spawnSyncFn?: SpawnSyncFn;
  env?: NodeJS.ProcessEnv;
  platform?: string;
}

interface ClaudeCliAuthStatus {
  connected: boolean;
  reason: string;
}

export const getClaudeCliAuthStatus = ({
  spawnSyncFn = spawnSync,
  env = process.env,
  platform = process.platform,
}: GetClaudeCliAuthStatusOptions = {}): ClaudeCliAuthStatus => {
  const childEnv: NodeJS.ProcessEnv = { ...env };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.ANTHROPIC_AUTH_TOKEN;
  delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

  try {
    let result = readStatus(spawnSyncFn, 'claude', childEnv);
    if (!`${result.stdout || ''}`.trim() && result.error) {
      const resolved = resolveFromLoginShell(spawnSyncFn, childEnv, platform);
      if (resolved) result = readStatus(spawnSyncFn, resolved, childEnv);
    }
    const output = `${result.stdout || ''}`.trim();
    if (!output) return { connected: false, reason: 'empty-status' };
    const payload = JSON.parse(output) as ClaudeAuthStatusPayload | null;
    return {
      connected: payload?.loggedIn === true,
      reason: payload?.loggedIn === true ? 'logged-in' : 'logged-out',
    };
  } catch (error) {
    return {
      connected: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};
