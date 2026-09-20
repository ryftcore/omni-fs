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
 * FTP and FTPS (explicit `AUTH TLS` and implicit TLS-on-connect).
 *
 * The defining constraint is the single control channel: one command at a time,
 * per connection. `maxConcurrency: 1` communicates that to the transfer queue,
 * which is why a bulk upload over FTP serialises while the same upload to S3
 * fans out sixteen ways — without either the queue or the UI knowing why.
 *
 * FTP also has no server-side copy, so `ManagedFileSystem` will stream a copy
 * down and back up. That is genuinely what has to happen; declaring it honestly
 * lets the UI warn before a user copies a 2 GB file across a folder.
 */
export const FTP_SETTINGS_SCHEMA: SettingsSchema = {
  fields: [
    { kind: 'text', key: 'host', label: 'Host', required: true, placeholder: 'ftp.example.com' },
    { kind: 'number', key: 'port', label: 'Port', default: 21, min: 1, max: 65535 },
    { kind: 'text', key: 'username', label: 'Username', required: true, placeholder: 'anonymous' },
    {
      kind: 'select',
      key: 'secure',
      label: 'Encryption',
      required: true,
      default: 'explicit',
      options: [
        { value: 'explicit', label: 'FTPS — explicit TLS (AUTH TLS, recommended)' },
        { value: 'implicit', label: 'FTPS — implicit TLS (port 990)' },
        { value: 'none', label: 'Plain FTP — unencrypted' },
      ],
    },
    {
      kind: 'boolean',
      key: 'allowSelfSigned',
      label: 'Allow self-signed certificates',
      default: false,
      help: 'Disables TLS certificate verification. Only for servers you control.',
    },
    {
      kind: 'text',
      key: 'rootPrefix',
      label: 'Root prefix',
      placeholder: 'public_html',
      help: 'Optional. Scopes the connection to a subfolder of the login directory. Begin with / for an absolute server path, e.g. /srv/ftp/shared.',
    },
  ],
};

export const FTP_SECRET_SCHEMA: SettingsSchema = {
  fields: [{ kind: 'password', key: 'password', label: 'Password', required: true }],
};

export const FTP_CAPABILITIES: ProviderCapabilities = {
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
  preservesMTime: false,
  hasVersionTokens: false,
  // One control channel. Do not raise this.
  maxConcurrency: 1,
  listIsPaginated: false,
};

/**
 * TODO(provider-ftp): implement against `basic-ftp`.
 *
 * The shape below is the contract the rest of omni-fs already codes against, so
 * filling these in is self-contained work that cannot ripple outward. Follow
 * `packages/provider-s3` as the reference, and run the shared conformance suite
 * (`pnpm test:conformance`) against a vsftpd container to verify.
 *
 * `rootPrefix` is relative to the login directory; a leading `/` makes it an
 * absolute server path instead. Both forms must work: `public_html` sits
 * under the login directory, `/srv/ftp/shared` does not.
 *
 * Both `readSettings` implementations that exist today — provider-s3 and
 * provider-webdav — strip the leading slash, so do not copy that part. It is
 * right for them: the absolute part of the location already lives in their
 * Bucket or Server URL field, and `rootPrefix` has no absolute form left to
 * express. Here the server's filesystem root is a real, reachable place that
 * no other setting names, so the slash is load-bearing.
 */
class FtpFileSystem implements RemoteFileSystem {
  readonly capabilities = FTP_CAPABILITIES;

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
    message: `FTP provider: ${operation} is not implemented yet.`,
    providerId: 'ftp',
  });
}

export const ftpProvider: ProviderDefinition = {
  id: 'ftp',
  displayName: 'FTP / FTPS',
  schemes: ['ftp', 'ftps'],
  settingsSchema: FTP_SETTINGS_SCHEMA,
  secretSchema: FTP_SECRET_SCHEMA,
  defaultCapabilities: FTP_CAPABILITIES,
  create: (context) => new FtpFileSystem(context),
};
