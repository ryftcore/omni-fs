import * as vscode from 'vscode';
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
import { describeError } from '../host/describe-error.js';
import { ConnectionManagerPanel } from '../webview/connection-manager-panel.js';
import type { ConnectionNode, ConnectionsTreeProvider } from '../views/connections-tree.js';
import type { MountResult, WorkspaceMounts } from '../workspace/workspace-mounts.js';
import { forgetConnection, logUnconfirmed } from './forget-connection.js';

export interface CommandDeps {
  readonly extensionUri: vscode.Uri;
  readonly manager: ConnectionManager;
  readonly configStore: ConfigStore;
  readonly secretStore: SecretStore;
  readonly registry: ProviderRegistry;
  readonly transfers: TransferQueue;
  readonly cache: EntryCache;
  readonly connectionsTree: ConnectionsTreeProvider;
  readonly mounts: WorkspaceMounts;
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
    vscode.commands.registerCommand('omniFs.removeFromWorkspace', (node?: ConnectionNode) =>
      removeFromWorkspace(deps, node),
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
      cache: deps.cache,
      mounts: deps.mounts,
      logger: deps.logger,
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

  await forgetConnection(deps, config);
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
        // The popup says what went wrong; the log keeps it, with the code, for
        // after the popup is gone. The manager has already logged the cause.
        deps.logger.log('error', 'Connect failed', { connectionId: id, ...describeError(error) });
        void vscode.window.showErrorMessage(
          `Omni-FS: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
  deps.connectionsTree.refresh();
}

/**
 * Closes the connection and takes it out of the workspace.
 *
 * Both, because a mounted folder cannot stay disconnected: the next thing VS
 * Code reads from it — a stat, a search, its `.vscode/settings.json`, the
 * Explorer refreshing when the window regains focus — reconnects, undoing the
 * disconnect moments after the click. Only this explicit Disconnect unmounts.
 * An idle or config-changed disconnect keeps the folder, which reconnects on
 * next use, because the user never asked for it to go.
 */
async function disconnect(deps: CommandDeps, node?: ConnectionNode): Promise<void> {
  const config = await resolveConfig(deps, node);
  if (config === undefined) return;

  const unmounted = await deps.mounts.unmount(config.id);
  if (unmounted === 'refused') {
    deps.logger.log('warn', 'Could not remove a disconnected connection from the workspace', {
      connectionId: config.id,
    });
    void vscode.window.showWarningMessage(
      `Omni-FS: "${config.label}" is still in the workspace, so opening its folder will reconnect it.`,
    );
  } else if (unmounted === 'unconfirmed') {
    logUnconfirmed(deps.logger, config.id);
  }

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
 *
 * Opening a connection that is already open shows its folder instead. The
 * tree only offers this command to unmounted connections, so that is reached
 * from the Command Palette — where a second folder or an error would both be
 * the wrong answer to "open this".
 *
 * Resolves to what happened, for whoever runs the command programmatically.
 */
async function mount(deps: CommandDeps, node?: ConnectionNode): Promise<MountResult | undefined> {
  const config = await resolveConfig(deps, node);
  if (config === undefined) return undefined;

  const result = await deps.mounts.mount(config);

  if (result === 'already-mounted') {
    const [folder] = deps.mounts.foldersOf(config.id);
    if (folder !== undefined) await vscode.commands.executeCommand('revealInExplorer', folder.uri);
    return 'already-mounted';
  }

  if (result === 'refused') {
    deps.logger.log('error', 'Could not add a connection to the workspace', {
      connectionId: config.id,
    });
    void vscode.window.showErrorMessage(`Could not add "${config.label}" to the workspace.`);
    return 'refused';
  }

  return 'added';
}

/**
 * Takes the connection's folder out of the workspace and leaves the
 * connection as it is: still browsable in the tree, and closed by the idle
 * timeout like any other — unless the folder was the workspace's first. VS
 * Code then restarts the extension host, and this connection and every other
 * one close with it.
 */
async function removeFromWorkspace(deps: CommandDeps, node?: ConnectionNode): Promise<void> {
  const config = await resolveConfig(deps, node, {
    only: (candidate) => deps.mounts.isMounted(candidate.id),
    none: 'No connection is open in the workspace.',
  });
  if (config === undefined) return;

  const unmounted = await deps.mounts.unmount(config.id);
  if (unmounted === 'refused') {
    deps.logger.log('error', 'Could not remove a connection from the workspace', {
      connectionId: config.id,
    });
    void vscode.window.showErrorMessage(`Could not remove "${config.label}" from the workspace.`);
  } else if (unmounted === 'unconfirmed') {
    logUnconfirmed(deps.logger, config.id);
  }
}

/**
 * The connection a command applies to: the tree node it was run on, or one
 * picked from the palette. `only` narrows the pick list, never the node — the
 * tree's menus already decide which nodes a command is offered on.
 */
async function resolveConfig(
  deps: CommandDeps,
  node?: ConnectionNode,
  filter?: { readonly only: (config: ConnectionConfig) => boolean; readonly none: string },
): Promise<ConnectionConfig | undefined> {
  if (node?.kind === 'connection') return node.config;

  const stored = await deps.configStore.list();
  const configs = filter === undefined ? stored : stored.filter(filter.only);
  if (configs.length === 0) {
    void vscode.window.showInformationMessage(
      stored.length === 0 || filter === undefined ? 'No connections configured yet.' : filter.none,
    );
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
