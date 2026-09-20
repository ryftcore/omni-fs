import { describe, expect, it } from 'vitest';
import { NOOP_LOGGER, OmniFsError, RemotePath } from '@omni-fs/core';
import type { ConnectionConfig, DirEntry, ProviderContext } from '@omni-fs/core';
import { SftpFileSystem } from './sftp-file-system.js';
import type {
  SftpAttrs,
  SftpConnection,
  SftpExtensions,
  SftpSessionOptions,
} from './sftp-session.js';

export const NO_EXTENSIONS: SftpExtensions = {
  posixRename: false,
  fsync: false,
  copyData: false,
};

export function file(size = 4, mtime = 1_700_000_000): SftpAttrs {
  return { mode: 0o100644, size, mtime, uid: 1000, gid: 1000 };
}

export function directory(): SftpAttrs {
  return { mode: 0o040755, size: 4096, mtime: 1_700_000_000, uid: 1000, gid: 1000 };
}

export function link(): SftpAttrs {
  return { mode: 0o120777, size: 7, mtime: 1_700_000_000, uid: 1000, gid: 1000 };
}

export function notFound(): Error & { code: number } {
  return Object.assign(new Error('No such file'), { code: 2 });
}

/** A session whose behaviour each test supplies; anything unset throws. */
export function fakeSession(
  over: Partial<SftpConnection>,
  extensions: SftpExtensions = NO_EXTENSIONS,
): SftpConnection {
  const missing = (name: string) => async (): Promise<never> => {
    throw new Error(`fake session: ${name} was not expected to be called`);
  };

  return {
    extensions,
    isAlive: () => true,
    close: async () => undefined,
    realpath: async () => '/home/omnifs',
    stat: missing('stat'),
    lstat: missing('lstat'),
    readdir: missing('readdir'),
    mkdir: missing('mkdir'),
    rmdir: missing('rmdir'),
    unlink: missing('unlink'),
    rename: missing('rename'),
    posixRename: missing('posixRename'),
    writeAll: missing('writeAll'),
    copyData: missing('copyData'),
    openReadStream: missing('openReadStream'),
    openWriteStream: missing('openWriteStream'),
    ...over,
  } as SftpConnection;
}

export function context(settings: Readonly<Record<string, unknown>> = {}): ProviderContext {
  const config: ConnectionConfig = {
    id: 'test-connection',
    providerId: 'sftp',
    label: 'Test',
    settings: { host: 'sftp.example.com', username: 'omnifs', ...settings },
  };
  return { config, getSecret: async () => ({ password: 'secret' }), logger: NOOP_LOGGER };
}

/** A connected file system over the given session. */
export async function connected(
  session: SftpConnection,
  settings: Readonly<Record<string, unknown>> = {},
): Promise<{ fs: SftpFileSystem; opened: SftpSessionOptions[] }> {
  const opened: SftpSessionOptions[] = [];
  const fs = new SftpFileSystem(context(settings), async (options) => {
    opened.push(options);
    return session;
  });
  await fs.connect();
  return { fs, opened };
}

export async function collect(entries: AsyncIterable<DirEntry>): Promise<DirEntry[]> {
  const out: DirEntry[] = [];
  for await (const entry of entries) out.push(entry);
  return out;
}

describe('SftpFileSystem connect', () => {
  it('is not alive before it connects', () => {
    const fs = new SftpFileSystem(context(), async () => fakeSession({}));
    expect(fs.isAlive()).toBe(false);
  });

  it('passes the resolved secret to the session', async () => {
    const { opened } = await connected(fakeSession({}));
    expect(opened).toHaveLength(1);
    expect(opened[0]?.secret).toEqual({ password: 'secret' });
  });

  it('roots an empty prefix at the login directory', async () => {
    const seen: string[] = [];
    const session = fakeSession({
      realpath: async () => '/home/omnifs',
      stat: async (path: string) => {
        seen.push(path);
        return file();
      },
    });
    const { fs } = await connected(session);

    await fs.stat(RemotePath.parse('/docs/a.txt'));
    expect(seen).toEqual(['/home/omnifs/docs/a.txt']);
  });

  it('takes an absolute root prefix as the server path', async () => {
    const seen: string[] = [];
    const session = fakeSession({
      stat: async (path: string) => {
        seen.push(path);
        return file();
      },
    });
    const { fs } = await connected(session, { rootPrefix: '/var/www' });

    await fs.stat(RemotePath.parse('/a.txt'));
    expect(seen).toEqual(['/var/www/a.txt']);
  });

  it('puts a relative root prefix below the login directory', async () => {
    const seen: string[] = [];
    const session = fakeSession({
      stat: async (path: string) => {
        seen.push(path);
        return file();
      },
    });
    const { fs } = await connected(session, { rootPrefix: 'projects' });

    await fs.stat(RemotePath.parse('/a.txt'));
    expect(seen).toEqual(['/home/omnifs/projects/a.txt']);
  });

  it('does not reconnect while the session is alive', async () => {
    const { fs, opened } = await connected(fakeSession({}));
    await fs.connect();
    expect(opened).toHaveLength(1);
  });

  it('lets go of a dead session before it opens another', async () => {
    let alive = true;
    let closed = 0;
    const dead = fakeSession({
      isAlive: () => alive,
      close: async () => {
        closed += 1;
      },
    });
    const replacement = fakeSession({});
    const queue: SftpConnection[] = [dead, replacement];
    const opened: SftpSessionOptions[] = [];
    const fs = new SftpFileSystem(context(), async (options) => {
      opened.push(options);
      return queue.shift() ?? replacement;
    });

    await fs.connect();
    alive = false;
    await fs.connect();

    expect(closed).toBe(1);
    expect(opened).toHaveLength(2);
    expect(fs.isAlive()).toBe(true);
  });
});

describe('SftpFileSystem capabilities', () => {
  it('declares recursive delete and no mtime preservation', () => {
    const fs = new SftpFileSystem(context(), async () => fakeSession({}));
    expect(fs.capabilities.canDeleteRecursive).toBe(true);
    expect(fs.capabilities.preservesMTime).toBe(false);
    expect(fs.capabilities.hasVersionTokens).toBe(false);
  });

  it('promises no server-side copy before a server has been asked', () => {
    const fs = new SftpFileSystem(context(), async () => fakeSession({}));
    expect(fs.capabilities.canCopyServerSide).toBe(false);
  });

  it('reports server-side copy once a server announces copy-data', async () => {
    const { fs } = await connected(fakeSession({}, { ...NO_EXTENSIONS, copyData: true }));
    expect(fs.capabilities.canCopyServerSide).toBe(true);
  });

  it('keeps promising nothing on a server without the extension', async () => {
    const { fs } = await connected(fakeSession({}));
    expect(fs.capabilities.canCopyServerSide).toBe(false);
  });
});

describe('SftpFileSystem stat', () => {
  it('maps type, size and modification time', async () => {
    const { fs } = await connected(fakeSession({ stat: async () => file(12) }));
    const stat = await fs.stat(RemotePath.parse('/a.txt'));
    expect(stat).toMatchObject({ type: 'file', size: 12, mtime: 1_700_000_000_000 });
  });

  it('translates a missing path into NotFound', async () => {
    const { fs } = await connected(
      fakeSession({
        stat: async () => {
          throw notFound();
        },
        lstat: async () => {
          throw notFound();
        },
      }),
    );

    await expect(fs.stat(RemotePath.parse('/gone.txt'))).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
    );
  });

  it('reports a dangling symlink as a symlink rather than as absent', async () => {
    const { fs } = await connected(
      fakeSession({
        stat: async () => {
          throw notFound();
        },
        lstat: async () => link(),
      }),
    );

    expect((await fs.stat(RemotePath.parse('/broken'))).type).toBe('symlink');
  });
});

describe('SftpFileSystem list', () => {
  it('yields children with absolute, resolvable paths', async () => {
    const { fs } = await connected(
      fakeSession({
        readdir: async () => [{ filename: 'a.txt', attrs: file() }],
      }),
    );

    const entries = await collect(fs.list(RemotePath.parse('/docs')));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('a.txt');
    expect(entries[0]?.path.value).toBe('/docs/a.txt');
  });

  it('drops the dot entries OpenSSH includes in a listing', async () => {
    const { fs } = await connected(
      fakeSession({
        readdir: async () => [
          { filename: '.', attrs: directory() },
          { filename: '..', attrs: directory() },
          { filename: 'deep', attrs: directory() },
        ],
      }),
    );

    const entries = await collect(fs.list(RemotePath.parse('/shallow')));
    expect(entries.map((entry) => entry.name)).toEqual(['deep']);
  });

  it('resolves a symlink to the type of its target', async () => {
    const { fs } = await connected(
      fakeSession({
        readdir: async () => [{ filename: 'current', attrs: link() }],
        stat: async () => directory(),
      }),
    );

    const entries = await collect(fs.list(RemotePath.parse('/releases')));
    expect(entries[0]).toMatchObject({ name: 'current', type: 'directory' });
  });

  it('leaves a link whose target is gone as a symlink', async () => {
    const { fs } = await connected(
      fakeSession({
        readdir: async () => [{ filename: 'broken', attrs: link() }],
        stat: async () => {
          throw notFound();
        },
      }),
    );

    const entries = await collect(fs.list(RemotePath.parse('/releases')));
    expect(entries[0]).toMatchObject({ name: 'broken', type: 'symlink' });
  });
});
