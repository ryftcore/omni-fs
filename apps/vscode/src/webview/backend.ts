import type {
  ConnectionSummary,
  ConnectionsBackend,
  InitialSelection,
  ProbeOutcome,
  SaveConnectionInput,
  TestConnectionInput,
} from '@omni-fs/ui';
import type { ConnectionId, ProviderSummary } from '@omni-fs/core';
import type { HostToView, MethodName, ViewToHost } from './protocol.js';

interface VsCodeApi {
  postMessage(message: ViewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/**
 * The VS Code half of the seam. Turns the Port's method calls into correlated
 * postMessage round trips. `apps/desktop` will have a sibling of this file
 * over `ipcRenderer` — and nothing in `packages/ui` will change.
 */
export class WebviewBackend implements ConnectionsBackend {
  readonly #api: VsCodeApi = acquireVsCodeApi();
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly #listeners = new Set<() => void>();
  #nextId = 0;

  constructor() {
    window.addEventListener('message', (event: MessageEvent) => {
      this.#receive(event.data as HostToView);
    });
    // The host replies with full state; this also covers a webview reload.
    this.#api.postMessage({ kind: 'ready' });
  }

  listProviders(): Promise<readonly ProviderSummary[]> {
    return this.#call('listProviders', undefined);
  }

  listConnections(): Promise<readonly ConnectionSummary[]> {
    return this.#call('listConnections', undefined);
  }

  initialSelection(): Promise<InitialSelection | undefined> {
    return this.#call('initialSelection', undefined);
  }

  save(input: SaveConnectionInput): Promise<ConnectionId> {
    return this.#call('save', input);
  }

  remove(id: ConnectionId): Promise<void> {
    return this.#call('remove', id);
  }

  test(input: TestConnectionInput): Promise<ProbeOutcome> {
    return this.#call('test', input);
  }

  connect(id: ConnectionId): Promise<void> {
    return this.#call('connect', id);
  }

  pickFile(): Promise<string | undefined> {
    return this.#call('pickFile', undefined);
  }

  onDidChange(listener: () => void): Disposable {
    this.#listeners.add(listener);
    return { [Symbol.dispose]: () => this.#listeners.delete(listener) };
  }

  #call<T>(method: MethodName, params: unknown): Promise<T> {
    const id = (this.#nextId += 1);
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#api.postMessage({ kind: 'request', id, method, params });
    });
  }

  #receive(message: HostToView): void {
    if (message.kind === 'event') {
      for (const listener of this.#listeners) listener();
      return;
    }

    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);

    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.error.message));
  }
}
