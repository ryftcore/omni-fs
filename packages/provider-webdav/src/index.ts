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
 * WebDAV, including Nextcloud and ownCloud.
 *
 * The one protocol of the four with a native server-side copy (`COPY`) *and*
 * real directories (`MKCOL`), so it needs almost no emulation. It has no
 * ranged-write support, and ETags are real, which makes it the best protocol
 * for exercising the `ifMatch` conflict-detection path.
 */
export const WEBDAV_SETTINGS_SCHEMA: SettingsSchema = {
  fields: [
    {
      kind: 'text',
      key: 'baseUrl',
      label: 'Server URL',
      required: true,
      placeholder: 'https://cloud.example.com/remote.php/dav/files/alice',
    },
    {
      kind: 'select',
      key: 'authType',
      label: 'Authentication',
      required: true,
      default: 'password',
      options: [
        { value: 'password', label: 'Username and password' },
        { value: 'token', label: 'Bearer token' },
        { value: 'none', label: 'None (public share)' },
      ],
    },
    { kind: 'text', key: 'username', label: 'Username' },
    {
      kind: 'text',
      key: 'rootPrefix',
      label: 'Root prefix',
      placeholder: 'Documents',
      help: 'Optional. Scopes the connection to a subfolder of the server URL.',
    },
  ],
};

export const WEBDAV_SECRET_SCHEMA: SettingsSchema = {
  fields: [
    { kind: 'password', key: 'password', label: 'Password / app password' },
    { kind: 'password', key: 'token', label: 'Bearer token' },
  ],
};

export const WEBDAV_CAPABILITIES: ProviderCapabilities = {
  canWrite: true,
  canRename: true,
  canCopyServerSide: true,
  canCreateDirectory: true,
  canDeleteRecursive: true,
  canAppend: false,
  canReadRange: true,
  canStreamWrite: true,
  canWatch: false,
  hasRealDirectories: true,
  preservesMTime: false,
  hasVersionTokens: true,
  maxConcurrency: 6,
  listIsPaginated: false,
};

/**
 * TODO(provider-webdav): implement against the `webdav` package.
 * See `packages/provider-s3` for the reference shape, and verify with the
 * shared conformance suite against a Nextcloud or `sabredav` container.
 */
class WebdavFileSystem implements RemoteFileSystem {
  readonly capabilities = WEBDAV_CAPABILITIES;

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
    message: `WebDAV provider: ${operation} is not implemented yet.`,
    providerId: 'webdav',
  });
}

export const webdavProvider: ProviderDefinition = {
  id: 'webdav',
  displayName: 'WebDAV',
  schemes: ['webdav', 'dav'],
  settingsSchema: WEBDAV_SETTINGS_SCHEMA,
  secretSchema: WEBDAV_SECRET_SCHEMA,
  defaultCapabilities: WEBDAV_CAPABILITIES,
  create: (context) => new WebdavFileSystem(context),
};
