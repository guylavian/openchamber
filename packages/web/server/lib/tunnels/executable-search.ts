import fs from 'fs';
import os from 'os';
import path from 'path';

export interface ExecutableSearchOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** The file checks the search makes (node:fs). */
export interface ExecutableSearchFs {
  statSync: (path: string) => { isFile: () => boolean };
  accessSync: (path: string, mode?: number) => void;
}

export interface FindExecutableOptions extends ExecutableSearchOptions {
  fsLike?: ExecutableSearchFs;
}

const getEnvValue = (env: NodeJS.ProcessEnv | undefined, keys: string[]) => {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return '';
};

const normalizeSearchDirectoryKey = (directory: string, platform: NodeJS.Platform) => {
  const trimmed = typeof directory === 'string' ? directory.trim() : '';
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
};

const getWindowsAppsDirectory = (env: NodeJS.ProcessEnv) => {
  const localAppData = getEnvValue(env, ['LOCALAPPDATA', 'LocalAppData', 'localappdata']);
  if (localAppData) {
    return path.win32.join(localAppData, 'Microsoft', 'WindowsApps');
  }

  const userProfile = getEnvValue(env, ['USERPROFILE', 'UserProfile', 'userprofile']);
  if (userProfile) {
    return path.win32.join(userProfile, 'AppData', 'Local', 'Microsoft', 'WindowsApps');
  }

  return path.win32.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WindowsApps');
};

export function getExecutableSearchDirectories({ env = process.env, platform = process.platform }: ExecutableSearchOptions = {}): string[] {
  const delimiter = platform === 'win32' ? ';' : ':';
  const pathValue = getEnvValue(env, ['PATH', 'Path', 'path']);
  const directories = pathValue.split(delimiter).map((entry) => entry.trim()).filter(Boolean);

  if (platform === 'win32') {
    directories.push(getWindowsAppsDirectory(env));
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const directory of directories) {
    const key = normalizeSearchDirectoryKey(directory, platform);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(directory);
  }

  return unique;
}

export function createExecutableSearchEnv({ env = process.env, platform = process.platform }: ExecutableSearchOptions = {}): NodeJS.ProcessEnv {
  const delimiter = platform === 'win32' ? ';' : ':';
  const pathValue = getExecutableSearchDirectories({ env, platform }).join(delimiter);
  const nextEnv = { ...env };

  if (platform === 'win32') {
    nextEnv.PATH = pathValue;
    nextEnv.Path = pathValue;
    nextEnv.path = pathValue;
  } else {
    nextEnv.PATH = pathValue;
  }

  return nextEnv;
}

const getExecutableExtensions = ({ env = process.env, platform = process.platform }: ExecutableSearchOptions = {}) => {
  if (platform !== 'win32') {
    return [''];
  }

  return (env.PATHEXT || env.PathExt || env.pathext || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean)
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));
};

export function findExecutableOnPath(command: string, {
  env = process.env,
  platform = process.platform,
  fsLike = fs,
}: FindExecutableOptions = {}): string | null {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return null;
  }

  const pathApi = platform === 'win32' ? path.win32 : path;
  const directories = getExecutableSearchDirectories({ env, platform });
  const extensions = getExecutableExtensions({ env, platform });
  const commandName = command.trim();

  for (const directory of directories) {
    for (const extension of extensions) {
      const fileName = platform === 'win32' ? `${commandName}${extension}` : commandName;
      const candidate = pathApi.join(directory, fileName);
      try {
        const stats = fsLike.statSync(candidate);
        if (!stats.isFile()) {
          continue;
        }
        if (platform !== 'win32') {
          try {
            fsLike.accessSync(candidate, fs.constants.X_OK);
          } catch {
            continue;
          }
        }
        return candidate;
      } catch {
        continue;
      }
    }
  }

  return null;
}

export function resolveExecutableLaunchTarget(command: string, options: FindExecutableOptions = {}): { command: string; env: NodeJS.ProcessEnv } | null {
  const platform = options.platform || process.platform;
  const resolvedPath = findExecutableOnPath(command, { ...options, platform });
  const env = createExecutableSearchEnv({ env: options.env || process.env, platform });
  if (resolvedPath) {
    return { command: resolvedPath, env };
  }

  // Windows Store app execution aliases are launchable through CreateProcess
  // but can reject fs.stat/fs.access with EACCES. Let the version probe decide.
  if (platform === 'win32' && typeof command === 'string' && command.trim().length > 0) {
    return { command: command.trim(), env };
  }

  return null;
}
