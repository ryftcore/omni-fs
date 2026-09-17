import { OmniFsError } from '../errors.js';

/** Throws `Cancelled` if the signal is already aborted. */
export function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) throw OmniFsError.cancelled(operation);
}

/**
 * Rejects when `signal` aborts, so a provider without native cancellation still
 * releases its caller promptly. The underlying request keeps running until the
 * protocol library notices — that is a provider bug to fix, not something this
 * helper can paper over.
 */
export function withCancellation<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  operation: string,
): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(OmniFsError.cancelled(operation));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(OmniFsError.cancelled(operation));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Merges an outer signal with a per-operation timeout. */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}
