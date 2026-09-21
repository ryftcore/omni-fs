import * as vscode from 'vscode';
import { RemotePath } from '@omni-fs/core';
import type {
  ConfigStore,
  ConnectionConfig,
  EntryCache,
  Logger,
  ConnectionManager,
  ProviderRegistry,
  SecretStore,
  TransferQueue,
} from '@omni-fs/core';
import type { InitialSelection } from '@omni-fs/ui';
import { OmniFileSystemProvider } from '../fs/omni-file-system-provider.js';
import { ConnectionManagerPanel } from '../webview/connection-manager-panel.js';
import type { ConnectionNode, ConnectionsTreeProvider } from '../views/connections-tree.js';

export interface CommandDeps {
  readonly extensionUri: vscode.Uri;
  readonly manager: ConnectionManager;
  readonly configStore: ConfigStore;
  readonly secretStore: SecretStore;
  readonly registry: ProviderRegistry;
  readonly transfers: TransferQueue;
  readonly cache: EntryCache;
  readonly connectionsTree: ConnectionsTreeProvider;
  readonly logger: Logger;
}

/**
 * Command handlers.
 *
 * Adding, editing and managing connections all open the same
 * `ConnectionManagerPanel` (see `../webview/connection-manager-panel.ts`); this
 * file only resolves *which* connection a tree command applies to and wires
 * the remaining tree/transfer actions that do not need a webview at all.
 */
export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('omniFs.addConnection', () => {
      const first = deps.registry.list()[0];
      showPanel(deps, first === undefined ? undefined : { kind: 'new', providerId: first.id });
    }),
    vscode.commands.registerCommand('omniFs.editConnection', (node?: ConnectionNode) => {
      showPanel(
        deps,
        node?.kind === 'connection' ? { kind: 'connection', id: node.config.id } : undefined,
      );
    }),
    vscode.commands.registerCommand('omniFs.manageConnections', () => showPanel(deps)),
    vscode.commands.registerCommand('omniFs.removeConnection', (node?: ConnectionNode) =>
      removeConnection(deps, node),
    ),
    vscode.commands.registerCommand('omniFs.connect', (node?: ConnectionNode) =>
      connect(deps, node),
    ),
    vscode.commands.registerCommand('omniFs.disconnect', (node?: ConnectionNode) =>
      disconnect(deps, node),
    ),
    vscode.commands.registerCommand('omniFs.mountAsWorkspaceFolder', (node?: ConnectionNode) =>
      mount(deps, node),
    ),
    vscode.commands.registerCommand('omniFs.makeReadOnly', (node?: ConnectionNode) =>
      setReadOnly(deps, node, true),
    ),
    vscode.commands.registerCommand('omniFs.makeWritable', (node?: ConnectionNode) =>
      setReadOnly(deps, node, false),
    ),
    vscode.commands.registerCommand('omniFs.refresh', () => deps.connectionsTree.refresh()),
    vscode.commands.registerCommand('omniFs.clearCompletedTransfers', () =>
      deps.transfers.clearCompleted(),
    ),
    vscode.commands.registerCommand('omniFs.cancelTransfer', (task?: { id: string }) => {
      if (task !== undefined) deps.transfers.cancel(task.id);
    }),

    // TODO(vscode): download/upload land once the transfer executor is wired to
    // the local filesystem. The queue, retry and progress reporting already
    // exist in core; only the local-file half is missing.
    vscode.commands.registerCommand('omniFs.download', () => notYet('Download')),
    vscode.commands.registerCommand('omniFs.upload', () => notYet('Upload')),
  ];
}

function showPanel(deps: CommandDeps, selection?: InitialSelection): void {
  ConnectionManagerPanel.show(
    {
      extensionUri: deps.extensionUri,
      manager: deps.manager,
      configStore: deps.configStore,
      secretStore: deps.secretStore,
      registry: deps.registry,
      onChanged: () => deps.connectionsTree.refresh(),
    },
    selection,
  );
}

async function removeConnection(deps: CommandDeps, node?: ConnectionNode): Promise<void> {
  const config = await resolveConfig(deps, node);
  if (config === undefined) return;

  const confirmed = await vscode.window.showWarningMessage(
    `Remove connection "${config.label}"?`,
    { modal: true, detail: 'The remote server is not affected. Stored credentials are deleted.' },
    'Remove',
  );
  if (confirmed !== 'Remove') return;

  await deps.manager.disconnect(config.id);
  await deps.configStore.delete(config.id);
  await deps.secretStore.delete(config.id);
  deps.cache.invalidateConnection(config.id);
  deps.connectionsTree.refresh();
}

async function connect(deps: CommandDeps, node?: ConnectionNode): Promise<void> {
  const config = await resolveConfig(deps, node);
  if (config === undefined) return;
  await connectById(deps, config.id, config.label);
}

async function connectById(deps: CommandDeps, id: string, label: string): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Connecting to ${label}…` },
    async () => {
      try {
        const fs = await deps.manager.acquire(id);
        // Teach the queue this protocol's safe concurrency — an FTP server with
        // one control channel must not receive four parallel uploads.
        deps.transfers.setConnectionLimit(id, fs.capabilities.maxConcurrency);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Omni-FS: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
  deps.connectionsTree.refresh();
}

async function disconnect(deps: CommandDeps, node?: ConnectionNode): Promise<void> {
  const config = await resolveConfig(deps, node);
  if (config === undefined) return;
  await deps.manager.disconnect(config.id);
  deps.cache.invalidateConnection(config.id);
  deps.connectionsTree.refresh();
}

/**
 * The quick way to lock a connection, without opening the connection manager.
 *
 * Saves the flag and nothing else: the connection stays up, because
 * `OmniFileSystemProvider` reads `readOnly` on every operation rather than
 * once per connect. Writes are refused from the next one on. An editor
 * already open keeps the permissions VS Code read when it opened the file.
 */
async function setReadOnly(
  deps: CommandDeps,
  node: ConnectionNode | undefined,
  readOnly: boolean,
): Promise<void> {
  const picked = await resolveConfig(deps, node);
  if (picked === undefined) return;

  // A tree node carries the config as it was when the tree was drawn. Write
  // over the stored one, or an edit saved since would be silently undone.
  const stored = await deps.configStore.get(picked.id);
  if (stored === undefined) return;

  const { readOnly: _previous, ...rest } = stored;
  await deps.configStore.save(readOnly ? { ...rest, readOnly: true } : rest);
  deps.connectionsTree.refresh();
}

/**
 * Adds the connection root to the workspace. This is the payoff of implementing
 * FileSystemProvider: search, quick-open, git-less diffing and the Explorer all
 * start working against the remote with no further code.
 */
async function mount(deps: CommandDeps, node?: ConnectionNode): Promise<void> {
  const config = await resolveConfig(deps, node);
  if (config === undefined) return;

  const uri = OmniFileSystemProvider.toUri(config.id, RemotePath.parse(config.rootPath ?? '/'));

  const added = vscode.workspace.updateWorkspaceFolders(
    vscode.workspace.workspaceFolders?.length ?? 0,
    0,
    { uri, name: config.label },
  );

  if (!added) {
    void vscode.window.showErrorMessage(`Could not add "${config.label}" to the workspace.`);
  }
}

async function resolveConfig(
  deps: CommandDeps,
  node?: ConnectionNode,
): Promise<ConnectionConfig | undefined> {
  if (node?.kind === 'connection') return node.config;

  const configs = await deps.configStore.list();
  if (configs.length === 0) {
    void vscode.window.showInformationMessage('No connections configured yet.');
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    configs.map((config) => ({ label: config.label, description: config.providerId, config })),
    { title: 'Connection' },
  );
  return picked?.config;
}

function notYet(feature: string): void {
  void vscode.window.showInformationMessage(`${feature} is not implemented yet.`);
}
