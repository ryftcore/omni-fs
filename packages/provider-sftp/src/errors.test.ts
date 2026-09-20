import { describe, expect, it } from 'vitest';
import { OmniFsError } from '@omni-fs/core';
import { isFailure, toOmniFsError } from './errors.js';

function statusError(code: number, message = 'Failure'): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

function systemError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

describe('toOmniFsError', () => {
  it('passes an OmniFsError straight through', () => {
    const original = OmniFsError.notFound('/a.txt');
    expect(toOmniFsError(original)).toBe(original);
  });

  it.each([
    [2, 'NotFound'],
    [3, 'PermissionDenied'],
    [5, 'ProtocolError'],
    [6, 'ConnectionFailed'],
    [7, 'ConnectionFailed'],
    [8, 'Unsupported'],
  ])('maps SFTP status %i to %s', (status, code) => {
    expect(toOmniFsError(statusError(status), '/a.txt').code).toBe(code);
  });

  it('leaves status 4 unclassified, because only the call site knows what it meant', () => {
    expect(toOmniFsError(statusError(4), '/dir').code).toBe('Unknown');
  });

  it('marks a lost connection retryable', () => {
    expect(toOmniFsError(statusError(7)).retryable).toBe(true);
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EPIPE'])(
    'maps %s to a retryable ConnectionFailed',
    (code) => {
      const error = toOmniFsError(systemError(code));
      expect(error.code).toBe('ConnectionFailed');
      expect(error.retryable).toBe(true);
    },
  );

  it('maps a failed handshake to Timeout', () => {
    expect(toOmniFsError(new Error('Timed out while waiting for handshake')).code).toBe('Timeout');
  });

  it('maps rejected credentials to AuthenticationFailed', () => {
    expect(toOmniFsError(new Error('All configured authentication methods failed')).code).toBe(
      'AuthenticationFailed',
    );
  });

  it('maps an aborted operation to Cancelled', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(toOmniFsError(abort, '/a.txt').code).toBe('Cancelled');
  });

  it('keeps the path and the provider id on what it builds', () => {
    const error = toOmniFsError(statusError(3), '/secret.txt');
    expect(error.path).toBe('/secret.txt');
    expect(error.providerId).toBe('sftp');
  });

  it('keeps the path, provider id and cause on a NotFound built via the status-2 branch', () => {
    const original = statusError(2);
    const error = toOmniFsError(original, '/missing.txt');
    expect(error.path).toBe('/missing.txt');
    expect(error.providerId).toBe('sftp');
    expect(error.cause).toBe(original);
  });

  it('keeps the path and provider id on a Cancelled built via the AbortError branch', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const error = toOmniFsError(abort, '/a.txt');
    expect(error.path).toBe('/a.txt');
    expect(error.providerId).toBe('sftp');
  });

  it('calls anything it cannot place Unknown rather than guessing', () => {
    expect(toOmniFsError(new Error('something else entirely')).code).toBe('Unknown');
  });
});

describe('isFailure', () => {
  it('is true only for SFTP status 4', () => {
    expect(isFailure(statusError(4))).toBe(true);
    expect(isFailure(statusError(2))).toBe(false);
    expect(isFailure(new Error('no code at all'))).toBe(false);
  });
});
