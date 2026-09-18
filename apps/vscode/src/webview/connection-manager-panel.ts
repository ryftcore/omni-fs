import * as vscode from 'vscode';
import { mergeSecret, toProviderSummary } from '@omni-fs/core';
import type {
  ConfigStore,
  ConnectionConfig,
  ConnectionManager,
  ProviderRegistry,
  SecretStore,
} from '@omni-fs/core';
import type {
  ConnectionSummary,
  InitialSelection,
  ProbeOutcome,
  SaveConnectionInput,
  TestConnectionInput,
} from '@omni-fs/ui';
import type { HostToView, MethodName, ViewToHost } from './protocol.js';

export interface PanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly manager: ConnectionManager;
  readonly configStore: ConfigStore;
  readonly secretStore: SecretStore;
  readonly registry: ProviderRegistry;
  readonly onChanged: () => void;
}

/**
 * The extension-host half of the connection manager.
 *
 * This is the only file that touches ConfigStore, SecretStore, the registry and
 * the ConnectionManager on the panel's behalf. The webview gets data and
 * nothing else — in particular it never receives a stored credential.
 */
export class ConnectionManagerPanel {
  static #current: ConnectionManagerPanel | undefined;

  readonly #panel: vscode.WebviewPanel;
  readonly #deps: PanelDeps;
  readonly #disposables: vscode.Disposable[] = [];
  #selection: InitialSelection | undefined;

  static show(deps: PanelDeps, selection?: InitialSelection): void {
    const existing = ConnectionManagerPanel.#current;
    if (existing !== undefined) {
      existing.#selection = selection;
      existing.#panel.reveal(vscode.ViewColumn.Active);
      if (selection !== undefined) existing.#post({ kind: 'event', event: 'connectionsChanged' });
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'omniFs.connectionManager',
      'Omni-FS Connections',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // Keeps the webview's context alive while hidden, so an in-progress
        // draft survives switching to another editor tab instead of being
        // torn down. A genuine reload still resyncs everything else via the
        // `ready` message.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, 'out')],
      },
    );

    ConnectionManagerPanel.#current = new ConnectionManagerPanel(panel, deps, selection);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    deps: PanelDeps,
    selection: InitialSelection | undefined,
  ) {
    this.#panel = panel;
    this.#deps = deps;
    this.#selection = selection;

    panel.webview.html = this.#html();

    this.#disposables.push(
      panel.webview.onDidReceiveMessage((message: ViewToHost) => void this.#receive(message)),
    );

    // Hand-editing settings.json updates an open panel.
    const configSubscription = deps.configStore.onDidChange(() => {
      this.#post({ kind: 'event', event: 'connectionsChanged' });
    });
    const stateSubscription = deps.manager.onDidChangeState((change) => {
      this.#post({
        kind: 'event',
        event: 'stateChanged',
        connectionId: change.connectionId,
        state: change.state,
      });
    });

    panel.onDidDispose(() => {
      configSubscription[Symbol.dispose]();
      stateSubscription[Symbol.dispose]();
      for (const disposable of this.#disposables) disposable.dispose();
      ConnectionManagerPanel.#current = undefined;
    });
  }

  #post(message: HostToView): void {
    void this.#panel.webview.postMessage(message);
  }

  async #receive(message: ViewToHost): Promise<void> {
    if (message.kind === 'ready') {
      this.#post({ kind: 'event', event: 'connectionsChanged' });
      return;
    }

    try {
      this.#post({
        kind: 'response',
        id: message.id,
        ok: true,
        value: await this.#dispatch(message.method, message.params),
      });
    } catch (error) {
      this.#post({
        kind: 'response',
        id: message.id,
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  async #dispatch(method: MethodName, params: unknown): Promise<unknown> {
    switch (method) {
      case 'listProviders':
        return this.#deps.registry.list().map(toProviderSummary);

      case 'listConnections':
        return this.#listConnections();

      case 'initialSelection': {
        const selection = this.#selection;
        // One-shot: reopening the panel later should not jump back.
        this.#selection = undefined;
        return selection;
      }

      case 'save':
        return this.#save(params as SaveConnectionInput);

      case 'remove':
        return this.#remove(params as string);

      case 'test':
        return this.#test(params as TestConnectionInput);

      case 'connect':
        await this.#deps.manager.acquire(params as string);
        return undefined;

      case 'pickFile': {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false });
        return picked?.[0]?.fsPath;
      }
    }
  }

  async #listConnections(): Promise<readonly ConnectionSummary[]> {
    const configs = await this.#deps.configStore.list();

    return Promise.all(
      configs.map(async (config): Promise<ConnectionSummary> => {
        const secret = await this.#deps.secretStore.get(config.id);
        return {
          id: config.id,
          providerId: config.providerId,
          label: config.label,
          settings: config.settings,
          rootPath: config.rootPath,
          readOnly: config.readOnly ?? false,
          // Keys only. The values stay in this process.
          secretFieldsPresent: Object.keys(secret ?? {}),
          state: this.#deps.manager.getState(config.id),
        };
      }),
    );
  }

  async #save(input: SaveConnectionInput): Promise<string> {
    const definition = this.#deps.registry.get(input.providerId);
    const id = input.id ?? generateId();

    const stored = await this.#deps.configStore.get(id);

    const config: ConnectionConfig = {
      id,
      providerId: input.providerId,
      label: input.label,
      settings: input.settings,
      readOnly: input.readOnly,
      ...(input.rootPath !== undefined ? { rootPath: input.rootPath } : {}),
      // `color` is not edited by this UI and is absent from SaveConnectionInput, so it has to be
      // carried across by hand or a save would delete it. Add any future unmanaged
      // ConnectionConfig field here too.
      ...(stored?.color !== undefined ? { color: stored.color } : {}),
    };

    const storedSecret = await this.#deps.secretStore.get(id);
    const merged = mergeSecret(storedSecret, input.secretPatch, definition.secretSchema);

    await this.#deps.configStore.save(config);
    await this.#deps.secretStore.set(id, merged);
    // Settings may have changed, so any live connection is stale.
    await this.#deps.manager.invalidate(config);
    this.#deps.onChanged();

    return id;
  }

  async #remove(id: string): Promise<void> {
    const config = await this.#deps.configStore.get(id);
    const confirmed = await vscode.window.showWarningMessage(
      `Remove connection "${config?.label ?? id}"?`,
      {
        modal: true,
        detail: 'The remote server is not affected. Stored credentials are deleted.',
      },
      'Remove',
    );
    if (confirmed !== 'Remove') return;

    await this.#deps.manager.disconnect(id);
    await this.#deps.configStore.delete(id);
    await this.#deps.secretStore.delete(id);
    this.#deps.onChanged();
  }

  async #test(input: TestConnectionInput): Promise<ProbeOutcome> {
    const definition = this.#deps.registry.get(input.providerId);
    const stored = input.id === undefined ? undefined : await this.#deps.secretStore.get(input.id);
    // The merge happens here, not in the webview, which never sees `stored`.
    const secret = mergeSecret(stored, input.secretPatch, definition.secretSchema);

    const result = await this.#deps.manager.probe(
      {
        providerId: input.providerId,
        label: input.label,
        settings: input.settings,
        ...(input.rootPath !== undefined ? { rootPath: input.rootPath } : {}),
      },
      secret,
    );

    // Convert at the boundary: an OmniFsError instance cannot be
    // structured-cloned to the webview.
    return {
      ok: result.ok,
      durationMs: result.durationMs,
      ...(result.capabilities !== undefined ? { capabilities: result.capabilities } : {}),
      ...(result.error !== undefined
        ? {
            error: {
              code: result.error.code,
              message: result.error.message,
              retryable: result.error.retryable,
            },
          }
        : {}),
    };
  }

  #html(): string {
    const webview = this.#panel.webview;
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.#deps.extensionUri, 'out', 'webview.js'),
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.#deps.extensionUri, 'out', 'webview.css'),
    );
    const nonce = generateNonce();

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${style.toString()}" rel="stylesheet" />
    <title>Omni-FS Connections</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${script.toString()}"></script>
  </body>
</html>`;
  }
}

function generateId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function generateNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}
