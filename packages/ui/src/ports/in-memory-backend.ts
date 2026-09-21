import { mergeSecret } from '@omni-fs/core';
import type { ConnectionId, ProviderSummary } from '@omni-fs/core';
import type {
  ConnectionSummary,
  ConnectionsBackend,
  InitialSelection,
  ProbeOutcome,
  SaveConnectionInput,
  TestConnectionInput,
} from './connections-backend.js';

/**
 * A working backend with no host behind it.
 *
 * Mirrors `InMemoryConfigStore` in core, and serves the same two purposes:
 * reducer tests run against a real implementation rather than a hand-rolled
 * stub, and the desktop renderer can be built before any Electron IPC exists.
 */
export class InMemoryConnectionsBackend implements ConnectionsBackend {
  readonly #providers: readonly ProviderSummary[];
  readonly #connections = new Map<ConnectionId, ConnectionSummary>();
  readonly #secrets = new Map<ConnectionId, Record<string, unknown>>();
  readonly #listeners = new Set<() => void>();
  #counter = 0;

  /** Set to make the next `test()` fail, for exercising the error path. */
  nextProbe: ProbeOutcome = { ok: true, durationMs: 1 };
  /** Set to make `pickFile()` return a path. */
  nextFile: string | undefined = undefined;
  /** Set to open on a particular connection. */
  nextInitialSelection: InitialSelection | undefined = undefined;

  constructor(providers: readonly ProviderSummary[]) {
    this.#providers = providers;
  }

  async listProviders(): Promise<readonly ProviderSummary[]> {
    return this.#providers;
  }

  async listConnections(): Promise<readonly ConnectionSummary[]> {
    return [...this.#connections.values()];
  }

  async save(input: SaveConnectionInput): Promise<ConnectionId> {
    const id = input.id ?? `mem${(this.#counter += 1)}`;
    const provider = this.#providers.find((candidate) => candidate.id === input.providerId);
    if (provider === undefined) throw new Error(`Unknown provider: ${input.providerId}`);

    const merged = mergeSecret(this.#secrets.get(id), input.secretPatch, provider.secretSchema);
    this.#secrets.set(id, { ...merged });

    this.#connections.set(id, {
      id,
      providerId: input.providerId,
      label: input.label,
      settings: input.settings,
      rootPath: input.rootPath,
      readOnly: input.readOnly,
      color: input.color,
      secretFieldsPresent: Object.keys(merged),
      state: { status: 'disconnected' },
    });

    this.#emit();
    return id;
  }

  async remove(id: ConnectionId): Promise<void> {
    this.#connections.delete(id);
    this.#secrets.delete(id);
    this.#emit();
  }

  async test(_input: TestConnectionInput): Promise<ProbeOutcome> {
    return this.nextProbe;
  }

  async connect(_id: ConnectionId): Promise<void> {
    // Nothing to connect to in memory.
  }

  async initialSelection(): Promise<InitialSelection | undefined> {
    return this.nextInitialSelection;
  }

  async pickFile(): Promise<string | undefined> {
    return this.nextFile;
  }

  onDidChange(listener: () => void): Disposable {
    this.#listeners.add(listener);
    return { [Symbol.dispose]: () => this.#listeners.delete(listener) };
  }

  /** Test-only window onto stored credentials. Not part of the Port. */
  secretFor(id: ConnectionId): Record<string, unknown> | undefined {
    return this.#secrets.get(id);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
