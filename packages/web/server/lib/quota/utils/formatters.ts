export type ResetTimestamp = string | number | Date;

export interface UsageWindow {
  usedPercent: number | null | undefined;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: ResetTimestamp | null | undefined;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  valueLabel?: string;
}

export interface UsageWindowInput {
  usedPercent?: number | null;
  windowSeconds?: number | null;
  resetAt?: ResetTimestamp | null;
  valueLabel?: string | null;
}

export interface QuotaUsage {
  windows: Record<string, UsageWindow>;
}

export interface QuotaResult {
  providerId: string;
  providerName: string;
  ok: boolean;
  configured: boolean;
  usage: QuotaUsage | null;
  error?: string;
  planLabel?: string;
  fetchedAt: number;
}

export interface QuotaResultInput {
  providerId: string;
  providerName: string;
  ok: boolean;
  configured: boolean;
  usage?: QuotaUsage | null;
  error?: string | null;
  planLabel?: string | null;
}

export const formatResetTime = (timestamp: ResetTimestamp): string | null => {
  try {
    const resetDate = new Date(timestamp);
    if (!Number.isFinite(resetDate.getTime())) {
      return null;
    }

    const now = new Date();
    const isToday = resetDate.toDateString() === now.toDateString();
    
    if (isToday) {
      return resetDate.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit'
      });
    }
    
    return resetDate.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit'
    });
  } catch {
    return null;
  }
};

const hasResetTimestamp = (resetAt: ResetTimestamp | null | undefined): resetAt is ResetTimestamp => resetAt !== null && resetAt !== undefined && resetAt !== '';

export const calculateResetAfterSeconds = (resetAt: ResetTimestamp | null | undefined): number | null => {
  if (!hasResetTimestamp(resetAt)) return null;
  const resetAtTime = new Date(resetAt).getTime();
  if (!Number.isFinite(resetAtTime)) return null;
  const delta = Math.floor((resetAtTime - Date.now()) / 1000);
  return delta < 0 ? 0 : delta;
};

export const toUsageWindow = ({ usedPercent, windowSeconds, resetAt, valueLabel }: UsageWindowInput): UsageWindow => {
  const resetAfterSeconds = calculateResetAfterSeconds(resetAt);
  const resetFormatted = hasResetTimestamp(resetAt) ? formatResetTime(resetAt) : null;
  const hasFiniteUsedPercent = typeof usedPercent === 'number' && Number.isFinite(usedPercent);
  return {
    usedPercent,
    remainingPercent: hasFiniteUsedPercent ? Math.max(0, 100 - usedPercent) : null,
    windowSeconds: windowSeconds ?? null,
    resetAfterSeconds,
    resetAt,
    resetAtFormatted: resetFormatted,
    resetAfterFormatted: resetFormatted,
    ...(valueLabel ? { valueLabel } : {})
  };
};

export const buildResult = ({ providerId, providerName, ok, configured, usage, error, planLabel }: QuotaResultInput): QuotaResult => ({
  providerId,
  providerName,
  ok,
  configured,
  usage: usage ?? null,
  ...(error ? { error } : {}),
  ...(planLabel ? { planLabel } : {}),
  fetchedAt: Date.now()
});

export const durationToLabel = (duration: number | null | undefined, unit: string | null | undefined): string => {
  if (!duration || !unit) return 'limit';
  if (unit === 'TIME_UNIT_MINUTE') return `${duration}m`;
  if (unit === 'TIME_UNIT_HOUR') return `${duration}h`;
  if (unit === 'TIME_UNIT_DAY') return `${duration}d`;
  return 'limit';
};

export const durationToSeconds = (duration: number | null | undefined, unit: string | null | undefined): number | null => {
  if (!duration || !unit) return null;
  if (unit === 'TIME_UNIT_MINUTE') return duration * 60;
  if (unit === 'TIME_UNIT_HOUR') return duration * 3600;
  if (unit === 'TIME_UNIT_DAY') return duration * 86400;
  return null;
};

export const formatMoney = (value: unknown): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value.toFixed(2);
};
