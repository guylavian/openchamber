/**
 * Body handling for `POST /api/guests/upload`: a raw zip sent as
 * `application/octet-stream`. The archive is collected into memory (the
 * install path works on a buffer) under a configurable cap, so a remote or
 * web user can add an extension without a path on the server. Nothing from
 * the archive is ever logged.
 */

const DEFAULT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

export interface GuestUploadRequest extends AsyncIterable<Buffer | string> {
  headers?: Record<string, string | string[] | undefined>;
  resume?: () => void;
}

export type GuestUploadBodyResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; status: 413 | 415; error: 'unsupported-media-type' | 'too-large' };

export const guestUploadMaxBytes = (): number => {
  const raw = Number(process.env.OPENCHAMBER_GUEST_UPLOAD_MAX_BYTES);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_UPLOAD_MAX_BYTES;
};

const isOctetStream = (contentType: string | string[] | undefined): boolean => (
  String(contentType || '').toLowerCase().startsWith('application/octet-stream')
);

/**
 * Reads the upload body. `req` is the Express request (headers plus an
 * async-iterable body). Answers `{ ok: true, buffer }`, or `{ ok: false,
 * status, error }` with 415 for a wrong content type and 413 when either the
 * declared `Content-Length` or the bytes actually received pass `maxBytes`.
 * The declared-size refusal drains the request so the socket stays reusable.
 */
export const readGuestUploadBody = async (req: GuestUploadRequest, maxBytes: number): Promise<GuestUploadBodyResult> => {
  if (!isOctetStream(req.headers?.['content-type'])) {
    req.resume?.();
    return { ok: false, status: 415, error: 'unsupported-media-type' };
  }
  const declaredSize = Number(req.headers?.['content-length']);
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    req.resume?.();
    return { ok: false, status: 413, error: 'too-large' };
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > maxBytes) {
      req.resume?.();
      return { ok: false, status: 413, error: 'too-large' };
    }
    chunks.push(buffer);
  }
  return { ok: true, buffer: Buffer.concat(chunks, received) };
};
