import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  ConnectionManager,
  EntryCache,
  InMemoryConfigStore,
  InMemorySecretStore,
  NOOP_LOGGER,
  ProviderRegistry,
} from '@omni-fs/core';
import type { ConnectionConfig, DirEntry, Logger, LogLevel } from '@omni-fs/core';
import { MemoryFileSystem, memoryProvider } from '@omni-fs/testing';
import { forgetConnection } from '../../commands/forget-connection.js';
import type { ForgetDeps } from '../../commands/forget-connection.js';
import { ConnectionsTreeProvider } from '../../views/connections-tree.js';
import { WorkspaceMounts } from '../../workspace/workspace-mounts.js';
import type { WorkspaceFoldersHost } from '../../workspace/workspace-mounts.js';
import { EXTENSION_ID } from '../helpers.js';

/**
 * `WorkspaceMounts` and what reads it, over a fake `vscode.workspace`.
 *
 * The real one cannot be changed from this label: its window has a single
 * folder open, and adding a second makes VS Code enter a new workspace, which
 * it refuses under test and then refuses every later update too. The `workspace`
 * label drives the real thing; this file pins the rules, including the ones VS
 * Code enforces, which the fake copies from `extHostWorkspace.ts`.
 */

/** Keeps VS Code's two refusals: a pending update, and one folder twice. */
class FakeWorkspace implements WorkspaceFoldersHost {
  readonly #emitter = new vscode.EventEmitter<vscode.WorkspaceFoldersChangeEvent>();
  #folders: vscode.WorkspaceFolder[];
  #pending = false;

  /** Subscriptions not yet disposed, so a test can see one left behind. */
  listening = 0;
  readonly onDidChangeWorkspaceFolders: vscode.Event<vscode.WorkspaceFoldersChangeEvent> = (
    listener,
    thisArgs,
  ) => {
    const subscription = this.#emitter.event(listener, thisArgs);
    this.listening += 1;
    let disposed = false;
    return new vscode.Disposable(() => {
      if (disposed) return;
      disposed = true;
      this.listening -= 1;
      subscription.dispose();
    });
  };
  /**
   * Applied to the folders just before the next update is reported, as a
   * change the user makes while an update is pending.
   */
  meanwhile: ((folders: vscode.WorkspaceFolder[]) => vscode.WorkspaceFolder[]) | undefined;
  /** Every update requested, refused ones included. */
  readonly calls: { start: number; deleteCount: number; added: string[] }[] = [];
  /**
   * False makes updates apply without an event, as when VS Code cannot write
   * the workspace file, or restarts the extension host to enter a new
   * workspace before reporting anything.
   */
  reports = true;

  constructor(...uris: string[]) {
    this.#folders = uris.map((uri, index) => ({ uri: vscode.Uri.parse(uri), name: uri, index }));
  }

  get workspaceFolders(): readonly vscode.WorkspaceFolder[] | undefined {
    return this.#folders.length === 0 ? undefined : this.#folders;
  }

  /** The folder URIs as VS Code would write them out. */
  get uris(): string[] {
    return this.#folders.map((folder) => folder.uri.toString());
  }

  /** Reports a change nobody here asked for. */
  announce(event: vscode.WorkspaceFoldersChangeEvent): void {
    this.#emitter.fire(event);
  }

  updateWorkspaceFolders(
    start: number,
    deleteCount: number | undefined | null,
    ...add: { readonly uri: vscode.Uri; readonly name?: string }[]
  ): boolean {
    this.calls.push({
      start,
      deleteCount: deleteCount ?? 0,
      added: add.map((folder) => folder.uri.toString()),
    });
    if (this.#pending) return false;

    const next = [...this.#folders];
    const removed = next.splice(
      start,
      deleteCount ?? 0,
      ...add.map((folder) => ({ uri: folder.uri, name: folder.name ?? '', index: 0 })),
    );
    // `toString()` is VS Code's comparison key, authority lowercased included.
    const keys = next.map((folder) => folder.uri.toString());
    if (new Set(keys).size !== keys.length) return false;

    this.#folders = next.map((folder, index) => ({ ...folder, index }));
    this.#pending = true;
    const added = this.#folders.slice(start, start + add.length);
    setTimeout(() => {
      this.#pending = false;
      if (this.meanwhile !== undefined) {
        this.#folders = this.meanwhile(this.#folders).map((folder, index) => ({
          ...folder,
          index,
        }));
        this.meanwhile = undefined;
      }
      if (this.reports) this.#emitter.fire({ added, removed });
    }, 0);
    return true;
  }
}

function config(id: string, extra: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return { id, providerId: id, label: `${id} label`, settings: {}, ...extra };
}

/**
 * Cleanup registered as things are made, and run by `teardown`, so a failed
 * assertion does not leave a live connection or a subscription behind.
 */
function cleanups(): (dispose: () => unknown) => void {
  const pending: (() => unknown)[] = [];
  teardown(async () => {
    for (const dispose of pending.splice(0).reverse()) await dispose();
  });
  return (dispose) => pending.push(dispose);
}

function manager(options: {
  registry: ProviderRegistry;
  configStore: InMemoryConfigStore;
  secretStore?: InMemorySecretStore;
  logger?: Logger;
}): ConnectionManager {
  return new ConnectionManager({
    registry: options.registry,
    configStore: options.configStore,
    secretStore: options.secretStore ?? new InMemorySecretStore(),
    logger: options.logger ?? NOOP_LOGGER,
  });
}

suite('WorkspaceMounts', () => {
  let mounts: WorkspaceMounts | undefined;

  teardown(() => mounts?.dispose());

  test('matches a connection by its id as the authority, whatever the path or case', () => {
    const host = new FakeWorkspace(
      'file:///local',
      'omnifs://prod/deploy',
      'omnifs://staging/',
      'memory://prod/',
    );
    mounts = new WorkspaceMounts(host);

    assert.equal(mounts.isMounted('prod'), true);
    // A workspace file stores the authority lowercased; see the last suite.
    assert.equal(mounts.isMounted('Prod'), true);
    assert.equal(mounts.isMounted('staging'), true);
    assert.equal(mounts.isMounted('dev'), false);
    assert.deepEqual(
      mounts.foldersOf('prod').map((folder) => folder.uri.toString()),
      ['omnifs://prod/deploy'],
    );
  });

  test('opens the root after the last folder, named after the connection', async () => {
    const host = new FakeWorkspace('file:///local');
    mounts = new WorkspaceMounts(host);

    assert.equal(await mounts.mount(config('prod', { rootPath: '/srv/app' })), 'added');

    assert.deepEqual(host.calls, [{ start: 1, deleteCount: 0, added: ['omnifs://prod/srv/app'] }]);
    assert.equal(host.workspaceFolders?.[1]?.name, 'prod label');
  });

  test('opening a mounted connection again asks VS Code for nothing', async () => {
    const host = new FakeWorkspace('file:///local', 'omnifs://prod/');
    mounts = new WorkspaceMounts(host);

    assert.equal(await mounts.mount(config('prod')), 'already-mounted');
    // Nor after a `rootPath` edit, which would otherwise add a second folder.
    assert.equal(await mounts.mount(config('prod', { rootPath: '/other' })), 'already-mounted');
    assert.deepEqual(host.calls, []);
  });

  test('reports a refusal instead of waiting for a change that is not coming', async () => {
    const host = new FakeWorkspace('file:///local');
    mounts = new WorkspaceMounts(host, { confirmTimeoutMs: 60_000 });

    // Two mounts without awaiting: VS Code refuses the second while the first
    // is unconfirmed.
    const first = mounts.mount(config('prod'));
    assert.equal(await mounts.mount(config('staging')), 'refused');
    assert.equal(await first, 'added');
  });

  test('removes a connection in one call, keeping the folders around it', async () => {
    const host = new FakeWorkspace('file:///a', 'omnifs://prod/x', 'omnifs://prod/y', 'file:///b');
    mounts = new WorkspaceMounts(host);

    assert.equal(await mounts.unmount('prod'), 'removed');

    assert.deepEqual(host.calls, [{ start: 1, deleteCount: 2, added: [] }]);
    assert.deepEqual(host.uris, ['file:///a', 'file:///b']);
  });

  test('removes folders that are not adjacent one run at a time, re-adding none', async () => {
    // Only a workspace written by an older release or by hand has two folders
    // of one connection. Re-adding the folders between them would make VS
    // Code stat `staging`, connecting it to disconnect `prod`.
    const host = new FakeWorkspace(
      'omnifs://prod/old',
      'file:///b',
      'omnifs://staging/',
      'omnifs://prod/new',
      'file:///c',
    );
    mounts = new WorkspaceMounts(host);

    assert.equal(await mounts.unmount('prod'), 'removed');

    // Highest first, so the lower index is still right, and the run at index
    // 0 — whose removal restarts the extension host — is the last call.
    assert.deepEqual(host.calls, [
      { start: 3, deleteCount: 1, added: [] },
      { start: 0, deleteCount: 1, added: [] },
    ]);
    assert.deepEqual(host.uris, ['file:///b', 'omnifs://staging/', 'file:///c']);
  });

  test('does nothing for a connection that is not mounted', async () => {
    const host = new FakeWorkspace('file:///a');
    mounts = new WorkspaceMounts(host);

    assert.equal(await mounts.unmount('prod'), 'not-mounted');
    assert.deepEqual(host.calls, []);
  });

  test('stops waiting for a change VS Code never reports, and says so', async () => {
    const host = new FakeWorkspace('omnifs://prod/', 'file:///a');
    host.reports = false;
    mounts = new WorkspaceMounts(host, { confirmTimeoutMs: 50 });

    assert.equal(await mounts.unmount('prod'), 'unconfirmed');
  });

  test('a mount still counts as added when VS Code is slow to report it', async () => {
    // VS Code stats a folder before adding it, so a slow server alone
    // outlasts the wait.
    const host = new FakeWorkspace('file:///a');
    host.reports = false;
    mounts = new WorkspaceMounts(host, { confirmTimeoutMs: 50 });

    assert.equal(await mounts.mount(config('prod')), 'added');
  });

  test('reads the folders again before each removal', async () => {
    const host = new FakeWorkspace(
      'file:///a',
      'file:///b',
      'omnifs://prod/x',
      'omnifs://staging/',
      'omnifs://prod/y',
    );
    // The user removes a folder above them while the first removal is pending.
    host.meanwhile = (folders) => folders.filter((folder) => folder.uri.path !== '/a');
    mounts = new WorkspaceMounts(host);

    assert.equal(await mounts.unmount('prod'), 'removed');

    // Index 2 now names `staging`; the second removal must not.
    assert.deepEqual(host.calls, [
      { start: 4, deleteCount: 1, added: [] },
      { start: 1, deleteCount: 1, added: [] },
    ]);
    assert.deepEqual(host.uris, ['file:///b', 'omnifs://staging/']);
  });

  test('is confirmed by the change that names its folder, not by any change', async () => {
    const host = new FakeWorkspace('omnifs://prod/', 'file:///a');
    host.reports = false;
    mounts = new WorkspaceMounts(host, { confirmTimeoutMs: 100 });

    const unmounted = mounts.unmount('prod');
    host.announce({
      added: [{ uri: vscode.Uri.parse('file:///b'), name: 'b', index: 1 }],
      removed: [],
    });

    assert.equal(await unmounted, 'unconfirmed');
  });

  test('stops listening when VS Code throws instead of answering', async () => {
    const host = new FakeWorkspace('file:///a');
    host.updateWorkspaceFolders = () => {
      throw new Error('extension host stopped');
    };
    mounts = new WorkspaceMounts(host);
    const relaying = host.listening;

    await assert.rejects(mounts.mount(config('prod')), /extension host stopped/);

    assert.equal(host.listening, relaying);
  });

  test('says when a connection folder comes or goes, and only then', async () => {
    const host = new FakeWorkspace('file:///a');
    mounts = new WorkspaceMounts(host);
    let changes = 0;
    mounts.onDidChange(() => (changes += 1));

    // A local folder: redrawing the tree for it would re-list every connection.
    host.updateWorkspaceFolders(1, 0, { uri: vscode.Uri.parse('file:///b') });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(changes, 0);

    await mounts.mount(config('prod'));
    assert.equal(changes, 1);
  });
});

suite('the connections tree while a connection is mounted', () => {
  const ID = 'mounts-tree';
  const later = cleanups();

  interface Menu {
    readonly command: string;
    readonly when: string;
  }

  /** The tree-item commands whose `when` clause holds for this contextValue. */
  function offered(contextValue: string): string[] {
    const manifest = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as {
      contributes: { menus: { 'view/item/context': readonly Menu[] } };
    };
    return manifest.contributes.menus['view/item/context']
      .filter((menu) => menu.when.includes('view == omniFs.connections'))
      .filter((menu) => {
        const pattern = /viewItem =~ \/(.+)\/$/.exec(menu.when)?.[1];
        const exact = /viewItem == (\S+)/.exec(menu.when)?.[1];
        return pattern !== undefined
          ? new RegExp(pattern).test(contextValue)
          : exact === contextValue;
      })
      .map((menu) => menu.command)
      .sort();
  }

  async function treeItem(options: {
    connected: boolean;
    mounted: boolean;
    readOnly: boolean;
  }): Promise<vscode.TreeItem> {
    const registry = new ProviderRegistry();
    registry.register({ ...memoryProvider, id: ID, schemes: [ID] });
    const configStore = new InMemoryConfigStore();
    const stored = config(ID, options.readOnly ? { readOnly: true } : {});
    await configStore.save(stored);
    const connections = manager({ registry, configStore });
    later(() => connections[Symbol.asyncDispose]());
    if (options.connected) await connections.acquire(ID);

    const mounts = new WorkspaceMounts(
      new FakeWorkspace('file:///local', ...(options.mounted ? [`omnifs://${ID}/`] : [])),
    );
    later(() => mounts.dispose());
    const tree = new ConnectionsTreeProvider({
      manager: connections,
      configStore,
      registry,
      cache: new EntryCache(),
      logger: NOOP_LOGGER,
      mounts,
    });
    return tree.getTreeItem({ kind: 'connection', config: stored });
  }

  for (const connected of [true, false]) {
    for (const mounted of [true, false]) {
      for (const readOnly of [true, false]) {
        const name = [
          connected ? 'connected' : 'disconnected',
          mounted ? 'mounted' : 'unmounted',
          readOnly ? 'read-only' : 'writable',
        ].join(', ');

        test(`offers exactly the matching commands when ${name}`, async () => {
          const item = await treeItem({ connected, mounted, readOnly });
          assert.ok(item.contextValue);

          assert.deepEqual(
            offered(item.contextValue),
            [
              connected ? 'omniFs.disconnect' : 'omniFs.connect',
              mounted ? 'omniFs.removeFromWorkspace' : 'omniFs.mountAsWorkspaceFolder',
              readOnly ? 'omniFs.makeWritable' : 'omniFs.makeReadOnly',
              'omniFs.editConnection',
              'omniFs.removeConnection',
            ].sort(),
          );
        });
      }
    }
  }

  test('says a mounted connection is in the workspace', async () => {
    const mounted = await treeItem({ connected: false, mounted: true, readOnly: true });
    const unmounted = await treeItem({ connected: false, mounted: false, readOnly: false });

    assert.equal(mounted.description, 'In-memory (testing) · read-only · in workspace');
    assert.equal(unmounted.description, 'In-memory (testing)');
  });

  test('redraws when the workspace folders change', async () => {
    const mounts = new WorkspaceMounts(new FakeWorkspace('file:///local'));
    later(() => mounts.dispose());
    const registry = new ProviderRegistry();
    const configStore = new InMemoryConfigStore();
    const connections = manager({ registry, configStore });
    later(() => connections[Symbol.asyncDispose]());
    const tree = new ConnectionsTreeProvider({
      manager: connections,
      configStore,
      registry,
      cache: new EntryCache(),
      logger: NOOP_LOGGER,
      mounts,
    });
    let redraws = 0;
    const subscription = tree.onDidChangeTreeData(() => (redraws += 1));
    later(() => subscription.dispose());

    await mounts.mount(config(ID));

    assert.equal(redraws, 1);
  });

  test('does not report a listing that a disconnect cut short as an error', async () => {
    // Disconnect removes the folder first, and that change redraws the tree
    // just before the connection closes under the listing it started.
    let closeUnderIt = (): void => {};
    const closed = new Promise<void>((resolve) => (closeUnderIt = resolve));
    class ClosingDisk extends MemoryFileSystem {
      override list(): AsyncIterable<DirEntry> {
        return {
          [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<DirEntry>> => {
              await closed;
              throw new Error('connection closed');
            },
          }),
        };
      }
    }
    const registry = new ProviderRegistry();
    registry.register({
      ...memoryProvider,
      id: ID,
      schemes: [ID],
      create: () => new ClosingDisk(),
    });
    const configStore = new InMemoryConfigStore();
    await configStore.save(config(ID));
    const logged: LogLevel[] = [];
    const logger: Logger = {
      log: (level) => logged.push(level),
      child: () => logger,
    };
    const connections = manager({ registry, configStore });
    later(() => connections[Symbol.asyncDispose]());
    await connections.acquire(ID);
    const mounts = new WorkspaceMounts(new FakeWorkspace());
    later(() => mounts.dispose());
    const tree = new ConnectionsTreeProvider({
      manager: connections,
      configStore,
      registry,
      cache: new EntryCache(),
      logger,
      mounts,
    });

    const children = tree.getChildren({ kind: 'connection', config: config(ID) });
    await connections.disconnect(ID);
    closeUnderIt();

    assert.deepEqual(await children, []);
    assert.deepEqual(logged, ['debug']);
  });
});

suite('forgetting a removed connection', () => {
  const ID = 'mounts-forget';
  const later = cleanups();

  /** A keychain that will not let go, as a locked one or a D-Bus failure does. */
  class StuckSecretStore extends InMemorySecretStore {
    override async delete(): Promise<void> {
      throw new Error('keychain locked');
    }
  }

  async function forget(
    host: FakeWorkspace,
    secretStore: InMemorySecretStore = new InMemorySecretStore(),
  ): Promise<{ deps: ForgetDeps; disk: MemoryFileSystem }> {
    const disk = new MemoryFileSystem();
    const registry = new ProviderRegistry();
    registry.register({ ...memoryProvider, id: ID, schemes: [ID], create: () => disk });
    const configStore = new InMemoryConfigStore();
    await configStore.save(config(ID));
    await secretStore.set(ID, { password: 'x' });
    const connections = manager({ registry, configStore, secretStore });
    later(() => connections[Symbol.asyncDispose]());
    await connections.acquire(ID);
    const mounts = new WorkspaceMounts(host, { confirmTimeoutMs: 50 });
    later(() => mounts.dispose());
    return {
      deps: {
        manager: connections,
        configStore,
        secretStore,
        cache: new EntryCache(),
        mounts,
        logger: NOOP_LOGGER,
      },
      disk,
    };
  }

  test('deletes it, takes it out of the workspace and closes it', async () => {
    const host = new FakeWorkspace('file:///local', `omnifs://${ID}/`);
    const { deps, disk } = await forget(host);

    assert.equal(await forgetConnection(deps, config(ID)), 'removed');

    assert.equal(await deps.configStore.get(ID), undefined);
    assert.equal(await deps.secretStore.get(ID), undefined);
    assert.deepEqual(host.uris, ['file:///local']);
    assert.equal(disk.isAlive(), false);
    assert.equal(deps.manager.getState(ID).status, 'disconnected');
  });

  test('has deleted and closed it when removing the folder kills the extension host', async () => {
    // Its first folder: VS Code restarts the extension host here, and nothing
    // after this call is guaranteed to run.
    const host = new FakeWorkspace(`omnifs://${ID}/`, 'file:///local');
    host.updateWorkspaceFolders = () => {
      throw new Error('extension host stopped');
    };
    const { deps, disk } = await forget(host);

    await assert.rejects(forgetConnection(deps, config(ID)), /extension host stopped/);

    assert.equal(await deps.configStore.get(ID), undefined);
    assert.equal(await deps.secretStore.get(ID), undefined);
    // Closed before the folder was touched: a connection left open would keep
    // serving it, with no config left to say it was read-only.
    assert.equal(disk.isAlive(), false);
  });

  test('closes it even when the keychain refuses to delete its credentials', async () => {
    const host = new FakeWorkspace('file:///local', `omnifs://${ID}/`);
    const { deps, disk } = await forget(host, new StuckSecretStore());

    await assert.rejects(forgetConnection(deps, config(ID)), /keychain locked/);

    assert.equal(await deps.configStore.get(ID), undefined);
    assert.equal(disk.isAlive(), false);
  });

  test('still deletes it when VS Code refuses to remove the folder, and says so', async () => {
    const host = new FakeWorkspace('file:///local', `omnifs://${ID}/`);
    host.updateWorkspaceFolders = () => false;
    const { deps, disk } = await forget(host);

    assert.equal(await forgetConnection(deps, config(ID)), 'refused');

    assert.equal(await deps.configStore.get(ID), undefined);
    assert.equal(disk.isAlive(), false);
  });
});

suite('VS Code URI authorities', () => {
  test('come back lowercased once written out, which is why ids match without case', () => {
    // How a workspace file stores a non-file folder, and how it is read back.
    const opened = vscode.Uri.from({ scheme: 'omnifs', authority: 'Prod', path: '/' });
    const restored = vscode.Uri.parse(opened.toString());

    assert.equal(opened.authority, 'Prod');
    assert.equal(restored.authority, 'prod');
  });
});
