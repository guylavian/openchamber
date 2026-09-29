/**
 * CLI output formatting adapter.
 *
 * Wraps @clack/prompts for structured, beautiful terminal output.
 * Custom formatters (icons, redaction) live here to isolate the
 * formatting dependency from the rest of the CLI.
 */

import {
  intro,
  outro,
  log,
  box,
  confirm,
  select,
  text,
  password,
  spinner,
  progress,
  cancel,
  isCancel,
} from '@clack/prompts';
import type { ProgressOptions } from '@clack/prompts';

// ── Provider icons ──────────────────────────────────────────────

const TUNNEL_PROVIDER_ICON: Record<string, string> = {
  cloudflare: '☁',
};

function formatProviderWithIcon(provider: unknown): string {
  if (typeof provider !== 'string' || provider.trim().length === 0) {
    return 'unknown';
  }
  const normalized = provider.trim().toLowerCase();
  const icon = TUNNEL_PROVIDER_ICON[normalized];
  return icon ? `${icon} ${normalized}` : normalized;
}

// ── Status-aware log dispatch ───────────────────────────────────

/**
 * Print a status-tagged message using clack log primitives.
 *
 * @param {'success'|'warning'|'error'|'info'|'neutral'} status
 * @param {string} message  Primary line
 * @param {string} [detail] Optional dim secondary line appended after newline
 */
type LogStatusKind = 'success' | 'warning' | 'error' | 'info' | 'neutral';

function logStatus(status: LogStatusKind, message: string, detail?: string): void {
  const full = detail ? `${message}\n${detail}` : message;
  switch (status) {
    case 'success':
      log.success(full);
      break;
    case 'warning':
      log.warn(full);
      break;
    case 'error':
      log.error(full);
      break;
    case 'info':
    case 'neutral':
    default:
      log.info(full);
      break;
  }
}

// ── TTY detection ───────────────────────────────────────────────

/**
 * Whether both stdout and stdin are interactive TTYs.
 * Prompts must be disabled when stdin is piped (e.g. --token-stdin).
 */
interface OutputModeOptions {
  json?: boolean | undefined;
  quiet?: boolean | undefined;
}

const isTTY = Boolean(process.stdout?.isTTY) && Boolean(process.stdin?.isTTY);

function isJsonMode(options?: OutputModeOptions | null): boolean {
  return Boolean(options?.json);
}

function isQuietMode(options?: OutputModeOptions | null): boolean {
  return Boolean(options?.quiet);
}

function shouldRenderHumanOutput(options?: OutputModeOptions | null): boolean {
  return !isJsonMode(options) && !isQuietMode(options);
}

function canPrompt(options?: OutputModeOptions | null): boolean {
  return shouldRenderHumanOutput(options) && isTTY;
}

function createSpinner(options?: OutputModeOptions | null) {
  return canPrompt(options) ? spinner() : null;
}

async function createProgress(options?: OutputModeOptions | null, config?: ProgressOptions) {
  return canPrompt(options) ? progress(config) : null;
}

interface JsonPayload {
  status?: unknown;
  messages?: unknown;
  [key: string]: unknown;
}

interface JsonMessage {
  level?: unknown;
}

function printJson(payload: unknown): void {
  const base: JsonPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...payload }
    : { data: payload };

  const messages: readonly (JsonMessage | null | undefined)[] | undefined = Array.isArray(base.messages) ? base.messages : undefined;
  const hasWarning = Boolean(messages?.some((entry) => entry?.level === 'warning'));
  const hasError = Boolean(messages?.some((entry) => entry?.level === 'error'));
  const normalizedStatus = base.status === 'ok' || base.status === 'warning' || base.status === 'error'
    ? base.status
    : (hasError ? 'error' : (hasWarning ? 'warning' : 'ok'));

  const output = {
    status: normalizedStatus,
    ...base,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

export {
  intro,
  outro,
  log,
  box,
  confirm,
  select,
  text,
  password,
  cancel,
  isCancel,
  isJsonMode,
  isQuietMode,
  shouldRenderHumanOutput,
  canPrompt,
  createSpinner,
  createProgress,
  printJson,
  formatProviderWithIcon,
  logStatus,
};
