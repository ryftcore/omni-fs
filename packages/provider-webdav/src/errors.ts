import { OmniFsError } from '@omni-fs/core';

/**
 * Translates `webdav` failures into the shared vocabulary. This happens here and
 * nowhere else — above this line no code knows that WebDAV speaks HTTP.
 */
export function toOmniFsError(cause: unknown, path?: string): OmniFsError {
  if (OmniFsError.is(cause)) return cause;

  const message = cause instanceof Error ? cause.message : String(cause);
  const base = { path, providerId: 'webdav', cause } as const;

  if (errorName(cause) === 'AbortError') return OmniFsError.cancelled(path ?? 'WebDAV request');

  switch (httpStatus(cause)) {
    case 401:
      return new OmniFsError({ ...base, code: 'AuthenticationFailed', message });
    case 403:
    case 423: // Locked — someone else holds a WebDAV lock on this resource.
      return new OmniFsError({ ...base, code: 'PermissionDenied', message });
    case 404:
      return OmniFsError.notFound(path ?? 'resource', cause);
    // MKCOL answers 405 when the collection is already there.
    case 405:
      return new OmniFsError({ ...base, code: 'AlreadyExists', message });
    case 409:
    case 412:
      return new OmniFsError({ ...base, code: 'Conflict', message });
    case 507:
      return new OmniFsError({ ...base, code: 'QuotaExceeded', message });
    case 408:
      return new OmniFsError({ ...base, code: 'Timeout', message, retryable: true });
    case 429:
      return new OmniFsError({ ...base, code: 'ProtocolError', message, retryable: true });
  }

  const status = httpStatus(cause);
  if (status !== undefined && status >= 500) {
    return new OmniFsError({ ...base, code: 'ProtocolError', message, retryable: true });
  }
  if (isNetworkError(cause)) {
    return new OmniFsError({ ...base, code: 'ConnectionFailed', message, retryable: true });
  }

  return new OmniFsError({ ...base, code: 'Unknown', message });
}

/**
 * Whether the server answered 412 Precondition Failed.
 *
 * A 412 means two different things to this provider and only the call site can
 * tell them apart, so `toOmniFsError` cannot decide for both. On a `COPY` or
 * `MOVE` the caller asked not to overwrite, the request carried `Overwrite: F`
 * and a 412 says one thing only — the destination is already there, which is
 * `AlreadyExists`. On an `If-Match` write it says the remote moved on, which is
 * `Conflict`, and that is what the shared mapping keeps meaning.
 */
export function isPreconditionFailed(cause: unknown): boolean {
  return httpStatus(cause) === 412;
}

function errorName(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null) return '';
  const name = (cause as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

function httpStatus(cause: unknown): number | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const record = cause as { status?: unknown; response?: { status?: unknown } };
  if (typeof record.status === 'number') return record.status;
  return typeof record.response?.status === 'number' ? record.response.status : undefined;
}

function isNetworkError(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const code = (cause as { code?: unknown }).code;
  return (
    typeof code === 'string' &&
    ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ETIMEDOUT'].includes(code)
  );
}
