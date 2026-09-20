import * as vscode from 'vscode';
import type {
  ConfigStore,
  ConnectionConfig,
  ConnectionId,
  ConnectionSecret,
  Logger,
  LogLevel,
  SecretStore,
} from '@omni-fs/core';

/**
 * The VS Code side of every port `@omni-fs/core` declares.
 *
 * This file is the whole adapter layer. When the desktop app is built it gets
 * an `electron-ports.ts` of comparable size — an OutputChannel becomes
 * electron-log, SecretStorage becomes safeStorage, a Memento becomes a JSON
 * file — and nothing else in the codebase changes. That is the payoff for
 * keeping `packages/*` free of host APIs.
 */

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

export class VsCodeLogger implements Logger {
  readonly #channel: vscode.LogOutputChannel;
  readonly #scope: string;
  readonly #minLevel: LogLevel;

  constructor(channel: vscode.LogOutputChannel, minLevel: LogLevel = 'info', scope = '') {
    this.#channel = channel;
    this.#minLevel = minLevel;
    this.#scope = scope;
  }

  log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#minLevel]) return;

    const prefix = this.#scope === '' ? '' : `[${this.#scope}] `;
    const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`;
    const line = `${prefix}${message}${suffix}`;

    switch (level) {
      case 'trace':
        this.#channel.trace(line);
        break;
      case 'debug':
        this.#channel.debug(line);
        break;
      case 'info':
        this.#channel.info(line);
        break;
      case 'warn':
        this.#channel.warn(line);
        break;
      case 'error':
        this.#channel.error(line);
        break;
    }
  }

  child(scope: string): Logger {
    const nested = this.#scope === '' ? scope : `${this.#scope}/${scope}`;
    return new VsCodeLogger(this.#channel, this.#minLevel, nested);
  }
}

/**
 * Credentials go to `ExtensionContext.secrets`, which is the OS keychain
 * (Keychain on macOS, DPAPI on Windows, libsecret on Linux). They are never
 * written to settings.json, so a user can commit `omniFs.connections` without
 * leaking an access key.
 */
export class VsCodeSecretStore implements SecretStore {
  readonly #secrets: vscode.SecretStorage;

  constructor(secrets: vscode.SecretStorage) {
    this.#secrets = secrets;
  }

  async get(connectionId: ConnectionId): Promise<ConnectionSecret | undefined> {
    const raw = await this.#secrets.get(key(connectionId));
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as ConnectionSecret;
    } catch {
      // Corrupt entry is equivalent to no entry; the user will be re-prompted.
      return undefined;
    }
  }

  async set(connectionId: ConnectionId, secret: ConnectionSecret): Promise<void> {
    await this.#secrets.store(key(connectionId), JSON.stringify(secret));
  }

  async delete(connectionId: ConnectionId): Promise<void> {
    await this.#secrets.delete(key(connectionId));
  }
}

function key(connectionId: ConnectionId): string {
  return `omniFs.secret.${connectionId}`;
}

/**
 * Connection definitions live in the `omniFs.connections` setting rather than in
 * a Memento, so they participate in Settings Sync and can be committed to a
 * repo's `.vscode/settings.json` for a whole team.
 */
export class VsCodeConfigStore implements ConfigStore {
  readonly #section = 'omniFs';
  readonly #target: vscode.ConfigurationTarget;

  constructor(target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global) {
    this.#target = target;
  }

  async list(): Promise<readonly ConnectionConfig[]> {
    const raw = vscode.workspace.getConfiguration(this.#section).get<unknown[]>('connections', []);
    return raw.filter(isConnectionConfig);
  }

  async get(id: ConnectionId): Promise<ConnectionConfig | undefined> {
    return (await this.list()).find((config) => config.id === id);
  }

  async save(config: ConnectionConfig): Promise<void> {
    const existing = await this.list();
    const index = existing.findIndex((candidate) => candidate.id === config.id);
    const next = [...existing];
    if (index === -1) next.push(config);
    else next[index] = config;
    await this.#write(next);
  }

  async delete(id: ConnectionId): Promise<void> {
    const next = (await this.list()).filter((config) => config.id !== id);
    await this.#write(next);
  }

  onDidChange(listener: () => void): Disposable {
    const subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${this.#section}.connections`)) listener();
    });
    return { [Symbol.dispose]: () => subscription.dispose() };
  }

  async #write(configs: readonly ConnectionConfig[]): Promise<void> {
    await vscode.workspace
      .getConfiguration(this.#section)
      // `undefined` removes the key; an empty array would leave
      // `"omniFs.connections": []` behind. This setting is meant to be
      // committed and shared with a team, so removing the last connection has
      // to leave the file as it was found rather than adding a line to
      // someone's `.vscode/settings.json`.
      .update('connections', configs.length === 0 ? undefined : configs, this.#target);
  }
}

function isConnectionConfig(value: unknown): value is ConnectionConfig {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ConnectionConfig>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.providerId === 'string' &&
    typeof candidate.label === 'string' &&
    typeof candidate.settings === 'object' &&
    candidate.settings !== null
  );
}
