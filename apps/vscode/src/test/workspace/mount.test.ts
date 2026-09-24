import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { activateExtension, connectMemory, resetConnections } from '../helpers.js';
import type { TestConnection } from '../helpers.js';

/**
 * A connection opened as a workspace folder, in a real multi-root window.
 *
 * This is the one thing the `hermetic` label cannot do: its window has a
 * single folder, and VS Code refuses to turn that into a workspace under test.
 * Everything here goes through the commands the tree runs, and reads the
 * result off `vscode.workspace` and the in-memory disk behind the connection
 * — whose `isAlive()` is whether the extension holds it open.
 */

const ID = 'omnifs-test-mount';

const node = {
  kind: 'connection',
  config: { id: ID, providerId: ID, label: ID, settings: {} },
};

function omnifsFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'omnifs')
    .map((folder) => folder.uri.toString());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `action`, and fails unless VS Code reports a folder change for it. */
async function expectFolderChange(action: () => Thenable<unknown>): Promise<void> {
  let subscription: vscode.Disposable | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = new Promise<boolean>((resolve) => {
    subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => resolve(true));
    timer = setTimeout(() => resolve(false), 5000);
  });
  await action();
  const reported = await changed;
  subscription?.dispose();
  clearTimeout(timer);
  assert.ok(reported, 'VS Code reported no workspace folder change within 5s');
}

suite('a connection as a workspace folder', () => {
  let connection: TestConnection;

  suiteSetup(async () => {
    const api = await activateExtension();
    await resetConnections();
    connection = await connectMemory({ api, id: ID, seed: { '/readme.txt': 'hello' } });
  });

  suiteTeardown(async () => {
    // Highest index first, one confirmed update at a time: VS Code refuses a
    // second until the first is confirmed.
    for (const folder of [...(vscode.workspace.workspaceFolders ?? [])].reverse()) {
      if (folder.uri.scheme !== 'omnifs') continue;
      await expectFolderChange(async () =>
        vscode.workspace.updateWorkspaceFolders(folder.index, 1),
      );
    }
    await connection?.dispose();
  });

  test('Open as Workspace Folder adds the connection root', async () => {
    await expectFolderChange(async () =>
      assert.equal(
        await vscode.commands.executeCommand('omniFs.mountAsWorkspaceFolder', node),
        'added',
      ),
    );

    assert.deepEqual(omnifsFolders(), [`omnifs://${ID}/`]);
    assert.equal(
      vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === 'omnifs')?.name,
      ID,
    );
  });

  test('opening it again shows the folder instead of adding one or failing', async () => {
    let changes = 0;
    const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => (changes += 1));

    // Before, VS Code refused the duplicate and the command reported an error:
    // the folders were the same, and only the result tells the two apart.
    assert.equal(
      await vscode.commands.executeCommand('omniFs.mountAsWorkspaceFolder', node),
      'already-mounted',
    );
    await delay(500);
    subscription.dispose();

    assert.equal(changes, 0);
    assert.deepEqual(omnifsFolders(), [`omnifs://${ID}/`]);
  });

  test('Disconnect takes the folder out of the workspace and closes the connection', async () => {
    await vscode.workspace.fs.readDirectory(connection.uri('/'));
    assert.equal(connection.disk.isAlive(), true, 'reading the folder should have connected');

    await expectFolderChange(() => vscode.commands.executeCommand('omniFs.disconnect', node));

    // With the folder gone, VS Code has nothing left to read that would
    // connect it again.
    assert.deepEqual(omnifsFolders(), []);
    assert.equal(connection.disk.isAlive(), false);
  });

  test('Remove from Workspace takes the folder out and leaves the connection open', async () => {
    await expectFolderChange(() =>
      vscode.commands.executeCommand('omniFs.mountAsWorkspaceFolder', node),
    );
    await vscode.workspace.fs.readDirectory(connection.uri('/'));
    assert.equal(connection.disk.isAlive(), true);

    await expectFolderChange(() =>
      vscode.commands.executeCommand('omniFs.removeFromWorkspace', node),
    );

    assert.deepEqual(omnifsFolders(), []);
    assert.equal(connection.disk.isAlive(), true);
  });
});
