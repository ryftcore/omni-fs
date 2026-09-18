import type {
  ConnectionId,
  ConnectionState,
  OmniFsErrorCode,
  ProviderCapabilities,
  ProviderId,
  ProviderSummary,
  SecretPatchEntry,
} from '@omni-fs/core';

/**
 * PORT. Everything the connection manager needs from a host.
 *
 * The same idea as core's `SecretStore`, `ConfigStore` and `Logger`, one layer
 * up: `apps/vscode` implements it over `postMessage`, `apps/desktop` will
 * implement it over Electron IPC, and the UI above it changes not at all.
 *
 * Every type crossing this interface is plain serializable data. That is not a
 * style preference — in VS Code it travels through `postMessage`, which
 * structured-clones its argument and throws on a function. It is why
 * `ProviderSummary` is used here and `ProviderDefinition` (which carries a
 * `create()` closure) is not.
 */
export interface ConnectionsBackend {
  listProviders(): Promise<readonly ProviderSummary[]>;
  listConnections(): Promise<readonly ConnectionSummary[]>;
  save(input: SaveConnectionInput): Promise<ConnectionId>;
  remove(id: ConnectionId): Promise<void>;
  test(input: TestConnectionInput): Promise<ProbeOutcome>;
  connect(id: ConnectionId): Promise<void>;
  /**
   * Where to open. Lets a host deep-link: VS Code's "Edit Connection" on a
   * tree node opens the panel already showing that connection.
   */
  initialSelection(): Promise<InitialSelection | undefined>;
  /**
   * Opens the host's native file dialog for a `kind: 'file'` field — SFTP's
   * private key path. A sandboxed webview cannot do this itself.
   */
  pickFile(): Promise<string | undefined>;
  onDidChange(listener: () => void): Disposable;
}

export type InitialSelection =
  | { readonly kind: 'connection'; readonly id: ConnectionId }
  | { readonly kind: 'new'; readonly providerId: ProviderId };

export interface ConnectionSummary {
  readonly id: ConnectionId;
  readonly providerId: ProviderId;
  readonly label: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly rootPath: string | undefined;
  readonly readOnly: boolean;
  /** Which secret keys hold a stored value. Never the values themselves. */
  readonly secretFieldsPresent: readonly string[];
  readonly state: ConnectionState;
}

export interface SaveConnectionInput {
  /** `undefined` creates a connection; the host generates the id. */
  readonly id: ConnectionId | undefined;
  readonly providerId: ProviderId;
  readonly label: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly rootPath: string | undefined;
  readonly readOnly: boolean;
  /** Only touched secret fields. Untouched ones keep their stored value. */
  readonly secretPatch: Readonly<Record<string, SecretPatchEntry>>;
}

export type TestConnectionInput = Omit<SaveConnectionInput, 'readOnly'>;

/** The serializable form of core's `ProbeResult`, converted at the boundary. */
export interface ProbeOutcome {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly capabilities?: ProviderCapabilities | undefined;
  readonly error?:
    | { readonly code: OmniFsErrorCode; readonly message: string; readonly retryable: boolean }
    | undefined;
}
