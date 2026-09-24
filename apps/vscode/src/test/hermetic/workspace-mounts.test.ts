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
import type { ConnectionConfig } from '@omni-fs/core';
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

  readonly onDidChangeWorkspaceFolders = this.#emitter.event;
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
      if (this.reports) this.#emitter.fire({ added, removed });
    }, 0);
    return true;
  }
}

function config(id: string, extra: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return { id, providerId: id, label: `${id} label`, settings: {}, ...extra };
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

  test('says when the folders change', async () => {
    const host = new FakeWorkspace('file:///a');
    mounts = new WorkspaceMounts(host);
    let changes = 0;
    mounts.onDidChange(() => (changes += 1));

    await mounts.mount(config('prod'));

    assert.equal(changes, 1);
  });
});

suite('the connections tree while a connection is mounted', () => {
  const ID = 'mounts-tree';

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
    const manager = new ConnectionManager({
      registry,
      configStore,
      secretStore: new InMemorySecretStore(),
      logger: NOOP_LOGGER,
    });
    if (options.connected) await manager.acquire(ID);

    const tree = new ConnectionsTreeProvider({
      manager,
      configStore,
      registry,
      cache: new EntryCache(),
      logger: NOOP_LOGGER,
      mounts: new WorkspaceMounts(
        new FakeWorkspace('file:///local', ...(options.mounted ? [`omnifs://${ID}/`] : [])),
      ),
    });
    const item = tree.getTreeItem({ kind: 'connection', config: stored });
    await manager[Symbol.asyncDispose]();
    return item;
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
    const host = new FakeWorkspace('file:///local');
    const mounts = new WorkspaceMounts(host);
    const registry = new ProviderRegistry();
    const configStore = new InMemoryConfigStore();
    const tree = new ConnectionsTreeProvider({
      manager: new ConnectionManager({
        registry,
        configStore,
        secretStore: new InMemorySecretStore(),
        logger: NOOP_LOGGER,
      }),
      configStore,
      registry,
      cache: new EntryCache(),
      logger: NOOP_LOGGER,
      mounts,
    });
    let redraws = 0;
    const subscription = tree.onDidChangeTreeData(() => (redraws += 1));

    await mounts.mount(config(ID));

    assert.equal(redraws, 1);
    subscription.dispose();
    mounts.dispose();
  });
});

suite('forgetting a removed connection', () => {
  const ID = 'mounts-forget';

  interface Forget {
    readonly deps: ForgetDeps;
    readonly disk: MemoryFileSystem;
    readonly host: FakeWorkspace;
    dispose(): void;
  }

  async function forget(host: FakeWorkspace): Promise<Forget> {
    const disk = new MemoryFileSystem();
    const registry = new ProviderRegistry();
    registry.register({ ...memoryProvider, id: ID, schemes: [ID], create: () => disk });
    const configStore = new InMemoryConfigStore();
    await configStore.save(config(ID));
    const secretStore = new InMemorySecretStore();
    await secretStore.set(ID, { password: 'x' });
    const manager = new ConnectionManager({
      registry,
      configStore,
      secretStore,
      logger: NOOP_LOGGER,
    });
    await manager.acquire(ID);
    const mounts = new WorkspaceMounts(host, { confirmTimeoutMs: 50 });
    return {
      deps: {
        manager,
        configStore,
        secretStore,
        cache: new EntryCache(),
        mounts,
        logger: NOOP_LOGGER,
      },
      disk,
      host,
      dispose: () => mounts.dispose(),
    };
  }

  test('deletes it, takes it out of the workspace and closes it', async () => {
    const { deps, disk, host, dispose } = await forget(
      new FakeWorkspace('file:///local', `omnifs://${ID}/`),
    );

    assert.equal(await forgetConnection(deps, config(ID)), 'removed');

    assert.equal(await deps.configStore.get(ID), undefined);
    assert.equal(await deps.secretStore.get(ID), undefined);
    assert.deepEqual(host.uris, ['file:///local']);
    assert.equal(disk.isAlive(), false);
    assert.equal(deps.manager.getState(ID).status, 'disconnected');
    dispose();
  });

  test('has already deleted it when removing the folder kills the extension host', async () => {
    // Its first folder: VS Code restarts the extension host here, and nothing
    // after this call is guaranteed to run.
    const host = new FakeWorkspace(`omnifs://${ID}/`, 'file:///local');
    host.updateWorkspaceFolders = () => {
      throw new Error('extension host stopped');
    };
    const { deps, dispose } = await forget(host);

    await assert.rejects(forgetConnection(deps, config(ID)), /extension host stopped/);

    assert.equal(await deps.configStore.get(ID), undefined);
    assert.equal(await deps.secretStore.get(ID), undefined);
    dispose();
  });

  test('still deletes it when VS Code refuses to remove the folder, and says so', async () => {
    const host = new FakeWorkspace('file:///local', `omnifs://${ID}/`);
    host.updateWorkspaceFolders = () => false;
    const { deps, disk, dispose } = await forget(host);

    assert.equal(await forgetConnection(deps, config(ID)), 'refused');

    assert.equal(await deps.configStore.get(ID), undefined);
    assert.equal(disk.isAlive(), false);
    dispose();
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
