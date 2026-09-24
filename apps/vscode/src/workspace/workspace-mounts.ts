import * as vscode from 'vscode';
import { RemotePath } from '@omni-fs/core';
import type { ConnectionConfig, ConnectionId } from '@omni-fs/core';
import { OMNI_FS_SCHEME, OmniFileSystemProvider } from '../fs/omni-file-system-provider.js';

/** The part of `vscode.workspace` this class uses, so a test can hand in a fake. */
export interface WorkspaceFoldersHost {
  readonly workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined;
  readonly onDidChangeWorkspaceFolders: vscode.Event<vscode.WorkspaceFoldersChangeEvent>;
  updateWorkspaceFolders(
    start: number,
    deleteCount: number | undefined | null,
    ...workspaceFoldersToAdd: { readonly uri: vscode.Uri; readonly name?: string }[]
  ): boolean;
}

export type MountResult = 'added' | 'already-mounted' | 'refused';
/**
 * `unconfirmed`: VS Code accepted the removal but did not report it in time.
 * It may still land — the workbench re-reads every remaining folder first, so
 * another slow remote folder delays it — or it may never: a workspace file VS
 * Code cannot write leaves the folder where it was, with an error of its own.
 */
export type UnmountResult = 'removed' | 'unconfirmed' | 'not-mounted' | 'refused';

/**
 * Which connections are open as workspace folders, and opening or closing them.
 *
 * VS Code owns this state, not Omni-FS: the user can remove a folder from the
 * Explorer, a saved `.code-workspace` brings folders back on the next start,
 * and the extension host itself restarts when the first folder changes. So
 * nothing here is remembered — every answer is read off `workspaceFolders`
 * at the time it is asked, and `onDidChange` says when to ask again.
 *
 * A connection counts as mounted if any folder has its id as the authority,
 * whatever the path: after a `rootPath` edit, the folder opened earlier still
 * belongs to the same connection.
 */
export class WorkspaceMounts implements vscode.Disposable {
  readonly #host: WorkspaceFoldersHost;
  readonly #confirmTimeoutMs: number;
  readonly #emitter = new vscode.EventEmitter<void>();
  readonly #subscription: vscode.Disposable;

  /** Fires after a change that adds or removes a connection's folder, from whichever side. */
  readonly onDidChange = this.#emitter.event;

  constructor(
    host: WorkspaceFoldersHost = vscode.workspace,
    options: { readonly confirmTimeoutMs?: number } = {},
  ) {
    this.#host = host;
    this.#confirmTimeoutMs = options.confirmTimeoutMs ?? 2000;
    // Only changes that involve a connection: adding a local folder must not
    // redraw the tree, which re-lists every expanded folder of every connected
    // connection — on S3, each one a paid LIST.
    this.#subscription = host.onDidChangeWorkspaceFolders((event) => {
      if (
        [...event.added, ...event.removed].some((folder) => folder.uri.scheme === OMNI_FS_SCHEME)
      ) {
        this.#emitter.fire();
      }
    });
  }

  /** The folder URI `mount` opens for this connection. */
  rootUri(config: ConnectionConfig): vscode.Uri {
    return OmniFileSystemProvider.toUri(config.id, RemotePath.parse(config.rootPath ?? '/'));
  }

  /** This connection's folders, in workspace order. */
  foldersOf(connectionId: ConnectionId): vscode.WorkspaceFolder[] {
    return (this.#host.workspaceFolders ?? []).filter((folder) =>
      belongsTo(folder.uri, connectionId),
    );
  }

  isMounted(connectionId: ConnectionId): boolean {
    return this.foldersOf(connectionId).length > 0;
  }

  /**
   * Appends the connection's root as a workspace folder, unless it already
   * has one.
   *
   * Appended, so that an existing first folder stays first: VS Code restarts
   * every extension host when the first folder changes, dropping every live
   * connection and queued transfer. When nothing comes before the new folder
   * — an empty window, a single-folder one, or a workspace whose folders have
   * all been removed — it restarts them anyway, so nothing worth keeping may
   * run after this call returns.
   */
  async mount(config: ConnectionConfig): Promise<MountResult> {
    // VS Code refuses a duplicate folder itself, but only by returning false,
    // which is indistinguishable from any other refusal.
    if (this.isMounted(config.id)) return 'already-mounted';

    const uri = this.rootUri(config);
    const confirmed = this.#update(
      [uri],
      (event) => event.added,
      () =>
        this.#host.updateWorkspaceFolders(this.#host.workspaceFolders?.length ?? 0, 0, {
          uri,
          name: config.label,
        }),
    );
    if (confirmed === undefined) return 'refused';
    // Not whether it was confirmed: VS Code stats a folder before adding it,
    // so a slow server alone outlasts the wait, and the folder still arrives.
    await confirmed;
    return 'added';
  }

  /**
   * Removes every folder of this connection, and resolves once VS Code has
   * confirmed it or the wait has timed out.
   *
   * The folders are usually a single entry. There are several only in a
   * workspace this version did not write — one saved by 0.1.3 or earlier,
   * which added a second folder when a connection was reopened after a
   * `rootPath` edit, or one edited by hand — and they need not be adjacent.
   * Each adjacent run is removed with a call of its own, highest first, so a
   * run at index 0, whose removal restarts the extension host, comes last.
   * Nothing is ever re-added in between: VS Code stats every folder it adds,
   * which would connect another connection just to remove this one.
   *
   * One call at a time, because VS Code refuses an update while the previous
   * one is unconfirmed; so a run whose confirmation timed out usually makes
   * the next one `refused`. And the folders are read again before each call,
   * because the user can change them during the wait, and an index read
   * before it could then name somebody else's folder.
   */
  async unmount(connectionId: ConnectionId): Promise<UnmountResult> {
    const runs = this.#runsOf(connectionId).length;
    if (runs === 0) return 'not-mounted';

    let result: UnmountResult = 'removed';
    // Bounded by the runs there were: a folder of this connection that
    // appears meanwhile was not asked to be removed.
    for (let removed = 0; removed < runs; removed += 1) {
      const folders = this.#host.workspaceFolders ?? [];
      const run = this.#runsOf(connectionId).at(-1);
      if (run === undefined) break;

      const uris = folders.slice(run.start, run.start + run.count).map((folder) => folder.uri);
      const confirmed = this.#update(
        uris,
        (event) => event.removed,
        () => this.#host.updateWorkspaceFolders(run.start, run.count),
      );
      if (confirmed === undefined) return 'refused';
      if (!(await confirmed)) result = 'unconfirmed';
    }
    return result;
  }

  dispose(): void {
    this.#subscription.dispose();
    this.#emitter.dispose();
  }

  /** This connection's folders, as runs of adjacent indices. */
  #runsOf(connectionId: ConnectionId): { start: number; count: number }[] {
    return adjacentRuns(
      (this.#host.workspaceFolders ?? []).flatMap((folder, index) =>
        belongsTo(folder.uri, connectionId) ? [index] : [],
      ),
    );
  }

  /**
   * Requests an update, and returns whether VS Code reported it — or
   * `undefined` when it refused the request outright.
   *
   * Reported means a folder change that names every one of `uris` on the
   * side `pick` reads. Any change would not do: a folder the user adds
   * during the wait would count as this removal, and the next request would
   * be sent while this one is still pending, which VS Code refuses.
   *
   * Subscribed before the update is requested, so a host that reports
   * synchronously is not missed. Bounded, because nothing guarantees the
   * report: a workspace file VS Code cannot write fails with its own error
   * and no event, and a window that has to enter a new workspace restarts
   * the extension host instead.
   */
  #update(
    uris: readonly vscode.Uri[],
    pick: (event: vscode.WorkspaceFoldersChangeEvent) => readonly vscode.WorkspaceFolder[],
    request: () => boolean,
  ): Promise<boolean> | undefined {
    // `toString()` is how VS Code itself compares folders; it lowercases the
    // authority, which the folders it reports back may already have.
    const expected = new Set(uris.map((uri) => uri.toString()));
    let settle = (_confirmed: boolean): void => {};
    const done = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => settle(false), this.#confirmTimeoutMs);
      const subscription = this.#host.onDidChangeWorkspaceFolders((event) => {
        const reported = new Set(pick(event).map((folder) => folder.uri.toString()));
        if ([...expected].every((uri) => reported.has(uri))) settle(true);
      });
      settle = (confirmed) => {
        clearTimeout(timer);
        subscription.dispose();
        resolve(confirmed);
      };
    });

    try {
      if (request()) return done;
    } catch (error) {
      settle(false);
      throw error;
    }
    settle(false);
    return undefined;
  }
}

/** Ascending indices grouped into runs of adjacent ones. */
function adjacentRuns(indices: readonly number[]): { start: number; count: number }[] {
  const runs: { start: number; count: number }[] = [];
  for (const index of indices) {
    const last = runs.at(-1);
    if (last !== undefined && last.start + last.count === index) last.count += 1;
    else runs.push({ start: index, count: 1 });
  }
  return runs;
}

/**
 * Whether a folder URI is one of this connection's.
 *
 * The authority is compared without case. VS Code writes workspace folders
 * to disk through `Uri.toString()`, which lowercases the authority, so a
 * folder read back from a workspace file can differ in case from the id it
 * was opened with.
 */
function belongsTo(uri: vscode.Uri, connectionId: ConnectionId): boolean {
  return (
    uri.scheme === OMNI_FS_SCHEME && uri.authority.toLowerCase() === connectionId.toLowerCase()
  );
}
