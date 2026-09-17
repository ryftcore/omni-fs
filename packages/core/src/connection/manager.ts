import { Emitter } from '../util/events.js';
import { OmniFsError } from '../errors.js';
import type { ConfigStore } from '../ports/config-store.js';
import type { ConnectionConfig, ConnectionId, ConnectionState } from '../model/connection.js';
import type { Logger } from '../ports/logger.js';
import type { ProviderRegistry } from '../registry.js';
import type { RemoteFileSystem } from '../provider.js';
import type { SecretStore } from '../ports/secret-store.js';

export interface ConnectionStateChange {
  readonly connectionId: ConnectionId;
  readonly state: ConnectionState;
}

export interface ConnectionManagerOptions {
  readonly registry: ProviderRegistry;
  readonly configStore: ConfigStore;
  readonly secretStore: SecretStore;
  readonly logger: Logger;
  /** Drop an idle connection after this long. `0` disables. Default 5 min. */
  readonly idleTimeoutMs?: number;
}

/**
 * Owns the lifecycle of live `RemoteFileSystem` instances: lazy connect,
 * de-duplicated concurrent connects, idle eviction, state broadcasting.
 *
 * This is the single largest piece of logic that would otherwise be written
 * twice — once in the extension and once in the desktop app — and it is exactly
 * the kind of thing that drifts between two copies. It lives here instead.
 */
export class ConnectionManager implements AsyncDisposable {
  readonly #options: Required<ConnectionManagerOptions>;
  readonly #live = new Map<ConnectionId, RemoteFileSystem>();
  readonly #connecting = new Map<ConnectionId, Promise<RemoteFileSystem>>();
  readonly #states = new Map<ConnectionId, ConnectionState>();
  readonly #idleTimers = new Map<ConnectionId, ReturnType<typeof setTimeout>>();
  readonly #onDidChangeState = new Emitter<ConnectionStateChange>();

  readonly onDidChangeState = this.#onDidChangeState.event;

  constructor(options: ConnectionManagerOptions) {
    this.#options = { idleTimeoutMs: 5 * 60_000, ...options };
  }

  getState(id: ConnectionId): ConnectionState {
    return this.#states.get(id) ?? { status: 'disconnected' };
  }

  /**
   * Returns a connected filesystem, connecting if needed. Concurrent callers
   * share one connect attempt — without this, expanding a tree node fires a
   * stat and a list simultaneously and opens two FTP control channels.
   */
  async acquire(id: ConnectionId, signal?: AbortSignal): Promise<RemoteFileSystem> {
    const existing = this.#live.get(id);
    if (existing !== undefined && existing.isAlive()) {
      this.#touch(id);
      return existing;
    }

    const pending = this.#connecting.get(id);
    if (pending !== undefined) return pending;

    const attempt = this.#connect(id, signal);
    this.#connecting.set(id, attempt);
    try {
      return await attempt;
    } finally {
      this.#connecting.delete(id);
    }
  }

  async #connect(id: ConnectionId, signal?: AbortSignal): Promise<RemoteFileSystem> {
    const config = await this.#options.configStore.get(id);
    if (config === undefined) {
      throw new OmniFsError({ code: 'NotFound', message: `Unknown connection: ${id}` });
    }

    this.#setState(id, { status: 'connecting' });
    const definition = this.#options.registry.get(config.providerId);
    const logger = this.#options.logger.child(`${config.providerId}:${config.label}`);

    const fs = definition.create({
      config,
      getSecret: async () => {
        const secret = await this.#options.secretStore.get(id);
        if (secret === undefined) {
          throw new OmniFsError({
            code: 'AuthenticationFailed',
            message: `No stored credentials for "${config.label}".`,
            providerId: config.providerId,
          });
        }
        return secret;
      },
      logger,
    });

    try {
      await fs.connect(signal);
    } catch (error) {
      const wrapped = OmniFsError.wrap(error, { providerId: config.providerId });
      this.#setState(id, { status: 'error', error: wrapped.message, at: Date.now() });
      // Release whatever the failed connect left open. A teardown failure here
      // must not mask the original connect error.
      try {
        await fs[Symbol.asyncDispose]();
      } catch {
        // ignored on purpose
      }
      throw wrapped;
    }

    this.#live.set(id, fs);
    this.#setState(id, { status: 'connected', since: Date.now() });
    this.#touch(id);
    return fs;
  }

  /** Closes one connection. Safe to call when it is not open. */
  async disconnect(id: ConnectionId): Promise<void> {
    this.#clearIdleTimer(id);
    const fs = this.#live.get(id);
    this.#live.delete(id);
    if (fs === undefined) return;

    try {
      await fs[Symbol.asyncDispose]();
    } catch (error) {
      this.#options.logger.log('warn', 'Error while disconnecting', {
        connectionId: id,
        error: String(error),
      });
    }
    this.#setState(id, { status: 'disconnected' });
  }

  /** Call after editing a config so the next acquire uses the new settings. */
  async invalidate(config: ConnectionConfig): Promise<void> {
    await this.disconnect(config.id);
  }

  #touch(id: ConnectionId): void {
    const { idleTimeoutMs } = this.#options;
    this.#clearIdleTimer(id);
    if (idleTimeoutMs <= 0) return;

    const timer = setTimeout(() => {
      void this.disconnect(id);
    }, idleTimeoutMs);
    // Do not hold the host process open just to expire an idle FTP socket.
    timer.unref?.();
    this.#idleTimers.set(id, timer);
  }

  #clearIdleTimer(id: ConnectionId): void {
    const timer = this.#idleTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#idleTimers.delete(id);
    }
  }

  #setState(id: ConnectionId, state: ConnectionState): void {
    this.#states.set(id, state);
    this.#onDidChangeState.fire({ connectionId: id, state });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await Promise.all([...this.#live.keys()].map((id) => this.disconnect(id)));
    this.#onDidChangeState.dispose();
  }
}
