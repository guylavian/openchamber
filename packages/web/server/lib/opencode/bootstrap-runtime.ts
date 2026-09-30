import type { Express, Request } from 'express';

import { registerNotificationEmitRoutes } from '../notifications/emit-route.js';
import type { NotificationEmitRouteDependencies, PluginNotificationEmitter } from '../notifications/emit-route.js';
import type { OpenChamberRouteDependencies } from './openchamber-routes.js';
import type { LooseRecord } from './settings-normalization-runtime.js';

interface AgentToolRuntime {
  authorizeRequest?: (req: Request) => boolean;
}

interface SessionRuntime {
  getSessionActivitySnapshot: unknown;
  getSessionStateSnapshot: unknown;
  getPendingBlockingRequestsSnapshot: unknown;
  getSessionAttentionSnapshot: unknown;
  getSessionState: unknown;
  getSessionAttentionState: unknown;
  markSessionViewed: unknown;
  markSessionUnviewed: unknown;
  markUserMessageSent: unknown;
}

interface UiAuthController {
  enabled?: boolean;
}

type ExpressModule = NotificationEmitRouteDependencies['express'];

type RouteRegistrar = (app: Express, dependencies: LooseRecord) => unknown;

export interface BootstrapDependencies {
  createUiAuth: (options: { password: unknown; readSettingsFromDiskMigrated: unknown; clientAuthController: unknown }) => UiAuthController;
  registerServerStatusRoutes: RouteRegistrar;
  registerCommonRequestMiddleware: RouteRegistrar;
  registerAuthAndAccessRoutes: RouteRegistrar;
  registerTtsRoutes: RouteRegistrar;
  registerNotificationRoutes: RouteRegistrar;
  registerOpenChamberRoutes: (app: Express, dependencies: OpenChamberRouteDependencies & { os: typeof import('node:os') }) => unknown;
  registerAgentToolRoutes?: (app: Express, options: { express: ExpressModule; agentToolRuntime: AgentToolRuntime | undefined }) => unknown;
  express: ExpressModule;
}

export interface BootstrapOptions {
  openchamberVersion: unknown;
  runtimeName: unknown;
  serverStartedAt: unknown;
  gracefulShutdown: unknown;
  getHealthSnapshot: unknown;
  getServerPort: unknown;
  getTunnelUrl: unknown;
  verboseRequestLogs: unknown;
  uiPassword: unknown;
  tunnelAuthController: unknown;
  remoteClientAuthRuntime: unknown;
  clientPairingRuntime: unknown;
  getRelayPairingCandidate: unknown;
  reconcileRelay: unknown;
  getPairingTransports: unknown;
  getDirectCandidateUrls: unknown;
  getServerId: unknown;
  getServerLabel: unknown;
  readSettingsFromDiskMigrated: unknown;
  normalizeTunnelSessionTtlMs: unknown;
  sayTTSCapability: unknown;
  ensurePushInitialized: unknown;
  ensureGlobalWatcherStarted: unknown;
  getOrCreateVapidKeys: unknown;
  getUiSessionTokenFromRequest: unknown;
  writeSettingsToDisk: unknown;
  addOrUpdatePushSubscription: unknown;
  removePushSubscription: unknown;
  addOrUpdateApnsToken: unknown;
  removeApnsToken: unknown;
  updateUiVisibility: unknown;
  clearPendingPushBadge: unknown;
  isUiVisible: unknown;
  getUiNotificationClients: unknown;
  writeSseEvent: unknown;
  setPushInitialized: unknown;
  setAutoAcceptSession: unknown;
  skipBodyParsing: unknown;
  process: OpenChamberRouteDependencies['process'];
  fs: OpenChamberRouteDependencies['fs'];
  os: typeof import('node:os');
  path: OpenChamberRouteDependencies['path'];
  server: OpenChamberRouteDependencies['server'];
  __dirname: string;
  openchamberDataDir: string;
  modelsDevApiUrl: string;
  modelsMetadataCacheTtl: number;
  fetchFreeZenModels: OpenChamberRouteDependencies['fetchFreeZenModels'];
  getCachedZenModels: OpenChamberRouteDependencies['getCachedZenModels'];
  desktopUpdater: OpenChamberRouteDependencies['desktopUpdater'];
  pluginNotificationEmitter: PluginNotificationEmitter;
  agentToolRuntime: AgentToolRuntime | undefined;
  sessionRuntime: SessionRuntime;
}

export const createBootstrapRuntime = (dependencies: BootstrapDependencies) => {
  const {
    createUiAuth,
    registerServerStatusRoutes,
    registerCommonRequestMiddleware,
    registerAuthAndAccessRoutes,
    registerTtsRoutes,
    registerNotificationRoutes,
    registerOpenChamberRoutes,
    registerAgentToolRoutes = () => {},
    express,
  } = dependencies;

  const setupBaseRoutes = (app: Express, options: BootstrapOptions) => {
    const {
      process,
      openchamberVersion,
      runtimeName,
      serverStartedAt,
      gracefulShutdown,
      getHealthSnapshot,
      getServerPort,
      getTunnelUrl,
      verboseRequestLogs,
      uiPassword,
      tunnelAuthController,
      remoteClientAuthRuntime,
      clientPairingRuntime,
      getRelayPairingCandidate,
      reconcileRelay,
      getPairingTransports,
      getDirectCandidateUrls,
      getServerId,
      getServerLabel,
      readSettingsFromDiskMigrated,
      normalizeTunnelSessionTtlMs,
      sayTTSCapability,
      ensurePushInitialized,
      ensureGlobalWatcherStarted,
      getOrCreateVapidKeys,
      getUiSessionTokenFromRequest,
      writeSettingsToDisk,
      addOrUpdatePushSubscription,
      removePushSubscription,
      addOrUpdateApnsToken,
      removeApnsToken,
      updateUiVisibility,
      clearPendingPushBadge,
      isUiVisible,
      getUiNotificationClients,
      writeSseEvent,
      sessionRuntime,
      setPushInitialized,
      fs,
      os,
      path,
      server,
      __dirname,
      openchamberDataDir,
      modelsDevApiUrl,
      modelsMetadataCacheTtl,
      fetchFreeZenModels,
      getCachedZenModels,
      setAutoAcceptSession,
      agentToolRuntime,
      pluginNotificationEmitter,
      desktopUpdater,
      skipBodyParsing,
    } = options;

    const uiAuthController = createUiAuth({
      password: uiPassword,
      readSettingsFromDiskMigrated,
      clientAuthController: remoteClientAuthRuntime,
    });
    if (uiAuthController.enabled) {
      console.log('UI password protection enabled for browser sessions');
    }

    registerServerStatusRoutes(app, {
      express,
      process,
      openchamberVersion,
      runtimeName,
      serverStartedAt,
      gracefulShutdown,
      getHealthSnapshot,
      getServerId,
      getServerPort,
      getTunnelUrl,
      tunnelAuthController,
      uiAuthController,
    });

    registerCommonRequestMiddleware(app, { express, verboseRequestLogs, skipBodyParsing });

    registerAgentToolRoutes(app, { express, agentToolRuntime });

    const notificationEmitRoutes = registerNotificationEmitRoutes(app, {
      express,
      isAgentToolRequestAuthorized: (req: Request) => agentToolRuntime?.authorizeRequest?.(req) === true,
      emitter: pluginNotificationEmitter,
    });
    notificationEmitRoutes.registerPluginRoute();

    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController,
      uiAuthController,
      remoteClientAuthRuntime,
      clientPairingRuntime,
      getRelayPairingCandidate,
      reconcileRelay,
      getPairingTransports,
      getDirectCandidateUrls,
      getServerId,
      getServerLabel,
      readSettingsFromDiskMigrated,
      normalizeTunnelSessionTtlMs,
    });

    notificationEmitRoutes.registerApiRoute();

    registerTtsRoutes(app, { sayTTSCapability });

    registerNotificationRoutes(app, {
      uiAuthController,
      ensurePushInitialized,
      ensureGlobalWatcherStarted,
      getOrCreateVapidKeys,
      getUiSessionTokenFromRequest,
      readSettingsFromDiskMigrated,
      writeSettingsToDisk,
      addOrUpdatePushSubscription,
      removePushSubscription,
      addOrUpdateApnsToken,
      removeApnsToken,
      updateUiVisibility,
      clearPendingPushBadge,
      isUiVisible,
      getUiNotificationClients,
      writeSseEvent,
      getSessionActivitySnapshot: sessionRuntime.getSessionActivitySnapshot,
      getSessionStateSnapshot: sessionRuntime.getSessionStateSnapshot,
      getPendingBlockingRequestsSnapshot: sessionRuntime.getPendingBlockingRequestsSnapshot,
      getSessionAttentionSnapshot: sessionRuntime.getSessionAttentionSnapshot,
      getSessionState: sessionRuntime.getSessionState,
      getSessionAttentionState: sessionRuntime.getSessionAttentionState,
      markSessionViewed: sessionRuntime.markSessionViewed,
      markSessionUnviewed: sessionRuntime.markSessionUnviewed,
      markUserMessageSent: sessionRuntime.markUserMessageSent,
      setPushInitialized,
      setAutoAcceptSession,
    });

    registerOpenChamberRoutes(app, {
      fs,
      os,
      path,
      process,
      server,
      __dirname,
      openchamberDataDir,
      modelsDevApiUrl,
      modelsMetadataCacheTtl,
      readSettingsFromDiskMigrated,
      fetchFreeZenModels,
      getCachedZenModels,
      desktopUpdater,
    });

    return {
      uiAuthController,
    };
  };

  return {
    setupBaseRoutes,
  };
};
