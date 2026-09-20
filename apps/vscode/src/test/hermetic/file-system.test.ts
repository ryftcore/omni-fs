import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  activateExtension,
  bytes,
  connectMemory,
  isFileSystemError,
  resetConnections,
  text,
  type TestConnection,
} from '../helpers.js';

/**
 * The activated composition, driven the way a keystroke drives it: manifest,
 * registration, connection lookup, URI parsing, `ManagedFileSystem`, provider.
 *
 * This is also the end-to-end proof of the brand check. The errors asserted
 * below are thrown by a `MemoryFileSystem` living in *this* bundle and are
 * recognised by `toVsCodeError` in the *extension's* bundle. Before that fix
 * they arrived untranslated and every case expecting `FileNotFound` saw
 * `Unavailable` instead.
 *
 * The blocks handed to `assert.rejects` are `async` throughout because
 * `workspace.fs` returns a `Thenable`, and `assert.rejects` takes a real
 * `Promise`.
 */

const ID = 'omnifs-test-file-system';

suite('workspace.fs over omnifs://', () => {
  let connection: TestConnection;

  suiteSetup(async () => {
    await resetConnections();
    const api = await activateExtension();
    connection = await connectMemory({
      api,
      id: ID,
      seed: {
        '/readme.txt': 'hello omni-fs',
        // Owned by the overwrite case below, so the read case can own
        // `/readme.txt` outright. Sharing one path between them would make the
        // read pass only because Mocha happens to run in declaration order —
        // and this file grows another suite in a later task.
        '/replace-me.txt': 'before',
        '/docs/guide.md': '# Guide',
        '/docs/nested/deep.txt': 'three levels down',
      },
    });
  });

  suiteTeardown(async () => {
    // Optional-chained: when `suiteSetup` fails before `connectMemory` returns,
    // an unguarded call throws a second, misleading hook failure on top of the
    // real one.
    await connection?.dispose();
  });

  const statCases: readonly [string, vscode.FileType][] = [
    ['/readme.txt', vscode.FileType.File],
    ['/docs/guide.md', vscode.FileType.File],
    ['/docs', vscode.FileType.Directory],
    ['/docs/nested', vscode.FileType.Directory],
  ];

  for (const [path, type] of statCases) {
    test(`stat reports ${vscode.FileType[type]} for ${path}`, async () => {
      const stat = await vscode.workspace.fs.stat(connection.uri(path));
      assert.equal(stat.type, type);
    });
  }

  test('stat rejects a missing path as FileNotFound', async () => {
    // The code VS Code reads as "create this on save". Getting it wrong is the
    // difference between a new remote file saving and the editor reporting a
    // generic failure.
    await assert.rejects(
      async () => vscode.workspace.fs.stat(connection.uri('/not-here.txt')),
      (error: unknown) => isFileSystemError(error, 'FileNotFound'),
    );
  });

  test('readDirectory returns [name, FileType] tuples with names, not paths', async () => {
    const entries = await vscode.workspace.fs.readDirectory(connection.uri('/docs'));
    const byName = new Map(entries);

    // core's DirEntry carries an absolute path; the host layer's job is to send
    // VS Code the bare name. These two catch a path where a name belongs.
    assert.equal(byName.get('guide.md'), vscode.FileType.File);
    assert.equal(byName.get('nested'), vscode.FileType.Directory);
    // And this catches the other shape of the same bug: a listing that leaks
    // descendants, so `nested/deep.txt` turns up as a child of `/docs`. In the
    // Explorer that reads as folders that do not exist.
    assert.ok(
      !entries.some(([name]) => name.includes('/')),
      `readDirectory leaked a descendant: ${JSON.stringify(entries)}`,
    );
  });

  test('readFile returns the seeded bytes', async () => {
    const data = await vscode.workspace.fs.readFile(connection.uri('/readme.txt'));
    assert.equal(text(data), 'hello omni-fs');
  });

  test('readFile on a directory fails as FileIsADirectory', async () => {
    // The second mapping reachable end-to-end through workspace.fs. The rest of
    // the table is asserted against the translator directly, where an error can
    // be injected; here the provider has to raise it for real.
    await assert.rejects(
      async () => vscode.workspace.fs.readFile(connection.uri('/docs')),
      (error: unknown) => isFileSystemError(error, 'FileIsADirectory'),
    );
  });

  const writeCases: readonly [string, string, string][] = [
    ['creates a new file', '/written/new.txt', 'first'],
    ['replaces an existing file', '/replace-me.txt', 'replaced'],
  ];

  for (const [name, path, content] of writeCases) {
    test(`writeFile ${name}`, async () => {
      await vscode.workspace.fs.writeFile(connection.uri(path), bytes(content));
      assert.equal(text(await vscode.workspace.fs.readFile(connection.uri(path))), content);
    });
  }

  test('createDirectory creates a directory stat then reports', async () => {
    const uri = connection.uri('/fresh-directory');
    await vscode.workspace.fs.createDirectory(uri);
    assert.equal((await vscode.workspace.fs.stat(uri)).type, vscode.FileType.Directory);
  });

  test('rename moves a file and the old path is gone', async () => {
    const from = connection.uri('/rename-me.txt');
    const to = connection.uri('/renamed.txt');
    await vscode.workspace.fs.writeFile(from, bytes('moved'));

    await vscode.workspace.fs.rename(from, to);

    assert.equal(text(await vscode.workspace.fs.readFile(to)), 'moved');
    await assert.rejects(
      async () => vscode.workspace.fs.stat(from),
      (error: unknown) => isFileSystemError(error, 'FileNotFound'),
    );
  });

  test('copy duplicates a file within one connection', async () => {
    const from = connection.uri('/copy-me.txt');
    const to = connection.uri('/copied.txt');
    await vscode.workspace.fs.writeFile(from, bytes('payload'));

    await vscode.workspace.fs.copy(from, to);

    assert.equal(text(await vscode.workspace.fs.readFile(to)), 'payload');
    assert.equal(text(await vscode.workspace.fs.readFile(from)), 'payload');
  });

  test('delete with recursive removes a populated directory', async () => {
    const dir = connection.uri('/doomed');
    await vscode.workspace.fs.writeFile(connection.uri('/doomed/one.txt'), bytes('1'));
    await vscode.workspace.fs.writeFile(connection.uri('/doomed/deeper/two.txt'), bytes('2'));

    await vscode.workspace.fs.delete(dir, { recursive: true });

    await assert.rejects(
      async () => vscode.workspace.fs.stat(connection.uri('/doomed/one.txt')),
      (error: unknown) => isFileSystemError(error, 'FileNotFound'),
    );
  });

  test('an authority naming no saved connection fails as FileNotFound', async () => {
    // `#resolve` calls `manager.acquire(authority)`, which asks the ConfigStore
    // before the registry is ever consulted. Registering a provider is not
    // enough to make a URI resolvable — there has to be a saved connection.
    const stray = vscode.Uri.from({
      scheme: 'omnifs',
      authority: 'no-such-connection',
      path: '/a',
    });
    await assert.rejects(
      async () => vscode.workspace.fs.stat(stray),
      (error: unknown) => isFileSystemError(error, 'FileNotFound'),
    );
  });
});

const READ_ONLY_ID = 'omnifs-test-read-only';

suite('a connection saved with readOnly: true', () => {
  let connection: TestConnection;

  suiteSetup(async () => {
    const api = await activateExtension();
    connection = await connectMemory({
      api,
      id: READ_ONLY_ID,
      readOnly: true,
      seed: { '/readme.txt': 'untouched' },
    });
  });

  suiteTeardown(async () => {
    await connection?.dispose();
  });

  test('still reads', async () => {
    // Read-only has to mean read-only, not broken.
    assert.equal(
      text(await vscode.workspace.fs.readFile(connection.uri('/readme.txt'))),
      'untouched',
    );
    assert.equal(
      (await vscode.workspace.fs.stat(connection.uri('/readme.txt'))).type,
      vscode.FileType.File,
    );
  });

  // `async` for the same reason as every other block in this file: these are
  // handed to `assert.rejects`, which takes a real `Promise` and not the
  // `Thenable` that `workspace.fs` returns.
  const refusals: readonly [string, () => Promise<unknown>][] = [
    [
      'writeFile',
      async () => vscode.workspace.fs.writeFile(connection.uri('/readme.txt'), bytes('nope')),
    ],
    ['delete', async () => vscode.workspace.fs.delete(connection.uri('/readme.txt'))],
    [
      'rename',
      async () =>
        vscode.workspace.fs.rename(connection.uri('/readme.txt'), connection.uri('/moved.txt')),
    ],
    [
      'createDirectory',
      async () => vscode.workspace.fs.createDirectory(connection.uri('/new-folder')),
    ],
  ];

  for (const [name, call] of refusals) {
    test(`refuses ${name} as NoPermissions`, async () => {
      // NoPermissions is the code that makes VS Code show a read-only editor
      // rather than a failed save, which is the whole point of the flag.
      await assert.rejects(call, (error: unknown) => isFileSystemError(error, 'NoPermissions'));
    });
  }

  test('leaves the file exactly as it was', async () => {
    assert.equal(
      text(await vscode.workspace.fs.readFile(connection.uri('/readme.txt'))),
      'untouched',
    );
  });
});
