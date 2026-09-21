import { OmniFsError } from '@omni-fs/core';

/**
 * The FTP reply codes this provider classifies. `basic-ftp` puts the
 * three-digit reply on `FTPError.code` as a number (`FtpContext.d.ts:26`).
 */
const AUTH_REPLIES: readonly number[] = [530, 332, 532];
const DATA_CONNECTION_REPLIES: readonly number[] = [425, 426, 450];
const QUOTA_REPLIES: readonly number[] = [452, 552];
const UNSUPPORTED_REPLIES: readonly number[] = [500, 501, 502, 504];

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

const CERTIFICATE_CODES: readonly string[] = [
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
];

const PROTOCOL_VERSION_CODES: readonly string[] = [
  'ERR_SSL_UNSUPPORTED_PROTOCOL',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
  'ERR_SSL_VERSION_TOO_LOW',
];

/**
 * A handshake that failed for a reason the TLS floor setting can fix. OpenSSL 3
 * reports its security level this way, and the security level is precisely what
 * lowering the floor below TLS 1.2 relaxes — so these belong with the version
 * failures rather than with the certificate ones.
 */
const SECURITY_LEVEL_MESSAGE =
  /no protocols available|unsupported protocol|key too small|version too low/i;

const PERMISSION_MESSAGE = /permission denied|access denied|not allowed|forbidden/i;

/**
 * Translates `basic-ftp` and Node failures into the shared vocabulary. This
 * happens here and nowhere else — above this line no code knows that FTP has
 * reply codes.
 *
 * 550 is the ambiguous one, as SFTP status 4 is for `provider-sftp`. Servers
 * answer it for "no such file", for "permission denied", for "directory not
 * empty" and for a plain refusal. Unlike SFTP's status 4 it cannot fall through
 * to `Unknown`: the conformance suite's first case requires a missing path to
 * stat as `NotFound`, and `NotFound` is what 550 means the overwhelming
 * majority of the time. So the default is `NotFound`, and the call sites narrow
 * through `isReplyCode` — `RMD` to `NotEmpty`, `MKD` to `AlreadyExists`.
 *
 * 521 gets the same permission carve-out as 550, for the same reason a locked
 * `MKD` can arrive as either: it has no dominant meaning to default to, so
 * only the permission case is classified and everything else still falls
 * through to `Unknown`, exactly as before that carve-out existed.
 */
export function toOmniFsError(cause: unknown, path?: string): OmniFsError {
  if (OmniFsError.is(cause)) return cause;

  const message = cause instanceof Error ? cause.message : String(cause);
  const base = { path, providerId: 'ftp', cause } as const;

  // Built inline rather than through `OmniFsError.notFound`/`.cancelled`:
  // those factories drop `providerId` (and `cancelled` drops `path` and `cause`
  // too), which would break this function's invariant that everything it builds
  // carries both.
  if (errorName(cause) === 'AbortError') {
    return new OmniFsError({
      ...base,
      code: 'Cancelled',
      message: `Cancelled: ${path ?? 'FTP request'}`,
    });
  }

  const system = systemCode(cause);
  if (system !== undefined && CERTIFICATE_CODES.includes(system)) {
    return new OmniFsError({
      ...base,
      code: 'ConnectionFailed',
      retryable: false,
      message: `TLS certificate rejected: ${message}. Tick "Allow self-signed certificates" if this server uses one.`,
    });
  }

  if (
    (system !== undefined && PROTOCOL_VERSION_CODES.includes(system)) ||
    SECURITY_LEVEL_MESSAGE.test(message)
  ) {
    return new OmniFsError({
      ...base,
      code: 'ConnectionFailed',
      retryable: false,
      message: `TLS handshake failed: ${message}. Lower "Minimum TLS version" if this server is an old one.`,
    });
  }

  if (system !== undefined && NETWORK_CODES.includes(system)) {
    return new OmniFsError({ ...base, code: 'ConnectionFailed', message, retryable: true });
  }

  const code = replyCode(cause);
  if (code !== undefined) {
    if (code === 550) {
      return PERMISSION_MESSAGE.test(message)
        ? new OmniFsError({ ...base, code: 'PermissionDenied', message })
        : new OmniFsError({
            ...base,
            code: 'NotFound',
            message: `Not found: ${path ?? 'resource'}`,
          });
    }
    // 521 is non-standard and just as ambiguous as 550 — servers answer it
    // both for "already exists" and for "access denied" on a locked `MKD`.
    // Unlike 550 it has no dominant meaning to default to, so a non-permission
    // 521 falls through exactly as it always has, to `Unknown` below. Only the
    // permission case is carved out, the same sniff and the same reasoning as
    // 550's, so `#mkdirp`'s swallow of 550/521 cannot mistake a locked
    // directory for one that already exists just because the server chose 521
    // instead of 550.
    if (code === 521 && PERMISSION_MESSAGE.test(message)) {
      return new OmniFsError({ ...base, code: 'PermissionDenied', message });
    }
    if (code === 553) return new OmniFsError({ ...base, code: 'PermissionDenied', message });
    if (code === 421 || DATA_CONNECTION_REPLIES.includes(code)) {
      return new OmniFsError({ ...base, code: 'ConnectionFailed', message, retryable: true });
    }
    if (AUTH_REPLIES.includes(code)) {
      return new OmniFsError({ ...base, code: 'AuthenticationFailed', message });
    }
    if (QUOTA_REPLIES.includes(code)) {
      return new OmniFsError({ ...base, code: 'QuotaExceeded', message });
    }
    if (UNSUPPORTED_REPLIES.includes(code)) {
      return new OmniFsError({ ...base, code: 'Unsupported', message });
    }
  }

  // `basic-ftp` reports its own inactivity timeout as a message, not a code.
  if (/^timeout/i.test(message)) {
    return new OmniFsError({ ...base, code: 'Timeout', message, retryable: true });
  }

  return new OmniFsError({ ...base, code: 'Unknown', message });
}

/**
 * Whether the server answered one of these reply codes.
 *
 * The same shape as `provider-sftp`'s `isFailure` and `provider-webdav`'s
 * `isPreconditionFailed`, for the same reason: one code, several meanings, and
 * only the caller knows which command it sent.
 */
export function isReplyCode(cause: unknown, ...codes: readonly number[]): boolean {
  const code = replyCode(cause);
  return code !== undefined && codes.includes(code);
}

/**
 * Whether a 421 means "I am full" rather than "you were idle".
 *
 * The difference matters: a connection limit shrinks the pool permanently for
 * this session, while an idle timeout must simply reconnect. Guessing wrong in
 * the second direction would leave a connection stuck at one channel for the
 * rest of its life because it was once left alone for five minutes.
 */
export function isConnectionLimit(cause: unknown): boolean {
  if (!isReplyCode(cause, 421)) return false;
  const message = cause instanceof Error ? cause.message : String(cause);
  return /too many|limit|maximum|full/i.test(message);
}

function errorName(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null) return '';
  const name = (cause as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

function replyCode(cause: unknown): number | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  if (typeof code === 'number') return code;
  // Every call site that narrows a 550 is holding an error this module already
  // translated, whose own `code` is an `OmniFsErrorCode` string and whose
  // `cause` is the original `FTPError`. Unwrapping here is what lets `RMD` and
  // `MKD` ask "was that a 550?" without reaching into `.cause` themselves.
  const inner = (cause as { cause?: unknown }).cause;
  return inner === undefined || inner === cause ? undefined : replyCode(inner);
}

function systemCode(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
