// Minimal settings.json access for CLI contexts (connect-url, pairing
// candidate building) that must not load the full web settings runtime.
//
// The running app already treats settings.json as a shared store — the relay
// identity, tunnels, notifications, the Electron main, and ssh-manager all
// read-modify-write it. This accessor must therefore mirror the settings
// runtime's guarantees or it will corrupt or regenerate shared state:
//
//   - ATOMIC writes (write tmp, rename into place). A plain writeFile can
//     interleave with a concurrent reader in the running app; the reader sees
//     a half-written file, its lenient read maps it to `{}`, and relay
//     identity logic then mints a NEW serverId — orphaning every paired
//     device. The tmp+rename below means no reader can ever observe a partial
//     file.
//
//   - A STRICT read that THROWS on corrupt/unreadable payloads, gating relay
//     identity regeneration. Only a genuinely missing file means "no
//     settings"; any other failure (corrupt JSON, EACCES, transient I/O,
//     non-object payload) must propagate so callers never confuse a broken
//     read with first run and mint a replacement signing/encryption keypair.

type SettingsRecord = Record<string, unknown>;

interface SettingsFs {
  readFile: (path: string, encoding: 'utf8') => Promise<string>;
  rename: (oldPath: string, newPath: string) => Promise<unknown>;
  copyFile: (src: string, dest: string) => Promise<unknown>;
  rm: (path: string, options: { force: boolean }) => Promise<unknown>;
  mkdir: (path: string, options: { recursive: boolean }) => Promise<unknown>;
  writeFile: (path: string, data: string, options: { encoding: 'utf8'; mode: number }) => Promise<unknown>;
  chmod: (path: string, mode: number) => Promise<unknown>;
}

interface SettingsPath {
  join: (...paths: string[]) => string;
  dirname: (path: string) => string;
}

export interface SettingsAccessorsDeps {
  fsPromises: SettingsFs;
  path: SettingsPath;
  dataDir: string;
  settingsFileName: string;
}

export interface SettingsAccessors {
  readSettingsFromDiskMigrated: () => Promise<SettingsRecord>;
  readSettingsStrict: () => Promise<SettingsRecord>;
  writeSettingsToDisk: (settings: SettingsRecord) => Promise<void>;
}

export const createSettingsAccessors = ({ fsPromises, path, dataDir, settingsFileName }: SettingsAccessorsDeps): SettingsAccessors => {
  const settingsPath = path.join(dataDir, settingsFileName);

  const readSettingsFromDiskMigrated = async () => {
    try {
      return JSON.parse(await fsPromises.readFile(settingsPath, 'utf8')) as SettingsRecord;
    } catch {
      return {};
    }
  };

  const readSettingsStrict = async () => {
    let raw: string;
    try {
      raw = await fsPromises.readFile(settingsPath, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') {
        return {};
      }
      throw error;
    }
    const corruptSettingsError = (cause: unknown) =>
      new Error(`Settings file is corrupt or unreadable: ${settingsPath} (fix or remove it, then retry)`, { cause });

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw corruptSettingsError(error);
    }
    if (!parsed || typeof parsed !== 'object') {
      throw corruptSettingsError(new Error('non-object payload'));
    }
    return parsed as SettingsRecord;
  };

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const isTransientWindowsReplaceError = (error: unknown): boolean => {
    if (process.platform !== 'win32' || !error || typeof error !== 'object') {
      return false;
    }
    return (error as { code?: unknown }).code === 'EPERM' || (error as { code?: unknown }).code === 'EACCES' || (error as { code?: unknown }).code === 'EBUSY';
  };

  const replaceFile = async (tmp: string, target: string): Promise<void> => {
    const maxAttempts = process.platform === 'win32' ? 6 : 1;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await fsPromises.rename(tmp, target);
        return;
      } catch (error) {
        lastError = error;
        if (!isTransientWindowsReplaceError(error) || attempt === maxAttempts) {
          break;
        }
        await sleep(25 * attempt);
      }
    }

    if (!isTransientWindowsReplaceError(lastError)) {
      throw lastError;
    }

    // Windows can transiently reject the atomic replace while another process
    // briefly holds the target open. Fall back to copying the COMPLETE tmp file
    // so persistence never wedges. Note: copyFile is NOT atomic — this is a
    // last-resort path confined to Windows, matching the settings runtime's
    // fallback, not a substitute for the atomic rename used everywhere else.
    await fsPromises.copyFile(tmp, target);
    await fsPromises.rm(tmp, { force: true });
  };

  const writeSettingsToDisk = async (settings: SettingsRecord): Promise<void> => {
    await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
    const tmp = `${settingsPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fsPromises.writeFile(tmp, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') {
      await fsPromises.chmod(tmp, 0o600);
    }
    await replaceFile(tmp, settingsPath);
    if (process.platform !== 'win32') {
      await fsPromises.chmod(settingsPath, 0o600);
    }
  };

  return { readSettingsFromDiskMigrated, readSettingsStrict, writeSettingsToDisk };
};
