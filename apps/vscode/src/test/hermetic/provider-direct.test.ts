import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  ConnectionManager,
  EntryCache,
  InMemoryConfigStore,
  InMemorySecretStore,
  NOOP_LOGGER,
  OmniFsError,
  ProviderRegistry,
} from '@omni-fs/core';
import type { FileStat, RemotePath } from '@omni-fs/core';
import { MemoryFileSystem, memoryProvider } from '@omni-fs/testing';
import { OmniFileSystemProvider } from '../../fs/omni-file-system-provider.js';
import { bytes, isFileSystemError, text } from '../helpers.js';

/**
 * `OmniFileSystemProvider` constructed directly, because `workspace.fs` cannot
 * reach parts of it.
 *
 * `workspace.fs` always sends `create: true, overwrite: true`, so two of this
 * class's three real decisions are unreachable through it, and the change
 * emitter is private to the provider — VS Code surfaces it to watchers, not to
 * callers. Nothing here is activated, registered or saved to settings: one
 * bundle, one object graph, no shared state with any other file.
 */

const ID = 'direct';

/** A MemoryFileSystem whose `stat` can be made to answer anything. */
class StubFileSystem extends MemoryFileSystem {
  #override: ((path: RemotePath) => FileStat | undefined) | undefined;

  /**
   * Every `stat` for a path this returns a value for answers with it, until
   * replaced. Pass `() => undefined` to fall back to real behaviour.
   */
  overrideStat(answer: (path: RemotePath) => FileStat | undefined): void {
    this.#override = answer;
  }

  override async stat(path: RemotePath, signal?: AbortSignal): Promise<FileStat> {
    return this.#override?.(path) ?? (await super.stat(path, signal));
  }
}

interface Harness {
  readonly provider: OmniFileSystemProvider;
  readonly disk: StubFileSystem;
  uri(path: string): vscode.Uri;
  /** Every change event fired since construction, flattened and in order. */
  readonly events: vscode.FileChangeEvent[];
  dispose(): void;
}

async function harness(seed: Readonly<Record<string, string>> = {}): Promise<Harness> {
  const disk = new StubFileSystem();
  disk.seed(seed);

  const registry = new ProviderRegistry();
  registry.register({ ...memoryProvider, id: ID, schemes: [ID], create: () => disk });

  const configStore = new InMemoryConfigStore();
  await configStore.save({ id: ID, providerId: ID, label: ID, settings: {} });

  const manager = new ConnectionManager({
    registry,
    configStore,
    secretStore: new InMemorySecretStore(),
    logger: NOOP_LOGGER,
  });

  const provider = new OmniFileSystemProvider({
    manager,
    configStore,
    // Fresh per test: the shared 15s cache would otherwise serve a stat from a
    // previous case and hide the very branch under test.
    cache: new EntryCache(),
    logger: NOOP_LOGGER,
  });

  const events: vscode.FileChangeEvent[] = [];
  const subscription = provider.onDidChangeFile((batch) => events.push(...batch));

  return {
    provider,
    disk,
    uri: (path: string) => vscode.Uri.from({ scheme: 'omnifs', authority: ID, path }),
    events,
    dispose: () => {
      subscription.dispose();
      provider.dispose();
    },
  };
}

suite('OmniFileSystemProvider, constructed directly', () => {
  // Nullable, and started through `start()` so that `teardown` has something
  // to dispose even when a test fails before its harness is built — and so
  // each test reads a non-optional local rather than a possibly-undefined
  // suite variable.
  let current: Harness | undefined;

  async function start(seed: Readonly<Record<string, string>> = {}): Promise<Harness> {
    current = await harness(seed);
    return current;
  }

  teardown(() => {
    current?.dispose();
    current = undefined;
  });

  suite('flags workspace.fs never sends', () => {
    test('writeFile with create: false on a missing file fails as FileNotFound', async () => {
      const fixture = await start();
      await assert.rejects(
        () =>
          fixture.provider.writeFile(fixture.uri('/absent.txt'), bytes('x'), {
            create: false,
            overwrite: true,
          }),
        (error: unknown) => isFileSystemError(error, 'FileNotFound'),
      );
    });

    test('writeFile with create: false on an existing file succeeds', async () => {
      const fixture = await start({ '/present.txt': 'before' });
      await fixture.provider.writeFile(fixture.uri('/present.txt'), bytes('after'), {
        create: false,
        overwrite: true,
      });
      assert.equal(text(await fixture.provider.readFile(fixture.uri('/present.txt'))), 'after');
    });

    test('writeFile with overwrite: false on an existing file fails as FileExists', async () => {
      const fixture = await start({ '/present.txt': 'before' });
      await assert.rejects(
        () =>
          fixture.provider.writeFile(fixture.uri('/present.txt'), bytes('after'), {
            create: true,
            overwrite: false,
          }),
        (error: unknown) => isFileSystemError(error, 'FileExists'),
      );
      assert.equal(text(await fixture.provider.readFile(fixture.uri('/present.txt'))), 'before');
    });

    test('writeFile with create: false propagates a stat failure that is not NotFound', async () => {
      // The caller required the file to exist. We could not confirm it does,
      // so the honest answer is the failure we got — not FileNotFound, which
      // would tell VS Code to start a create-on-save flow against a server
      // that is currently unreachable.
      const fixture = await start({ '/present.txt': 'before' });
      fixture.disk.overrideStat(() => {
        throw new OmniFsError({ code: 'Timeout', message: 'server stopped responding' });
      });

      await assert.rejects(
        () =>
          fixture.provider.writeFile(fixture.uri('/present.txt'), bytes('after'), {
            create: false,
            overwrite: true,
          }),
        (error: unknown) => isFileSystemError(error, 'Unavailable'),
      );
    });

    test('writeFile with create: true still writes when the stat fails unreadably', async () => {
      // The stat only labels the change event here. A save must not be lost
      // because the label could not be computed.
      const fixture = await start({ '/present.txt': 'before' });
      fixture.disk.overrideStat(() => {
        throw new OmniFsError({ code: 'Timeout', message: 'server stopped responding' });
      });

      await fixture.provider.writeFile(fixture.uri('/present.txt'), bytes('after'), {
        create: true,
        overwrite: true,
      });

      fixture.disk.overrideStat(() => undefined);
      assert.equal(text(await fixture.provider.readFile(fixture.uri('/present.txt'))), 'after');
      assert.deepEqual(
        fixture.events.map((event) => event.type),
        [vscode.FileChangeType.Changed],
      );
    });

    test('writeFile with create: true is still lost on a nested path', async () => {
      // Where the resilience above stops, recorded rather than fixed. The
      // sibling case survives only because `/present.txt`'s parent is the
      // root: `ManagedFileSystem.writeFile` calls `#ensureParents`, which
      // stats every parent below the root and rethrows anything that is not
      // NotFound. So under the very fault that case is named for, `/a/b.txt`
      // does not save.
      //
      // Deliberately not fixed here. Letting the parent check proceed through
      // an arbitrary stat failure changes when a write is attempted against a
      // server that is misbehaving, which is a core decision with its own
      // blast radius — not a comment's worth of host-layer resilience.
      const fixture = await start();
      fixture.disk.overrideStat(() => {
        throw new OmniFsError({ code: 'Timeout', message: 'server stopped responding' });
      });

      await assert.rejects(
        () =>
          fixture.provider.writeFile(fixture.uri('/nested/file.txt'), bytes('x'), {
            create: true,
            overwrite: true,
          }),
        (error: unknown) => isFileSystemError(error, 'Unavailable'),
      );

      fixture.disk.overrideStat(() => undefined);
      await assert.rejects(
        () => fixture.provider.readFile(fixture.uri('/nested/file.txt')),
        (error: unknown) => isFileSystemError(error, 'FileNotFound'),
      );
      assert.deepEqual(fixture.events, []);
    });
  });

  suite('change events', () => {
    test('a new file reports Created', async () => {
      const fixture = await start();
      const uri = fixture.uri('/new.txt');
      await fixture.provider.writeFile(uri, bytes('x'), { create: true, overwrite: true });

      assert.deepEqual(
        fixture.events.map((event) => event.type),
        [vscode.FileChangeType.Created],
      );
      assert.equal(fixture.events[0]?.uri.toString(), uri.toString());
    });

    test('an overwrite reports Changed, not Created', async () => {
      // `options.create` is true on every ordinary save, so it cannot tell a
      // new file from an overwrite. A watcher that believes it sees files
      // appear that were already there.
      const fixture = await start({ '/present.txt': 'before' });
      await fixture.provider.writeFile(fixture.uri('/present.txt'), bytes('after'), {
        create: true,
        overwrite: true,
      });

      assert.deepEqual(
        fixture.events.map((event) => event.type),
        [vscode.FileChangeType.Changed],
      );
    });

    test('a delete reports Deleted', async () => {
      const fixture = await start({ '/doomed.txt': 'x' });
      await fixture.provider.delete(fixture.uri('/doomed.txt'), { recursive: false });

      assert.deepEqual(
        fixture.events.map((event) => event.type),
        [vscode.FileChangeType.Deleted],
      );
    });

    test('a rename reports Deleted at the old path then Created at the new', async () => {
      const fixture = await start({ '/before.txt': 'x' });
      await fixture.provider.rename(fixture.uri('/before.txt'), fixture.uri('/after.txt'), {
        overwrite: false,
      });

      // Whole URI rather than just the path: a rename firing on the right
      // path under the wrong authority is a watcher told about someone else's
      // connection, and `.path` alone would not notice.
      assert.deepEqual(
        fixture.events.map((event) => [event.type, event.uri.toString()]),
        [
          [vscode.FileChangeType.Deleted, fixture.uri('/before.txt').toString()],
          [vscode.FileChangeType.Created, fixture.uri('/after.txt').toString()],
        ],
      );
    });

    test('a created directory reports Created', async () => {
      const fixture = await start();
      await fixture.provider.createDirectory(fixture.uri('/folder'));

      assert.deepEqual(
        fixture.events.map((event) => event.type),
        [vscode.FileChangeType.Created],
      );
    });
  });

  suite('stat fields only a provider can set', () => {
    test('a read-only entry reports FilePermission.Readonly', async () => {
      // FileStat.readOnly is what makes VS Code open the file in a read-only
      // editor rather than letting the user type and fail at save time.
      const fixture = await start({ '/locked.txt': 'x' });
      fixture.disk.overrideStat((path) =>
        path.value === '/locked.txt' ? { type: 'file', size: 1, readOnly: true } : undefined,
      );

      const stat = await fixture.provider.stat(fixture.uri('/locked.txt'));
      assert.equal(stat.permissions, vscode.FilePermission.Readonly);
    });

    test('an ordinary entry sets no permissions at all', async () => {
      // Not `permissions: 0`: VS Code treats the absent property as "no
      // special permissions", and sending 0 is a different statement.
      const fixture = await start({ '/plain.txt': 'x' });
      const stat = await fixture.provider.stat(fixture.uri('/plain.txt'));
      assert.equal(stat.permissions, undefined);
    });

    test('a symlink maps to FileType.SymbolicLink', async () => {
      const fixture = await start({ '/link': 'x' });
      fixture.disk.overrideStat((path) =>
        path.value === '/link' ? { type: 'symlink', size: 0 } : undefined,
      );

      const stat = await fixture.provider.stat(fixture.uri('/link'));
      assert.equal(stat.type, vscode.FileType.SymbolicLink);
    });
  });
});
