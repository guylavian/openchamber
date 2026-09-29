import { OpenCode } from '@opencode/client';
import type { ModelInfo, OpenCodeClient, ProviderInfo } from '@opencode/client';

interface OpenCodeConnection {
  buildOpenCodeUrl: (path: string, query: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
}

interface DefaultModelPayload extends Partial<ModelInfo> {
  data?: ModelInfo | null;
}

// The running OpenCode instance is the only transport this module has. It is
// wired once from `server/index.js`, and re-read on every call because the
// port and the server password both move across an OpenCode restart.
let connection: OpenCodeConnection | null = null;

/**
 * Wires this module to the running OpenCode instance. Pass `null` to detach.
 * Until it is wired, every lookup answers "no client", which the callers
 * report as "no small model available" rather than guessing.
 */
export function configureOpenCodeRuntimeProviders(next: OpenCodeConnection | null | undefined): void {
  connection = next ?? null;
}

/**
 * Drops anything cached about the running instance. An OpenCode restart can
 * change the port, the password and the model list.
 */
export function resetOpenCodeRuntimeProviders(): void {
  modelCache = null;
  modelCacheKey = '';
  modelCacheAt = 0;
}

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

/**
 * A `@opencode/client` bound to the running instance and scoped to
 * `directory`, or `null` when OpenCode is not reachable yet.
 *
 * Built per call on purpose: `OpenCode.make` only closes over a base URL and
 * headers, and both change when OpenCode restarts.
 */
export function getSmallModelClient(directory?: string | null): OpenCodeClient | null {
  if (!connection) return null;
  let baseUrl: string;
  try {
    baseUrl = stripTrailingSlash(connection.buildOpenCodeUrl('', ''));
  } catch {
    // The port is not known yet — OpenCode has not finished starting.
    return null;
  }
  const headers = { ...connection.getOpenCodeAuthHeaders() };
  if (typeof directory === 'string' && directory.trim()) {
    headers['x-opencode-directory'] = encodeURIComponent(directory.trim());
  }
  return OpenCode.make({ baseUrl, headers });
}

const MODEL_CACHE_TTL_MS = 30_000;
let modelCache: ModelInfo[] | null = null;
let modelCacheKey = '';
let modelCacheAt = 0;

const unwrap = <T>(payload: { data?: T[] | null } | null | undefined): T[] => (Array.isArray(payload?.data) ? payload.data : []);

/**
 * Every model the running OpenCode knows about for `directory`.
 *
 * Cached briefly: a generation needs the model's context and output limits,
 * and paying a round trip for them on every title or summary would be the
 * wrong trade. An empty array means "asked and got nothing", so callers fall
 * back to conservative defaults rather than refusing.
 */
export async function listModelInfos(client: OpenCodeClient, directory?: string | null): Promise<ModelInfo[]> {
  const key = typeof directory === 'string' ? directory : '';
  if (modelCache && modelCacheKey === key && Date.now() - modelCacheAt < MODEL_CACHE_TTL_MS) {
    return modelCache;
  }
  try {
    const models = unwrap(await client.model.list());
    modelCache = models;
    modelCacheKey = key;
    modelCacheAt = Date.now();
    return models;
  } catch {
    // Keep the previous answer for this directory when there is one: a
    // momentarily unreachable OpenCode must not retract model limits.
    return modelCacheKey === key && modelCache ? modelCache : [];
  }
}

export async function listProviderInfos(client: OpenCodeClient): Promise<ProviderInfo[]> {
  try {
    return unwrap(await client.provider.list());
  } catch {
    return [];
  }
}

/**
 * The model OpenCode would pick on its own, or `null` when it cannot say.
 */
export async function getDefaultModelInfo(client: OpenCodeClient): Promise<ModelInfo | null> {
  try {
    const payload: DefaultModelPayload | null | undefined = await client.model.default();
    const info = payload?.data ?? payload;
    return info && typeof info === 'object' && typeof info.id === 'string' ? (info as ModelInfo) : null;
  } catch {
    return null;
  }
}

/**
 * The model entry for a `provider/model` reference. `id` is the catalog key a
 * reference holds; `modelID` is the provider API name, shared by derived
 * entries (`gpt-6-luna` and `gpt-6-luna-fast`), so an exact `id` match wins.
 */
export function findModelInfo(models: ModelInfo[], providerID: string, modelID: string): ModelInfo | null {
  const ofProvider = models.filter((model) => model?.providerID === providerID);
  return ofProvider.find((model) => model.id === modelID)
    ?? ofProvider.find((model) => model.modelID === modelID)
    ?? null;
}
