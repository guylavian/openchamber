interface StartServerOptions {
  port: number;
  host: string | undefined;
  tryCfTunnel: boolean;
  tunnelProvider: string | undefined;
  tunnelMode: string | undefined;
  tunnelConfigPath: string | null | undefined;
  tunnelToken: string | undefined;
  tunnelHostname: string | undefined;
  attachSignals: boolean;
  exitOnShutdown: boolean;
  uiPassword: string | null;
  apiOnly: boolean;
}

type ServeCliOptions = Omit<StartServerOptions, 'attachSignals' | 'exitOnShutdown'>;

interface ParseServeCliOptionsInput {
  argv: string[];
  env: NodeJS.ProcessEnv;
  defaultPort: number;
  cloudflareProvider: string;
  managedLocalMode: string;
}

interface CliEntryDependencies {
  process: { argv: string[]; env: NodeJS.ProcessEnv; exit: (code: number) => void };
  currentFilename: string;
  parseServeCliOptions: (input: ParseServeCliOptionsInput) => ServeCliOptions;
  defaultPort: number;
  cloudflareProvider: string;
  managedLocalMode: string;
  setExitOnShutdown: (value: boolean) => void;
  startServer: (options: StartServerOptions) => Promise<unknown>;
}

export const runCliEntryIfMain = (dependencies: CliEntryDependencies): void => {
  const {
    process,
    currentFilename,
    parseServeCliOptions,
    defaultPort,
    cloudflareProvider,
    managedLocalMode,
    setExitOnShutdown,
    startServer,
  } = dependencies;

  const isCliExecution = process.argv[1] === currentFilename;
  if (!isCliExecution) {
    return;
  }

  const cliOptions = parseServeCliOptions({
    argv: process.argv.slice(2),
    env: process.env,
    defaultPort,
    cloudflareProvider,
    managedLocalMode,
  });

  setExitOnShutdown(true);
  startServer({
    port: cliOptions.port,
    host: cliOptions.host,
    tryCfTunnel: cliOptions.tryCfTunnel,
    tunnelProvider: cliOptions.tunnelProvider,
    tunnelMode: cliOptions.tunnelMode,
    tunnelConfigPath: cliOptions.tunnelConfigPath,
    tunnelToken: cliOptions.tunnelToken,
    tunnelHostname: cliOptions.tunnelHostname,
    attachSignals: true,
    exitOnShutdown: true,
    uiPassword: cliOptions.uiPassword,
    apiOnly: cliOptions.apiOnly,
  }).catch((error: unknown) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
};
