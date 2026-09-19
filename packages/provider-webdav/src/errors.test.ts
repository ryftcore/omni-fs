import { describe, expect, it } from 'vitest';
import { OmniFsError } from '@omni-fs/core';
import { toOmniFsError } from './errors.js';

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
