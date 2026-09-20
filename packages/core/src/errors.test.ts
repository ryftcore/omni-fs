import { describe, expect, it, vi } from 'vitest';
import { OmniFsError } from './errors.js';
import type { OmniFsErrorCode } from './errors.js';

/**
 * `OmniFsError` is the whole error vocabulary: providers translate inward once,
 * hosts translate outward once, and `TransferQueue` reads `retryable` and
 * nothing else. Both of those contracts are pinned here.
 */

describe('OmniFsError', () => {
  describe('construction', () => {
    it('keeps every field it was given', () => {
      const cause = new Error('socket hang up');
      const error = new OmniFsError({
        code: 'ConnectionFailed',
        message: 'could not reach the server',
        path: '/a/one.txt',
        providerId: 'sftp',
        cause,
      });

      expect(error.code).toBe('ConnectionFailed');
      expect(error.message).toBe('could not reach the server');
      expect(error.path).toBe('/a/one.txt');
      expect(error.providerId).toBe('sftp');
      expect(error.cause).toBe(cause);
    });

    it('is a real Error with a stable name', () => {
      const error = new OmniFsError({ code: 'Unknown', message: 'x' });

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('OmniFsError');
    });

    it('leaves optional fields undefined rather than inventing them', () => {
      const error = new OmniFsError({ code: 'Unknown', message: 'x' });

      expect(error.path).toBeUndefined();
      expect(error.providerId).toBeUndefined();
      expect(error.cause).toBeUndefined();
    });
  });

  describe('retryable', () => {
    const cases: ReadonlyArray<readonly [OmniFsErrorCode, boolean]> = [
      ['ConnectionFailed', true],
      ['Timeout', true],
      ['ProtocolError', true],
      ['NotFound', false],
      ['PermissionDenied', false],
      ['AuthenticationFailed', false],
      ['AlreadyExists', false],
      ['Unsupported', false],
      ['Cancelled', false],
      ['Conflict', false],
      ['QuotaExceeded', false],
      ['Unknown', false],
    ];

    it.each(cases)('defaults %s to retryable=%s', (code, expected) => {
      expect(new OmniFsError({ code, message: 'x' }).retryable).toBe(expected);
    });

    it('lets a provider override the default in either direction', () => {
      // A provider knows things the code alone does not — an S3 503 is worth
      // retrying even though it arrives as a generic failure.
      expect(new OmniFsError({ code: 'Unknown', message: 'x', retryable: true }).retryable).toBe(
        true,
      );
      expect(new OmniFsError({ code: 'Timeout', message: 'x', retryable: false }).retryable).toBe(
        false,
      );
    });
  });

  describe('is', () => {
    it('recognises an OmniFsError', () => {
      expect(OmniFsError.is(new OmniFsError({ code: 'Unknown', message: 'x' }))).toBe(true);
    });

    it('rejects anything else', () => {
      expect(OmniFsError.is(new Error('plain'))).toBe(false);
      expect(OmniFsError.is('NotFound')).toBe(false);
      expect(OmniFsError.is(undefined)).toBe(false);
      expect(OmniFsError.is({ code: 'NotFound', message: 'shaped like one' })).toBe(false);
    });
  });

  describe('wrap', () => {
    it('returns an already-classified error untouched', () => {
      const original = new OmniFsError({ code: 'NotFound', message: 'gone' });

      const wrapped = OmniFsError.wrap(original, { providerId: 'sftp' });

      // A provider that classified it knew more than the caller does; adding
      // context here would overwrite a better answer with a worse one.
      expect(wrapped).toBe(original);
      expect(wrapped.providerId).toBeUndefined();
    });

    it('classifies a native error as Unknown and keeps it as the cause', () => {
      const native = new Error('ECONNRESET');

      const wrapped = OmniFsError.wrap(native, { path: '/a', providerId: 'ftp' });

      expect(wrapped.code).toBe('Unknown');
      expect(wrapped.message).toBe('ECONNRESET');
      expect(wrapped.path).toBe('/a');
      expect(wrapped.providerId).toBe('ftp');
      expect(wrapped.cause).toBe(native);
    });

    it('stringifies a thrown non-error', () => {
      const wrapped = OmniFsError.wrap('just a string', {});

      expect(wrapped.code).toBe('Unknown');
      expect(wrapped.message).toBe('just a string');
    });

    it('does not mark a wrapped unknown failure retryable', () => {
      // Unknown means unclassified, and retrying a write nobody understands is
      // how duplicates get created.
      expect(OmniFsError.wrap(new Error('?'), {}).retryable).toBe(false);
    });
  });

  describe('factories', () => {
    it('notFound carries the path in both the code and the message', () => {
      const error = OmniFsError.notFound('/a/one.txt');

      expect(error.code).toBe('NotFound');
      expect(error.path).toBe('/a/one.txt');
      expect(error.message).toContain('/a/one.txt');
    });

    it('alreadyExists carries the path', () => {
      const error = OmniFsError.alreadyExists('/a/one.txt');

      expect(error.code).toBe('AlreadyExists');
      expect(error.path).toBe('/a/one.txt');
    });

    it('unsupported names the provider when it is given one', () => {
      expect(OmniFsError.unsupported('renaming', 'sftp').message).toContain('sftp');
      expect(OmniFsError.unsupported('renaming').message).toContain('This provider');
      expect(OmniFsError.unsupported('renaming', 'sftp').providerId).toBe('sftp');
    });

    it('cancelled names the operation', () => {
      const error = OmniFsError.cancelled('download');

      expect(error.code).toBe('Cancelled');
      expect(error.message).toContain('download');
    });

    it('leaves providerId unset on the factories that take no provider', () => {
      // A deliberate limit of these signatures rather than an oversight: a
      // provider that needs its id on the error constructs one directly.
      expect(OmniFsError.notFound('/a').providerId).toBeUndefined();
      expect(OmniFsError.cancelled('read').providerId).toBeUndefined();
    });
  });
});

describe('OmniFsError.is across module copies', () => {
  it('recognises an error built by a second instance of this module', async () => {
    // esbuild gives the extension bundle and the test bundle each their own
    // class object, so `instanceof` answers "no" for an error that is an
    // OmniFsError in every way that matters. `vi.resetModules()` reproduces
    // that here without a bundler: the dynamic import below re-evaluates
    // errors.ts and hands back a different class.
    vi.resetModules();
    const second = await import('./errors.js');
    const foreign = new second.OmniFsError({ code: 'NotFound', message: 'gone' });

    expect(second.OmniFsError).not.toBe(OmniFsError);
    expect(foreign instanceof OmniFsError).toBe(false);
    expect(OmniFsError.is(foreign)).toBe(true);
  });

  it('recognises a structurally identical error carrying the brand', () => {
    // The contract stated without relying on module-registry mechanics: the
    // brand is the whole test. Anything carrying it is one of ours.
    const branded = Object.defineProperty(new Error('gone'), Symbol.for('omni-fs.error'), {
      value: true,
    });

    expect(OmniFsError.is(branded)).toBe(true);
  });

  it('still refuses anything without the brand', () => {
    expect(OmniFsError.is(new Error('ordinary'))).toBe(false);
    expect(OmniFsError.is({ code: 'NotFound', message: 'shaped like one' })).toBe(false);
    expect(OmniFsError.is(null)).toBe(false);
    expect(OmniFsError.is(undefined)).toBe(false);
    expect(OmniFsError.is('NotFound')).toBe(false);
  });

  it('keeps the brand off anything that serialises the error', () => {
    // Non-enumerable: a spread-based copy of the error must not carry the
    // brand, or every logged error grows a mystery symbol key. (The brand is
    // separately absent after any postMessage hop, since structuredClone
    // drops symbol-keyed properties regardless of enumerability — that is not
    // what this assertion is about.)
    const error = new OmniFsError({ code: 'NotFound', message: 'gone' });
    expect(Object.getOwnPropertySymbols({ ...error })).not.toContain(Symbol.for('omni-fs.error'));
    expect(Object.getOwnPropertyDescriptor(error, Symbol.for('omni-fs.error'))?.enumerable).toBe(
      false,
    );
  });
});
