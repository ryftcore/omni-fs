import { Emitter } from '../util/events.js';
import { OmniFsError } from '../errors.js';
import type { Logger } from '../ports/logger.js';
import type { TransferRequest, TransferTask } from './types.js';

export interface TransferQueueOptions {
  readonly logger: Logger;
  /** Global ceiling. Per-connection limits come from provider capabilities. */
  readonly maxConcurrent?: number;
  readonly maxAttempts?: number;
  /** Base for exponential backoff between retries. */
  readonly retryBaseMs?: number;
}

/** Does the actual work for one task; reports progress as it goes. */
export type TransferExecutor = (
  task: TransferTask,
  ctx: { signal: AbortSignal; onProgress: (bytes: number) => void },
) => Promise<void>;

/**
 * Priority queue with bounded concurrency, exponential-backoff retry and
 * cancellation.
 *
 * Every host needs this: the extension shows it in a "Transfers" view, the
 * desktop app in a progress panel. Only the rendering differs, so only the
 * rendering lives in the host.
 *
 * Concurrency is capped per connection using the provider's declared
 * `maxConcurrency` — an FTP server with one control channel must not receive
 * eight parallel uploads, while S3 happily takes sixteen.
 */
export class TransferQueue implements Disposable {
  readonly #options: Required<TransferQueueOptions>;
  readonly #tasks = new Map<string, TransferTask>();
  readonly #pending: string[] = [];
  readonly #controllers = new Map<string, AbortController>();
  readonly #perConnectionLimit = new Map<string, number>();
  readonly #perConnectionActive = new Map<string, number>();
  readonly #onDidChange = new Emitter<TransferTask>();

  #active = 0;
  #executor: TransferExecutor | undefined;
  #disposed = false;

  readonly onDidChange = this.#onDidChange.event;

  constructor(options: TransferQueueOptions) {
    this.#options = {
      maxConcurrent: 4,
      maxAttempts: 3,
      retryBaseMs: 500,
      ...options,
    };
  }

  /** Set once at wiring time by the host. */
  setExecutor(executor: TransferExecutor): void {
    this.#executor = executor;
  }

  /** Applies a provider's declared `maxConcurrency` to one connection. */
  setConnectionLimit(connectionId: string, limit: number): void {
    this.#perConnectionLimit.set(connectionId, Math.max(1, limit));
  }

  enqueue(request: TransferRequest): TransferTask {
    const task: TransferTask = {
      ...request,
      id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      status: 'queued',
      transferredBytes: 0,
      attempt: 0,
      queuedAt: Date.now(),
    };

    this.#tasks.set(task.id, task);
    this.#insertByPriority(task);
    this.#onDidChange.fire(task);
    this.#pump();
    return task;
  }

  cancel(taskId: string): void {
    const task = this.#tasks.get(taskId);
    if (task === undefined) return;

    this.#controllers.get(taskId)?.abort();

    if (task.status === 'queued' || task.status === 'retrying') {
      const index = this.#pending.indexOf(taskId);
      if (index >= 0) this.#pending.splice(index, 1);
      this.#update(taskId, { status: 'cancelled', finishedAt: Date.now() });
    }
  }

  cancelAll(): void {
    for (const id of [...this.#tasks.keys()]) this.cancel(id);
  }

  list(): readonly TransferTask[] {
    return [...this.#tasks.values()];
  }

  get activeCount(): number {
    return this.#active;
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  /** Drops finished tasks so the UI list does not grow without bound. */
  clearCompleted(): void {
    for (const [id, task] of this.#tasks) {
      if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'failed') {
        this.#tasks.delete(id);
      }
    }
  }

  #insertByPriority(task: TransferTask): void {
    const priority = task.priority ?? 0;
    const index = this.#pending.findIndex((id) => (this.#tasks.get(id)?.priority ?? 0) < priority);
    if (index === -1) this.#pending.push(task.id);
    else this.#pending.splice(index, 0, task.id);
  }

  #pump(): void {
    if (this.#disposed || this.#executor === undefined) return;

    while (this.#active < this.#options.maxConcurrent) {
      const index = this.#pending.findIndex((id) => this.#hasConnectionSlot(id));
      if (index === -1) return;

      const [taskId] = this.#pending.splice(index, 1);
      if (taskId === undefined) return;
      void this.#run(taskId);
    }
  }

  #hasConnectionSlot(taskId: string): boolean {
    const task = this.#tasks.get(taskId);
    if (task === undefined) return false;
    const limit = this.#perConnectionLimit.get(task.connectionId) ?? 1;
    const active = this.#perConnectionActive.get(task.connectionId) ?? 0;
    return active < limit;
  }

  async #run(taskId: string): Promise<void> {
    const task = this.#tasks.get(taskId);
    if (task === undefined || this.#executor === undefined) return;

    const controller = new AbortController();
    this.#controllers.set(taskId, controller);
    this.#active += 1;
    this.#bumpConnection(task.connectionId, 1);

    const running = this.#update(taskId, {
      status: 'running',
      attempt: task.attempt + 1,
      startedAt: task.startedAt ?? Date.now(),
      error: undefined,
    });

    try {
      await this.#executor(running, {
        signal: controller.signal,
        onProgress: (bytes) => this.#update(taskId, { transferredBytes: bytes }),
      });
      this.#update(taskId, { status: 'completed', finishedAt: Date.now() });
    } catch (error) {
      this.#handleFailure(taskId, error);
    } finally {
      this.#controllers.delete(taskId);
      this.#active -= 1;
      this.#bumpConnection(task.connectionId, -1);
      this.#pump();
    }
  }

  #handleFailure(taskId: string, error: unknown): void {
    const task = this.#tasks.get(taskId);
    if (task === undefined) return;

    const omniError = OmniFsError.wrap(error, { path: task.remotePath.value });

    if (omniError.code === 'Cancelled') {
      this.#update(taskId, { status: 'cancelled', finishedAt: Date.now() });
      return;
    }

    const canRetry = omniError.retryable && task.attempt < this.#options.maxAttempts;
    if (!canRetry) {
      this.#options.logger.log('error', 'Transfer failed', {
        taskId,
        path: task.remotePath.value,
        code: omniError.code,
        message: omniError.message,
      });
      this.#update(taskId, {
        status: 'failed',
        error: omniError.message,
        finishedAt: Date.now(),
      });
      return;
    }

    // Exponential backoff. `attempt` is already incremented for this try.
    const delay = this.#options.retryBaseMs * 2 ** (task.attempt - 1);
    this.#update(taskId, { status: 'retrying', error: omniError.message });
    const timer = setTimeout(() => {
      if (this.#tasks.get(taskId)?.status !== 'retrying') return;
      this.#insertByPriority(this.#tasks.get(taskId)!);
      this.#pump();
    }, delay);
    timer.unref?.();
  }

  #bumpConnection(connectionId: string, delta: number): void {
    const next = (this.#perConnectionActive.get(connectionId) ?? 0) + delta;
    if (next <= 0) this.#perConnectionActive.delete(connectionId);
    else this.#perConnectionActive.set(connectionId, next);
  }

  #update(taskId: string, patch: Partial<TransferTask>): TransferTask {
    const current = this.#tasks.get(taskId);
    if (current === undefined) throw new Error(`Unknown transfer task: ${taskId}`);
    const next = { ...current, ...patch } as TransferTask;
    this.#tasks.set(taskId, next);
    this.#onDidChange.fire(next);
    return next;
  }

  [Symbol.dispose](): void {
    this.#disposed = true;
    this.cancelAll();
    this.#onDidChange.dispose();
  }
}
