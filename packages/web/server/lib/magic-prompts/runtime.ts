import type { PlatformPath } from 'node:path';

interface PromptState {
  version: number;
  overrides: Record<string, string>;
}

interface MagicPromptRuntimeDependencies {
  fsPromises: {
    readFile: (path: string, encoding: 'utf8') => Promise<string>;
    mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
    writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>;
  };
  path: Pick<PlatformPath, 'dirname'>;
  filePath: string;
}

const FILE_VERSION = 1;
const MAX_PROMPT_TEXT_LENGTH = 200_000;
const PROMPT_ID_PATTERN = /^[a-z0-9._-]{1,160}$/;
const isVisiblePromptID = (id: string): boolean => typeof id === 'string' && id.endsWith('.visible');

const hasOwn = (input: object, key: string): boolean => Object.prototype.hasOwnProperty.call(input, key);

const sanitizeOverrides = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const next: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!PROMPT_ID_PATTERN.test(key) || typeof entry !== 'string') {
      continue;
    }
    next[key] = entry;
  }
  return next;
};

export const createMagicPromptRuntime = (dependencies: MagicPromptRuntimeDependencies) => {
  const {
    fsPromises,
    path,
    filePath,
  } = dependencies;

  let writeLock: Promise<void> | Promise<PromptState> = Promise.resolve();

  const readPromptState = async (): Promise<PromptState> => {
    try {
      const raw = await fsPromises.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as { overrides?: unknown } | null;
      const overrides = sanitizeOverrides(parsed?.overrides);
      return {
        version: FILE_VERSION,
        overrides,
      };
    } catch (error) {
      if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') {
        return { version: FILE_VERSION, overrides: {} };
      }
      console.warn('Failed to read magic prompts file:', error);
      return { version: FILE_VERSION, overrides: {} };
    }
  };

  const writePromptState = async (state: PromptState): Promise<void> => {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
  };

  const persist = async (mutator: (state: PromptState) => Promise<PromptState>): Promise<PromptState> => {
    const run = async () => {
      const current = await readPromptState();
      const next = await mutator(current);
      await writePromptState(next);
      return next;
    };
    writeLock = writeLock.then(run, run);
    return writeLock;
  };

  const setOverride = async (id: unknown, text: unknown): Promise<PromptState> => {
    const normalizedId = typeof id === 'string' ? id.trim() : '';
    if (!PROMPT_ID_PATTERN.test(normalizedId)) {
      throw new Error('Invalid prompt id');
    }
    if (typeof text !== 'string') {
      throw new Error('Prompt text must be a string');
    }
    if (isVisiblePromptID(normalizedId) && text.trim().length === 0) {
      throw new Error('Visible prompt text cannot be empty');
    }
    if (text.length > MAX_PROMPT_TEXT_LENGTH) {
      throw new Error('Prompt text is too long');
    }

    return persist(async (state) => {
      const nextOverrides = { ...state.overrides, [normalizedId]: text };
      return {
        version: FILE_VERSION,
        overrides: nextOverrides,
      };
    });
  };

  const resetOverride = async (id: unknown): Promise<PromptState> => {
    const normalizedId = typeof id === 'string' ? id.trim() : '';
    if (!PROMPT_ID_PATTERN.test(normalizedId)) {
      throw new Error('Invalid prompt id');
    }

    return persist(async (state) => {
      if (!hasOwn(state.overrides, normalizedId)) {
        return state;
      }
      const nextOverrides = { ...state.overrides };
      delete nextOverrides[normalizedId];
      return {
        version: FILE_VERSION,
        overrides: nextOverrides,
      };
    });
  };

  const resetAllOverrides = async (): Promise<PromptState> => {
    return persist(async () => ({ version: FILE_VERSION, overrides: {} }));
  };

  return {
    readPromptState,
    setOverride,
    resetOverride,
    resetAllOverrides,
  };
};
