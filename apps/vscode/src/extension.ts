import * as vscode from 'vscode';
import {
  ConnectionManager,
  EntryCache,
  ProviderRegistry,
  TransferQueue,
  type LogLevel,
} from '@omni-fs/core';
import { ftpProvider } from '@omni-fs/provider-ftp';
import { s3Provider } from '@omni-fs/provider-s3';
import { sftpProvider } from '@omni-fs/provider-sftp';
import { webdavProvider } from '@omni-fs/provider-webdav';
import { OMNI_FS_SCHEME, OmniFileSystemProvider } from './fs/omni-file-system-provider.js';
import { VsCodeConfigStore, VsCodeLogger, VsCodeSecretStore } from './host/vscode-ports.js';
import { ConnectionsTreeProvider } from './views/connections-tree.js';
import { TransfersTreeProvider } from './views/transfers-tree.js';
import { registerCommands } from './commands/index.js';

/**
 * What `activate` resolves to.
 *
 * A genuine public extension API, not only a test hook: `ProviderRegistry` is
 * already the documented extension point — "a new protocol is a new package
 * plus one `register()` call per host" — so publishing it means a third-party
 * extension can add a protocol with the same line this function uses below.
 * Unstable before 1.0.
 *
 * It deliberately does not carry the `SecretStore`, but be clear about how
 * small that is: `registry.get('sftp')` hands back the live definition, whose
 * `create` receives `getSecret`. `register()` freezes what it stores, which
 * closes the in-place swap; VS Code does not isolate extensions from one
 * another, so nothing here can close co-residency. Withholding the secret
 * store is hygiene, not a boundary.
 */
export interface OmniFsApi {
  readonly registry: ProviderRegistry;
}

/**
 * Composition root.
 *
 * Note what this function does and does not do. It constructs core services,
 * registers the four providers, and plugs in the VS Code adapters. It contains
 * no protocol logic, no caching policy, no retry policy — those live in
 * `@omni-fs/core` where the desktop app will reuse them.
 *
 * The desktop app's `main.ts` will be recognisably this same function with
 * different adapters. If a future change makes that stop being true, the change
 * is in the wrong layer.
 */
export function activate(context: vscode.ExtensionContext): OmniFsApi {
  const settings = vscode.workspace.getConfiguration('omniFs');

  const channel = vscode.window.createOutputChannel('Omni-FS', { log: true });
  const logger = new VsCodeLogger(channel, settings.get<LogLevel>('logLevel', 'info'));

  // 1. Protocols. Adding a fifth is one import and one register call.
  const registry = new ProviderRegistry();
  for (const provider of [s3Provider, ftpProvider, sftpProvider, webdavProvider]) {
    registry.register(provider);
  }

  // 2. Host adapters for core's ports.
  const configStore = new VsCodeConfigStore();
  const secretStore = new VsCodeSecretStore(context.secrets);

  // 3. Core services.
  const cache = new EntryCache({ ttlMs: settings.get<number>('cache.ttlSeconds', 15) * 1000 });
  const manager = new ConnectionManager({
    registry,
    configStore,
    secretStore,
    logger,
    idleTimeoutMs: settings.get<number>('connection.idleTimeoutSeconds', 300) * 1000,
  });
  const transfers = new TransferQueue({
    logger,
    maxConcurrent: settings.get<number>('transfers.maxConcurrent', 4),
  });

  // 4. VS Code surfaces.
  const fileSystemProvider = new OmniFileSystemProvider({ manager, configStore, cache, logger });
  const connectionsTree = new ConnectionsTreeProvider({ manager, configStore, registry, cache });
  const transfersTree = new TransfersTreeProvider(transfers);

  context.subscriptions.push(
    channel,
    fileSystemProvider,
    vscode.workspace.registerFileSystemProvider(OMNI_FS_SCHEME, fileSystemProvider, {
      isCaseSensitive: true,
    }),
    vscode.window.createTreeView('omniFs.connections', {
      treeDataProvider: connectionsTree,
      showCollapseAll: true,
      canSelectMany: true,
    }),
    vscode.window.createTreeView('omniFs.transfers', { treeDataProvider: transfersTree }),
    ...registerCommands({
      extensionUri: context.extensionUri,
      manager,
      configStore,
      secretStore,
      registry,
      transfers,
      cache,
      connectionsTree,
      logger,
    }),
    // `Disposable` from core is the TS 5.2 `Symbol.dispose` protocol; VS Code
    // wants a `.dispose()` method. Bridge rather than leak vscode into core.
    new vscode.Disposable(() => {
      transfers[Symbol.dispose]();
      void manager[Symbol.asyncDispose]();
    }),
  );

  logger.log('info', 'Omni-FS activated', {
    providers: registry.list().map((provider) => provider.id),
  });

  return { registry };
}

export function deactivate(): void {
  // Everything is registered in `context.subscriptions`; VS Code disposes it.
}
