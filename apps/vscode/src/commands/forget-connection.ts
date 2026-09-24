import * as vscode from 'vscode';
import type {
  ConfigStore,
  ConnectionConfig,
  ConnectionManager,
  EntryCache,
  Logger,
  SecretStore,
} from '@omni-fs/core';
import type { UnmountResult, WorkspaceMounts } from '../workspace/workspace-mounts.js';

export interface ForgetDeps {
  readonly manager: ConnectionManager;
  readonly configStore: ConfigStore;
  readonly secretStore: SecretStore;
  readonly cache: EntryCache;
  readonly mounts: WorkspaceMounts;
  readonly logger: Logger;
}

/**
 * Everything a removed connection leaves behind, once the user has confirmed.
 *
 * Shared by the Remove Connection command and the connection manager's
 * Delete, which had already drifted apart once — the panel's copy never
 * dropped the cached listings.
 *
 * The order is load-bearing. The config goes first, and the connection is
 * closed straight after it: once the config is gone nothing can reconnect,
 * but a connection still open would keep serving the folder — without its
 * read-only flag, which lives in that config. The credentials go before the
 * folder, because removing the workspace's first folder restarts the
 * extension host, and nothing after that call is guaranteed to run. The
 * folder goes last, or it stays in the Explorer, and in a saved workspace
 * file, as a root that no longer resolves.
 */
export async function forgetConnection(
  deps: ForgetDeps,
  config: Pick<ConnectionConfig, 'id' | 'label'>,
): Promise<UnmountResult> {
  await deps.configStore.delete(config.id);
  await deps.manager.disconnect(config.id);
  deps.cache.invalidateConnection(config.id);
  await deps.secretStore.delete(config.id);

  const unmounted = await deps.mounts.unmount(config.id);
  reportUnmount(deps.logger, config.id, unmounted, {
    level: 'warn',
    log: 'Could not remove a deleted connection from the workspace',
    // Names the Explorer's command, because Omni-FS's own Remove from
    // Workspace lists stored connections, and this one is no longer stored.
    show: `Omni-FS: "${config.label}" was removed, but its folder is still in the workspace. Use Remove Folder from Workspace in the Explorer.`,
  });
  return unmounted;
}

/**
 * Says what an unmount that did not simply succeed means, the same way from
 * every command that unmounts.
 *
 * A refusal is logged and shown, at the level the caller gives. An
 * unconfirmed removal is only logged: VS Code reports a workspace file it
 * cannot write itself, and the usual cause is just another remote folder
 * being slow to re-read. The line is for when "disconnected, then it came
 * back" needs explaining.
 */
export function reportUnmount(
  logger: Logger,
  connectionId: string,
  result: UnmountResult,
  refused: { readonly level: 'warn' | 'error'; readonly log: string; readonly show: string },
): void {
  if (result === 'refused') {
    logger.log(refused.level, refused.log, { connectionId });
    if (refused.level === 'error') void vscode.window.showErrorMessage(refused.show);
    else void vscode.window.showWarningMessage(refused.show);
  } else if (result === 'unconfirmed') {
    logger.log('warn', 'VS Code did not confirm removing a connection from the workspace', {
      connectionId,
    });
  }
}
