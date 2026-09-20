import { afterEach, describe, expect, it, vi } from 'vitest';
import { TransferQueue } from './queue.js';
import { NOOP_LOGGER } from '../ports/logger.js';
import { OmniFsError } from '../errors.js';
import { RemotePath } from '../model/path.js';
import type { TransferExecutor, TransferQueueOptions } from './queue.js';
import type { TransferRequest } from './types.js';

/**
 * The queue is the only place that decides how hard to push a server: a global
 * ceiling, a per-connection ceiling taken from the provider's declared
 * `maxConcurrency`, and a retry policy that consults nothing but
 * `OmniFsError.retryable`. Both hosts depend on all three.
 */

function request(overrides: Partial<TransferRequest> = {}): TransferRequest {
  return {
    direction: 'download',
    connectionId: 'c1',
    remotePath: RemotePath.parse('/a/one.txt'),
    ...overrides,
  };
}

function makeQueue(options: Partial<TransferQueueOptions> = {}): TransferQueue {
  return new TransferQueue({ logger: NOOP_LOGGER, ...options });
}

/** Resolves once the queue has no running and no pending work left. */
async function settle(queue: TransferQueue): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (queue.activeCount === 0 && queue.pendingCount === 0) return;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Queue never settled.');
}

/**
 * Lets the queue pump and any already-resolved executor run, without waiting
 * for the queue to drain — the concurrency tests hold tasks open on purpose.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function statusOf(queue: TransferQueue, id: string): string {
  return queue.list().find((task) => task.id === id)?.status ?? 'gone';
}

/** An executor that blocks until the test releases each task by id. */
function gatedExecutor(): {
  executor: TransferExecutor;
  started: string[];
  release: (id: string) => void;
} {
  const started: string[] = [];
  const gates = new Map<string, () => void>();

  const executor: TransferExecutor = (task) => {
    started.push(task.id);
    return new Promise<void>((resolve) => {
      gates.set(task.id, resolve);
    });
  };

  return {
    executor,
    started,
    release: (id) => gates.get(id)?.(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TransferQueue', () => {
  describe('running work', () => {
    it('runs an enqueued task to completion', async () => {
      const queue = makeQueue();
      queue.setExecutor(async () => undefined);

      const task = queue.enqueue(request());
      await settle(queue);

      expect(statusOf(queue, task.id)).toBe('completed');
    });

    it('reports progress as the executor makes it', async () => {
      const queue = makeQueue();
      const seen: number[] = [];
      queue.onDidChange((task) => seen.push(task.transferredBytes));
      queue.setExecutor(async (_task, ctx) => {
        ctx.onProgress(50);
        ctx.onProgress(100);
      });

      queue.enqueue(request({ totalBytes: 100 }));
      await settle(queue);

      expect(seen).toContain(50);
      expect(seen).toContain(100);
    });

    it('hands the executor a signal that cancellation aborts', async () => {
      const queue = makeQueue();
      let aborted = false;
      queue.setExecutor(
        (_task, ctx) =>
          new Promise<void>((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => {
              aborted = true;
              reject(OmniFsError.cancelled('download'));
            });
          }),
      );

      const task = queue.enqueue(request());
      await Promise.resolve();
      queue.cancel(task.id);
      await settle(queue);

      expect(aborted).toBe(true);
      expect(statusOf(queue, task.id)).toBe('cancelled');
    });
  });

  describe('ordering and concurrency', () => {
    it('runs higher priority work first', async () => {
      const queue = makeQueue({ maxConcurrent: 1 });
      const { executor, started, release } = gatedExecutor();
      queue.setExecutor(executor);
      queue.setConnectionLimit('c1', 8);

      const blocker = queue.enqueue(request());
      await flush();
      const low = queue.enqueue(request({ priority: 1 }));
      const high = queue.enqueue(request({ priority: 9 }));

      release(blocker.id);
      await flush();
      release(high.id);
      await flush();
      release(low.id);
      await flush();

      // An interactive save must outrank a bulk sync already in the queue,
      // even though the bulk sync was enqueued first.
      expect(started).toEqual([blocker.id, high.id, low.id]);
    });

    it('respects the global concurrency ceiling', async () => {
      const queue = makeQueue({ maxConcurrent: 2 });
      const { executor, started, release } = gatedExecutor();
      queue.setExecutor(executor);
      queue.setConnectionLimit('c1', 8);

      const tasks = [queue.enqueue(request()), queue.enqueue(request()), queue.enqueue(request())];
      await flush();

      expect(started).toHaveLength(2);
      expect(queue.activeCount).toBe(2);

      // Finishing one admits exactly one more, never two.
      release(tasks[0]!.id);
      await flush();
      expect(started).toHaveLength(3);

      for (const task of tasks) release(task.id);
      await flush();
    });

    it('serialises one connection while another runs in parallel', async () => {
      const queue = makeQueue({ maxConcurrent: 8 });
      const { executor, started, release } = gatedExecutor();
      queue.setExecutor(executor);
      // An FTP server with one control channel against an S3 bucket that fans out.
      queue.setConnectionLimit('ftp', 1);
      queue.setConnectionLimit('s3', 4);

      const ftpA = queue.enqueue(request({ connectionId: 'ftp' }));
      const ftpB = queue.enqueue(request({ connectionId: 'ftp' }));
      const s3A = queue.enqueue(request({ connectionId: 's3' }));
      const s3B = queue.enqueue(request({ connectionId: 's3' }));
      await flush();

      // Both S3 transfers run; the second FTP one waits on the control channel.
      expect(started).toEqual([ftpA.id, s3A.id, s3B.id]);

      release(ftpA.id);
      await flush();
      expect(started).toContain(ftpB.id);

      for (const task of [ftpB, s3A, s3B]) release(task.id);
      await flush();
    });

    it('defaults an unknown connection to one at a time', async () => {
      const queue = makeQueue({ maxConcurrent: 8 });
      const { executor, started, release } = gatedExecutor();
      queue.setExecutor(executor);

      queue.enqueue(request({ connectionId: 'unknown' }));
      queue.enqueue(request({ connectionId: 'unknown' }));
      await flush();

      // Better to under-use a server than to flood one whose limit is unknown.
      expect(started).toHaveLength(1);
      for (const task of queue.list()) release(task.id);
      await flush();
    });
  });

  describe('retry', () => {
    it('retries a retryable failure and succeeds on the second attempt', async () => {
      vi.useFakeTimers();
      const queue = makeQueue({ retryBaseMs: 10 });
      let attempts = 0;
      queue.setExecutor(async () => {
        attempts += 1;
        if (attempts === 1) throw new OmniFsError({ code: 'ConnectionFailed', message: 'reset' });
      });

      const task = queue.enqueue(request());
      await vi.advanceTimersByTimeAsync(0);
      expect(statusOf(queue, task.id)).toBe('retrying');

      await vi.advanceTimersByTimeAsync(20);

      expect(attempts).toBe(2);
      expect(statusOf(queue, task.id)).toBe('completed');
    });

    it('does not retry a permanent failure', async () => {
      const queue = makeQueue();
      let attempts = 0;
      queue.setExecutor(async () => {
        attempts += 1;
        throw new OmniFsError({ code: 'PermissionDenied', message: 'read-only' });
      });

      const task = queue.enqueue(request());
      await settle(queue);

      // `retryable` is the only thing consulted; retrying a 403 just wastes time.
      expect(attempts).toBe(1);
      expect(statusOf(queue, task.id)).toBe('failed');
    });

    it('gives up after maxAttempts', async () => {
      vi.useFakeTimers();
      const queue = makeQueue({ maxAttempts: 2, retryBaseMs: 10 });
      let attempts = 0;
      queue.setExecutor(async () => {
        attempts += 1;
        throw new OmniFsError({ code: 'Timeout', message: 'slow' });
      });

      const task = queue.enqueue(request());
      await vi.advanceTimersByTimeAsync(1_000);

      expect(attempts).toBe(2);
      expect(statusOf(queue, task.id)).toBe('failed');
    });

    it('backs off exponentially between attempts', async () => {
      vi.useFakeTimers();
      const queue = makeQueue({ maxAttempts: 3, retryBaseMs: 100 });
      let attempts = 0;
      queue.setExecutor(async () => {
        attempts += 1;
        throw new OmniFsError({ code: 'Timeout', message: 'slow' });
      });

      queue.enqueue(request());
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(attempts).toBe(2);

      // The second wait is twice the first, so 100ms more is not yet enough.
      await vi.advanceTimersByTimeAsync(100);
      expect(attempts).toBe(2);

      await vi.advanceTimersByTimeAsync(100);
      expect(attempts).toBe(3);
    });

    it('treats a cancellation as cancelled rather than a failure to retry', async () => {
      const queue = makeQueue();
      let attempts = 0;
      queue.setExecutor(async () => {
        attempts += 1;
        throw OmniFsError.cancelled('download');
      });

      const task = queue.enqueue(request());
      await settle(queue);

      expect(attempts).toBe(1);
      expect(statusOf(queue, task.id)).toBe('cancelled');
    });
  });

  describe('cancellation and cleanup', () => {
    it('cancels a task that has not started', async () => {
      const queue = makeQueue({ maxConcurrent: 1 });
      const { executor, release } = gatedExecutor();
      queue.setExecutor(executor);

      const running = queue.enqueue(request());
      const waiting = queue.enqueue(request());
      await flush();

      queue.cancel(waiting.id);

      expect(statusOf(queue, waiting.id)).toBe('cancelled');
      expect(queue.pendingCount).toBe(0);
      release(running.id);
    });

    it('ignores a cancel for an unknown task', () => {
      const queue = makeQueue();

      expect(() => queue.cancel('nope')).not.toThrow();
    });

    it('clearCompleted drops finished work and keeps the rest', async () => {
      const queue = makeQueue({ maxConcurrent: 1 });
      const { executor, release } = gatedExecutor();
      queue.setExecutor(executor);

      const running = queue.enqueue(request());
      const cancelled = queue.enqueue(request());
      await flush();
      queue.cancel(cancelled.id);

      queue.clearCompleted();

      expect(queue.list().map((task) => task.id)).toEqual([running.id]);
      release(running.id);
    });

    it('cancels everything when disposed', async () => {
      const queue = makeQueue({ maxConcurrent: 1 });
      const { executor, release } = gatedExecutor();
      queue.setExecutor(executor);
      const running = queue.enqueue(request());
      const waiting = queue.enqueue(request());
      await flush();

      queue[Symbol.dispose]();

      expect(statusOf(queue, waiting.id)).toBe('cancelled');
      release(running.id);
    });
  });

  describe('wiring', () => {
    it('starts work that was queued before the executor was wired up', async () => {
      const queue = makeQueue();
      const task = queue.enqueue(request());
      expect(statusOf(queue, task.id)).toBe('queued');

      queue.setExecutor(async () => undefined);
      await settle(queue);

      // A host that enqueues during startup must not end up with work that
      // never starts until some unrelated transfer happens to be added.
      expect(statusOf(queue, task.id)).toBe('completed');
    });
  });
});
