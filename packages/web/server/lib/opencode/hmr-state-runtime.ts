import type { ChildProcess } from 'node:child_process';

interface HmrState {
  openCodeProcess: ChildProcess | null;
  openCodePort: number | null;
  openCodeBaseUrl?: string | null;
  openCodeWorkingDirectory: string;
  isShuttingDown: boolean;
  signalsAttached: boolean;
  userProvidedOpenCodePassword: string | null | undefined;
  openCodeAuthPassword: string | null;
  openCodeAuthSource: string | null;
}

interface OpenCodeRuntimeState {
  openCodeProcess: ChildProcess | null;
  openCodePort: number | null;
  openCodeBaseUrl: string | null;
  isShuttingDown: boolean;
  signalsAttached: boolean;
  openCodeWorkingDirectory: string;
  openCodeAuthPassword: string | null;
  openCodeAuthSource: string | null;
}

interface OpenCodeAuthState {
  openCodeAuthPassword: string | null;
  openCodeAuthSource: string | null;
}

interface HmrAuthInput {
  hmrState: HmrState;
  userProvidedOpenCodePassword: string | null;
}

interface HmrStateDependencies {
  globalThisLike: Record<string, HmrState | undefined>;
  os: { homedir: () => string };
  processLike: { env: NodeJS.ProcessEnv };
  stateKey: string;
}

export const createHmrStateRuntime = (dependencies: HmrStateDependencies) => {
  const {
    globalThisLike,
    os,
    processLike,
    stateKey,
  } = dependencies;

  const getInitialOpenCodeWorkingDirectory = () => {
    const configured = typeof processLike.env.OPENCHAMBER_OPENCODE_CWD === 'string'
      ? processLike.env.OPENCHAMBER_OPENCODE_CWD.trim()
      : '';
    return configured || os.homedir();
  };

  const getOrCreateHmrState = (): HmrState => {
    if (!globalThisLike[stateKey]) {
      globalThisLike[stateKey] = {
        openCodeProcess: null,
        openCodePort: null,
        openCodeWorkingDirectory: getInitialOpenCodeWorkingDirectory(),
        isShuttingDown: false,
        signalsAttached: false,
        userProvidedOpenCodePassword: undefined,
        openCodeAuthPassword: null,
        openCodeAuthSource: null,
      };
    }
    return globalThisLike[stateKey];
  };

  const ensureUserProvidedOpenCodePassword = (hmrState: HmrState): void => {
    if (typeof hmrState.userProvidedOpenCodePassword !== 'undefined') {
      return;
    }
    const initialPassword = typeof processLike.env.OPENCODE_SERVER_PASSWORD === 'string'
      ? processLike.env.OPENCODE_SERVER_PASSWORD.trim()
      : '';
    hmrState.userProvidedOpenCodePassword = initialPassword || null;
  };

  const getUserProvidedOpenCodePassword = (hmrState: HmrState): string | null => (
    typeof hmrState.userProvidedOpenCodePassword === 'string' && hmrState.userProvidedOpenCodePassword.length > 0
      ? hmrState.userProvidedOpenCodePassword
      : null
  );

  const resolveOpenCodeAuthFromState = ({ hmrState, userProvidedOpenCodePassword }: HmrAuthInput): OpenCodeAuthState => ({
    openCodeAuthPassword:
      typeof hmrState.openCodeAuthPassword === 'string' && hmrState.openCodeAuthPassword.length > 0
        ? hmrState.openCodeAuthPassword
        : userProvidedOpenCodePassword,
    openCodeAuthSource:
      typeof hmrState.openCodeAuthSource === 'string' && hmrState.openCodeAuthSource.length > 0
        ? hmrState.openCodeAuthSource
        : (userProvidedOpenCodePassword ? 'user-env' : null),
  });

  const syncStateFromRuntime = (hmrState: HmrState, runtime: OpenCodeRuntimeState): void => {
    hmrState.openCodeProcess = runtime.openCodeProcess;
    hmrState.openCodePort = runtime.openCodePort;
    hmrState.openCodeBaseUrl = runtime.openCodeBaseUrl;
    hmrState.isShuttingDown = runtime.isShuttingDown;
    hmrState.signalsAttached = runtime.signalsAttached;
    hmrState.openCodeWorkingDirectory = runtime.openCodeWorkingDirectory;
    hmrState.openCodeAuthPassword = runtime.openCodeAuthPassword;
    hmrState.openCodeAuthSource = runtime.openCodeAuthSource;
  };

  const restoreRuntimeFromState = ({ hmrState, userProvidedOpenCodePassword }: HmrAuthInput): OpenCodeRuntimeState => {
    const auth = resolveOpenCodeAuthFromState({ hmrState, userProvidedOpenCodePassword });
    return {
      openCodeProcess: hmrState.openCodeProcess,
      openCodePort: hmrState.openCodePort,
      openCodeBaseUrl: hmrState.openCodeBaseUrl ?? null,
      isShuttingDown: hmrState.isShuttingDown,
      signalsAttached: hmrState.signalsAttached,
      openCodeWorkingDirectory: hmrState.openCodeWorkingDirectory,
      openCodeAuthPassword: auth.openCodeAuthPassword,
      openCodeAuthSource: auth.openCodeAuthSource,
    };
  };

  return {
    getOrCreateHmrState,
    ensureUserProvidedOpenCodePassword,
    getUserProvidedOpenCodePassword,
    resolveOpenCodeAuthFromState,
    syncStateFromRuntime,
    restoreRuntimeFromState,
  };
};
