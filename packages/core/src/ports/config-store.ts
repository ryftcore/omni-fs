import type { ConnectionConfig, ConnectionId } from '../model/connection.js';

/**
 * PORT. Persistence for the non-secret half of a connection.
 *
 * VS Code backs this with workspace/global `Memento` or `settings.json`, so
 * connections can be committed and shared with a team. The desktop app will
 * back it with a JSON file in userData. Same core logic either way.
 */
export interface ConfigStore {
  list(): Promise<readonly ConnectionConfig[]>;
  get(id: ConnectionId): Promise<ConnectionConfig | undefined>;
  save(config: ConnectionConfig): Promise<void>;
  delete(id: ConnectionId): Promise<void>;
  /** Fires when configs change outside this process (settings sync, file edit). */
  onDidChange(listener: () => void): Disposable;
}

export class InMemoryConfigStore implements ConfigStore {
  readonly #configs = new Map<ConnectionId, ConnectionConfig>();
  readonly #listeners = new Set<() => void>();

  async list(): Promise<readonly ConnectionConfig[]> {
    return [...this.#configs.values()];
  }

  async get(id: ConnectionId): Promise<ConnectionConfig | undefined> {
    return this.#configs.get(id);
  }

  async save(config: ConnectionConfig): Promise<void> {
    this.#configs.set(config.id, config);
    this.#emit();
  }

  async delete(id: ConnectionId): Promise<void> {
    this.#configs.delete(id);
    this.#emit();
  }

  onDidChange(listener: () => void): Disposable {
    this.#listeners.add(listener);
    return { [Symbol.dispose]: () => this.#listeners.delete(listener) };
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
