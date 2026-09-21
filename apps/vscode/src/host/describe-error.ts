import { OmniFsError } from '@omni-fs/core';

/**
 * An error as log data: the code and retry hint a host switches on when there
 * is one, and the message either way. Never the stack or the cause chain — a
 * native error from a protocol SDK can carry the request that failed, and the
 * log is a file people attach to bug reports.
 */
export function describeError(error: unknown): Record<string, unknown> {
  if (OmniFsError.is(error)) {
    return { code: error.code, retryable: error.retryable, message: error.message };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}
