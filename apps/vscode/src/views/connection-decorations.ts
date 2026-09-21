import * as vscode from 'vscode';
import { parseConnectionColor } from '@omni-fs/core';
import type { ConfigStore, ConnectionColor, ConnectionId } from '@omni-fs/core';
import { OMNI_FS_SCHEME } from '../fs/omni-file-system-provider.js';

/**
 * Tints every `omnifs://` resource with its connection's colour: the
 * connection node and its entries in our tree, the Explorer, and — the one
 * that matters most — the editor tab of a file already open, where a red
 * production connection has to stay obvious after the tree is out of view.
 *
 * VS Code paints decorations with theme colour ids only, so a preset maps to
 * its contributed `omniFs.connectionColor.<id>` and a custom hex to the
 * closest preset's. The exact custom colour shows in the connection manager.
 */
export class ConnectionDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  readonly #configStore: ConfigStore;
  readonly #emitter = new vscode.EventEmitter<undefined>();
  readonly #subscription: Disposable;
  #colors: Promise<ReadonlyMap<ConnectionId, ConnectionColor>>;

  readonly onDidChangeFileDecorations = this.#emitter.event;

  constructor(configStore: ConfigStore) {
    this.#configStore = configStore;
    this.#colors = this.#load();
    this.#subscription = configStore.onDidChange(() => {
      this.#colors = this.#load();
      // `undefined` redraws every resource: a colour change touches all of a
      // connection's files, and there is no list of which ones VS Code shows.
      this.#emitter.fire(undefined);
    });
  }

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    if (uri.scheme !== OMNI_FS_SCHEME) return undefined;
    const color = (await this.#colors).get(uri.authority);
    if (color === undefined) return undefined;
    return new vscode.FileDecoration(undefined, undefined, themeColorFor(color));
  }

  dispose(): void {
    this.#subscription[Symbol.dispose]();
    this.#emitter.dispose();
  }

  async #load(): Promise<ReadonlyMap<ConnectionId, ConnectionColor>> {
    // A decoration is cosmetic: a store that cannot be read costs the tint,
    // never a rejected promise VS Code would log on every file it draws.
    const configs = await this.#configStore.list().catch(() => []);
    const colors = new Map<ConnectionId, ConnectionColor>();
    for (const config of configs) {
      const color = parseConnectionColor(config.color);
      if (color !== undefined) colors.set(config.id, color);
    }
    return colors;
  }
}

/** The contributed theme colour for a connection colour; see `contributes.colors`. */
function themeColorFor(color: ConnectionColor): vscode.ThemeColor {
  return new vscode.ThemeColor(`omniFs.connectionColor.${color.preset.id}`);
}
