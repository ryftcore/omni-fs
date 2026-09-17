import * as vscode from 'vscode';
import type { TransferQueue, TransferStatus, TransferTask } from '@omni-fs/core';

/**
 * Renders the core transfer queue. Pure presentation — ordering, retry and
 * concurrency all happen in `TransferQueue`, so the desktop app's transfer
 * panel will show the same state from the same source without reimplementing
 * any of it.
 */
export class TransfersTreeProvider implements vscode.TreeDataProvider<TransferTask> {
  readonly #queue: TransferQueue;
  readonly #emitter = new vscode.EventEmitter<void>();

  readonly onDidChangeTreeData = this.#emitter.event;

  constructor(queue: TransferQueue) {
    this.#queue = queue;
    // Coalesce: a busy transfer fires progress far faster than a tree can
    // usefully redraw, and re-rendering per byte chunk is a real slowdown.
    let scheduled = false;
    this.#queue.onDidChange(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        this.#emitter.fire();
      }, 150);
    });
  }

  getTreeItem(task: TransferTask): vscode.TreeItem {
    const item = new vscode.TreeItem(
      task.remotePath.basename,
      vscode.TreeItemCollapsibleState.None,
    );

    item.id = task.id;
    item.description = describe(task);
    item.contextValue = isActive(task.status) ? 'transfer.active' : 'transfer.finished';
    item.iconPath = icon(task);
    item.tooltip = new vscode.MarkdownString(
      [
        `**${task.direction}** \`${task.remotePath.value}\``,
        task.localPath !== undefined ? `Local: \`${task.localPath}\`` : undefined,
        task.error !== undefined ? `⚠️ ${task.error}` : undefined,
        task.attempt > 1 ? `Attempt ${task.attempt}` : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n\n'),
    );

    return item;
  }

  getChildren(element?: TransferTask): TransferTask[] {
    if (element !== undefined) return [];
    // Active work first, then the most recently queued.
    return [...this.#queue.list()].sort((a, b) => {
      const activeDelta = Number(isActive(b.status)) - Number(isActive(a.status));
      return activeDelta !== 0 ? activeDelta : b.queuedAt - a.queuedAt;
    });
  }
}

function isActive(status: TransferStatus): boolean {
  return status === 'running' || status === 'queued' || status === 'retrying';
}

function describe(task: TransferTask): string {
  switch (task.status) {
    case 'running': {
      if (task.totalBytes === undefined || task.totalBytes === 0) {
        return `${formatBytes(task.transferredBytes)} transferred`;
      }
      const percent = Math.round((task.transferredBytes / task.totalBytes) * 100);
      return `${percent}% · ${formatBytes(task.transferredBytes)} / ${formatBytes(task.totalBytes)}`;
    }
    case 'queued':
      return 'Queued';
    case 'retrying':
      return `Retrying (attempt ${task.attempt + 1})`;
    case 'completed':
      return 'Done';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return task.error ?? 'Failed';
  }
}

function icon(task: TransferTask): vscode.ThemeIcon {
  switch (task.status) {
    case 'running':
      return new vscode.ThemeIcon('loading~spin');
    case 'queued':
      return new vscode.ThemeIcon('watch');
    case 'retrying':
      return new vscode.ThemeIcon('debug-restart', new vscode.ThemeColor('charts.yellow'));
    case 'completed':
      return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    case 'cancelled':
      return new vscode.ThemeIcon('circle-slash');
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
