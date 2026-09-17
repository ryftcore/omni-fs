import type { ConnectionId } from '../model/connection.js';
import type { RemotePath } from '../model/path.js';

export type TransferDirection = 'upload' | 'download' | 'remote-copy' | 'delete';

export type TransferStatus =
  'queued' | 'running' | 'retrying' | 'completed' | 'failed' | 'cancelled';

export interface TransferRequest {
  readonly direction: TransferDirection;
  readonly connectionId: ConnectionId;
  readonly remotePath: RemotePath;
  /** Absolute local path for upload/download. Absent for remote-only work. */
  readonly localPath?: string | undefined;
  readonly totalBytes?: number | undefined;
  /** Higher runs first. Interactive saves should outrank a bulk sync. */
  readonly priority?: number | undefined;
}

export interface TransferTask extends TransferRequest {
  readonly id: string;
  readonly status: TransferStatus;
  readonly transferredBytes: number;
  readonly attempt: number;
  readonly queuedAt: number;
  readonly startedAt?: number | undefined;
  readonly finishedAt?: number | undefined;
  readonly error?: string | undefined;
}

/** Bytes per second over a short window, plus an ETA when total is known. */
export interface TransferRate {
  readonly bytesPerSecond: number;
  readonly etaMs?: number | undefined;
}
