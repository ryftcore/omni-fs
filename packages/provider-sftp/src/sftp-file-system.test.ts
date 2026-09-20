import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { NOOP_LOGGER, OmniFsError, RemotePath } from '@omni-fs/core';
import type { ConnectionConfig, DirEntry, Logger, LogLevel, ProviderContext } from '@omni-fs/core';
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

/** SFTP status 4, `FAILURE` — the one status whose meaning only a call site knows. */
export function failure(): Error & { code: number } {
  return Object.assign(new Error('Failure'), { code: 4 });
}

export function connectionLost(): Error & { code: number } {
  return Object.assign(new Error('Connection lost'), { code: 7 });
}

interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
}

/**
 * A logger that keeps what it was told, for the one hermetic case about
 * something the provider only *says*: the warning a non-atomic rename owes the
 * user. `NOOP_LOGGER` would let that warning disappear without a failing test.
 */
function capturingLogger(): { logger: Logger; entries: readonly LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger: Logger = {
    log: (level, message) => {
      entries.push({ level, message });
    },
    child: () => logger,
  };
  return { logger, entries };
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

export function context(
  settings: Readonly<Record<string, unknown>> = {},
  logger: Logger = NOOP_LOGGER,
): ProviderContext {
  const config: ConnectionConfig = {
    id: 'test-connection',
    providerId: 'sftp',
    label: 'Test',
    settings: { host: 'sftp.example.com', username: 'omnifs', ...settings },
  };
  return { config, getSecret: async () => ({ password: 'secret' }), logger };
}

/** A connected file system over the given session. */
export async function connected(
  session: SftpConnection,
  settings: Readonly<Record<string, unknown>> = {},
  logger: Logger = NOOP_LOGGER,
): Promise<{ fs: SftpFileSystem; opened: SftpSessionOptions[] }> {
  const opened: SftpSessionOptions[] = [];
  const fs = new SftpFileSystem(context(settings, logger), async (options) => {
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

  it('takes a lone slash as the server filesystem root', async () => {
    const seen: string[] = [];
    const session = fakeSession({
      stat: async (path: string) => {
        seen.push(path);
        return file();
      },
    });
    const { fs } = await connected(session, { rootPrefix: '/' });

    await fs.stat(RemotePath.parse('/a.txt'));
    expect(seen).toEqual(['/a.txt']);
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

  it('does not report a connection that dropped mid-fallback as absent', async () => {
    // `NotFound` is what drives create-on-save in the VS Code host, so a lost
    // socket must not be answered with it.
    const { fs } = await connected(
      fakeSession({
        stat: async () => {
          throw notFound();
        },
        lstat: async () => {
          throw connectionLost();
        },
      }),
    );

    await expect(fs.stat(RemotePath.parse('/a.txt'))).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'ConnectionFailed',
    );
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

  it('keeps listing when a link cannot be followed at all', async () => {
    // Status 4 is what OpenSSH answers for a symlink loop, and it translates to
    // `Unknown` — the everyday case that must not cost the whole directory.
    const { fs } = await connected(
      fakeSession({
        readdir: async () => [
          { filename: 'loop', attrs: link() },
          { filename: 'a.txt', attrs: file() },
        ],
        stat: async () => {
          throw Object.assign(new Error('Failure'), { code: 4 });
        },
      }),
    );

    const entries = await collect(fs.list(RemotePath.parse('/releases')));
    expect(entries.map((entry) => entry.name)).toEqual(['loop', 'a.txt']);
    expect(entries[0]).toMatchObject({ name: 'loop', type: 'symlink' });
  });

  it('refuses an entry whose name is not a single path segment', async () => {
    const { fs } = await connected(
      fakeSession({ readdir: async () => [{ filename: '../../escape', attrs: file() }] }),
    );

    await expect(collect(fs.list(RemotePath.parse('/docs')))).rejects.toSatisfy(
      // Not retryable: a server that sends an unusable name will send it again.
      (error: unknown) =>
        OmniFsError.is(error) && error.code === 'ProtocolError' && !error.retryable,
    );
  });

  it('refuses an entry with no name at all', async () => {
    const { fs } = await connected(
      fakeSession({ readdir: async () => [{ filename: '', attrs: file() }] }),
    );

    await expect(collect(fs.list(RemotePath.parse('/docs')))).rejects.toSatisfy(
      (error: unknown) =>
        OmniFsError.is(error) && error.code === 'ProtocolError' && !error.retryable,
    );
  });

  it('keeps a name containing a backslash, which is a legal POSIX filename', async () => {
    const { fs } = await connected(
      fakeSession({ readdir: async () => [{ filename: 'back\\slash', attrs: file() }] }),
    );

    const entries = await collect(fs.list(RemotePath.parse('/docs')));
    expect(entries[0]?.name).toBe('back\\slash');
    expect(entries[0]?.path.value).toBe('/docs/back\\slash');
  });

  it('gives up on the listing when the follow-up is cancelled', async () => {
    const { fs } = await connected(
      fakeSession({
        readdir: async () => [{ filename: 'current', attrs: link() }],
        stat: async () => {
          throw new OmniFsError({
            code: 'Cancelled',
            message: 'Cancelled: SFTP request',
            providerId: 'sftp',
          });
        },
      }),
    );

    await expect(collect(fs.list(RemotePath.parse('/releases')))).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled',
    );
  });
});

describe('SftpFileSystem reads', () => {
  function readable(body: string): ReadableStream<Uint8Array> {
    return Readable.toWeb(Readable.from([Buffer.from(body)])) as ReadableStream<Uint8Array>;
  }

  it('reads a whole file', async () => {
    const { fs } = await connected(fakeSession({ openReadStream: async () => readable('hello') }));
    expect(new TextDecoder().decode(await fs.readFile(RemotePath.parse('/a.txt')))).toBe('hello');
  });

  it('asks for an inclusive byte range', async () => {
    let range: unknown;
    const { fs } = await connected(
      fakeSession({
        openReadStream: async (_path: string, options: unknown) => {
          range = options;
          return readable('234');
        },
      }),
    );

    await fs.readFile(RemotePath.parse('/ranged.txt'), { offset: 2, length: 3 });
    expect(range).toMatchObject({ start: 2, end: 4 });
  });

  it('answers a zero-length read without opening a stream, after checking the file is there', async () => {
    let opened = 0;
    const { fs } = await connected(
      fakeSession({
        stat: async () => file(10),
        openReadStream: async () => {
          opened += 1;
          return readable('');
        },
      }),
    );

    const bytes = await fs.readFile(RemotePath.parse('/a.txt'), { offset: 5, length: 0 });
    expect(bytes.byteLength).toBe(0);
    expect(opened).toBe(0);
  });

  it('still reports a missing file on a zero-length read', async () => {
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

    await expect(
      fs.readFile(RemotePath.parse('/gone.txt'), { offset: 0, length: 0 }),
    ).rejects.toSatisfy((error: unknown) => OmniFsError.is(error) && error.code === 'NotFound');
  });

  it('translates a failure the stream reports after it was handed over', async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull() {
        throw Object.assign(new Error('No such file'), { code: 2 });
      },
    });
    const { fs } = await connected(fakeSession({ openReadStream: async () => failing }));

    await expect(fs.readFile(RemotePath.parse('/gone.txt'))).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
    );
  });
});

describe('SftpFileSystem writes', () => {
  it('writes a file, truncating by default', async () => {
    const writes: { path: string; flags: string; body: string }[] = [];
    const { fs } = await connected(
      fakeSession({
        writeAll: async (path: string, data: Uint8Array, flags: string) => {
          writes.push({ path, flags, body: new TextDecoder().decode(data) });
        },
      }),
    );

    await fs.writeFile(RemotePath.parse('/a.txt'), new TextEncoder().encode('hello'));
    expect(writes).toEqual([{ path: '/home/omnifs/a.txt', flags: 'w', body: 'hello' }]);
  });

  it('opens exclusively when overwrite is false, so the server does the excluding', async () => {
    const flags: string[] = [];
    const { fs } = await connected(
      fakeSession({
        writeAll: async (_p: string, _d: Uint8Array, mode: string) => void flags.push(mode),
      }),
    );

    await fs.writeFile(RemotePath.parse('/a.txt'), new Uint8Array(), { overwrite: false });
    expect(flags).toEqual(['wx']);
  });

  it('reports an exclusive write that lost the race as AlreadyExists', async () => {
    const { fs } = await connected(
      fakeSession({
        writeAll: async () => {
          throw failure();
        },
      }),
    );

    await expect(
      fs.writeFile(RemotePath.parse('/a.txt'), new Uint8Array(), { overwrite: false }),
    ).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'AlreadyExists',
    );
  });

  it('leaves a truncating write that failed as Unknown, because nothing was excluded', async () => {
    // The other half of the `wx` narrowing, and the half that says the guard is
    // doing work: a plain `w` write already overwrites, so status 4 from one is
    // whatever else status 4 covers and must not be dressed up as
    // `AlreadyExists` — an answer about the one condition this caller said it
    // did not mind.
    const { fs } = await connected(
      fakeSession({
        writeAll: async () => {
          throw failure();
        },
      }),
    );

    await expect(fs.writeFile(RemotePath.parse('/a.txt'), new Uint8Array())).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Unknown',
    );
  });

  it('creates the missing parent chain and writes again', async () => {
    const made: string[] = [];
    let attempts = 0;
    const { fs } = await connected(
      fakeSession({
        mkdir: async (path: string) => void made.push(path),
        writeAll: async () => {
          attempts += 1;
          if (attempts === 1) throw notFound();
        },
      }),
    );

    await fs.writeFile(RemotePath.parse('/deep/nested/a.txt'), new TextEncoder().encode('x'));
    expect(made).toEqual(['/home/omnifs/deep', '/home/omnifs/deep/nested']);
    expect(attempts).toBe(2);
  });

  it('retries once and no more when building the parents did not help', async () => {
    // The second failure is the server saying something other than the parent
    // was wrong; retrying past it would turn a real error into a hang.
    let attempts = 0;
    const { fs } = await connected(
      fakeSession({
        mkdir: async () => undefined,
        writeAll: async () => {
          attempts += 1;
          throw notFound();
        },
      }),
    );

    await expect(fs.writeFile(RemotePath.parse('/deep/a.txt'), new Uint8Array())).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
    );
    expect(attempts).toBe(2);
  });

  it('does not build parents when the caller said not to', async () => {
    const { fs } = await connected(
      fakeSession({
        writeAll: async () => {
          throw notFound();
        },
      }),
    );

    await expect(
      fs.writeFile(RemotePath.parse('/deep/a.txt'), new Uint8Array(), { createParents: false }),
    ).rejects.toSatisfy((error: unknown) => OmniFsError.is(error) && error.code === 'NotFound');
  });

  it('reports progress for a whole-buffer write', async () => {
    const seen: number[] = [];
    const { fs } = await connected(fakeSession({ writeAll: async () => undefined }));

    await fs.writeFile(RemotePath.parse('/a.txt'), new TextEncoder().encode('12345'), {
      onProgress: (transferred) => seen.push(transferred),
    });
    expect(seen).toEqual([5]);
  });

  it('hands back a write stream opened with the right flags', async () => {
    const flags: string[] = [];
    const sink = new WritableStream<Uint8Array>();
    const { fs } = await connected(
      fakeSession({
        openWriteStream: async (_path: string, mode: string) => {
          flags.push(mode);
          return sink;
        },
      }),
    );

    expect(await fs.createWriteStream(RemotePath.parse('/a.txt'))).toBe(sink);
    await fs.createWriteStream(RemotePath.parse('/b.txt'), { overwrite: false });
    expect(flags).toEqual(['w', 'wx']);
  });

  it('builds the parents of a streamed write before the first byte', async () => {
    const made: string[] = [];
    let attempts = 0;
    const { fs } = await connected(
      fakeSession({
        mkdir: async (path: string) => void made.push(path),
        openWriteStream: async () => {
          attempts += 1;
          if (attempts === 1) throw notFound();
          return new WritableStream<Uint8Array>();
        },
      }),
    );

    await fs.createWriteStream(RemotePath.parse('/deep/a.txt'));
    expect(made).toEqual(['/home/omnifs/deep']);
    expect(attempts).toBe(2);
  });
});

describe('SftpFileSystem createDirectory', () => {
  it('creates the whole chain, shallowest first', async () => {
    const made: string[] = [];
    const { fs } = await connected(fakeSession({ mkdir: async (p: string) => void made.push(p) }));

    await fs.createDirectory(RemotePath.parse('/a/b/c'));
    expect(made).toEqual(['/home/omnifs/a', '/home/omnifs/a/b', '/home/omnifs/a/b/c']);
  });

  it('treats an existing directory as nothing to do', async () => {
    const { fs } = await connected(
      fakeSession({
        mkdir: async () => {
          throw failure();
        },
        stat: async () => directory(),
      }),
    );

    await expect(fs.createDirectory(RemotePath.parse('/existing'))).resolves.toBeUndefined();
  });

  it('refuses when a file already occupies the path', async () => {
    const { fs } = await connected(
      fakeSession({
        mkdir: async () => {
          throw failure();
        },
        stat: async () => file(),
      }),
    );

    await expect(fs.createDirectory(RemotePath.parse('/a.txt'))).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'AlreadyExists',
    );
  });
});

describe('SftpFileSystem delete', () => {
  it('unlinks a file', async () => {
    const unlinked: string[] = [];
    const { fs } = await connected(
      fakeSession({
        lstat: async () => file(),
        unlink: async (path: string) => void unlinked.push(path),
      }),
    );

    await fs.delete(RemotePath.parse('/a.txt'));
    expect(unlinked).toEqual(['/home/omnifs/a.txt']);
  });

  it('unlinks a symlink instead of following it, even when it points at a directory', async () => {
    const unlinked: string[] = [];
    const { fs } = await connected(
      fakeSession({
        lstat: async () => link(),
        stat: async () => directory(),
        unlink: async (path: string) => void unlinked.push(path),
      }),
    );

    await fs.delete(RemotePath.parse('/current'));
    expect(unlinked).toEqual(['/home/omnifs/current']);
  });

  it('removes an empty directory', async () => {
    const removed: string[] = [];
    const { fs } = await connected(
      fakeSession({
        lstat: async () => directory(),
        rmdir: async (path: string) => void removed.push(path),
      }),
    );

    await fs.delete(RemotePath.parse('/empty'));
    expect(removed).toEqual(['/home/omnifs/empty']);
  });

  it('refuses to remove a directory that still has children', async () => {
    const { fs } = await connected(
      fakeSession({
        lstat: async () => directory(),
        rmdir: async () => {
          throw failure();
        },
      }),
    );

    await expect(fs.delete(RemotePath.parse('/full'))).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'NotEmpty',
    );
  });

  it('walks a tree depth-first when asked to be recursive', async () => {
    const order: string[] = [];
    const tree: Record<string, { filename: string; attrs: SftpAttrs }[]> = {
      '/home/omnifs/tree': [
        { filename: 'one.txt', attrs: file() },
        { filename: 'nested', attrs: directory() },
      ],
      '/home/omnifs/tree/nested': [{ filename: 'two.txt', attrs: file() }],
    };

    const { fs } = await connected(
      fakeSession({
        lstat: async () => directory(),
        readdir: async (path: string) => tree[path] ?? [],
        unlink: async (path: string) => void order.push(`unlink ${path}`),
        rmdir: async (path: string) => void order.push(`rmdir ${path}`),
      }),
    );

    await fs.delete(RemotePath.parse('/tree'), { recursive: true });
    expect(order).toEqual([
      'unlink /home/omnifs/tree/one.txt',
      'unlink /home/omnifs/tree/nested/two.txt',
      'rmdir /home/omnifs/tree/nested',
      'rmdir /home/omnifs/tree',
    ]);
  });

  it('unlinks a symlink inside a tree rather than deleting what it points at', async () => {
    const order: string[] = [];
    const { fs } = await connected(
      fakeSession({
        lstat: async () => directory(),
        readdir: async (path: string) =>
          path === '/home/omnifs/tree' ? [{ filename: 'current', attrs: link() }] : [],
        stat: async () => directory(),
        unlink: async (path: string) => void order.push(`unlink ${path}`),
        rmdir: async (path: string) => void order.push(`rmdir ${path}`),
      }),
    );

    await fs.delete(RemotePath.parse('/tree'), { recursive: true });
    expect(order).toEqual(['unlink /home/omnifs/tree/current', 'rmdir /home/omnifs/tree']);
  });

  it('removes nothing at all when the server names an entry outside the tree', async () => {
    // `RemotePath.join` resolves `..` upward, so `../../escape` under
    // `/home/omnifs/tree` would land on `/escape` — outside the subtree, with
    // the connection base as the blast radius. The whole listing is refused
    // before anything is removed, which is why `one.txt` survives too.
    const touched: string[] = [];
    const { fs } = await connected(
      fakeSession({
        lstat: async () => directory(),
        readdir: async (path: string) =>
          path === '/home/omnifs/tree'
            ? [
                { filename: 'one.txt', attrs: file() },
                { filename: '../../escape', attrs: file() },
              ]
            : [],
        unlink: async (path: string) => void touched.push(`unlink ${path}`),
        rmdir: async (path: string) => void touched.push(`rmdir ${path}`),
      }),
    );

    await expect(fs.delete(RemotePath.parse('/tree'), { recursive: true })).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'ProtocolError',
    );
    expect(touched).toEqual([]);
  });

  it('removes nothing at all when the server names an entry with no name', async () => {
    // The worse half of the same guard. `RemotePath.join('')` normalises back to
    // the directory itself, so before the refusal an empty entry meant either
    // unlinking the directory being walked or recursing into it without end —
    // and unlike `../../escape` an empty name needs no hostile server, only a
    // length field nobody checked.
    const touched: string[] = [];
    const { fs } = await connected(
      fakeSession({
        lstat: async () => directory(),
        readdir: async (path: string) =>
          path === '/home/omnifs/tree' ? [{ filename: '', attrs: directory() }] : [],
        unlink: async (path: string) => void touched.push(`unlink ${path}`),
        rmdir: async (path: string) => void touched.push(`rmdir ${path}`),
      }),
    );

    await expect(fs.delete(RemotePath.parse('/tree'), { recursive: true })).rejects.toSatisfy(
      (error: unknown) =>
        OmniFsError.is(error) && error.code === 'ProtocolError' && !error.retryable,
    );
    expect(touched).toEqual([]);
  });
});

describe('SftpFileSystem rename', () => {
  it('replaces the destination through the POSIX extension when the server has it', async () => {
    const calls: string[] = [];
    const { fs } = await connected(
      fakeSession(
        { posixRename: async (from: string, to: string) => void calls.push(`${from} -> ${to}`) },
        { posixRename: true, fsync: false, copyData: false },
      ),
    );

    await fs.rename(RemotePath.parse('/before.txt'), RemotePath.parse('/after.txt'));
    expect(calls).toEqual(['/home/omnifs/before.txt -> /home/omnifs/after.txt']);
  });

  it('removes the destination first on a server without the extension, and says so is not atomic', async () => {
    const order: string[] = [];
    let renames = 0;
    const { logger, entries } = capturingLogger();
    const { fs } = await connected(
      fakeSession({
        rename: async (from: string, to: string) => {
          renames += 1;
          if (renames === 1) throw failure();
          order.push(`rename ${from} -> ${to}`);
        },
        unlink: async (path: string) => void order.push(`unlink ${path}`),
      }),
      {},
      logger,
    );

    await fs.rename(RemotePath.parse('/before.txt'), RemotePath.parse('/after.txt'));
    expect(order).toEqual([
      'unlink /home/omnifs/after.txt',
      'rename /home/omnifs/before.txt -> /home/omnifs/after.txt',
    ]);

    // The warning is the whole of "says so": the unlink/rename order is not
    // visible to a caller, so this line is the only notice anyone gets that a
    // reader who looked in between would have found nothing at the destination.
    expect(entries.filter((entry) => entry.level === 'warn')).toEqual([
      {
        level: 'warn',
        message: 'Replacing a rename destination without posix-rename, which is not atomic',
      },
    ]);
  });

  it('reports an occupied destination as AlreadyExists when overwrite is false', async () => {
    const { fs } = await connected(
      fakeSession({
        rename: async () => {
          throw failure();
        },
      }),
    );

    await expect(
      fs.rename(RemotePath.parse('/a.txt'), RemotePath.parse('/b.txt'), { overwrite: false }),
    ).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'AlreadyExists',
    );
  });

  it('never replaces a destination when overwrite is false, even with the extension', async () => {
    let posix = 0;
    const { fs } = await connected(
      fakeSession(
        {
          posixRename: async () => void (posix += 1),
          rename: async () => undefined,
        },
        { posixRename: true, fsync: false, copyData: false },
      ),
    );

    await fs.rename(RemotePath.parse('/a.txt'), RemotePath.parse('/b.txt'), { overwrite: false });
    expect(posix).toBe(0);
  });

  it('reports the original failure when the destination was not in the way after all', async () => {
    // Status 4 also covers EXDEV, EISDIR and EBUSY. Letting the `unlink`'s own
    // status 2 surface would answer `NotFound` about a path the caller never
    // asked about — and `NotFound` is what drives create-on-save in the VS Code
    // host, so a cross-device rename would read as "write this file".
    const { fs } = await connected(
      fakeSession({
        rename: async () => {
          throw Object.assign(new Error('Cross-device link'), { code: 4 });
        },
        unlink: async () => {
          throw notFound();
        },
      }),
    );

    await expect(
      fs.rename(RemotePath.parse('/before.txt'), RemotePath.parse('/after.txt')),
    ).rejects.toSatisfy(
      (error: unknown) =>
        OmniFsError.is(error) &&
        error.code === 'Unknown' &&
        error.message === 'Cross-device link' &&
        error.path === '/before.txt' &&
        // `Unknown` is not retryable, which is the right answer here: an
        // identical cross-device rename will fail identically.
        !error.retryable,
    );
  });

  it('reports the lost connection when the clearing unlink is what the socket killed', async () => {
    // The mirror of the case above, and the reason it cannot simply rethrow the
    // original: status 4 translates to `Unknown`, which core does not retry, so
    // reporting it for a dropped socket would tell `TransferQueue` that a
    // transient failure is permanent and the rename would never be tried again.
    const { fs } = await connected(
      fakeSession({
        rename: async () => {
          throw failure();
        },
        unlink: async () => {
          throw connectionLost();
        },
      }),
    );

    await expect(
      fs.rename(RemotePath.parse('/before.txt'), RemotePath.parse('/after.txt')),
    ).rejects.toSatisfy(
      (error: unknown) =>
        OmniFsError.is(error) && error.code === 'ConnectionFailed' && error.retryable,
    );
  });

  it('says the destination was destroyed when the replacement rename fails', async () => {
    let renames = 0;
    const { fs } = await connected(
      fakeSession({
        rename: async () => {
          renames += 1;
          throw renames === 1
            ? failure()
            : Object.assign(new Error('Permission denied'), { code: 3 });
        },
        unlink: async () => undefined,
      }),
    );

    await expect(
      fs.rename(RemotePath.parse('/before.txt'), RemotePath.parse('/after.txt')),
    ).rejects.toSatisfy(
      (error: unknown) =>
        OmniFsError.is(error) &&
        error.code === 'PermissionDenied' &&
        error.message.includes('/after.txt was removed to make room and has not been replaced'),
    );
  });
});

describe('SftpFileSystem copy', () => {
  it('copies on the server when copy-data is there', async () => {
    const calls: string[] = [];
    const { fs } = await connected(
      fakeSession(
        {
          copyData: async (from: string, to: string, flags: string) =>
            void calls.push(`${from} -> ${to} (${flags})`),
        },
        { posixRename: false, fsync: false, copyData: true },
      ),
    );

    await fs.copy(RemotePath.parse('/source.txt'), RemotePath.parse('/copy.txt'));
    expect(calls).toEqual(['/home/omnifs/source.txt -> /home/omnifs/copy.txt (w)']);
  });

  it('reports an occupied destination as AlreadyExists', async () => {
    const { fs } = await connected(
      fakeSession(
        {
          copyData: async () => {
            throw failure();
          },
        },
        { posixRename: false, fsync: false, copyData: true },
      ),
    );

    await expect(
      fs.copy(RemotePath.parse('/a.txt'), RemotePath.parse('/b.txt'), { overwrite: false }),
    ).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'AlreadyExists',
    );
  });

  it('leaves an overwriting copy that failed as Unknown, because nothing was excluded', async () => {
    // As for `writeFile`: an overwriting copy asked for no exclusion, so status
    // 4 from it is one of the other things status 4 covers and `AlreadyExists`
    // would be an answer about a condition the caller said it did not mind.
    const { fs } = await connected(
      fakeSession(
        {
          copyData: async () => {
            throw failure();
          },
        },
        { posixRename: false, fsync: false, copyData: true },
      ),
    );

    await expect(fs.copy(RemotePath.parse('/a.txt'), RemotePath.parse('/b.txt'))).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Unknown',
    );
  });

  it('passes the session Unsupported through on a server without the extension', async () => {
    const { fs } = await connected(
      fakeSession({
        copyData: async () => {
          throw OmniFsError.unsupported('server-side copy', 'sftp');
        },
      }),
    );

    await expect(fs.copy(RemotePath.parse('/a.txt'), RemotePath.parse('/b.txt'))).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Unsupported',
    );
  });
});
