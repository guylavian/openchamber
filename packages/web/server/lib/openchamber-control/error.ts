export class OpenChamberControlError extends Error {
  // Declared, not a class field: the instance's own keys stay as before.
  declare statusCode: number;

  constructor(message: string, statusCode = 500, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'OpenChamberControlError';
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

/** What asControlError reads from whatever was thrown. */
type ThrownLike = { message?: unknown; statusCode?: unknown; status?: unknown; goalConfigured?: unknown } | null | undefined;

export const asControlError = (error: ThrownLike, fallbackMessage: string, fallbackStatus = 500): OpenChamberControlError => {
  if (error instanceof OpenChamberControlError) return error;
  const message = error instanceof Error ? error.message : fallbackMessage;
  return new OpenChamberControlError(message || fallbackMessage, Number(error?.statusCode) || Number(error?.status) || fallbackStatus, {
    ...(error?.goalConfigured === true ? { goalConfigured: true } : {}),
  });
};
