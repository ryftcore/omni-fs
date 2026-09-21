import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { MemoryFileSystem, memoryProvider } from '@omni-fs/testing';
import type { ConnectionConfig } from '@omni-fs/core';
import type { OmniFsApi } from '../extension.js';

/**
 * Shared setup for the hermetic suites.
 *
 * Note that `OmniFsApi` is imported as a *type*. `verbatimModuleSyntax` erases
 * it, so nothing here pulls `extension.ts` into the test bundle — which would
 * bundle a second copy of the whole extension and prove nothing about the one
 * the host loaded.
 *
 * `MemoryFileSystem` is a value import, so the test bundle does carry its own
 * copy of `@omni-fs/core`. That is the point: an `OmniFsError` thrown here is
 * a different class object from the extension bundle's, and these suites are
 * what proves the brand check in `OmniFsError.is` holds.
 */

export const EXTENSION_ID = 'ryftcore.omni-fs-vscode';

const SECTION = 'omniFs';
const CONNECTIONS = 'connections';

export async function activateExtension(): Promise<OmniFsApi> {
  const extension = vscode.extensions.getExtension<OmniFsApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} was not loaded by the host`);
  return extension.activate();
}

export interface TestConnection {
  readonly connectionId: string;
  /** The exact disk behind the connection, for seeding and for assertions. */
  readonly disk: MemoryFileSystem;
  /** Builds `omnifs://<connectionId><path>`. */
  uri(path: string): vscode.Uri;
  /**
   * Unregisters the provider and removes the saved connection — and nothing
   * else. It does *not* close the live filesystem: `ConnectionManager.acquire`
   * returns straight from its `#live` map without consulting the `ConfigStore`,
   * and `disconnect`/`invalidate` are unreachable because `OmniFsApi` exposes
   * only `registry`.
   *
   * Two consequences for anything written on top of this. Removing the config
   * does not make that connection's URIs stop resolving, so a test asserting
   * that will not see what it expects. And editing a live connection's config
   * has no effect until a fresh connect — `readOnly` excepted, which is read on
   * every operation — so a suite wanting different settings needs a different
   * `id`, not a rewrite.
   */
  dispose(): Promise<void>;
}

/**
 * Registers a provider backed by one pinned in-memory disk, saves a connection
 * pointing at it, and hands back both.
 *
 * `memoryProvider.create` returns a *new* `MemoryFileSystem` per call, which
 * would leave the test with no handle on the bytes it is asserting about — so
 * the definition is spread and `create` is replaced with one that returns the
 * instance this function owns.
 *
 * `ConnectionManager` calls `getSecret` lazily and `MemoryFileSystem` never
 * calls it, so these connections need no keychain entry at all.
 *
 * Pass an `id` unique to the calling file: it becomes the provider id, the URI
 * scheme and the connection id at once, so two files cannot collide.
 */
export async function connectMemory(options: {
  api: OmniFsApi;
  id: string;
  seed?: Readonly<Record<string, string>> | undefined;
  readOnly?: boolean | undefined;
}): Promise<TestConnection> {
  const disk = new MemoryFileSystem();
  // Before the connection can be acquired, so the shared 15s EntryCache has
  // nothing stale to serve.
  if (options.seed !== undefined) disk.seed(options.seed);

  const registration = options.api.registry.register({
    ...memoryProvider,
    id: options.id,
    schemes: [options.id],
    create: () => disk,
  });

  const config: ConnectionConfig = {
    id: options.id,
    providerId: options.id,
    label: options.id,
    settings: {},
    ...(options.readOnly === true ? { readOnly: true } : {}),
  };
  await saveConnection(config);

  return {
    connectionId: options.id,
    disk,
    uri: (path: string) => vscode.Uri.from({ scheme: 'omnifs', authority: options.id, path }),
    dispose: async () => {
      registration[Symbol.dispose]();
      await removeConnection(options.id);
    },
  };
}

async function listConnections(): Promise<ConnectionConfig[]> {
  return [...vscode.workspace.getConfiguration(SECTION).get<ConnectionConfig[]>(CONNECTIONS, [])];
}

export async function saveConnection(config: ConnectionConfig): Promise<void> {
  const next = (await listConnections()).filter((candidate) => candidate.id !== config.id);
  next.push(config);
  await write(next);
}

export async function removeConnection(id: string): Promise<void> {
  const next = (await listConnections()).filter((candidate) => candidate.id !== id);
  await write(next);
}

/**
 * Clears the global setting outright.
 *
 * For absorbing what a crashed run left behind, which is why suites call it in
 * `suiteSetup` and not only in teardown: the runner's user-data directory
 * survives between local runs, so entries from a suite that never reached its
 * teardown are still there on the next one and it fails for no visible reason.
 *
 * Not universal, and should not become so. A suite whose connection ids are
 * unique per run — the live label builds one from `Date.now()` and the pid —
 * cannot collide with a leftover, and calling this from it would delete the
 * connections of whatever else is mid-run.
 */
export async function resetConnections(): Promise<void> {
  await write([]);
}

async function write(configs: readonly ConnectionConfig[]): Promise<void> {
  await vscode.workspace
    .getConfiguration(SECTION)
    // `undefined` removes the key entirely rather than storing an empty array,
    // which is what "as the user found it" means here.
    .update(
      CONNECTIONS,
      configs.length === 0 ? undefined : configs,
      vscode.ConfigurationTarget.Global,
    );
}

export function bytes(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

export function text(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

/** True when `error` is a `vscode.FileSystemError` with this code. */
export function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof vscode.FileSystemError && error.code === code;
}
