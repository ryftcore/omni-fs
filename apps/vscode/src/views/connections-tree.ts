import * as vscode from 'vscode';
import { RemotePath } from '@omni-fs/core';
import type {
  ConfigStore,
  ConnectionConfig,
  ConnectionManager,
  ConnectionState,
  DirEntry,
  EntryCache,
  Logger,
  ProviderRegistry,
} from '@omni-fs/core';
import { OmniFileSystemProvider } from '../fs/omni-file-system-provider.js';
import { describeError } from '../host/describe-error.js';

export type ConnectionNode =
  | { readonly kind: 'connection'; readonly config: ConnectionConfig }
  | {
      readonly kind: 'entry';
      readonly connectionId: string;
      readonly entry: DirEntry;
    };

/**
 * The sidebar tree. It exists alongside the FileSystemProvider rather than
 * instead of it: the Explorer shows files you are working in, this shows
 * connections you can manage — status, connect/disconnect, credentials, and
 * browsing a server you have not mounted.
 *
 * It reads through the same `ConnectionManager` and `EntryCache` as the
 * FileSystemProvider, so expanding a folder here warms the cache for opening a
 * file there, and a delete in either view invalidates both.
 */
export class ConnectionsTreeProvider implements vscode.TreeDataProvider<ConnectionNode> {
  readonly #manager: ConnectionManager;
  readonly #configStore: ConfigStore;
  readonly #registry: ProviderRegistry;
  readonly #cache: EntryCache;
  readonly #logger: Logger;
  readonly #emitter = new vscode.EventEmitter<ConnectionNode | undefined>();

  readonly onDidChangeTreeData = this.#emitter.event;

  constructor(options: {
    manager: ConnectionManager;
    configStore: ConfigStore;
    registry: ProviderRegistry;
    cache: EntryCache;
    logger: Logger;
  }) {
    this.#manager = options.manager;
    this.#configStore = options.configStore;
    this.#registry = options.registry;
    this.#cache = options.cache;
    this.#logger = options.logger;

    this.#manager.onDidChangeState(() => this.refresh());
    this.#configStore.onDidChange(() => this.refresh());
  }

  refresh(node?: ConnectionNode): void {
    this.#emitter.fire(node);
  }

  /** Drops cached listings for a connection, then redraws. */
  refreshConnection(connectionId: string): void {
    this.#cache.invalidateConnection(connectionId);
    this.refresh();
  }

  getTreeItem(node: ConnectionNode): vscode.TreeItem {
    return node.kind === 'connection'
      ? this.#connectionItem(node.config)
      : this.#entryItem(node.connectionId, node.entry);
  }

  async getChildren(node?: ConnectionNode): Promise<ConnectionNode[]> {
    if (node === undefined) {
      const configs = await this.#configStore.list();
      return [...configs]
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((config) => ({ kind: 'connection', config }) as const);
    }

    const connectionId = node.kind === 'connection' ? node.config.id : node.connectionId;
    const path = node.kind === 'connection' ? RemotePath.ROOT : node.entry.path;

    // Only a connected connection is browsed. Expanding a disconnected node
    // does not silently dial out — the user connects explicitly, because for
    // FTP that is a visible, sometimes slow, sometimes credential-prompting act.
    if (node.kind === 'connection' && this.#manager.getState(connectionId).status !== 'connected') {
      return [];
    }

    const started = Date.now();
    try {
      const fs = await this.#manager.acquire(connectionId);
      const children: ConnectionNode[] = [];
      for await (const entry of fs.list(path)) {
        children.push({ kind: 'entry', connectionId, entry });
      }
      const sorted = children.sort(compareEntries);
      // Every expand, collapse-and-reopen and refresh of an open folder comes
      // through here, so a folder that keeps reloading shows up as a run of
      // these lines.
      this.#logger.log('debug', 'Tree expanded', {
        connectionId,
        path: path.value,
        entries: sorted.length,
        ms: Date.now() - started,
      });
      return sorted;
    } catch (error) {
      this.#logger.log('error', 'Tree could not list a folder', {
        connectionId,
        path: path.value,
        ...describeError(error),
      });
      void vscode.window.showErrorMessage(
        `Omni-FS: could not list ${path.value} — ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  #connectionItem(config: ConnectionConfig): vscode.TreeItem {
    const state = this.#manager.getState(config.id);
    const provider = this.#registry.tryGet(config.providerId);

    const item = new vscode.TreeItem(
      config.label,
      state.status === 'connected'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );

    item.id = config.id;
    const providerName = provider?.displayName ?? config.providerId;
    item.description = config.readOnly === true ? `${providerName} · read-only` : providerName;
    // `connection.<status>.<access>`: the manifest matches on both halves, to
    // offer Connect or Disconnect and Make Read-only or Make Writable.
    item.contextValue = `connection.${state.status === 'connected' ? 'connected' : 'disconnected'}.${
      config.readOnly === true ? 'readOnly' : 'writable'
    }`;
    item.iconPath = statusIcon(state);
    item.tooltip = buildTooltip(config, state, provider?.displayName);
    // Also what tints the label: `ConnectionDecorationProvider` colours every
    // resource of a tagged connection, this node included.
    item.resourceUri = OmniFileSystemProvider.toUri(config.id, RemotePath.ROOT);

    return item;
  }

  #entryItem(connectionId: string, entry: DirEntry): vscode.TreeItem {
    const isDirectory = entry.type === 'directory';
    const item = new vscode.TreeItem(
      entry.name,
      isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    item.id = `${connectionId}:${entry.path.value}`;
    item.contextValue = isDirectory ? 'entry.directory' : 'entry.file';
    // Setting resourceUri gives us the correct file icon from the user's icon
    // theme for free, plus decoration support.
    item.resourceUri = OmniFileSystemProvider.toUri(connectionId, entry.path);

    if (!isDirectory) {
      item.description = formatBytes(entry.size);
      item.command = {
        command: 'vscode.open',
        title: 'Open',
        arguments: [item.resourceUri],
      };
    }

    if (entry.mtime !== undefined) {
      item.tooltip = new vscode.MarkdownString(
        `\`${entry.path.value}\`\n\n${formatBytes(entry.size)} · modified ${new Date(entry.mtime).toLocaleString()}`,
      );
    }

    return item;
  }
}

function compareEntries(a: ConnectionNode, b: ConnectionNode): number {
  if (a.kind !== 'entry' || b.kind !== 'entry') return 0;
  const aDir = a.entry.type === 'directory';
  const bDir = b.entry.type === 'directory';
  if (aDir !== bDir) return aDir ? -1 : 1;
  return a.entry.name.localeCompare(b.entry.name);
}

function statusIcon(state: ConnectionState): vscode.ThemeIcon {
  switch (state.status) {
    case 'connected':
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
    case 'connecting':
      return new vscode.ThemeIcon('loading~spin');
    case 'error':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

function buildTooltip(
  config: ConnectionConfig,
  state: ConnectionState,
  providerName: string | undefined,
): vscode.MarkdownString {
  const lines = [`**${config.label}**`, '', `Provider: ${providerName ?? config.providerId}`];

  if (state.status === 'connected')
    lines.push(`Connected since ${new Date(state.since).toLocaleTimeString()}`);
  if (state.status === 'error') lines.push(`⚠️ ${state.error}`);
  if (config.readOnly === true) lines.push('🔒 Read-only');

  return new vscode.MarkdownString(lines.join('\n\n'));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
