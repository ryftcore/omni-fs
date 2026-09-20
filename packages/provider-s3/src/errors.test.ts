import { describe, expect, it } from 'vitest';
import { OmniFsError } from '@omni-fs/core';
import { isPreconditionFailed, toOmniFsError } from './errors.js';

/**
 * This is the only place in the system that knows `NoSuchKey` exists. Above it,
 * the VS Code adapter turns `NotFound` into create-on-save and `PermissionDenied`
 * into a read-only editor, and `TransferQueue` retries on nothing but
 * `retryable` — so a miss here is not a cosmetic wording problem, it changes
 * what the product does.
 */

/** A failure as the AWS SDK throws it: a `name`, and the status in `$metadata`. */
function sdkError(name: string, httpStatusCode?: number): Error {
  return Object.assign(new Error(`${name} occurred`), {
    name,
    ...(httpStatusCode !== undefined ? { $metadata: { httpStatusCode } } : {}),
  });
}

/**
 * A failure carrying nothing but a status. This is the shape that matters for
 * S3-compatible servers — MinIO, R2, Ceph — which answer the right HTTP code
 * without mirroring AWS's error names.
 */
function statusOnly(httpStatusCode: number): Error {
  return Object.assign(new Error(`HTTP ${httpStatusCode}`), { $metadata: { httpStatusCode } });
}

describe('toOmniFsError', () => {
  it('passes an already-translated error straight through', () => {
    const original = OmniFsError.notFound('/a.txt');
    expect(toOmniFsError(original, '/other.txt')).toBe(original);
  });

  describe('by SDK error name', () => {
    it.each([
      ['NoSuchKey', 'NotFound'],
      ['NoSuchBucket', 'NotFound'],
      ['NotFound', 'NotFound'],
      ['AccessDenied', 'PermissionDenied'],
      ['AllAccessDisabled', 'PermissionDenied'],
      ['InvalidAccessKeyId', 'AuthenticationFailed'],
      ['SignatureDoesNotMatch', 'AuthenticationFailed'],
      ['ExpiredToken', 'AuthenticationFailed'],
      ['TokenRefreshRequired', 'AuthenticationFailed'],
      ['UnrecognizedClientException', 'AuthenticationFailed'],
      ['BucketAlreadyExists', 'AlreadyExists'],
      ['BucketAlreadyOwnedByYou', 'AlreadyExists'],
      ['PreconditionFailed', 'Conflict'],
      ['RequestTimeout', 'Timeout'],
      ['RequestTimeTooSkewed', 'Timeout'],
      ['TimeoutError', 'Timeout'],
      ['SlowDown', 'ProtocolError'],
      ['ServiceUnavailable', 'ProtocolError'],
      ['InternalError', 'ProtocolError'],
      ['ThrottlingException', 'ProtocolError'],
      ['AbortError', 'Cancelled'],
    ])('maps %s to %s', (name, code) => {
      expect(toOmniFsError(sdkError(name), '/a.txt').code).toBe(code);
    });

    it('separates a wrong key from a forbidden one', () => {
      // The host re-prompts for credentials on AuthenticationFailed and merely
      // reports PermissionDenied, so collapsing these two strands a user with
      // a valid key and no access behind a credential dialog they cannot
      // satisfy — and a user with a typo'd key with no way to fix it.
      expect(toOmniFsError(sdkError('InvalidAccessKeyId')).code).toBe('AuthenticationFailed');
      expect(toOmniFsError(sdkError('AccessDenied')).code).toBe('PermissionDenied');
    });

    it('reads the name from an XML-style Code when there is no useful name', () => {
      // A plain `new Error()` is named "Error", which says nothing; some
      // clients put the real code on `Code` instead.
      const xml = Object.assign(new Error('nope'), { Code: 'NoSuchKey' });
      expect(toOmniFsError(xml, '/a.txt').code).toBe('NotFound');
    });
  });

  describe('retryability', () => {
    it('marks throttling and server faults retryable', () => {
      // `TransferQueue` consults this and nothing else. A 503 during a bulk
      // upload is the ordinary case that has to recover by itself.
      expect(toOmniFsError(sdkError('SlowDown')).retryable).toBe(true);
      expect(toOmniFsError(sdkError('ServiceUnavailable')).retryable).toBe(true);
      expect(toOmniFsError(sdkError('RequestTimeout')).retryable).toBe(true);
      expect(toOmniFsError(statusOnly(500)).retryable).toBe(true);
      expect(toOmniFsError(statusOnly(429)).retryable).toBe(true);
    });

    it('does not retry a decision the server will repeat', () => {
      expect(toOmniFsError(sdkError('NoSuchKey')).retryable).toBe(false);
      expect(toOmniFsError(sdkError('AccessDenied')).retryable).toBe(false);
      expect(toOmniFsError(sdkError('InvalidAccessKeyId')).retryable).toBe(false);
      expect(toOmniFsError(sdkError('PreconditionFailed')).retryable).toBe(false);
    });
  });

  describe('by HTTP status, for servers that do not mirror AWS names', () => {
    it.each([
      [404, 'NotFound'],
      [401, 'AuthenticationFailed'],
      [403, 'PermissionDenied'],
      [409, 'Conflict'],
      [412, 'Conflict'],
      [429, 'ProtocolError'],
      [500, 'ProtocolError'],
      [503, 'ProtocolError'],
    ])('maps HTTP %i to %s', (status, code) => {
      expect(toOmniFsError(statusOnly(status), '/a.txt').code).toBe(code);
    });

    it('prefers a recognised name over the status that came with it', () => {
      // MinIO answers 400 for a handful of conditions AWS names precisely.
      expect(toOmniFsError(sdkError('NoSuchKey', 400), '/a.txt').code).toBe('NotFound');
    });
  });

  it('maps a refused or reset socket to ConnectionFailed and retries it', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT']) {
      const network = Object.assign(new Error(`connect ${code}`), { code });
      const translated = toOmniFsError(network);
      expect(translated.code).toBe('ConnectionFailed');
      expect(translated.retryable).toBe(true);
    }
  });

  it('falls back to Unknown rather than leaking a bare Error', () => {
    const translated = toOmniFsError(new Error('something odd'), '/a.txt');
    expect(translated.code).toBe('Unknown');
    expect(translated.retryable).toBe(false);
  });

  it('translates a non-Error throw without losing what it was', () => {
    expect(toOmniFsError('just a string').message).toBe('just a string');
  });

  describe('context carried through', () => {
    it('names the path and the provider', () => {
      const translated = toOmniFsError(sdkError('AccessDenied'), '/docs/a.txt');
      expect(translated.path).toBe('/docs/a.txt');
      expect(translated.providerId).toBe('s3');
    });

    it('keeps the native error as the cause, for logs', () => {
      const native = sdkError('AccessDenied');
      expect(toOmniFsError(native, '/a.txt').cause).toBe(native);
    });

    it('puts the path in a NotFound message, where a user will read it', () => {
      expect(toOmniFsError(sdkError('NoSuchKey'), '/docs/a.txt').message).toContain('/docs/a.txt');
    });
  });
});

describe('isPreconditionFailed', () => {
  it('recognises a 412 however the SDK carried it', () => {
    expect(isPreconditionFailed(sdkError('PreconditionFailed'))).toBe(true);
    expect(isPreconditionFailed(statusOnly(412))).toBe(true);
  });

  it('is false for every other failure', () => {
    // 409 is the near miss: it is a genuine Conflict and must not be reported
    // as "something is already there".
    expect(isPreconditionFailed(statusOnly(409))).toBe(false);
    expect(isPreconditionFailed(statusOnly(404))).toBe(false);
    expect(isPreconditionFailed(new Error('no status at all'))).toBe(false);
    expect(isPreconditionFailed(undefined)).toBe(false);
  });

  it('does not see a 412 in an already-translated Conflict', () => {
    // `toOmniFsError` flattens the status away, so a caller that asks too late
    // gets `false` rather than a wrong `AlreadyExists`. `openUploadStream`
    // therefore has to ask before translating, and does.
    expect(isPreconditionFailed(toOmniFsError(statusOnly(412), '/a.txt'))).toBe(false);
  });
});
