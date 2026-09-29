import type { PlatformPath } from 'node:path';

export interface TerminalShellLaunchOptions {
  mode?: string;
  command?: string | null;
  loginShell?: boolean;
  platform?: NodeJS.Platform;
}

export interface TerminalShellLaunch {
  executable: string | null;
  args: string[];
}

export interface TerminalShellResolverDeps {
  fs: { promises: { readFile: (path: string, encoding: 'utf8') => Promise<string> } };
  path: Pick<PlatformPath, 'join'>;
  searchPathFor: (command: string, searchPath: string) => string | null;
  isExecutable: (candidate: string) => boolean;
  buildAugmentedPath?: () => string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export interface TerminalShellInfo {
  id: string;
  name: string;
  executable: string | null;
  supportsLogin: boolean;
}

const TERMINAL_SHELL_IDS = ['bash', 'zsh', 'sh', 'fish', 'pwsh', 'powershell', 'cmd', 'dash', 'ksh', 'nu'];
const TERMINAL_SHELL_ID_SET = new Set(TERMINAL_SHELL_IDS);
const isString = (value: unknown): value is string => String(value) === value;

export const normalizeTerminalShell = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized === 'auto' || TERMINAL_SHELL_ID_SET.has(normalized) ? normalized : null;
};

const shellIdFromPath = (value: string | null) => {
  const filename = String(value || '').replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';
  const id = filename.endsWith('.exe') ? filename.slice(0, -4) : filename;
  return TERMINAL_SHELL_ID_SET.has(id) ? id : null;
};

const SHELL_LABELS: Record<string, string> = { pwsh: 'PowerShell', powershell: 'Windows PowerShell', cmd: 'Command Prompt' };
const shellLabel = (id: string) => SHELL_LABELS[id] ?? id;

export const getTerminalShellLoginArgs = (executable: string | null, platform: NodeJS.Platform = process.platform) => {
  const id = shellIdFromPath(executable);
  if (id === 'bash' || id === 'zsh' || id === 'ksh') return ['-l'];
  if (id === 'fish' || id === 'nu') return ['--login'];
  if (id === 'pwsh' && platform !== 'win32') return ['-Login'];
  return null;
};

export const buildTerminalShellLaunch = (executable: string | null, { mode = 'interactive', command = null, loginShell = false, platform = process.platform }: TerminalShellLaunchOptions = {}): TerminalShellLaunch => {
  const loginArgs = loginShell ? getTerminalShellLoginArgs(executable, platform) : [];
  if (!loginArgs) throw new Error(`Terminal shell "${shellIdFromPath(executable) ?? executable}" does not support login mode`);

  if (mode === 'interactive') return { executable, args: loginArgs };

  const trimmedCommand = isString(command) ? command.trim() : '';
  if (!trimmedCommand) throw new Error('Terminal command is required');

  const id = shellIdFromPath(executable);
  if (id === 'nu') return { executable, args: [...loginArgs, '-c', trimmedCommand] };
  if (id === 'pwsh' || id === 'powershell') return { executable, args: [...loginArgs, '-Command', trimmedCommand] };
  if (id === 'cmd') return { executable, args: ['/d', '/s', '/c', trimmedCommand] };
  return { executable, args: [...loginArgs, '-i', '-c', trimmedCommand] };
};

export const createTerminalShellResolver = ({ fs, path, searchPathFor, isExecutable, buildAugmentedPath = () => env.PATH || '', platform = process.platform, env = process.env }: TerminalShellResolverDeps) => {
  const resolveExecutable = (candidate: string | undefined) => {
    if (!candidate) return null;
    const value = String(candidate);
    const found = value.includes('/') || value.includes('\\') ? value : searchPathFor(value, buildAugmentedPath());
    if (found && isExecutable(found)) return found;
    return isExecutable(value) ? value : null;
  };

  const defaultCandidates = () => platform === 'win32'
    ? [
        env.OPENCHAMBER_TERMINAL_SHELL,
        env.SHELL,
        env.ComSpec,
        path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        'pwsh.exe',
        'powershell.exe',
        'cmd.exe',
      ]
    : [env.OPENCHAMBER_TERMINAL_SHELL, env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh', 'zsh', 'bash', 'sh'];

  const resolveCandidates = (candidates: (string | undefined)[]) => {
    const seen = new Set<string>();
    return candidates
      .map(resolveExecutable)
      .filter((candidate) => candidate && !seen.has(candidate) && seen.add(candidate));
  };

  const list = async () => {
    let configuredShells: string[] = [];
    if (platform !== 'win32') {
      try {
        const contents = await fs.promises.readFile('/etc/shells', 'utf8');
        configuredShells = contents
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'));
      } catch {
        // PATH and platform defaults below remain authoritative fallbacks.
      }
    }

    const candidates = platform === 'win32'
      ? [...defaultCandidates(), ...TERMINAL_SHELL_IDS]
      : [env.OPENCHAMBER_TERMINAL_SHELL, env.SHELL, ...configuredShells, ...TERMINAL_SHELL_IDS, '/bin/zsh', '/bin/bash', '/bin/sh'];
    const autoExecutable = resolveCandidates(defaultCandidates())[0] ?? null;
    const byId = new Map<string, TerminalShellInfo>([
      ['auto', {
        id: 'auto',
        name: 'Auto',
        executable: autoExecutable,
        supportsLogin: Boolean(autoExecutable && getTerminalShellLoginArgs(autoExecutable, platform)),
      }],
    ]);
    for (const executable of resolveCandidates(candidates)) {
      const id = shellIdFromPath(executable);
      if (id && !byId.has(id)) {
        byId.set(id, { id, name: shellLabel(id), executable, supportsLogin: Boolean(getTerminalShellLoginArgs(executable, platform)) });
      }
    }
    return [...byId.values()];
  };

  const resolve = async (preference: unknown) => {
    const normalized = normalizeTerminalShell(preference ?? 'auto');
    if (!normalized) throw new Error('Invalid terminal shell');
    if (normalized === 'auto') return { id: 'auto', executables: resolveCandidates(defaultCandidates()) };
    const selected = (await list()).find((shell) => shell.id === normalized);
    if (!selected) throw new Error(`Terminal shell "${normalized}" is not available`);
    return { id: selected.id, executables: [selected.executable] };
  };

  return { list, resolve };
};
