interface ResolvedState {
  resolvedOpencodeBinary: string | null;
  resolvedOpencodeBinarySource: string | null;
  useWslForOpencode: boolean;
  resolvedWslBinary: string | null;
  resolvedWslOpencodePath: string | null;
  resolvedWslDistro: string | null;
  resolvedNodeBinary: string | null;
  resolvedBunBinary: string | null;
}

interface ManagedLaunchSpec {
  binary?: string | null;
  args?: string[];
  wrapperType?: string | null;
}

interface OpenCodeResolutionDependencies {
  path: { dirname: (path: string) => string };
  resolveOpencodeCliPath: () => string | null;
  applyOpencodeBinaryFromSettings: () => Promise<unknown>;
  ensureOpencodeCliEnv: () => unknown;
  resolveManagedOpenCodeLaunchSpec: (opencodePath: string) => ManagedLaunchSpec | null;
  getResolvedState: () => ResolvedState;
  setResolvedOpencodeBinarySource: (value: string | null) => void;
}

interface OpenCodeResolutionSettings {
  opencodeBinary?: unknown;
}

export const createOpenCodeResolutionRuntime = (dependencies: OpenCodeResolutionDependencies) => {
  const {
    path,
    resolveOpencodeCliPath,
    applyOpencodeBinaryFromSettings,
    ensureOpencodeCliEnv,
    resolveManagedOpenCodeLaunchSpec,
    getResolvedState,
    setResolvedOpencodeBinarySource,
  } = dependencies;

  const getOpenCodeResolutionSnapshot = async (settings?: OpenCodeResolutionSettings | null) => {
    const configured = typeof settings?.opencodeBinary === 'string' ? settings.opencodeBinary : null;

    const { resolvedOpencodeBinarySource: previousSource } = getResolvedState();
    const detectedNow = resolveOpencodeCliPath();
    const { resolvedOpencodeBinarySource: rawDetectedSourceNow } = getResolvedState();
    setResolvedOpencodeBinarySource(previousSource);

    await applyOpencodeBinaryFromSettings();
    ensureOpencodeCliEnv();

    const {
      resolvedOpencodeBinary,
      resolvedOpencodeBinarySource,
      useWslForOpencode,
      resolvedWslBinary,
      resolvedWslOpencodePath,
      resolvedWslDistro,
      resolvedNodeBinary,
      resolvedBunBinary,
    } = getResolvedState();

    const resolved = resolvedOpencodeBinary || null;
    const source = resolvedOpencodeBinarySource || null;
    const detectedSourceNow =
      detectedNow &&
      resolved &&
      detectedNow === resolved &&
      rawDetectedSourceNow === 'env' &&
      source &&
      source !== 'env'
        ? source
        : rawDetectedSourceNow;
    const launchSpec = resolved && !useWslForOpencode
      ? resolveManagedOpenCodeLaunchSpec(resolved)
      : null;

    return {
      configured,
      resolved,
      resolvedDir: resolved ? path.dirname(resolved) : null,
      source,
      detectedNow,
      detectedSourceNow,
      launchBinary: launchSpec?.binary || null,
      launchArgs: launchSpec?.args || [],
      launchWrapperType: launchSpec?.wrapperType || null,
      viaWsl: useWslForOpencode,
      wslBinary: resolvedWslBinary || null,
      wslPath: resolvedWslOpencodePath || null,
      wslDistro: resolvedWslDistro || null,
      node: resolvedNodeBinary || null,
      bun: resolvedBunBinary || null,
    };
  };

  return {
    getOpenCodeResolutionSnapshot,
  };
};
