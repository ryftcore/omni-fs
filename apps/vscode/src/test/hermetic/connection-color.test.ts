import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { CONNECTION_COLOR_PRESETS, InMemoryConfigStore } from '@omni-fs/core';
import { ConnectionDecorationProvider } from '../../views/connection-decorations.js';
import { EXTENSION_ID } from '../helpers.js';

interface ContributedColor {
  readonly id: string;
  readonly defaults: { readonly light: string; readonly dark: string };
}

suite('connection colours in the manifest', () => {
  test('contributes one theme colour per core preset, with the same light and dark values', () => {
    // VS Code can only tint a tree label or an editor tab with a theme colour
    // id, so the palette has to exist twice: as data in core and as static
    // JSON in the manifest. This is what keeps the two from drifting.
    const manifest = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as {
      contributes: { colors: readonly ContributedColor[] };
    };
    const contributed = new Map(manifest.contributes.colors.map((color) => [color.id, color]));

    for (const preset of CONNECTION_COLOR_PRESETS) {
      const color = contributed.get(`omniFs.connectionColor.${preset.id}`);
      assert.ok(color, `no contributed colour for preset ${preset.id}`);
      assert.equal(color.defaults.light.toLowerCase(), preset.light);
      assert.equal(color.defaults.dark.toLowerCase(), preset.dark);
    }
  });
});

suite('ConnectionDecorationProvider', () => {
  let configStore: InMemoryConfigStore;
  let decorations: ConnectionDecorationProvider;

  const uri = (connectionId: string, path = '/a.txt'): vscode.Uri =>
    vscode.Uri.from({ scheme: 'omnifs', authority: connectionId, path });

  async function colorOf(target: vscode.Uri): Promise<string | undefined> {
    const decoration = await decorations.provideFileDecoration(target);
    return decoration?.color?.id;
  }

  setup(async () => {
    configStore = new InMemoryConfigStore();
    await configStore.save({
      id: 'prod',
      providerId: 'x',
      label: 'prod',
      settings: {},
      color: 'red',
    });
    await configStore.save({
      id: 'custom',
      providerId: 'x',
      label: 'c',
      settings: {},
      color: '#ff1010',
    });
    await configStore.save({ id: 'plain', providerId: 'x', label: 'plain', settings: {} });
    decorations = new ConnectionDecorationProvider(configStore);
  });

  teardown(() => decorations.dispose());

  test('tints every file of a tagged connection with its preset theme colour', async () => {
    assert.equal(await colorOf(uri('prod')), 'omniFs.connectionColor.red');
    assert.equal(await colorOf(uri('prod', '/')), 'omniFs.connectionColor.red');
    assert.equal(await colorOf(uri('prod', '/deep/er/file.txt')), 'omniFs.connectionColor.red');
  });

  test('shows a custom colour as its closest preset', async () => {
    assert.equal(await colorOf(uri('custom')), 'omniFs.connectionColor.red');
  });

  test('leaves untagged connections, unknown ones and other schemes alone', async () => {
    assert.equal(await colorOf(uri('plain')), undefined);
    assert.equal(await colorOf(uri('missing')), undefined);
    assert.equal(await colorOf(vscode.Uri.file('/tmp/a.txt')), undefined);
  });

  test('follows a colour change and tells VS Code to redraw', async () => {
    let redraws = 0;
    const subscription = decorations.onDidChangeFileDecorations(() => (redraws += 1));

    await configStore.save({
      id: 'prod',
      providerId: 'x',
      label: 'prod',
      settings: {},
      color: 'blue',
    });

    assert.ok(redraws > 0);
    assert.equal(await colorOf(uri('prod')), 'omniFs.connectionColor.blue');
    subscription.dispose();
  });
});
