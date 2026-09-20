import { OmniFsError } from '@omni-fs/core';
import type {
  DeleteOptions,
  DirEntry,
  FileStat,
  ProviderCapabilities,
  ProviderContext,
  ProviderDefinition,
  ReadOptions,
  RemoteFileSystem,
  RemotePath,
  SettingsSchema,
  WriteOptions,
} from '@omni-fs/core';

/**
 * SFTP over SSH.
 *
 * The closest of the four to a real POSIX filesystem: real directories, real
 * rename, real permission bits. It is the provider where the fewest emulations
 * kick in, and therefore the useful control case when a bug might be in
 * `ManagedFileSystem` rather than in a protocol.
 *
 * Auth is either a password or a private key; the key's passphrase is a secret
 * too, which is why both live behind the `SecretStore` port rather than in the
 * connection settings.
 */
export const SFTP_SETTINGS_SCHEMA: SettingsSchema = {
  fields: [
    { kind: 'text', key: 'host', label: 'Host', required: true, placeholder: 'sftp.example.com' },
    { kind: 'number', key: 'port', label: 'Port', default: 22, min: 1, max: 65535 },
    { kind: 'text', key: 'username', label: 'Username', required: true },
    {
      kind: 'select',
      key: 'authMethod',
      label: 'Authentication',
      required: true,
      default: 'password',
      options: [
        { value: 'password', label: 'Password' },
        { value: 'privateKey', label: 'Private key' },
        { value: 'agent', label: 'SSH agent' },
      ],
    },
    {
      kind: 'file',
      key: 'privateKeyPath',
      label: 'Private key file',
      help: 'Used when authentication is set to Private key. e.g. ~/.ssh/id_ed25519',
    },
    {
      kind: 'text',
      key: 'rootPrefix',
      label: 'Root prefix',
      placeholder: '/var/www',
      help: 'Optional. Scopes the connection to a subfolder of the login directory. Begin with / for an absolute server path, e.g. /var/www.',
    },
  ],
};

export const SFTP_SECRET_SCHEMA: SettingsSchema = {
  fields: [
    { kind: 'password', key: 'password', label: 'Password', help: 'For password authentication.' },
    {
      kind: 'password',
      key: 'passphrase',
      label: 'Key passphrase',
      help: 'For an encrypted private key.',
    },
  ],
};

export const SFTP_CAPABILITIES: ProviderCapabilities = {
  canWrite: true,
  canRename: true,
  canCopyServerSide: false,
  canCreateDirectory: true,
  canDeleteRecursive: false,
  canAppend: true,
  canReadRange: true,
  canStreamWrite: true,
  canWatch: false,
  hasRealDirectories: true,
  preservesMTime: true,
  hasVersionTokens: false,
  // A single SSH connection multiplexes channels comfortably.
  maxConcurrency: 4,
  listIsPaginated: false,
};

/**
 * TODO(provider-sftp): implement against `ssh2-sftp-client`.
 * See `packages/provider-s3` for the reference shape, and verify with the
 * shared conformance suite against an openssh-server container.
 *
 * `rootPrefix` is relative to the login directory; a leading `/` makes it an
 * absolute server path instead. Both forms must work: `projects` sits under
 * the login directory, `/var/www` does not — and on SFTP the absolute form is
 * the common one, which is why the placeholder shows it.
 *
 * Both `readSettings` implementations that exist today — provider-s3 and
 * provider-webdav — strip the leading slash, so do not copy that part. It is
 * right for them: the absolute part of the location already lives in their
 * Bucket or Server URL field, and `rootPrefix` has no absolute form left to
 * express. Here the server's filesystem root is a real, reachable place that
 * no other setting names, so the slash is load-bearing.
 */
class SftpFileSystem implements RemoteFileSystem {
  readonly capabilities = SFTP_CAPABILITIES;

  constructor(private readonly context: ProviderContext) {}

  async connect(): Promise<void> {
    throw notImplemented('connect');
  }

  isAlive(): boolean {
    return false;
  }

  async stat(_path: RemotePath): Promise<FileStat> {
    throw notImplemented('stat');
  }

  // eslint-disable-next-line require-yield
  async *list(_path: RemotePath): AsyncIterable<DirEntry> {
    throw notImplemented('list');
  }

  async readFile(_path: RemotePath, _options?: ReadOptions): Promise<Uint8Array> {
    throw notImplemented('readFile');
  }

  async createReadStream(
    _path: RemotePath,
    _options?: ReadOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    throw notImplemented('createReadStream');
  }

  async writeFile(_path: RemotePath, _data: Uint8Array, _options?: WriteOptions): Promise<void> {
    throw notImplemented('writeFile');
  }

  async delete(_path: RemotePath, _options?: DeleteOptions): Promise<void> {
    throw notImplemented('delete');
  }

  async [Symbol.asyncDispose](): Promise<void> {
    void this.context;
  }
}

function notImplemented(operation: string): OmniFsError {
  return new OmniFsError({
    code: 'Unsupported',
    message: `SFTP provider: ${operation} is not implemented yet.`,
    providerId: 'sftp',
  });
}

export const sftpProvider: ProviderDefinition = {
  id: 'sftp',
  displayName: 'SFTP (SSH)',
  schemes: ['sftp'],
  settingsSchema: SFTP_SETTINGS_SCHEMA,
  secretSchema: SFTP_SECRET_SCHEMA,
  defaultCapabilities: SFTP_CAPABILITIES,
  create: (context) => new SftpFileSystem(context),
};
