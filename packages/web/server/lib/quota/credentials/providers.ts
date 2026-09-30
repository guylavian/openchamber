import { deleteQuotaCredential, readQuotaCredential, writeQuotaCredential } from './store.js';

interface CredentialInput {
  usageToken?: unknown;
  cookie?: unknown;
  accessToken?: unknown;
  refreshToken?: unknown;
}

type CredentialValue = CredentialInput | null | undefined;

const clean = (value: unknown) => typeof value === 'string' && !/[\r\n]/.test(value) ? value.trim() : '';

export const normalizers: Record<string, (value: CredentialValue) => Record<string, string> | null> = {
  'exe-dev': (value: CredentialValue) => {
    const usageToken = clean(value?.usageToken);
    return usageToken ? { usageToken } : null;
  },
  'ollama-cloud': (value: CredentialValue) => {
    const cookie = clean(value?.cookie);
    return cookie ? { cookie } : null;
  },
  cursor: (value: CredentialValue) => {
    const accessToken = clean(value?.accessToken);
    const refreshToken = clean(value?.refreshToken);
    return accessToken || refreshToken ? { accessToken, refreshToken } : null;
  },
};

export const readManagedCredential = (providerId: string) => {
  const normalize = normalizers[providerId];
  return normalize ? readQuotaCredential(providerId, normalize) as Record<string, string> | null : null;
};

export const writeManagedCredential = (providerId: string, value: CredentialValue) => {
  const credential = normalizers[providerId]?.(value);
  if (!credential) throw new Error('Invalid credential');
  writeQuotaCredential(providerId, credential);
  return getManagedCredentialStatus(providerId);
};

export const getManagedCredentialStatus = (providerId: string) => {
  const credential = readManagedCredential(providerId);
  if (!credential) return { configured: false };
  if (providerId === 'cursor') return { configured: true, hasRefreshToken: Boolean(credential.refreshToken), secretMasked: '••••••••' };
  return { configured: true, secretMasked: '••••••••' };
};

export const deleteManagedCredential = (providerId: string) => deleteQuotaCredential(providerId);
