import { describe, expect, it, vi } from 'vitest';
import { NOOP_LOGGER, OmniFsError, RemotePath, collectStream } from '@omni-fs/core';
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
  /** Served by `openReadStream`, honouring `start` and `length`. */
  readonly content?: string;
  /**
   * Leaves the data connection open after the first chunk, the way a `RETR` of
   * a large file is open between chunks. Only a transfer still in flight can be
   * aborted part-way through.
   */
  readonly stalls?: boolean;
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
    openReadStream: async (path, range, transfer) => {
      // Whether a signal arrived is recorded, not just the path and range: the
      // channel is the layer that tears a transfer down, so a provider that
      // dropped the signal on the way here would otherwise look identical.
      const signalled = String(transfer?.signal !== undefined);
      calls.push(`read ${path} ${range?.start ?? 0}:${range?.length ?? ''} signal=${signalled}`);
      const body = options.content ?? '';
      const start = range?.start ?? 0;
      const slice =
        range?.length === undefined ? body.slice(start) : body.slice(start, start + range.length);
      // Mirrors the real channel: the protocol has no end-of-range, so cutting
      // a RETR short leaves the control channel mid-command.
      if (range?.length !== undefined) channel.poison();
      transfer?.onProgress?.(slice.length);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(slice));
          if (options.stalls !== true) {
            controller.close();
            return;
          }
          // Mirrors `FtpControlChannel.openReadStream`: an abort part-way
          // through poisons the control channel and errors the transfer, rather
          // than ending it as though the file had simply stopped.
          transfer?.signal?.addEventListener(
            'abort',
            () => {
              channel.poison();
              controller.error(
                new OmniFsError({
                  code: 'Cancelled',
                  message: `Cancelled: ${path}`,
                  providerId: 'ftp',
                  path,
                }),
              );
            },
            { once: true },
          );
        },
      });
    },
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

describe('reading', () => {
  it('reads a whole file', async () => {
    const fs = await connected(fakeChannel({ content: 'payload' }));
    expect(new TextDecoder().decode(await fs.readFile(RemotePath.parse('/a.txt')))).toBe('payload');
  });

  it('reads a byte range', async () => {
    const fs = await connected(fakeChannel({ content: '0123456789' }));
    const slice = await fs.readFile(RemotePath.parse('/a.txt'), { offset: 2, length: 3 });
    expect(new TextDecoder().decode(slice)).toBe('234');
  });

  it('reads from an offset to the end', async () => {
    const fs = await connected(fakeChannel({ content: '0123456789' }));
    const slice = await fs.readFile(RemotePath.parse('/a.txt'), { offset: 7 });
    expect(new TextDecoder().decode(slice)).toBe('789');
  });

  it('reads no bytes for a zero-length range, without opening a data connection', async () => {
    const channel = fakeChannel({ content: '0123456789', mlst: async () => entry('a.txt') });
    const fs = await connected(channel);
    const slice = await fs.readFile(RemotePath.parse('/a.txt'), { offset: 2, length: 0 });
    expect(slice.byteLength).toBe(0);
    expect(channel.calls.some((call) => call.startsWith('read'))).toBe(false);
    // It still asked the server whether the path is there, which is what keeps
    // the answer from being an empty success over a file that does not exist.
    expect(channel.calls).toContain('mlst /home/alice/a.txt');
  });

  it('still refuses a missing path for a zero-length range', async () => {
    // Answering locally must not turn a missing path into an empty success.
    // Existence stays the server's to decide.
    const channel = fakeChannel({ hasMlst: false, list: async () => [] });
    const fs = await connected(channel);
    await expect(
      fs.readFile(RemotePath.parse('/absent.txt'), { offset: 0, length: 0 }),
    ).rejects.toSatisfy((error: unknown) => OmniFsError.is(error) && error.code === 'NotFound');
  });

  // At a ceiling of one the follow-up stat would deadlock if the read kept its
  // lease, so these three carry a timeout: the failure has to be a red test
  // rather than a hung suite.
  it('releases the channel once the stream is drained', async () => {
    const fs = await connected(fakeChannel({ content: 'payload' }), { maxConnections: 1 });
    await fs.readFile(RemotePath.parse('/a.txt'));
    await expect(fs.stat(RemotePath.ROOT)).resolves.toBeDefined();
  }, 2_000);

  it('releases the channel when the consumer cancels early', async () => {
    const fs = await connected(fakeChannel({ content: 'payload' }), { maxConnections: 1 });
    const stream = await fs.createReadStream(RemotePath.parse('/a.txt'));
    await stream.cancel('changed my mind');
    await expect(fs.stat(RemotePath.ROOT)).resolves.toBeDefined();
  }, 2_000);

  it('releases the channel when the read cannot even start', async () => {
    const channel = fakeChannel({ content: 'payload' });
    channel.openReadStream = async () => {
      throw Object.assign(new Error('550 No such file'), { code: 550 });
    };
    const fs = await connected(channel, { maxConnections: 1 });
    await expect(fs.readFile(RemotePath.parse('/gone.txt'))).rejects.toThrow();
    await expect(fs.stat(RemotePath.ROOT)).resolves.toBeDefined();
  }, 2_000);

  it('translates a failure to start into an OmniFsError', async () => {
    // Providers throw one error vocabulary: a raw 550 from the library must not
    // reach a caller as whatever `basic-ftp` happened to construct.
    const channel = fakeChannel({ content: 'payload' });
    channel.openReadStream = async () => {
      throw Object.assign(new Error('550 No such file'), { code: 550 });
    };
    const fs = await connected(channel);
    await expect(fs.readFile(RemotePath.parse('/gone.txt'))).rejects.toSatisfy(
      (error: unknown) =>
        OmniFsError.is(error) && error.code === 'NotFound' && error.path === '/gone.txt',
    );
  });

  it('replaces the channel a bounded read poisoned', async () => {
    // The protocol has no end-of-range, so a range that stops before EOF costs
    // the control channel. The pool notices on release and opens a fresh one.
    const opened: FakeChannel[] = [];
    const fs = new FtpFileSystem(context({ maxConnections: 1 }), async () => {
      const channel = fakeChannel({ content: '0123456789' });
      opened.push(channel);
      return channel;
    });
    await fs.connect();

    await fs.readFile(RemotePath.parse('/a.txt'), { offset: 0, length: 4 });
    await fs.stat(RemotePath.ROOT);

    expect(opened[0]?.isAlive()).toBe(false);
    expect(opened.length).toBe(2);
  }, 2_000);

  it('does not poison the channel for an unbounded read', async () => {
    const opened: FakeChannel[] = [];
    const fs = new FtpFileSystem(context({ maxConnections: 1 }), async () => {
      const channel = fakeChannel({ content: '0123456789' });
      opened.push(channel);
      return channel;
    });
    await fs.connect();

    await fs.readFile(RemotePath.parse('/a.txt'));
    await fs.stat(RemotePath.ROOT);

    expect(opened[0]?.isAlive()).toBe(true);
    expect(opened.length).toBe(1);
  }, 2_000);

  // Named for what it checks. The fake reports once, up front, so this says the
  // handler reached `openReadStream` — not that FTP reports incrementally,
  // which is `ftp-channel.test.ts`'s to prove.
  it("passes the caller's progress handler down to the channel", async () => {
    const seen: number[] = [];
    const fs = await connected(fakeChannel({ content: 'payload' }));
    await fs.readFile(RemotePath.parse('/a.txt'), { onProgress: (n) => seen.push(n) });
    expect(seen.at(-1)).toBe(7);
  });

  it('refuses an already-aborted signal before it acquires a channel', async () => {
    // This one stops inside `pool.acquire`, so it says nothing about the signal
    // reaching `openReadStream` — the case below is what covers that.
    const channel = fakeChannel({ content: 'payload' });
    const fs = await connected(channel);
    const controller = new AbortController();
    controller.abort();
    await expect(
      fs.readFile(RemotePath.parse('/a.txt'), { signal: controller.signal }),
    ).rejects.toSatisfy((error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled');
    expect(channel.calls.some((call) => call.startsWith('read'))).toBe(false);
  });

  // The half with teeth. A transfer already in flight is the channel's to tear
  // down — it poisons itself and errors the stream. A provider that dropped the
  // signal on the way to `openReadStream` would leave the RETR running and the
  // channel looking healthy: a wedged connection rather than an error, and
  // nothing above here would notice.
  it("carries the caller's abort signal down to the channel", async () => {
    const channel = fakeChannel({ content: 'payload', stalls: true });
    const fs = await connected(channel);
    const controller = new AbortController();
    const stream = await fs.createReadStream(RemotePath.parse('/a.txt'), {
      signal: controller.signal,
    });
    expect(channel.calls).toContain('read /home/alice/a.txt 0: signal=true');

    const draining = collectStream(stream);
    controller.abort();

    await expect(draining).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled',
    );
    expect(channel.isAlive()).toBe(false);
  }, 2_000);
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
