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
 * The stored config and credentials go first. Removing the workspace's first
 * folder restarts the extension host, and nothing after that call is
 * guaranteed to run; a removal the user confirmed must not be the part that
 * is lost. The folder goes next, or it stays in the Explorer — and in a saved
 * workspace file — as a root that no longer resolves.
 */
export async function forgetConnection(
  deps: ForgetDeps,
  config: Pick<ConnectionConfig, 'id' | 'label'>,
): Promise<UnmountResult> {
  await deps.configStore.delete(config.id);
  await deps.secretStore.delete(config.id);
  const unmounted = await deps.mounts.unmount(config.id);
  await deps.manager.disconnect(config.id);
  deps.cache.invalidateConnection(config.id);

  if (unmounted === 'refused') {
    deps.logger.log('warn', 'Could not remove a deleted connection from the workspace', {
      connectionId: config.id,
    });
    // Named, because Omni-FS's own Remove from Workspace lists stored
    // connections, and this one is no longer stored.
    void vscode.window.showWarningMessage(
      `Omni-FS: "${config.label}" was removed, but its folder is still in the workspace. Use Remove Folder from Workspace in the Explorer.`,
    );
  } else if (unmounted === 'unconfirmed') {
    logUnconfirmed(deps.logger, config.id);
  }
  return unmounted;
}

/**
 * No popup: VS Code reports a workspace file it cannot write itself, and the
 * usual cause is only another remote folder being slow to re-read. The line
 * is for when "disconnected, then it came back" needs explaining.
 */
export function logUnconfirmed(logger: Logger, connectionId: string): void {
  logger.log('warn', 'VS Code did not confirm removing a connection from the workspace', {
    connectionId,
  });
}
