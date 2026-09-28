/**
 * How a session answers tool permissions:
 *
 * - `ask`: every request waits for the user.
 * - `safety`: requests are accepted unless the safety net (Jev) says the user
 *   should decide; without an answer from Jev the request waits.
 * - `auto`: every request is accepted.
 *
 * Policy files written before the modes existed store booleans: `false` is
 * `ask`, and `true` meant auto-accept, which the old global safety-net switch
 * turned into `safety`. The caller supplies that answer as `legacyEnabledMode`.
 */
export const PERMISSION_MODES = ['ask', 'safety', 'auto'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

// `value` is any stored or requested value; includes() compares it as is.
export const isPermissionMode = (value: unknown): value is PermissionMode => PERMISSION_MODES.includes(value as PermissionMode);

/** A stored or requested value as a mode, or null when it is neither a mode nor a legacy boolean. */
export const toPermissionMode = (value: unknown, legacyEnabledMode: PermissionMode = 'auto'): PermissionMode | null => {
  if (isPermissionMode(value)) return value;
  if (value === true) return legacyEnabledMode;
  if (value === false) return 'ask';
  return null;
};

/** What clients that only know on/off see: anything but `ask` answers requests by itself. */
export const isAutoAnsweringMode = (mode: unknown): boolean => mode === 'safety' || mode === 'auto';
