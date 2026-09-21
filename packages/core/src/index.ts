/**
 * @omni-fs/core — the host-agnostic heart of omni-fs.
 *
 * Nothing in this package may import `vscode`, `electron`, or a protocol SDK.
 * That single rule is what lets the VS Code extension (MVP 1) and the desktop
 * app (MVP 2) share everything below the UI. See docs/architecture.md.
 */

// Domain model
export { RemotePath } from './model/path.js';
export type { DirEntry, FileStat, FileType } from './model/stat.js';
export { isDirectory, isFile } from './model/stat.js';
export type {
  ConnectionConfig,
  ConnectionId,
  ConnectionSecret,
  ConnectionState,
  ProviderId,
} from './model/connection.js';

// Errors
export { OmniFsError } from './errors.js';
export type { OmniFsErrorCode, OmniFsErrorOptions } from './errors.js';

// Provider contract
export type {
  DeleteOptions,
  FileChangeEvent,
  FileChangeType,
  OverwriteOptions,
  ProviderContext,
  ProviderDefinition,
  ReadOptions,
  RemoteFileSystem,
  SettingsField,
  SettingsSchema,
  WatchListener,
  WatchOptions,
  WriteOptions,
} from './provider.js';
export type { ProviderCapabilities } from './capabilities.js';
export { MINIMAL_CAPABILITIES } from './capabilities.js';
export { ProviderRegistry } from './registry.js';

// Connection form model, shared by every host's connection editor
export {
  clearSecretField,
  createDraft,
  isDirty,
  setField,
  setLabel,
  setReadOnly,
  setRootPath,
  toProviderSummary,
  toSecretPatch,
} from './forms/draft.js';
export { validateDraft, validateField } from './forms/validation.js';
export { mergeSecret } from './forms/secret-merge.js';
export type {
  ConnectionDraft,
  DraftBaseline,
  DraftSection,
  FieldError,
  ProviderSummary,
  SecretFieldState,
  SecretPatchEntry,
} from './forms/types.js';

// Orchestration
export { ConnectionManager } from './connection/manager.js';
export type {
  ConnectionManagerOptions,
  ConnectionStateChange,
  ProbeResult,
  ProbeTarget,
} from './connection/manager.js';
export { ManagedFileSystem } from './fs/managed-file-system.js';
export type { ManagedFileSystemOptions } from './fs/managed-file-system.js';
export { EntryCache } from './cache/entry-cache.js';
export type { EntryCacheOptions } from './cache/entry-cache.js';
export { TransferQueue } from './transfer/queue.js';
export type { TransferExecutor, TransferQueueOptions } from './transfer/queue.js';
export type {
  TransferDirection,
  TransferRate,
  TransferRequest,
  TransferStatus,
  TransferTask,
} from './transfer/types.js';

// Ports the host must implement
export type { ConfigStore } from './ports/config-store.js';
export { InMemoryConfigStore } from './ports/config-store.js';
export type { Logger, LogLevel } from './ports/logger.js';
export { NOOP_LOGGER } from './ports/logger.js';
export type { SecretStore } from './ports/secret-store.js';
export { InMemorySecretStore } from './ports/secret-store.js';

// Utilities
export { DisposableStore, Emitter } from './util/events.js';
export type { Listener } from './util/events.js';
export { throwIfAborted, withCancellation, withTimeout } from './util/cancellation.js';
export { collectStream, concat, streamFrom } from './util/streams.js';
export { trimLeadingSlashes, trimSlashes, trimTrailingSlashes } from './util/slashes.js';
