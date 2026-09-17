import type { ConnectionId, ConnectionSecret } from '../model/connection.js';

/**
 * PORT. The single way credentials are read or written anywhere in omni-fs.
 *
 * VS Code backs this with `ExtensionContext.secrets` (OS keychain). The desktop
 * app will back it with `safeStorage` + keytar. Core holds secrets in memory
 * only for the duration of a connect call and never serialises them.
 */
export interface SecretStore {
  get(connectionId: ConnectionId): Promise<ConnectionSecret | undefined>;
  set(connectionId: ConnectionId, secret: ConnectionSecret): Promise<void>;
  delete(connectionId: ConnectionId): Promise<void>;
}

/** In-memory implementation. Tests and conformance runs only — never ship it. */
export class InMemorySecretStore implements SecretStore {
  readonly #secrets = new Map<ConnectionId, ConnectionSecret>();

  async get(connectionId: ConnectionId): Promise<ConnectionSecret | undefined> {
    return this.#secrets.get(connectionId);
  }

  async set(connectionId: ConnectionId, secret: ConnectionSecret): Promise<void> {
    this.#secrets.set(connectionId, secret);
  }

  async delete(connectionId: ConnectionId): Promise<void> {
    this.#secrets.delete(connectionId);
  }
}
