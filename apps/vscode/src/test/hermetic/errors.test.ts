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
import type {
  DeleteOptions,
  FileStat,
  OmniFsErrorCode,
  OverwriteOptions,
  RemotePath,
  WriteOptions,
} from '@omni-fs/core';
import { MemoryFileSystem, memoryProvider } from '@omni-fs/testing';
import { OmniFileSystemProvider } from '../../fs/omni-file-system-provider.js';
import { bytes, isFileSystemError, text } from '../helpers.js';

/**
 * `toVsCodeError`, the one place a remote failure becomes an editor behaviour.
 *
 * Injection happens on `stat` on purpose. ManagedFileSystem emulates the
 * operations a protocol lacks — rename as copy-plus-delete, recursive delete
 * as a walk — so an error thrown from inside one of those can be caught and
 * replaced before it reaches the host, and the assertion would be about the
 * emulation instead of the table. `stat` consults only the cache, which never
 * stores a throw, before delegating.
 */

/** A MemoryFileSystem whose `stat` throws whatever it is handed. */
class ThrowingFileSystem extends MemoryFileSystem {
  failure: unknown;

  override async stat(path: RemotePath, signal?: AbortSignal): Promise<FileStat> {
    if (this.failure !== undefined) throw this.failure;
    return super.stat(path, signal);
  }
}

/** A MemoryFileSystem that remembers which mutating calls actually reached it. */
class RecordingFileSystem extends MemoryFileSystem {
  readonly calls: string[] = [];

  override async writeFile(
    path: RemotePath,
    data: Uint8Array,
    options?: WriteOptions,
  ): Promise<void> {
    this.calls.push('writeFile');
    return super.writeFile(path, data, options);
  }

  override async delete(path: RemotePath, options?: DeleteOptions): Promise<void> {
    this.calls.push('delete');
    return super.delete(path, options);
  }

  override async rename(
    from: RemotePath,
    to: RemotePath,
    options?: OverwriteOptions,
  ): Promise<void> {
    this.calls.push('rename');
    return super.rename(from, to, options);
  }

  override async copy(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void> {
    this.calls.push('copy');
    return super.copy(from, to, options);
  }
}

/** Builds a provider over one or more named in-memory filesystems. */
async function buildProvider(
  disks: Readonly<Record<string, MemoryFileSystem>>,
): Promise<OmniFileSystemProvider> {
  const registry = new ProviderRegistry();
  const configStore = new InMemoryConfigStore();

  for (const [id, disk] of Object.entries(disks)) {
    registry.register({ ...memoryProvider, id, schemes: [id], create: () => disk });
    await configStore.save({ id, providerId: id, label: id, settings: {} });
  }

  return new OmniFileSystemProvider({
    manager: new ConnectionManager({
      registry,
      configStore,
      secretStore: new InMemorySecretStore(),
      logger: NOOP_LOGGER,
    }),
    configStore,
    cache: new EntryCache(),
    logger: NOOP_LOGGER,
  });
}

function uriFor(connectionId: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: 'omnifs', authority: connectionId, path });
}

suite('toVsCodeError', () => {
  const TABLE: readonly [OmniFsErrorCode, string][] = [
    ['NotFound', 'FileNotFound'],
    ['AlreadyExists', 'FileExists'],
    ['NotADirectory', 'FileNotADirectory'],
    ['IsADirectory', 'FileIsADirectory'],
    ['PermissionDenied', 'NoPermissions'],
    ['AuthenticationFailed', 'NoPermissions'],
    ['Unsupported', 'NoPermissions'],
    // Everything not named above is Unavailable. These five are the ones a
    // user actually meets, so each is pinned rather than trusting the default.
    ['Timeout', 'Unavailable'],
    ['ConnectionFailed', 'Unavailable'],
    ['Conflict', 'Unavailable'],
    ['NotEmpty', 'Unavailable'],
    ['Unknown', 'Unavailable'],
  ];

  for (const [code, expected] of TABLE) {
    test(`maps ${code} to ${expected}`, async () => {
      const disk = new ThrowingFileSystem();
      disk.failure = new OmniFsError({ code, message: `${code} happened` });
      const provider = await buildProvider({ table: disk });

      await assert.rejects(
        () => provider.stat(uriFor('table', '/anything.txt')),
        (error: unknown) => isFileSystemError(error, expected),
      );
      provider.dispose();
    });
  }

  test('passes a plain Error through unwrapped', async () => {
    // A provider that throws something other than an OmniFsError has broken
    // its contract. Wrapping it in a FileSystemError would bury the stack the
    // author needs; the honest thing is to let it surface as itself.
    const disk = new ThrowingFileSystem();
    const original = new Error('the provider threw a bare Error');
    disk.failure = original;
    const provider = await buildProvider({ bare: disk });

    await assert.rejects(
      () => provider.stat(uriFor('bare', '/anything.txt')),
      (error: unknown) => error === original,
    );
    provider.dispose();
  });

  test('surfaces a failed connect as NoPermissions', async () => {
    // The second call site of toVsCodeError, inside `#resolve`'s catch on
    // `manager.acquire`. Stat injection never reaches it, because this failure
    // happens before there is a filesystem to stat.
    const registry = new ProviderRegistry();
    registry.register({
      ...memoryProvider,
      id: 'refuses',
      schemes: ['refuses'],
      create: () => {
        const disk = new MemoryFileSystem();
        return Object.assign(disk, {
          connect: async () => {
            throw new OmniFsError({ code: 'AuthenticationFailed', message: 'wrong password' });
          },
        });
      },
    });
    const configStore = new InMemoryConfigStore();
    await configStore.save({
      id: 'refuses',
      providerId: 'refuses',
      label: 'refuses',
      settings: {},
    });

    const provider = new OmniFileSystemProvider({
      manager: new ConnectionManager({
        registry,
        configStore,
        secretStore: new InMemorySecretStore(),
        logger: NOOP_LOGGER,
      }),
      configStore,
      cache: new EntryCache(),
      logger: NOOP_LOGGER,
    });

    await assert.rejects(
      () => provider.stat(uriFor('refuses', '/anything.txt')),
      (error: unknown) => isFileSystemError(error, 'NoPermissions'),
    );
    provider.dispose();
  });

  suite('across two connections', () => {
    test('rename refuses as NoPermissions and moves nothing', async () => {
      // Cross-connection moves are a copy-then-delete across two providers.
      // Worth doing, but it belongs in the transfer queue with progress and
      // cancellation — so until that lands the refusal must be clean, not a
      // half-completed move.
      const source = new RecordingFileSystem();
      source.seed({ '/file.txt': 'stays here' });
      const target = new RecordingFileSystem();
      const provider = await buildProvider({ left: source, right: target });

      await assert.rejects(
        () =>
          provider.rename(uriFor('left', '/file.txt'), uriFor('right', '/file.txt'), {
            overwrite: true,
          }),
        (error: unknown) => isFileSystemError(error, 'NoPermissions'),
      );

      assert.deepEqual(source.calls, [], 'the source filesystem was mutated');
      // Proving the target is untouched needs the target to be *acquired*:
      // `rename` only resolves the source and reaches the destination through
      // `parseUri`, so `target.calls` alone compares an empty array against an
      // empty array that nothing could have written to. Going through the
      // provider is what makes the claim real.
      await assert.rejects(
        () => provider.stat(uriFor('right', '/file.txt')),
        (error: unknown) => isFileSystemError(error, 'FileNotFound'),
      );
      provider.dispose();
    });

    test('copy refuses as NoPermissions and copies nothing', async () => {
      const source = new RecordingFileSystem();
      source.seed({ '/file.txt': 'stays here' });
      const target = new RecordingFileSystem();
      const provider = await buildProvider({ left: source, right: target });

      await assert.rejects(
        () =>
          provider.copy(uriFor('left', '/file.txt'), uriFor('right', '/file.txt'), {
            overwrite: true,
          }),
        (error: unknown) => isFileSystemError(error, 'NoPermissions'),
      );

      assert.deepEqual(source.calls, []);
      // Same reasoning as the rename test above: `target.calls` alone cannot
      // fail, because `copy` never acquires the target connection either.
      await assert.rejects(
        () => provider.stat(uriFor('right', '/file.txt')),
        (error: unknown) => isFileSystemError(error, 'FileNotFound'),
      );
      provider.dispose();
    });
  });

  test('a malformed uri with no authority fails as FileNotFound', async () => {
    const provider = await buildProvider({ table: new MemoryFileSystem() });
    const malformed = vscode.Uri.parse('omnifs:///no-authority.txt');

    await assert.rejects(
      () => provider.stat(malformed),
      (error: unknown) => isFileSystemError(error, 'FileNotFound'),
    );
    provider.dispose();
  });

  test('a mutating call is translated too, not only stat', async () => {
    // `translate()` wraps every call site. This proves the wrapper is in place
    // on a write path rather than only on the one the table above uses — and
    // it comes from the provider's own refusal, not from injection.
    const disk = new MemoryFileSystem();
    disk.seed({ '/present.txt': 'before' });
    const provider = await buildProvider({ writes: disk });

    await assert.rejects(
      () =>
        provider.writeFile(uriFor('writes', '/present.txt'), bytes('after'), {
          create: true,
          overwrite: false,
        }),
      (error: unknown) => isFileSystemError(error, 'FileExists'),
    );
    assert.equal(text(await provider.readFile(uriFor('writes', '/present.txt'))), 'before');
    provider.dispose();
  });
});
