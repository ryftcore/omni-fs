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
      // Only the extension host may resolve a pending call. VS Code loads a
      // webview's content in a frame at `vscode-webview://<uuid>`, an origin
      // that is this webview's and nothing else's, and `webview.postMessage`
      // arrives there carrying it. Anything else on the `message` bus is
      // somebody else — a frame inside rendered content, another extension's
      // webview, an opener — and `#receive` resolves a pending call on
      // nothing but a matching id, so a stranger could otherwise answer
      // `listConnections`, or fail a `test` with a message the user would
      // read as the server's. The panel's CSP (`default-src 'none'`) means no
      // such frame can exist today; this is the second lock.
      //
      // The sender is not checked as well because there is nothing nameable
      // to check it against: `event.source` reaches the content frame as a
      // `Window` that is neither `parent`, `top` nor this frame.
      // `webview-origin.test.ts` measures both facts against a real editor.
      if (event.origin !== window.origin) return;
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
