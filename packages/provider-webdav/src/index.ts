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
  WriteOptions,
} from '@omni-fs/core';
import { WEBDAV_SECRET_SCHEMA, WEBDAV_SETTINGS_SCHEMA } from './settings.js';

/**
 * WebDAV, including Nextcloud and ownCloud.
 *
 * The one protocol of the four with a native server-side copy (`COPY`) *and*
 * real directories (`MKCOL`), so it needs almost no emulation. It has no
 * ranged-write support. ETag support is server-dependent — see the
 * `hasVersionTokens` comment below.
 */
export { WEBDAV_SECRET_SCHEMA, WEBDAV_SETTINGS_SCHEMA } from './settings.js';

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
  // Measured against dgraziotin/nginx-webdav-nononsense: an `ETag` header is
  // present on GET/HEAD, but PROPFIND bodies never include a `getetag`
  // property. The `webdav` client derives both `stat()` and `list()` from
  // PROPFIND, so neither can produce a version token against this server —
  // declared false so the conformance suite skips the `ifMatch` path rather
  // than failing it. Real Nextcloud and sabredav do return `getetag`; see
  // task-4-report.md.
  hasVersionTokens: false,
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
