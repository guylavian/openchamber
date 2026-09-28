export const DEFAULT_INPUT_HISTORY_SCOPE = 'session';
export const DEFAULT_INPUT_HISTORY_LIMIT = 40;
const MIN_INPUT_HISTORY_LIMIT = 1;
const MAX_INPUT_HISTORY_LIMIT = 100;

export type InputHistoryScope = 'global' | 'session';

export const isInputHistoryScope = (value: unknown): value is InputHistoryScope => (
  value === 'global' || value === 'session'
);

// Number.isInteger proves `value` is a number; the checker does not narrow on it.
export const isInputHistoryLimit = (value: unknown): value is number => (
  Number.isInteger(value)
  && (value as number) >= MIN_INPUT_HISTORY_LIMIT
  && (value as number) <= MAX_INPUT_HISTORY_LIMIT
);
