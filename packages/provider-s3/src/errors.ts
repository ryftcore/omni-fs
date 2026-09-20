import { OmniFsError } from '@omni-fs/core';

/**
 * Translates AWS SDK failures into the shared vocabulary. This happens here and
 * nowhere else — above this line no code knows that `NoSuchKey` is a thing.
 */
export function toOmniFsError(cause: unknown, path?: string): OmniFsError {
  if (OmniFsError.is(cause)) return cause;

  const name = errorName(cause);
  const status = httpStatus(cause);
  const message = cause instanceof Error ? cause.message : String(cause);
  const base = { path, providerId: 's3', cause } as const;

  switch (name) {
    case 'NoSuchKey':
    case 'NoSuchBucket':
    case 'NotFound':
      return new OmniFsError({ ...base, code: 'NotFound', message: `Not found: ${path ?? name}` });

    case 'AccessDenied':
    case 'AllAccessDisabled':
      return new OmniFsError({ ...base, code: 'PermissionDenied', message });

    case 'InvalidAccessKeyId':
    case 'SignatureDoesNotMatch':
    case 'ExpiredToken':
    case 'TokenRefreshRequired':
    case 'UnrecognizedClientException':
      return new OmniFsError({ ...base, code: 'AuthenticationFailed', message });

    case 'BucketAlreadyExists':
    case 'BucketAlreadyOwnedByYou':
      return new OmniFsError({ ...base, code: 'AlreadyExists', message });

    case 'PreconditionFailed':
      return new OmniFsError({
        ...base,
        code: 'Conflict',
        message: 'The object changed on the server since it was read.',
      });

    case 'RequestTimeout':
    case 'RequestTimeTooSkewed':
    case 'TimeoutError':
      return new OmniFsError({ ...base, code: 'Timeout', message, retryable: true });

    case 'SlowDown':
    case 'ServiceUnavailable':
    case 'InternalError':
    case 'ThrottlingException':
      return new OmniFsError({ ...base, code: 'ProtocolError', message, retryable: true });

    case 'AbortError':
      return OmniFsError.cancelled(path ?? 'S3 request');
  }

  // Fall back to the HTTP status when the SDK gave us no useful name — common
  // with S3-compatible servers (MinIO, R2, Ceph) that do not mirror AWS codes.
  if (status === 404) return OmniFsError.notFound(path ?? 'object', cause);
  if (status === 401) return new OmniFsError({ ...base, code: 'AuthenticationFailed', message });
  if (status === 403) return new OmniFsError({ ...base, code: 'PermissionDenied', message });
  if (status === 409) return new OmniFsError({ ...base, code: 'Conflict', message });
  if (status === 412) return new OmniFsError({ ...base, code: 'Conflict', message });
  if (status === 429) {
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
 * Whether S3 answered 412 Precondition Failed.
 *
 * `If-None-Match: *` and `If-Match` both fail this way, and only the caller's
 * own option tells the two apart: the first means an object is already sitting
 * there (`AlreadyExists`), the second that it changed underneath the caller
 * (`Conflict`). The shared mapping above refuses to guess and answers
 * `Conflict`; `openUploadStream` narrows it at the one call site that knows
 * which condition it asked for. Same shape, same reason, as
 * `isPreconditionFailed` in provider-webdav.
 */
export function isPreconditionFailed(cause: unknown): boolean {
  return errorName(cause) === 'PreconditionFailed' || httpStatus(cause) === 412;
}

function errorName(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null) return '';
  const record = cause as { name?: unknown; Code?: unknown };
  if (typeof record.name === 'string' && record.name !== 'Error') return record.name;
  return typeof record.Code === 'string' ? record.Code : '';
}

function httpStatus(cause: unknown): number | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const meta = (cause as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  return typeof meta?.httpStatusCode === 'number' ? meta.httpStatusCode : undefined;
}

function isNetworkError(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const code = (cause as { code?: unknown }).code;
  return (
    typeof code === 'string' &&
    ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ETIMEDOUT'].includes(code)
  );
}
