/**
 * One error vocabulary for every protocol.
 *
 * S3 says `NoSuchKey`, FTP says `550`, SFTP says `ENOENT`, WebDAV says `404`.
 * Each provider translates its native failure into an `OmniFsError` exactly
 * once, at its own boundary. Above that line — transfer queue, caches, VS Code
 * adapter, desktop UI — code branches on `OmniFsErrorCode` and nothing else.
 *
 * Adding a protocol therefore never forces a change in a consumer.
 */
export type OmniFsErrorCode =
  /** Path does not exist. */
  | 'NotFound'
  /** Path exists and the operation required it not to. */
  | 'AlreadyExists'
  /** Authenticated, but not allowed to do this. */
  | 'PermissionDenied'
  /** Credentials missing, wrong, or expired. Distinct from PermissionDenied
   *  because the host should re-prompt rather than just report failure. */
  | 'AuthenticationFailed'
  /** Expected a directory, found a file. */
  | 'NotADirectory'
  /** Expected a file, found a directory. */
  | 'IsADirectory'
  /** Directory is not empty and the delete was not recursive. */
  | 'NotEmpty'
  /** Could not reach the server at all: DNS, TCP, TLS. */
  | 'ConnectionFailed'
  /** Reached the server; it stopped responding in time. */
  | 'Timeout'
  /** The provider does not support this operation at all. Check capabilities
   *  before calling rather than relying on catching this. */
  | 'Unsupported'
  /** Caller cancelled via signal. */
  | 'Cancelled'
  /** Remote changed underneath us; the write would clobber. */
  | 'Conflict'
  /** Out of space, or a quota was hit. */
  | 'QuotaExceeded'
  /** Server said no in a way we could not classify. */
  | 'ProtocolError'
  /** Anything genuinely unexpected. */
  | 'Unknown';

export interface OmniFsErrorOptions {
  readonly code: OmniFsErrorCode;
  readonly message: string;
  /** The path the operation targeted, when there was one. */
  readonly path?: string | undefined;
  /** Provider that raised it, for logs and telemetry. */
  readonly providerId?: string | undefined;
  /** Native error, kept for logs. Never inspected for control flow. */
  readonly cause?: unknown;
  /**
   * Whether retrying the identical request could plausibly succeed.
   * The transfer queue reads this and nothing else when deciding to retry.
   */
  readonly retryable?: boolean | undefined;
}

/**
 * Realm-global, so two copies of this module agree about their own errors.
 *
 * `instanceof` cannot: it compares class identity, and every esbuild bundle
 * gets its own class object. The extension bundle, a test bundle, and a
 * third-party extension that registers a provider each carry a copy of this
 * module — and an OmniFsError one of them throws must still be recognised by
 * the others, or `toVsCodeError` passes it through untranslated and every
 * remote failure reaches the editor as a generic error.
 *
 * `Symbol.for` looks the symbol up in the process-wide registry, so all
 * copies resolve the same key.
 */
const OMNI_FS_ERROR = Symbol.for('omni-fs.error');

export class OmniFsError extends Error {
  readonly code: OmniFsErrorCode;
  readonly path: string | undefined;
  readonly providerId: string | undefined;
  readonly retryable: boolean;

  constructor(options: OmniFsErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'OmniFsError';
    this.code = options.code;
    this.path = options.path;
    this.providerId = options.providerId;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE.has(options.code);
    // Non-enumerable: spreads, Object.keys and JSON.stringify must not see it.
    Object.defineProperty(this, OMNI_FS_ERROR, { value: true });
  }

  /**
   * The brand plus the one field every consumer reads. Callers above the
   * provider line branch on `code` and nothing else — `toVsCodeError`'s
   * default arm renders `${code}: ${message}` straight into the editor — so a
   * branded value without one would be accepted and then shown as
   * "undefined: undefined". Only this constructor brands anything in-repo, but
   * the registry is published on the host's API, so a third-party provider can
   * brand whatever it likes.
   */
  static is(value: unknown): value is OmniFsError {
    return (
      typeof value === 'object' &&
      value !== null &&
      OMNI_FS_ERROR in value &&
      typeof (value as { code?: unknown }).code === 'string'
    );
  }

  static notFound(path: string, cause?: unknown): OmniFsError {
    return new OmniFsError({ code: 'NotFound', message: `Not found: ${path}`, path, cause });
  }

  static alreadyExists(path: string, cause?: unknown): OmniFsError {
    return new OmniFsError({
      code: 'AlreadyExists',
      message: `Already exists: ${path}`,
      path,
      cause,
    });
  }

  static unsupported(operation: string, providerId?: string): OmniFsError {
    return new OmniFsError({
      code: 'Unsupported',
      message: `${providerId ?? 'This provider'} does not support ${operation}`,
      providerId,
    });
  }

  static cancelled(operation: string): OmniFsError {
    return new OmniFsError({ code: 'Cancelled', message: `Cancelled: ${operation}` });
  }

  /** Wraps anything thrown by a provider that was not already classified. */
  static wrap(cause: unknown, context: { path?: string; providerId?: string }): OmniFsError {
    if (OmniFsError.is(cause)) return cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    return new OmniFsError({
      code: 'Unknown',
      message,
      path: context.path,
      providerId: context.providerId,
      cause,
    });
  }
}

/**
 * Codes that are worth retrying unchanged. Anything not listed is treated as a
 * permanent failure unless the provider explicitly overrides `retryable`.
 */
const DEFAULT_RETRYABLE: ReadonlySet<OmniFsErrorCode> = new Set([
  'ConnectionFailed',
  'Timeout',
  'ProtocolError',
]);
