import type cryptoModule from 'node:crypto';
import type fsModule from 'node:fs/promises';
import type { IncomingHttpHeaders } from 'node:http';
import type { PlatformPath } from 'node:path';

export type ClientTransport = 'relay' | 'direct';

export interface RemoteClientRecord {
  id: string;
  label: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  clientKind: string | null;
  dedupeKey: string | null;
  usesRelay: boolean;
  lastTransport?: ClientTransport | null;
  authMethod: string | null;
  pairingId: string | null;
  deviceName: string | null;
  devicePlatform: string | null;
  deviceModel: string | null;
  appVersion: string | null;
}

export interface RemoteClientStore {
  version: number;
  clients: RemoteClientRecord[];
}

export type ClientStoreFs = Pick<typeof fsModule, 'readFile' | 'mkdir' | 'writeFile'> & Partial<Pick<typeof fsModule, 'chmod'>>;
export type ClientCrypto = Pick<typeof cryptoModule, 'createHash' | 'randomBytes' | 'timingSafeEqual'>;

export interface RemoteClientAuthDeps {
  fsPromises: ClientStoreFs;
  path: Pick<PlatformPath, 'dirname'>;
  crypto: ClientCrypto;
  storePath: string;
}

export interface CreateClientInput {
  label?: unknown;
  fallbackLabel?: unknown;
  expiresAt?: unknown;
  clientKind?: unknown;
  dedupeKey?: unknown;
  authMethod?: unknown;
  pairingId?: unknown;
  deviceName?: unknown;
  devicePlatform?: unknown;
  deviceModel?: unknown;
  appVersion?: unknown;
  usesRelay?: unknown;
}

const STORE_VERSION = 1;
const TOKEN_PREFIX = 'oc_client_';
const TOKEN_BYTES = 32;
const MAX_LABEL_LENGTH = 80;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

const normalizeLabel = (value: unknown): string => {
  if (typeof value !== 'string') return 'Remote client';
  const trimmed = value.trim();
  if (!trimmed) return 'Remote client';
  return trimmed.length > MAX_LABEL_LENGTH ? trimmed.slice(0, MAX_LABEL_LENGTH) : trimmed;
};

const normalizeTimestamp = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const time = Date.parse(trimmed);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeMetadata = (client: Record<string, unknown>) => ({
  authMethod: normalizeOptionalString(client.authMethod),
  pairingId: normalizeOptionalString(client.pairingId),
  deviceName: normalizeOptionalString(client.deviceName),
  devicePlatform: normalizeOptionalString(client.devicePlatform),
  deviceModel: normalizeOptionalString(client.deviceModel),
  appVersion: normalizeOptionalString(client.appVersion),
});

const safeJsonParse = (raw: string): { clients?: unknown } | null => {
  try {
    return JSON.parse(raw) as { clients?: unknown } | null;
  } catch {
    return null;
  }
};

const constantTimeEqual = (left: unknown, right: unknown, crypto: ClientCrypto): boolean => {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

export const createRemoteClientAuthRuntime = ({ fsPromises, path, crypto, storePath }: RemoteClientAuthDeps) => {
  const hashToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');
  const nowIso = () => new Date().toISOString();
  const generateId = () => crypto.randomBytes(12).toString('hex');
  const generateToken = () => `${TOKEN_PREFIX}${crypto.randomBytes(TOKEN_BYTES).toString('base64url')}`;
  let storeMutationQueue = Promise.resolve();

  const withStoreMutation = async <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = storeMutationQueue;
    let release!: () => void;
    storeMutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };

  const normalizeStore = (payload: { clients?: unknown } | null): RemoteClientStore => ({
    version: STORE_VERSION,
    clients: Array.isArray(payload?.clients)
      ? payload.clients
        .filter((client: unknown) => client && typeof client === 'object')
        .map((client: Record<string, unknown>): RemoteClientRecord => ({
          id: typeof client.id === 'string' ? client.id : generateId(),
          label: normalizeLabel(client.label),
          tokenHash: typeof client.tokenHash === 'string' ? client.tokenHash : '',
          createdAt: typeof client.createdAt === 'string' ? client.createdAt : nowIso(),
          lastUsedAt: typeof client.lastUsedAt === 'string' ? client.lastUsedAt : null,
          revokedAt: typeof client.revokedAt === 'string' ? client.revokedAt : null,
          expiresAt: normalizeTimestamp(client.expiresAt),
          clientKind: normalizeOptionalString(client.clientKind),
          dedupeKey: normalizeOptionalString(client.dedupeKey),
          usesRelay: client.usesRelay === true,
          lastTransport: client.lastTransport === 'relay' || client.lastTransport === 'direct' ? client.lastTransport : null,
          ...normalizeMetadata(client),
        }))
        .filter((client) => client.tokenHash.length > 0)
      : [],
  });

  const readStore = async () => {
    try {
      const raw = await fsPromises.readFile(storePath, 'utf8');
      return normalizeStore(safeJsonParse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return normalizeStore(null);
      throw error;
    }
  };

  const writeStore = async (store: RemoteClientStore): Promise<void> => {
    await fsPromises.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
    await fsPromises.writeFile(storePath, JSON.stringify(normalizeStore(store), null, 2), { mode: 0o600 });
    if (typeof fsPromises.chmod === 'function') {
      await fsPromises.chmod(storePath, 0o600).catch(() => {});
    }
  };

  const publicClient = (client: RemoteClientRecord) => ({
    id: client.id,
    label: client.label,
    createdAt: client.createdAt,
    lastUsedAt: client.lastUsedAt,
    revokedAt: client.revokedAt,
    expiresAt: client.expiresAt,
    clientKind: client.clientKind,
    authMethod: client.authMethod,
    pairingId: client.pairingId,
    deviceName: client.deviceName,
    devicePlatform: client.devicePlatform,
    deviceModel: client.deviceModel,
    appVersion: client.appVersion,
    usesRelay: client.usesRelay === true,
    lastTransport: client.lastTransport ?? null,
  });

  const listClients = async () => {
    return withStoreMutation(async () => {
      const store = await readStore();
      return store.clients.map(publicClient);
    });
  };

  // Relay-transport demand from paired devices: any non-revoked, non-expired
  // client that was paired over the relay OR was actually observed connecting
  // through the relay tunnel (lastTransport). The observed transport is the
  // authoritative signal — it covers records written before usesRelay existed
  // and devices re-paired via a QR that carried no relay candidate.
  const hasActiveRelayClients = async () => {
    return withStoreMutation(async () => {
      const store = await readStore();
      const now = Date.now();
      return store.clients.some((client) => {
        if (client.usesRelay !== true && client.lastTransport !== 'relay') return false;
        if (client.revokedAt) return false;
        const expires = Date.parse(client.expiresAt || '');
        return !Number.isFinite(expires) || expires > now;
      });
    });
  };

  const createClient = async ({
    label,
    fallbackLabel,
    expiresAt,
    clientKind,
    dedupeKey,
    authMethod,
    pairingId,
    deviceName,
    devicePlatform,
    deviceModel,
    appVersion,
    usesRelay,
  }: CreateClientInput = {}) => {
    return withStoreMutation(async () => {
      const store = await readStore();
      const normalizedDedupeKey = normalizeOptionalString(dedupeKey);
      const token = generateToken();
      // A dedupe-keyed mint REPLACES the previous record for the same device,
      // so an operator-visible name must survive the replacement: an explicit
      // label wins, otherwise the replaced record's label is kept, and only a
      // first-ever mint falls back to the client-reported default.
      const existing = normalizedDedupeKey
        ? store.clients.find((entry) => entry.dedupeKey === normalizedDedupeKey)
        : null;
      const client: RemoteClientRecord = {
        id: generateId(),
        label: normalizeLabel(normalizeOptionalString(label) || existing?.label || fallbackLabel),
        tokenHash: hashToken(token),
        createdAt: nowIso(),
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: normalizeTimestamp(expiresAt),
        clientKind: normalizeOptionalString(clientKind),
        dedupeKey: normalizedDedupeKey,
        authMethod: normalizeOptionalString(authMethod),
        pairingId: normalizeOptionalString(pairingId),
        deviceName: normalizeOptionalString(deviceName),
        devicePlatform: normalizeOptionalString(devicePlatform),
        deviceModel: normalizeOptionalString(deviceModel),
        appVersion: normalizeOptionalString(appVersion),
        usesRelay: usesRelay === true,
      };
      if (normalizedDedupeKey) {
        store.clients = store.clients.filter((entry) => entry.dedupeKey !== normalizedDedupeKey);
        // Migrate pre-clientKind desktop tokens: a deduped, kind-tagged mint
        // supersedes legacy records with the same label that carry neither a
        // kind nor a dedupe key — those tokens can no longer pass the
        // desktop-local client-create gate and would otherwise linger forever.
        if (client.clientKind) {
          store.clients = store.clients.filter((entry) =>
            !(entry.label === client.label && !entry.clientKind && !entry.dedupeKey));
        }
      }
      store.clients.push(client);
      await writeStore(store);
      return { client: publicClient(client), token };
    });
  };

  const revokeClient = async (id: unknown) => {
    if (typeof id !== 'string' || id.trim().length === 0) {
      return { revoked: false };
    }
    return withStoreMutation(async () => {
      const store = await readStore();
      const client = store.clients.find((entry) => entry.id === id);
      if (!client) return { revoked: false };
      if (!client.revokedAt) client.revokedAt = nowIso();
      await writeStore(store);
      return { revoked: true, client: publicClient(client) };
    });
  };

  const purgeRevokedClients = async () => {
    return withStoreMutation(async () => {
      const store = await readStore();
      const before = store.clients.length;
      store.clients = store.clients.filter((entry) => !entry.revokedAt);
      const purged = before - store.clients.length;
      if (purged > 0) {
        await writeStore(store);
      }
      return { purged };
    });
  };

  const authenticateBearerToken = async (token: unknown, req?: { headers?: IncomingHttpHeaders } | null) => {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) {
      return null;
    }
    // Which transport carried this request: the relay tunnel proxy stamps every
    // forwarded request with x-openchamber-relay-connection; anything else is a
    // direct (local/LAN/tunnel-URL) request. Feeds device display AND relay
    // demand (hasActiveRelayClients), so a relay request must never be
    // misclassified as direct.
    const transport = req?.headers?.['x-openchamber-relay-connection'] ? 'relay' : 'direct';
    return withStoreMutation(async () => {
      const tokenHash = hashToken(token);
      const store = await readStore();
      const client = store.clients.find((entry) => !entry.revokedAt && constantTimeEqual(entry.tokenHash, tokenHash, crypto));
      if (!client) return null;
      if (client.expiresAt && Date.parse(client.expiresAt) <= Date.now()) return null;
      const now = Date.now();
      const lastUsedAt = Date.parse(client.lastUsedAt || '');
      // Self-heal the paired-over-relay flag from the authoritative signal: a
      // request that arrived through the tunnel proves this device uses the
      // relay, regardless of what the pairing-time snapshot recorded. Sticky on
      // purpose — a later LAN request must not turn the relay host off again.
      const healUsesRelay = transport === 'relay' && client.usesRelay !== true;
      if (healUsesRelay) client.usesRelay = true;
      // Write on the throttle interval — or immediately when the transport
      // changed, so a LAN⇄relay switch is visible right away, not a minute late.
      if (healUsesRelay || !Number.isFinite(lastUsedAt) || now - lastUsedAt >= LAST_USED_WRITE_INTERVAL_MS || client.lastTransport !== transport) {
        client.lastUsedAt = new Date(now).toISOString();
        client.lastTransport = transport;
        await writeStore(store);
      }
      return { ok: true, clientId: client.id, sessionToken: client.id, client: publicClient(client) };
    });
  };

  return {
    authenticateBearerToken,
    createClient,
    listClients,
    hasActiveRelayClients,
    purgeRevokedClients,
    revokeClient,
  };
};

export type RemoteClientAuthRuntime = ReturnType<typeof createRemoteClientAuthRuntime>;
