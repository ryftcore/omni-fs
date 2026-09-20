import { OmniFsError } from '@omni-fs/core';

/**
 * SFTP protocol status codes, as `ssh2` reports them on `err.code`
 * (`lib/protocol/SFTP.js:32`).
 */
const STATUS = {
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
} as const;

const NETWORK_CODES: readonly string[] = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
];

/**
 * Translates `ssh2` failures into the shared vocabulary. This happens here and
 * nowhere else — above this line no code knows that SFTP has status codes.
 *
 * Status 4 (`FAILURE`) is deliberately absent from the switch. OpenSSH answers
 * it for "directory not empty", for "destination exists" and for a generic
 * refusal, so only the call site can say which: `rmdir` narrows it to
 * `NotEmpty`, a `wx` open and a non-overwriting `rename` to `AlreadyExists`,
 * through `isFailure`. It falls through to `Unknown`, which is unspecific but
 * true, rather than to a code that would be confidently wrong two times in
 * three. This is the same shape `provider-webdav` uses for 412 and 405.
 */
export function toOmniFsError(cause: unknown, path?: string): OmniFsError {
  if (OmniFsError.is(cause)) return cause;

  const message = cause instanceof Error ? cause.message : String(cause);
  const base = { path, providerId: 'sftp', cause } as const;

  // Built inline rather than through `OmniFsError.notFound`/`.cancelled`:
  // those factories drop `providerId` (and `cancelled` drops `path` and
  // `cause` too), which would break this function's invariant that
  // everything it builds carries `path` and `providerId: 'sftp'`.
  if (errorName(cause) === 'AbortError') {
    return new OmniFsError({
      ...base,
      code: 'Cancelled',
      message: `Cancelled: ${path ?? 'SFTP request'}`,
    });
  }

  switch (statusCode(cause)) {
    case STATUS.NO_SUCH_FILE:
      return new OmniFsError({
        ...base,
        code: 'NotFound',
        message: `Not found: ${path ?? 'resource'}`,
      });
    case STATUS.PERMISSION_DENIED:
      return new OmniFsError({ ...base, code: 'PermissionDenied', message });
    case STATUS.BAD_MESSAGE:
      // `ProtocolError` is retryable by default; this one is not, because a
      // malformed protocol message will not un-malform on an identical retry.
      return new OmniFsError({ ...base, code: 'ProtocolError', message, retryable: false });
    case STATUS.NO_CONNECTION:
    case STATUS.CONNECTION_LOST:
      return new OmniFsError({ ...base, code: 'ConnectionFailed', message, retryable: true });
    case STATUS.OP_UNSUPPORTED:
      return new OmniFsError({ ...base, code: 'Unsupported', message });
  }

  const system = systemCode(cause);
  if (system !== undefined && NETWORK_CODES.includes(system)) {
    return new OmniFsError({ ...base, code: 'ConnectionFailed', message, retryable: true });
  }

  // The handshake and authentication failures `ssh2` reports as a message only.
  if (/timed out while waiting for handshake/i.test(message)) {
    return new OmniFsError({ ...base, code: 'Timeout', message, retryable: true });
  }
  if (/authentication methods failed|no matching (host key|key exchange)/i.test(message)) {
    return new OmniFsError({ ...base, code: 'AuthenticationFailed', message });
  }

  return new OmniFsError({ ...base, code: 'Unknown', message });
}

/**
 * Whether the server answered SFTP status 4, `FAILURE`.
 *
 * The same shape as `provider-webdav`'s `isPreconditionFailed`, for the same
 * reason: one status, two meanings, and only the caller knows which method it
 * sent. `rmdir` reads it as `NotEmpty`; an exclusive open and a plain rename
 * read it as `AlreadyExists`.
 */
export function isFailure(cause: unknown): boolean {
  return statusCode(cause) === STATUS.FAILURE;
}

function errorName(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null) return '';
  const name = (cause as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

function statusCode(cause: unknown): number | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

function systemCode(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
