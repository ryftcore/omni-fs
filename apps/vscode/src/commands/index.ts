import * as vscode from 'vscode';
import { RemotePath } from '@omni-fs/core';
import type {
  ConfigStore,
  ConnectionConfig,
  EntryCache,
  Logger,
  ConnectionManager,
  ProviderDefinition,
  ProviderRegistry,
  SecretStore,
  SettingsField,
  TransferQueue,
} from '@omni-fs/core';
import { OmniFileSystemProvider } from '../fs/omni-file-system-provider.js';
import type { ConnectionNode, ConnectionsTreeProvider } from '../views/connections-tree.js';

export interface CommandDeps {
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
 * The connection editor is driven entirely by each provider's declarative
 * `settingsSchema`/`secretSchema` and rendered with QuickPick and InputBox, so
 * adding a protocol needs no UI work here at all. The desktop app will render
 * the same schemas as a React form — same data, different widgets.
 */
export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('omniFs.addConnection', () => addConnection(deps)),
    vscode.commands.registerCommand('omniFs.editConnection', (node?: ConnectionNode) =>
      editConnection(deps, node),
    ),
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

async function addConnection(deps: CommandDeps): Promise<void> {
  const provider = await pickProvider(deps.registry);
  if (provider === undefined) return;

  const label = await vscode.window.showInputBox({
    title: 'Connection name',
    prompt: 'A name for this connection',
    placeHolder: 'production-bucket',
    validateInput: (value) => (value.trim() === '' ? 'A name is required' : undefined),
  });
  if (label === undefined) return;

  const settings = await promptForFields(provider.settingsSchema.fields, 'Settings');
  if (settings === undefined) return;

  const secret = await promptForFields(provider.secretSchema.fields, 'Credentials');
  if (secret === undefined) return;

  const config: ConnectionConfig = {
    id: generateId(),
    providerId: provider.id,
    label: label.trim(),
    settings,
  };

  await deps.configStore.save(config);
  await deps.secretStore.set(config.id, secret);
  deps.connectionsTree.refresh();

  const connectNow = await vscode.window.showInformationMessage(
    `Added "${config.label}".`,
    'Connect',
  );
  if (connectNow === 'Connect') {
    await connectById(deps, config.id, config.label);
  }
}

async function editConnection(deps: CommandDeps, node?: ConnectionNode): Promise<void> {
  const config = await resolveConfig(deps, node);
  if (config === undefined) return;

  const provider = deps.registry.tryGet(config.providerId);
  if (provider === undefined) {
    void vscode.window.showErrorMessage(`Unknown provider: ${config.providerId}`);
    return;
  }

  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(gear) Settings', value: 'settings' as const },
      { label: '$(key) Credentials', value: 'secret' as const },
      { label: '$(pencil) Rename', value: 'rename' as const },
    ],
    { title: `Edit "${config.label}"` },
  );
  if (choice === undefined) return;

  if (choice.value === 'rename') {
    const label = await vscode.window.showInputBox({ title: 'New name', value: config.label });
    if (label === undefined || label.trim() === '') return;
    await deps.configStore.save({ ...config, label: label.trim() });
  } else if (choice.value === 'settings') {
    const settings = await promptForFields(
      provider.settingsSchema.fields,
      'Settings',
      config.settings,
    );
    if (settings === undefined) return;
    await deps.configStore.save({ ...config, settings });
  } else {
    const secret = await promptForFields(provider.secretSchema.fields, 'Credentials');
    if (secret === undefined) return;
    await deps.secretStore.set(config.id, secret);
  }

  // Settings changed, so the live connection is stale.
  await deps.manager.invalidate(config);
  deps.connectionsTree.refreshConnection(config.id);
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

async function pickProvider(registry: ProviderRegistry): Promise<ProviderDefinition | undefined> {
  const picked = await vscode.window.showQuickPick(
    registry.list().map((provider) => ({
      label: provider.displayName,
      description: provider.id,
      provider,
    })),
    { title: 'Protocol', placeHolder: 'Choose a protocol' },
  );
  return picked?.provider;
}

/** Walks a provider's declarative schema, prompting field by field. */
async function promptForFields(
  fields: readonly SettingsField[],
  title: string,
  existing: Readonly<Record<string, unknown>> = {},
): Promise<Record<string, unknown> | undefined> {
  const result: Record<string, unknown> = { ...existing };

  for (const field of fields) {
    const current = result[field.key];

    if (field.kind === 'boolean') {
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'Yes', value: true },
          { label: 'No', value: false },
        ],
        { title, placeHolder: field.label },
      );
      if (picked === undefined) return undefined;
      result[field.key] = picked.value;
      continue;
    }

    if (field.kind === 'select') {
      const picked = await vscode.window.showQuickPick(
        field.options.map((option) => ({ label: option.label, value: option.value })),
        { title, placeHolder: field.label },
      );
      if (picked === undefined) return undefined;
      result[field.key] = picked.value;
      continue;
    }

    const value = await vscode.window.showInputBox({
      title,
      prompt: field.label,
      ...('help' in field && field.help !== undefined ? { placeHolder: field.help } : {}),
      password: field.kind === 'password',
      // Never pre-fill a secret back into a visible box.
      value: field.kind === 'password' ? '' : typeof current === 'string' ? current : '',
      ignoreFocusOut: true,
      validateInput: (input) =>
        field.required === true && input.trim() === '' ? `${field.label} is required` : undefined,
    });

    if (value === undefined) return undefined;
    if (value.trim() === '' && field.required !== true) continue;

    result[field.key] = field.kind === 'number' ? Number(value) : value.trim();
  }

  return result;
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

function generateId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
