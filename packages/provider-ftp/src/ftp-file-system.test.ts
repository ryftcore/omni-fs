import { describe, expect, it, vi } from 'vitest';
import { NOOP_LOGGER, OmniFsError, RemotePath } from '@omni-fs/core';
import type { ConnectionConfig, ProviderContext } from '@omni-fs/core';
import { FTP_CAPABILITIES, FtpFileSystem } from './ftp-file-system.js';
import type { FtpChannel } from './ftp-channel.js';
import type { FtpEntry } from './ftp-helpers.js';

interface FakeChannel extends FtpChannel {
  alive: boolean;
  readonly calls: string[];
}

interface FakeChannelOptions {
  readonly hasMlst?: boolean;
  readonly mlst?: (path: string) => Promise<FtpEntry | undefined>;
  readonly list?: (path: string) => Promise<readonly FtpEntry[]>;
}

function entry(name: string, overrides: Partial<FtpEntry> = {}): FtpEntry {
  return { name, type: 'file', size: 0, mtime: undefined, mode: undefined, ...overrides };
}

function fakeChannel(options: FakeChannelOptions = {}): FakeChannel {
  const calls: string[] = [];
  const channel: FakeChannel = {
    alive: true,
    calls,
    hasMlst: options.hasMlst ?? true,
    poisoned: false,
    isAlive: () => channel.alive,
    poison: () => {
      channel.alive = false;
    },
    close: vi.fn(async () => {
      channel.alive = false;
    }),
    pwd: async () => {
      calls.push('pwd');
      return '/home/alice';
    },
    mlst: async (path) => {
      calls.push(`mlst ${path}`);
      return options.mlst === undefined ? undefined : options.mlst(path);
    },
    list: async (path) => {
      calls.push(`list ${path}`);
      return options.list === undefined ? [] : options.list(path);
    },
    mkdir: async (path) => {
      calls.push(`mkdir ${path}`);
    },
    rmdir: async (path) => {
      calls.push(`rmdir ${path}`);
    },
    unlink: async (path) => {
      calls.push(`unlink ${path}`);
    },
    rename: async (from, to) => {
      calls.push(`rename ${from} ${to}`);
    },
    openReadStream: async () => new ReadableStream<Uint8Array>(),
    upload: async (path) => {
      calls.push(`upload ${path}`);
    },
    openWriteStream: async () => new WritableStream<Uint8Array>(),
  };
  return channel;
}

function context(settings: Readonly<Record<string, unknown>> = {}): ProviderContext {
  const config: ConnectionConfig = {
    id: 'test',
    providerId: 'ftp',
    label: 'test',
    settings: { host: 'ftp.example.com', username: 'alice', ...settings },
  };
  return { config, getSecret: async () => ({ password: 'hunter2' }), logger: NOOP_LOGGER };
}

async function connected(
  channel: FtpChannel,
  settings: Readonly<Record<string, unknown>> = {},
): Promise<FtpFileSystem> {
  const fs = new FtpFileSystem(context(settings), async () => channel);
  await fs.connect();
  return fs;
}

describe('FTP_CAPABILITIES', () => {
  it('claims a recursive delete, because the provider does the walk', () => {
    // The shared suite calls delete(dir, { recursive: true }) on the raw
    // provider without gating on the flag, and S3 and SFTP already settled that
    // it means "the provider handles it", not "one server call".
    expect(FTP_CAPABILITIES.canDeleteRecursive).toBe(true);
  });

  it('claims no server-side copy, so core streams one', () => {
    expect(FTP_CAPABILITIES.canCopyServerSide).toBe(false);
  });

  it('claims no version tokens, so the ifMatch cases skip', () => {
    expect(FTP_CAPABILITIES.hasVersionTokens).toBe(false);
  });

  it('assumes one control channel before a connection exists', () => {
    expect(FTP_CAPABILITIES.maxConcurrency).toBe(1);
  });
});

describe('capabilities', () => {
  it('reports the configured pool size once the settings are known', () => {
    const fs = new FtpFileSystem(context({ maxConnections: 4 }), async () => fakeChannel());
    expect(fs.capabilities.maxConcurrency).toBe(4);
  });

  it('follows the pool ceiling down when the server refuses a login', async () => {
    let opened = 0;
    const fs = new FtpFileSystem(context({ maxConnections: 4 }), async () => {
      opened += 1;
      if (opened > 1) throw Object.assign(new Error('421 Too many connections'), { code: 421 });
      return fakeChannel();
    });
    await fs.connect();

    await Promise.all([
      fs.list(RemotePath.ROOT)[Symbol.asyncIterator]().next(),
      fs.list(RemotePath.ROOT)[Symbol.asyncIterator]().next(),
    ]);

    expect(fs.capabilities.maxConcurrency).toBe(1);
  });
});

describe('connect', () => {
  it('resolves the login directory once', async () => {
    const channel = fakeChannel();
    const fs = await connected(channel);
    expect(channel.calls).toContain('pwd');
    expect(fs.isAlive()).toBe(true);
  });

  it('is idempotent while the connection is alive', async () => {
    const open = vi.fn(async () => fakeChannel());
    const fs = new FtpFileSystem(context(), open);
    await fs.connect();
    await fs.connect();
    expect(open).toHaveBeenCalledOnce();
  });

  it('puts an absolute root prefix where it says, not below the login directory', async () => {
    const channel = fakeChannel();
    const fs = await connected(channel, { rootPrefix: '/srv/ftp/shared' });
    await collect(fs.list(RemotePath.ROOT));
    expect(channel.calls).toContain('list /srv/ftp/shared');
  });

  it('puts a relative root prefix below the login directory', async () => {
    const channel = fakeChannel();
    const fs = await connected(channel, { rootPrefix: 'public_html' });
    await collect(fs.list(RemotePath.ROOT));
    expect(channel.calls).toContain('list /home/alice/public_html');
  });

  it('closes the connection when the base cannot be resolved', async () => {
    const channel = fakeChannel();
    channel.pwd = async () => {
      throw Object.assign(new Error('530 Not logged in'), { code: 530 });
    };
    const fs = new FtpFileSystem(context(), async () => channel);
    await expect(fs.connect()).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'AuthenticationFailed',
    );
    expect(fs.isAlive()).toBe(false);
  });
});

describe('stat', () => {
  it('asks MLST first when the server advertised it', async () => {
    const channel = fakeChannel({
      mlst: async () => entry('readme.txt', { type: 'file', size: 18, mtime: 1000 }),
    });
    const fs = await connected(channel);
    const stat = await fs.stat(RemotePath.parse('/readme.txt'));
    expect(stat).toMatchObject({ type: 'file', size: 18, mtime: 1000 });
    expect(channel.calls).toContain('mlst /home/alice/readme.txt');
    expect(channel.calls.some((call) => call.startsWith('list'))).toBe(false);
  });

  it('falls back to listing the parent when the server has no MLST', async () => {
    const channel = fakeChannel({
      hasMlst: false,
      list: async () => [entry('readme.txt', { size: 18 }), entry('other.txt')],
    });
    const fs = await connected(channel);
    expect(await fs.stat(RemotePath.parse('/readme.txt'))).toMatchObject({ size: 18 });
    expect(channel.calls).toContain('list /home/alice');
  });

  it('falls back to listing when MLST answers something it cannot parse', async () => {
    // A slower answer rather than a failed one.
    const channel = fakeChannel({
      mlst: async () => undefined,
      list: async () => [entry('readme.txt', { size: 4 })],
    });
    const fs = await connected(channel);
    expect(await fs.stat(RemotePath.parse('/readme.txt'))).toMatchObject({ size: 4 });
  });

  it('reports a missing path as NotFound from the fallback too', async () => {
    const channel = fakeChannel({ hasMlst: false, list: async () => [entry('other.txt')] });
    const fs = await connected(channel);
    await expect(fs.stat(RemotePath.parse('/missing.txt'))).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
    );
  });

  it('answers for the connection root, which has no parent to list', async () => {
    const channel = fakeChannel({ hasMlst: false });
    const fs = await connected(channel);
    expect(await fs.stat(RemotePath.ROOT)).toMatchObject({ type: 'directory' });
  });

  it('refuses an already-aborted signal as Cancelled', async () => {
    const fs = await connected(fakeChannel());
    const controller = new AbortController();
    controller.abort();
    await expect(fs.stat(RemotePath.parse('/a.txt'), controller.signal)).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled',
    );
  });
});

describe('list', () => {
  it('yields entries under the path it was asked for', async () => {
    const channel = fakeChannel({
      list: async () => [entry('guide.md'), entry('nested', { type: 'directory' })],
    });
    const fs = await connected(channel);
    const entries = await collect(fs.list(RemotePath.parse('/docs')));

    expect(entries.map((e) => e.path.value)).toEqual(['/docs/guide.md', '/docs/nested']);
    expect(entries[1]?.type).toBe('directory');
    expect(channel.calls).toContain('list /home/alice/docs');
  });

  it('releases the channel before the consumer starts iterating', async () => {
    // FTP has no listing cursor, so the array is already in hand. Holding a
    // control channel while a slow consumer iterates would block every other
    // operation for nothing.
    const channel = fakeChannel({ list: async () => [entry('a.txt')] });
    const fs = await connected(channel, { maxConnections: 1 });
    const iterator = fs.list(RemotePath.ROOT)[Symbol.asyncIterator]();
    await iterator.next();

    // If the lease were still held this would deadlock at a ceiling of one.
    await expect(fs.stat(RemotePath.ROOT)).resolves.toBeDefined();
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
