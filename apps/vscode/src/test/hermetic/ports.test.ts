import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ConnectionConfig, LogLevel } from '@omni-fs/core';
import { VsCodeConfigStore, VsCodeLogger, VsCodeSecretStore } from '../../host/vscode-ports.js';
import { resetConnections } from '../helpers.js';

/**
 * The host adapter layer — the whole of it. When the desktop app is built it
 * gets an `electron-ports.ts` of comparable size and nothing else changes, so
 * these three classes are the seam the second host has to match.
 */

const PREFIX = 'ports-test';

function config(id: string, overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: `${PREFIX}-${id}`,
    providerId: 'memory',
    label: `label for ${id}`,
    settings: { host: 'example.test' },
    ...overrides,
  };
}

suite('VsCodeConfigStore, against the real configuration API', () => {
  let store: VsCodeConfigStore;

  suiteSetup(async () => {
    // Also at setup, not only teardown: the runner's user-data directory
    // survives between local runs, so a crashed run leaves entries behind.
    await resetConnections();
    store = new VsCodeConfigStore();
  });

  teardown(async () => {
    await resetConnections();
  });

  test('save then list round-trips a ConnectionConfig', async () => {
    const saved = config('round-trip', { rootPath: '/srv', readOnly: true });
    await store.save(saved);

    const listed = (await store.list()).filter((entry) => entry.id.startsWith(PREFIX));
    assert.deepEqual(listed, [saved]);
    assert.deepEqual(await store.get(saved.id), saved);
  });

  test('save replaces an existing entry rather than appending a duplicate', async () => {
    await store.save(config('edited', { label: 'before' }));
    await store.save(config('edited', { label: 'after' }));

    const listed = (await store.list()).filter((entry) => entry.id.startsWith(PREFIX));
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.label, 'after');
  });

  test('list drops entries that are not shaped like a ConnectionConfig', async () => {
    // `omniFs.connections` is hand-editable JSON that a team commits, so it
    // can and will arrive malformed. One bad entry must not take the rest of
    // a user's connections down with it.
    await vscode.workspace
      .getConfiguration('omniFs')
      .update(
        'connections',
        [
          config('valid'),
          { id: `${PREFIX}-no-provider`, label: 'x', settings: {} },
          { nonsense: true },
          'a bare string',
          null,
        ],
        vscode.ConfigurationTarget.Global,
      );

    // VS Code's `update()` does no value validation — the manifest's schema
    // drives the settings editor, not writes — so all five entries reach
    // `isConnectionConfig`. Asserted rather than assumed: if VS Code ever did
    // filter on write, this test would otherwise still pass and prove nothing.
    assert.equal(
      vscode.workspace.getConfiguration('omniFs').get<unknown[]>('connections', []).length,
      5,
    );

    const listed = (await store.list()).filter((entry) => entry.id.startsWith(PREFIX));
    assert.deepEqual(
      listed.map((entry) => entry.id),
      [`${PREFIX}-valid`],
    );
  });

  test('delete removes one connection and leaves the others', async () => {
    await store.save(config('keep-a'));
    await store.save(config('remove'));
    await store.save(config('keep-b'));

    await store.delete(`${PREFIX}-remove`);

    const listed = (await store.list()).filter((entry) => entry.id.startsWith(PREFIX));
    assert.deepEqual(listed.map((entry) => entry.id).sort(), [
      `${PREFIX}-keep-a`,
      `${PREFIX}-keep-b`,
    ]);
  });

  test('onDidChange fires for omniFs.connections', async () => {
    let fired = 0;
    const subscription = store.onDidChange(() => {
      fired += 1;
    });
    // Configuration events are delivered on a later tick and are not ordered
    // with the update() promise, so the previous test's teardown() write can
    // still be in flight when this listener is registered. Drain it, then
    // zero — otherwise this assertion could be satisfied by an event this
    // test never caused.
    await new Promise((resolve) => setTimeout(resolve, 100));
    fired = 0;

    await store.save(config('watched'));
    // Poll rather than a fixed sleep: delivery latency is not fixed, and a
    // loaded CI runner can take longer than a short wait would allow for.
    const deadline = Date.now() + 2000;
    while (fired === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    subscription[Symbol.dispose]();
    assert.ok(fired > 0, 'onDidChange never fired for a connections write');
  });

  test('onDidChange does not fire for an unrelated omniFs key', async () => {
    // `affectsConfiguration('omniFs')` would be true here. The store asks
    // about `omniFs.connections` specifically, and this is what says so — a
    // listener that reloads every connection on a log-level change is a real
    // cost against a metered bucket.
    let fired = 0;
    const subscription = store.onDidChange(() => {
      fired += 1;
    });
    // Same drain-then-zero as the sibling test above: without it, a leaked
    // event from the previous test's teardown() write could increment this
    // counter and fail this assertion while blaming a key it never touched.
    await new Promise((resolve) => setTimeout(resolve, 100));
    fired = 0;

    const configuration = vscode.workspace.getConfiguration('omniFs');
    try {
      await configuration.update('logLevel', 'debug', vscode.ConfigurationTarget.Global);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      // Failure-safe: an abort between the write and the reset would
      // otherwise leave "debug" in the runner's persistent user-data
      // directory for every later run.
      await configuration.update('logLevel', undefined, vscode.ConfigurationTarget.Global);
    }

    subscription[Symbol.dispose]();
    assert.equal(fired, 0, 'onDidChange fired for omniFs.logLevel');
  });

  test('deleting the last connection leaves nothing of ours behind', async () => {
    await store.save(config('last'));
    // Establishes the entry actually landed, so the removal below proves a
    // removal happened rather than passing on `teardown`'s already-empty
    // setting.
    assert.deepEqual(
      (await store.list()).map((entry) => entry.id),
      [`${PREFIX}-last`],
    );

    // Through the store, not through the test helper. The helper collapses an
    // empty array to `undefined` itself, so driving the removal with it would
    // satisfy the assertion below whatever `VsCodeConfigStore` did — the exact
    // regression this case exists to catch.
    await store.delete(`${PREFIX}-last`);

    const listed = (await store.list()).filter((entry) => entry.id.startsWith(PREFIX));
    assert.deepEqual(listed, []);
    // "Leaves nothing behind" means the key itself, not an empty array
    // stored under it — the two are indistinguishable through `list()`, and
    // `omniFs.connections` is a setting teams commit, so a stray `[]` is noise
    // in someone's `.vscode/settings.json`.
    assert.equal(
      vscode.workspace.getConfiguration('omniFs').inspect('connections')?.globalValue,
      undefined,
    );
  });
});

/**
 * Enough of `vscode.SecretStorage` for the store to run against.
 *
 * The real binding — Keychain, DPAPI, libsecret — is reached through
 * `ExtensionContext.secrets`, which a Mocha test does not have. Publishing the
 * secret store on `OmniFsApi` to get at it is exactly what the API decision
 * refuses, so this proves the store's own logic and not the keychain.
 */
function fakeSecretStorage(): vscode.SecretStorage & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>();
  const emitter = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
  return {
    entries,
    // `VsCodeSecretStore` never calls this; it exists only because
    // `vscode.SecretStorage` requires it structurally.
    keys: async () => [...entries.keys()],
    get: async (key: string) => entries.get(key),
    store: async (key: string, value: string) => {
      entries.set(key, value);
      emitter.fire({ key });
    },
    delete: async (key: string) => {
      entries.delete(key);
      emitter.fire({ key });
    },
    onDidChange: emitter.event,
  };
}

suite('VsCodeSecretStore', () => {
  test('namespaces keys so a connection id cannot collide with another extension', async () => {
    const storage = fakeSecretStorage();
    const store = new VsCodeSecretStore(storage);

    await store.set('my-bucket', { accessKeyId: 'AKIA', secretAccessKey: 'shh' });

    assert.deepEqual([...storage.entries.keys()], ['omniFs.secret.my-bucket']);
  });

  test('round-trips a secret through JSON', async () => {
    const store = new VsCodeSecretStore(fakeSecretStorage());
    const secret = { password: 'hunter2', passphrase: '' };

    await store.set('conn', secret);

    assert.deepEqual(await store.get('conn'), secret);
  });

  test('reports a missing secret as undefined', async () => {
    const store = new VsCodeSecretStore(fakeSecretStorage());
    assert.equal(await store.get('never-saved'), undefined);
  });

  test('treats a corrupt entry as no entry', async () => {
    // A half-written keychain entry must re-prompt, not throw on every
    // connect attempt for the rest of the installation's life.
    const storage = fakeSecretStorage();
    storage.entries.set('omniFs.secret.broken', '{not json');
    const store = new VsCodeSecretStore(storage);

    assert.equal(await store.get('broken'), undefined);
  });

  test('delete removes the namespaced key', async () => {
    const storage = fakeSecretStorage();
    const store = new VsCodeSecretStore(storage);
    await store.set('conn', { password: 'x' });
    // Stands on its own rather than leaning on the sibling that proves `set`
    // writes: without this, the test would pass just as well if `set` had
    // stored nothing and `delete` had done nothing.
    assert.equal(storage.entries.size, 1);

    await store.delete('conn');

    assert.equal(storage.entries.size, 0);
  });
});

/**
 * Records the five level methods `VsCodeLogger` actually calls, and carries a
 * writable `logLevel` — the one other member it reads, and the one the user
 * changes through the Output panel's "Set Log Level…".
 */
function fakeLogChannel(level: vscode.LogLevel = vscode.LogLevel.Info): {
  readonly channel: vscode.LogOutputChannel & { logLevel: vscode.LogLevel };
  readonly lines: [LogLevel, string][];
} {
  const lines: [LogLevel, string][] = [];
  const channel = {
    logLevel: level,
    trace: (line: string) => lines.push(['trace', line]),
    debug: (line: string) => lines.push(['debug', line]),
    info: (line: string) => lines.push(['info', line]),
    warn: (line: string) => lines.push(['warn', line]),
    error: (line: string) => lines.push(['error', line]),
    // `LogOutputChannel` has a dozen more members (append, show,
    // onDidChangeLogLevel …) that this adapter never touches. Casting is
    // honest here: implementing them would assert nothing.
  } as unknown as vscode.LogOutputChannel & { logLevel: vscode.LogLevel };
  return { channel, lines };
}

suite('VsCodeLogger', () => {
  test("drops everything below the channel's own level", async () => {
    const { channel, lines } = fakeLogChannel(vscode.LogLevel.Warning);
    const logger = new VsCodeLogger(channel);

    logger.log('trace', 'no');
    logger.log('debug', 'no');
    logger.log('info', 'no');
    logger.log('warn', 'yes');
    logger.log('error', 'yes');

    assert.deepEqual(
      lines.map(([level]) => level),
      ['warn', 'error'],
    );
  });

  test('follows a level change at once, without a reload', async () => {
    // What "Set Log Level…" in the Output panel does: VS Code changes the
    // channel's level under a logger that already exists.
    const { channel, lines } = fakeLogChannel(vscode.LogLevel.Info);
    const logger = new VsCodeLogger(channel).child('conn-1');

    logger.log('debug', 'hidden');
    channel.logLevel = vscode.LogLevel.Trace;
    logger.log('debug', 'shown');
    logger.log('trace', 'shown too');

    assert.deepEqual(
      lines.map(([, line]) => line),
      ['[conn-1] shown', '[conn-1] shown too'],
    );
  });

  test('writes nothing when the channel is off', async () => {
    const { channel, lines } = fakeLogChannel(vscode.LogLevel.Off);
    new VsCodeLogger(channel).log('error', 'dropped');

    assert.deepEqual(lines, []);
  });

  test('appends structured data as JSON', async () => {
    const { channel, lines } = fakeLogChannel();
    new VsCodeLogger(channel).log('info', 'connected', { providerId: 's3' });

    assert.equal(lines[0]?.[1], 'connected {"providerId":"s3"}');
  });

  test('child nests scopes as parent/child', async () => {
    // `#resolve` calls `logger.child(connectionId)`, and ManagedFileSystem
    // passes it on again. A flat scope makes two connections' logs identical.
    const { channel, lines } = fakeLogChannel();
    const logger = new VsCodeLogger(channel);

    logger.child('conn-1').child('transfer').log('info', 'started');

    assert.equal(lines[0]?.[1], '[conn-1/transfer] started');
  });
});
