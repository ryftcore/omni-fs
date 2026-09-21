import { describe, expect, it, vi } from 'vitest';
import type { Readable, Writable } from 'node:stream';
import { NOOP_LOGGER, OmniFsError, collectStream } from '@omni-fs/core';
import type { Logger, LogLevel } from '@omni-fs/core';
import { FtpControlChannel, buildAccessOptions } from './ftp-channel.js';
import type { FtpClientLike } from './ftp-channel.js';
import { readSettings } from './settings.js';

const settings = readSettings({ host: 'ftp.example.com', username: 'alice' });

function withSettings(overrides: Readonly<Record<string, unknown>>) {
  return readSettings({ host: 'ftp.example.com', username: 'alice', ...overrides });
}

describe('buildAccessOptions', () => {
  it('asks for explicit TLS by default', () => {
    expect(buildAccessOptions(settings, 'hunter2')).toMatchObject({
      host: 'ftp.example.com',
      port: 21,
      user: 'alice',
      password: 'hunter2',
      secure: true,
    });
  });

  it('asks for implicit TLS when the mode says so', () => {
    expect(buildAccessOptions(withSettings({ secure: 'implicit' }), 'p').secure).toBe('implicit');
  });

  it('leaves TLS off, and carries no TLS options at all, for plain FTP', () => {
    const options = buildAccessOptions(withSettings({ secure: 'none' }), 'p');
    expect(options.secure).toBe(false);
    expect(options.secureOptions).toBeUndefined();
  });

  it('turns certificate verification off only when the user asked', () => {
    expect(buildAccessOptions(settings, 'p').secureOptions?.rejectUnauthorized).toBeUndefined();
    expect(
      buildAccessOptions(withSettings({ allowSelfSigned: true }), 'p').secureOptions
        ?.rejectUnauthorized,
    ).toBe(false);
  });

  it('leaves the TLS floor to Node when the setting is auto', () => {
    // Node's floor moves with Node. Pinning it here would freeze this
    // provider's floor the day Node raises its own.
    expect(buildAccessOptions(settings, 'p').secureOptions?.minVersion).toBeUndefined();
  });

  it('passes a chosen TLS floor through', () => {
    expect(
      buildAccessOptions(withSettings({ tlsMinVersion: 'TLSv1.2' }), 'p').secureOptions?.minVersion,
    ).toBe('TLSv1.2');
  });

  it('relaxes the cipher policy below TLS 1.2, because the version alone is not enough', () => {
    // OpenSSL 3 rejects these servers' small DH parameters whatever protocol
    // version is negotiated, so a version-only knob would be set correctly and
    // still fail. Spec decision 8.
    for (const version of ['TLSv1.1', 'TLSv1']) {
      const options = buildAccessOptions(withSettings({ tlsMinVersion: version }), 'p');
      expect(options.secureOptions?.ciphers, version).toBe('DEFAULT@SECLEVEL=0');
    }
  });

  it('does not relax the cipher policy at TLS 1.2 or above', () => {
    for (const version of ['auto', 'TLSv1.2', 'TLSv1.3']) {
      const options = buildAccessOptions(withSettings({ tlsMinVersion: version }), 'p');
      expect(options.secureOptions?.ciphers, version).toBeUndefined();
    }
  });
});

/**
 * A fake `basic-ftp` Client. Every method records and answers immediately.
 *
 * `FtpClientLike.closed` is readonly — it is a getter on the real class — so
 * the fake is built through a mutable mapped type and handed back as that.
 */
type MutableClient = { -readonly [K in keyof FtpClientLike]: FtpClientLike[K] } & {
  sent: string[];
};

function fakeClient(overrides: Partial<FtpClientLike> = {}): MutableClient {
  const sent: string[] = [];
  const client: MutableClient = {
    sent,
    closed: false,
    close: vi.fn(() => {
      client.closed = true;
    }),
    access: vi.fn(async () => ({ code: 220, message: '220 ready' })),
    features: vi.fn(async () => new Map([['MLST', 'type*;size*;modify*;']])),
    pwd: vi.fn(async () => '/home/alice'),
    send: vi.fn(async (command: string) => {
      sent.push(command);
      return { code: 250, message: '250 ok' };
    }),
    list: vi.fn(async () => []),
    downloadTo: vi.fn(async () => ({ code: 226, message: '226 done' })),
    uploadFrom: vi.fn(async (source: Readable) => {
      source.resume();
      return { code: 226, message: '226 done' };
    }),
    rename: vi.fn(async () => ({ code: 250, message: '250 ok' })),
    remove: vi.fn(async () => ({ code: 250, message: '250 ok' })),
    removeEmptyDir: vi.fn(async () => ({ code: 250, message: '250 ok' })),
    trackProgress: vi.fn(),
    ...overrides,
  };
  return client;
}

async function open(
  client: FtpClientLike,
  overrides: Readonly<Record<string, unknown>> = {},
  logger: Logger = NOOP_LOGGER,
): Promise<FtpControlChannel> {
  return FtpControlChannel.open({
    settings: withSettings(overrides),
    secret: { password: 'hunter2' },
    logger,
    createClient: () => client,
  });
}

function capturingLogger(): { logger: Logger; entries: { level: LogLevel; message: string }[] } {
  const entries: { level: LogLevel; message: string }[] = [];
  const logger: Logger = {
    log: (level, message) => {
      entries.push({ level, message });
    },
    child: () => logger,
  };
  return { logger, entries };
}

describe('FtpControlChannel.open', () => {
  it('logs in and reads the feature list once', async () => {
    const client = fakeClient();
    const channel = await open(client);
    expect(client.access).toHaveBeenCalledOnce();
    expect(client.features).toHaveBeenCalledOnce();
    expect(channel.hasMlst).toBe(true);
    expect(channel.isAlive()).toBe(true);
  });

  it('notices a server without MLST, so stat can fall back', async () => {
    const client = fakeClient({ features: async () => new Map([['UTF8', '']]) });
    expect((await open(client)).hasMlst).toBe(false);
  });

  it('refuses to connect without a password', async () => {
    await expect(
      FtpControlChannel.open({
        settings,
        secret: {},
        logger: NOOP_LOGGER,
        createClient: () => fakeClient(),
      }),
    ).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'AuthenticationFailed',
    );
  });

  it('closes the client when login fails, rather than leaking a socket', async () => {
    const client = fakeClient({
      access: async () => {
        throw Object.assign(new Error('530 Login incorrect'), { code: 530 });
      },
    });
    await expect(open(client)).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'AuthenticationFailed',
    );
    expect(client.close).toHaveBeenCalled();
  });

  it('warns out loud when the cipher policy was relaxed', async () => {
    // Weakened crypto is never silent, even when it is implied by another
    // setting. Same rule as allowSelfSigned.
    const { logger, entries } = capturingLogger();
    await open(fakeClient(), { tlsMinVersion: 'TLSv1' }, logger);
    expect(entries.some((entry) => entry.level === 'warn' && /cipher/i.test(entry.message))).toBe(
      true,
    );
  });

  it('does not warn when the TLS floor is left alone', async () => {
    const { logger, entries } = capturingLogger();
    await open(fakeClient(), {}, logger);
    expect(entries.some((entry) => entry.level === 'warn')).toBe(false);
  });
});

describe('FtpControlChannel requests', () => {
  it('asks the server where it landed', async () => {
    const channel = await open(fakeClient());
    expect(await channel.pwd()).toBe('/home/alice');
  });

  it('reads a stat out of an MLST reply', async () => {
    const client = fakeClient({
      send: async () => ({
        code: 250,
        message: '250-Listing\n type=file;size=18;modify=20260921120000; /data/a.txt\n250 End',
      }),
    });
    const channel = await open(client);
    expect(await channel.mlst('/data/a.txt')).toMatchObject({ type: 'file', size: 18 });
  });

  it('drops the dot entries a listing may include', async () => {
    const client = fakeClient({
      list: async () => [
        { name: '.', type: 2, size: 0 },
        { name: '..', type: 2, size: 0 },
        { name: 'readme.txt', type: 1, size: 18 },
      ],
    });
    const channel = await open(client);
    const entries = await channel.list('/data');
    expect(entries.map((entry) => entry.name)).toEqual(['readme.txt']);
  });

  it('sends MKD for a directory, because ensureDir would move the working directory', async () => {
    // Every command this package sends carries an absolute path, which is what
    // makes a pooled channel interchangeable.
    const client = fakeClient();
    await (await open(client)).mkdir('/data/new');
    expect(client.sent).toContain('MKD /data/new');
  });

  it('translates a server refusal into the shared vocabulary', async () => {
    const client = fakeClient({
      remove: async () => {
        throw Object.assign(new Error('550 No such file'), { code: 550 });
      },
    });
    const channel = await open(client);
    await expect(channel.unlink('/data/gone.txt')).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
    );
  });

  it('refuses immediately on an already-aborted signal, without touching the client', async () => {
    const client = fakeClient();
    const channel = await open(client);
    const controller = new AbortController();
    controller.abort();

    await expect(channel.list('/data', controller.signal)).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled',
    );
    expect(client.list).not.toHaveBeenCalled();
    // Nothing was sent, so nothing is out of step: the channel survives.
    expect(channel.poisoned).toBe(false);
  });

  it('poisons itself when a request is aborted mid-flight', async () => {
    // FTP has no cancel on the wire. Abandoning a command leaves the control
    // channel out of step, so the only honest answer is to throw it away.
    const controller = new AbortController();
    const client = fakeClient({
      list: () =>
        new Promise(() => {
          /* never settles */
        }),
    });
    const channel = await open(client);
    const pending = channel.list('/data', controller.signal);
    controller.abort();

    await expect(pending).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled',
    );
    expect(channel.poisoned).toBe(true);
    expect(channel.isAlive()).toBe(false);
  });

  it('poisons itself when the connection drops', async () => {
    const client = fakeClient({
      pwd: async () => {
        throw Object.assign(new Error('socket gone'), { code: 'ECONNRESET' });
      },
    });
    const channel = await open(client);
    await expect(channel.pwd()).rejects.toThrow();
    expect(channel.poisoned).toBe(true);
  });

  it('survives an ordinary server refusal, which says nothing about the connection', async () => {
    const client = fakeClient({
      removeEmptyDir: async () => {
        throw Object.assign(new Error('550 Directory not empty'), { code: 550 });
      },
    });
    const channel = await open(client);
    await expect(channel.rmdir('/data/full')).rejects.toThrow();
    expect(channel.poisoned).toBe(false);
  });
});

describe('FtpControlChannel transfers', () => {
  /** A fake download that writes `content` into the sink `basic-ftp` was given. */
  function downloading(content: string) {
    return async (destination: Writable, _path: string, startAt = 0) => {
      destination.write(Buffer.from(content.slice(startAt)));
      destination.end();
      return { code: 226, message: '226 done' };
    };
  }

  it('reads a whole file', async () => {
    const client = fakeClient({ downloadTo: downloading('0123456789') });
    const channel = await open(client);
    const stream = await channel.openReadStream('/data/a.txt');
    expect(new TextDecoder().decode(await collectStream(stream))).toBe('0123456789');
    expect(channel.poisoned).toBe(false);
  });

  it('starts at an offset with REST, and keeps the channel', async () => {
    const client = fakeClient({ downloadTo: downloading('0123456789') });
    const channel = await open(client);
    const stream = await channel.openReadStream('/data/a.txt', { start: 4 });
    expect(new TextDecoder().decode(await collectStream(stream))).toBe('456789');
    expect(channel.poisoned).toBe(false);
  });

  it('cuts a bounded range short and poisons the channel', async () => {
    // RETR has no end position. Stopping early leaves the control channel
    // mid-command, and a desynchronised channel is worse than no channel.
    const client = fakeClient({ downloadTo: downloading('0123456789') });
    const channel = await open(client);
    const stream = await channel.openReadStream('/data/a.txt', { start: 2, length: 3 });
    expect(new TextDecoder().decode(await collectStream(stream))).toBe('234');
    expect(channel.poisoned).toBe(true);
  });

  it('surfaces a failed download on the stream, not from the call that made it', async () => {
    const client = fakeClient({
      downloadTo: async () => {
        throw Object.assign(new Error('550 No such file'), { code: 550 });
      },
    });
    const channel = await open(client);
    const stream = await channel.openReadStream('/data/gone.txt');
    await expect(collectStream(stream)).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
    );
  });

  it('uploads a buffer as one readable', async () => {
    const chunks: Buffer[] = [];
    const client = fakeClient({
      uploadFrom: async (source: Readable) => {
        for await (const chunk of source) chunks.push(chunk as Buffer);
        return { code: 226, message: '226 done' };
      },
    });
    const channel = await open(client);
    await channel.upload('/data/a.txt', new TextEncoder().encode('payload'));
    expect(Buffer.concat(chunks).toString()).toBe('payload');
  });

  it('resolves a write stream close only after the server has answered', async () => {
    // A close() that resolves for a transfer the server rejected is the defect
    // this repo has now fixed three times: S3, WebDAV and SFTP.
    let release: (() => void) | undefined;
    const client = fakeClient({
      uploadFrom: async (source: Readable) => {
        source.resume();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { code: 226, message: '226 done' };
      },
    });
    const channel = await open(client);
    const stream = await channel.openWriteStream('/data/a.txt');
    const writer = stream.getWriter();
    await writer.write(new TextEncoder().encode('payload'));

    let closed = false;
    const closing = writer.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);

    release?.();
    await closing;
    expect(closed).toBe(true);
  });

  it('fails a write stream close when the server rejects the transfer', async () => {
    const client = fakeClient({
      uploadFrom: async (source: Readable) => {
        source.resume();
        throw Object.assign(new Error('552 Quota exceeded'), { code: 552 });
      },
    });
    const channel = await open(client);
    const stream = await channel.openWriteStream('/data/a.txt');
    const writer = stream.getWriter();
    await writer.write(new TextEncoder().encode('payload'));
    await expect(writer.close()).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'QuotaExceeded',
    );
  });
});

describe('FtpClientLike', () => {
  it('is satisfied by the real basic-ftp Client', async () => {
    // The fake is the only client the rest of this file uses, so without this
    // the interface could drift from the library and no test would notice
    // until a live run.
    const { Client } = await import('basic-ftp');
    const client: FtpClientLike = new Client(1);
    // `closed` is `socket.remoteAddress === undefined || _closingError !== undefined`
    // (`FtpContext.js:89`), so a Client that has never connected reports
    // `true`. That is the answer `isAlive()` wants: a channel is alive only
    // once `access` has actually brought a control connection up.
    expect(client.closed).toBe(true);
    client.close();
  });
});
