import { describe, expect, it } from 'vitest';
import { OmniFsError } from '@omni-fs/core';
import { isConnectionLimit, isReplyCode, toOmniFsError } from './errors.js';

/** Shaped like `basic-ftp`'s FTPError: a numeric reply code on `.code`. */
function reply(code: number, message = 'server said no'): Error {
  return Object.assign(new Error(message), { code });
}

/** Shaped like a Node system or TLS error: a string on `.code`. */
function system(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

describe('toOmniFsError', () => {
  it('passes an OmniFsError through unchanged', () => {
    const original = new OmniFsError({ code: 'NotFound', message: 'gone' });
    expect(toOmniFsError(original)).toBe(original);
  });

  it('stamps the provider id and the path on everything it builds', () => {
    const error = toOmniFsError(reply(550), '/data/missing.txt');
    expect(error.providerId).toBe('ftp');
    expect(error.path).toBe('/data/missing.txt');
  });

  it('reads 550 as NotFound, which is what it means nearly every time', () => {
    expect(toOmniFsError(reply(550)).code).toBe('NotFound');
  });

  it('reads a 550 that says permission denied as PermissionDenied', () => {
    expect(toOmniFsError(reply(550, '550 Permission denied.')).code).toBe('PermissionDenied');
    expect(toOmniFsError(reply(550, 'Access denied')).code).toBe('PermissionDenied');
  });

  it('reads 553 as PermissionDenied', () => {
    expect(toOmniFsError(reply(553)).code).toBe('PermissionDenied');
  });

  it('reads the login refusals as AuthenticationFailed', () => {
    expect(toOmniFsError(reply(530)).code).toBe('AuthenticationFailed');
    expect(toOmniFsError(reply(332)).code).toBe('AuthenticationFailed');
    expect(toOmniFsError(reply(532)).code).toBe('AuthenticationFailed');
  });

  it('reads 421 as a retryable ConnectionFailed', () => {
    const error = toOmniFsError(reply(421, '421 Too many connections'));
    expect(error.code).toBe('ConnectionFailed');
    expect(error.retryable).toBe(true);
  });

  it('reads the data-connection failures as retryable ConnectionFailed', () => {
    for (const code of [425, 426, 450]) {
      const error = toOmniFsError(reply(code));
      expect(error.code, `reply ${code}`).toBe('ConnectionFailed');
      expect(error.retryable, `reply ${code}`).toBe(true);
    }
  });

  it('reads the out-of-space replies as QuotaExceeded', () => {
    expect(toOmniFsError(reply(452)).code).toBe('QuotaExceeded');
    expect(toOmniFsError(reply(552)).code).toBe('QuotaExceeded');
  });

  it('reads a command the server does not know as Unsupported', () => {
    for (const code of [500, 501, 502, 504]) {
      expect(toOmniFsError(reply(code)).code, `reply ${code}`).toBe('Unsupported');
    }
  });

  it('reads socket failures as retryable ConnectionFailed', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH']) {
      const error = toOmniFsError(system(code));
      expect(error.code, code).toBe('ConnectionFailed');
      expect(error.retryable, code).toBe(true);
    }
  });

  it('reads a timeout as a retryable Timeout', () => {
    const error = toOmniFsError(new Error('Timeout (control socket)'));
    expect(error.code).toBe('Timeout');
    expect(error.retryable).toBe(true);
  });

  it('reads an abort as Cancelled', () => {
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(toOmniFsError(aborted).code).toBe('Cancelled');
  });

  it('names the self-signed setting when the certificate is the problem', () => {
    for (const code of [
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ]) {
      const error = toOmniFsError(system(code));
      expect(error.code, code).toBe('ConnectionFailed');
      expect(error.message, code).toMatch(/Allow self-signed certificates/);
    }
  });

  it('does not retry a certificate this client will never accept', () => {
    // Retrying an identical handshake against an identical certificate is pure
    // cost: the answer cannot change until a setting does.
    expect(toOmniFsError(system('DEPTH_ZERO_SELF_SIGNED_CERT')).retryable).toBe(false);
  });

  it('names the TLS floor setting when the protocol version is the problem', () => {
    for (const code of [
      'ERR_SSL_UNSUPPORTED_PROTOCOL',
      'ERR_SSL_WRONG_VERSION_NUMBER',
      'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
    ]) {
      const error = toOmniFsError(system(code));
      expect(error.code, code).toBe('ConnectionFailed');
      expect(error.message, code).toMatch(/Minimum TLS version/);
      expect(error.retryable, code).toBe(false);
    }
  });

  it('reads a security-level refusal as the TLS floor talking, not the certificate', () => {
    // `dh key too small` is OpenSSL's security level, and the security level is
    // exactly what the TLS floor setting moves.
    const error = toOmniFsError(system('EPROTO', 'handshake failure: dh key too small'));
    expect(error.message).toMatch(/Minimum TLS version/);
  });

  it('reads an EPROTO with no protocols available as the TLS floor too', () => {
    const error = toOmniFsError(system('EPROTO', 'no protocols available'));
    expect(error.message).toMatch(/Minimum TLS version/);
  });

  it('falls back to Unknown rather than guessing', () => {
    expect(toOmniFsError(new Error('something else entirely')).code).toBe('Unknown');
  });

  it('survives a thrown non-error', () => {
    expect(toOmniFsError('just a string').code).toBe('Unknown');
  });
});

describe('isReplyCode', () => {
  it('matches the reply code the server sent', () => {
    expect(isReplyCode(reply(550), 550)).toBe(true);
    expect(isReplyCode(reply(550), 521, 550)).toBe(true);
    expect(isReplyCode(reply(553), 550)).toBe(false);
  });

  it('does not confuse a Node error code with a reply code', () => {
    expect(isReplyCode(system('ECONNRESET'), 550)).toBe(false);
  });

  it('sees through an OmniFsError to the reply it was built from', () => {
    // The call sites that narrow a 550 — RMD to NotEmpty, MKD to
    // AlreadyExists — are holding an already-translated error, because the
    // channel translates before anything above it sees the failure.
    const translated = toOmniFsError(reply(550), '/data/full');
    expect(isReplyCode(translated, 550)).toBe(true);
    expect(isReplyCode(translated, 553)).toBe(false);
  });
});

describe('isConnectionLimit', () => {
  it('recognises the 421 that means the server is full', () => {
    expect(isConnectionLimit(reply(421, '421 There are too many connections from your IP'))).toBe(
      true,
    );
    expect(isConnectionLimit(reply(421, '421 Session limit reached'))).toBe(true);
  });

  it('does not treat every 421 as a connection limit', () => {
    // A 421 also means "idle timeout, goodbye", which must reconnect rather
    // than permanently shrink the pool.
    expect(isConnectionLimit(reply(421, '421 Timeout.'))).toBe(false);
  });

  it('is false for anything that is not a 421', () => {
    expect(isConnectionLimit(reply(550))).toBe(false);
    expect(isConnectionLimit(system('ECONNRESET'))).toBe(false);
  });

  it('recognises a connection limit through a translated error', () => {
    // The pool only ever sees translated errors: the channel's open() catches
    // and translates before the pool can look.
    const translated = toOmniFsError(reply(421, '421 Too many connections'));
    expect(isConnectionLimit(translated)).toBe(true);
  });
});
