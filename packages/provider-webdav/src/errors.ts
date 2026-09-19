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

  // 405 is deliberately absent from this switch — see `isMethodNotAllowed`. It
  // falls through to `Unknown`, which is unspecific but true, rather than to
  // `ProtocolError`: that code is retryable by default, and a method the server
  // does not allow will not start being allowed on the second attempt.
  const status = httpStatus(cause);
  switch (status) {
    case 401:
      return new OmniFsError({ ...base, code: 'AuthenticationFailed', message });
    case 403:
    case 423: // Locked — someone else holds a WebDAV lock on this resource.
      return new OmniFsError({ ...base, code: 'PermissionDenied', message });
    case 404:
      return OmniFsError.notFound(path ?? 'resource', cause);
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

/**
 * Whether the server answered 405 Method Not Allowed.
 *
 * The same shape as `isPreconditionFailed`, for the same reason. `MKCOL` has
 * exactly one use for a 405 — RFC 4918 §9.3.1: a resource already occupies
 * that path — which is `AlreadyExists`. For `PUT`, `DELETE`, `COPY` and `MOVE`
 * it is instead the ordinary answer of a read-only or method-restricted
 * server, and calling that `AlreadyExists` is actively misleading. So the
 * shared mapping refuses to guess and `createDirectory` narrows it at its own
 * call site, where the method is known.
 */
export function isMethodNotAllowed(cause: unknown): boolean {
  return httpStatus(cause) === 405;
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
