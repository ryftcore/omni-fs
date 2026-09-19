import { describe, expect, it } from 'vitest';
import { OmniFsError } from '@omni-fs/core';
import { isPreconditionFailed, toOmniFsError } from './errors.js';

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`Request failed with status code ${status}`), { status });
}

describe('toOmniFsError', () => {
  it('passes an OmniFsError straight through', () => {
    const original = OmniFsError.notFound('/a.txt');
    expect(toOmniFsError(original)).toBe(original);
  });

  it.each([
    [404, 'NotFound'],
    [401, 'AuthenticationFailed'],
    [403, 'PermissionDenied'],
    [405, 'AlreadyExists'],
    [409, 'Conflict'],
    [412, 'Conflict'],
    [423, 'PermissionDenied'],
    [507, 'QuotaExceeded'],
  ])('maps HTTP %i to %s', (status, code) => {
    expect(toOmniFsError(httpError(status), '/a.txt').code).toBe(code);
  });

  it('marks 429 and 5xx retryable', () => {
    expect(toOmniFsError(httpError(429)).retryable).toBe(true);
    expect(toOmniFsError(httpError(503)).retryable).toBe(true);
  });

  it('maps an aborted request to Cancelled', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(toOmniFsError(abort, '/a.txt').code).toBe('Cancelled');
  });

  it('maps a refused socket to ConnectionFailed and marks it retryable', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const translated = toOmniFsError(refused);
    expect(translated.code).toBe('ConnectionFailed');
    expect(translated.retryable).toBe(true);
  });

  it('falls back to Unknown rather than leaking a bare Error', () => {
    expect(toOmniFsError(new Error('something odd')).code).toBe('Unknown');
  });
});

describe('isPreconditionFailed', () => {
  it('recognises a 412 however the client carried it', () => {
    expect(isPreconditionFailed(httpError(412))).toBe(true);
    // Some failures only carry the status on the response they wrap.
    expect(isPreconditionFailed({ response: { status: 412 } })).toBe(true);
  });

  it('is false for every other failure', () => {
    // 409 is the near miss that matters: COPY and MOVE answer it when the
    // *destination's parent* is missing, which is a real Conflict and must not
    // be reported as though the destination were already there.
    expect(isPreconditionFailed(httpError(409))).toBe(false);
    expect(isPreconditionFailed(httpError(404))).toBe(false);
    expect(isPreconditionFailed(new Error('no status at all'))).toBe(false);
    expect(isPreconditionFailed(undefined)).toBe(false);
  });

  it('does not see a 412 in an already-translated Conflict', () => {
    // `toOmniFsError` has flattened the status away by then, so a caller that
    // asked this too late gets `false` rather than a wrong `AlreadyExists`.
    expect(isPreconditionFailed(toOmniFsError(httpError(412), '/a.txt'))).toBe(false);
  });
});
