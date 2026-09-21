import { describe, expect, it, vi } from 'vitest';
import type { Readable, Writable } from 'node:stream';
import { NOOP_LOGGER, OmniFsError, collectStream } from '@omni-fs/core';
import type { Logger, LogLevel } from '@omni-fs/core';
import { FtpControlChannel, buildAccessOptions, hasSecurityLevels } from './ftp-channel.js';
import type { FtpClientLike, FtpContextLike } from './ftp-channel.js';
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

  it('leaves the cipher list alone where the TLS library has no security levels', () => {
    // VS Code runs on Electron, whose BoringSSL rejects `@SECLEVEL` outright
    // with ERR_SSL_INVALID_COMMAND. It has no levels to lower, so the floor
    // alone is what reaches the old server there.
    for (const version of ['TLSv1.1', 'TLSv1']) {
      const options = buildAccessOptions(withSettings({ tlsMinVersion: version }), 'p', false);
      expect(options.secureOptions?.ciphers, version).toBeUndefined();
      expect(options.secureOptions?.minVersion, version).toBe(version);
    }
  });

  it('knows whether the TLS library it runs on has security levels', () => {
    expect(hasSecurityLevels()).toBe(!process.versions.openssl.startsWith('0.'));
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

  it('keeps the greeting and what TLS actually negotiated', async () => {
    const client = fakeClient({
      access: vi.fn(async () => ({ code: 220, message: '220 Microsoft FTP Service' })),
    });
    client.ftp = fakeContext({
      getProtocol: () => 'TLSv1',
      getCipher: () => ({ name: 'ECDHE-RSA-AES256-SHA', standardName: '', version: 'TLSv1' }),
    });

    const channel = await open(client);

    expect(channel.session).toEqual({
      greeting: '220 Microsoft FTP Service',
      tlsProtocol: 'TLSv1',
      tlsCipher: 'ECDHE-RSA-AES256-SHA',
    });
  });

  it('reports no TLS for a plain control channel', async () => {
    const client = fakeClient();
    client.ftp = fakeContext({});

    const channel = await open(client, { secure: 'none' });

    expect(channel.session.tlsProtocol).toBeUndefined();
    expect(channel.session.tlsCipher).toBeUndefined();
  });

  it('sends the raw control channel to the log at trace', async () => {
    // The equivalent of FileZilla's message log. `basic-ftp` already writes
    // `> PASS ###` rather than the password (FtpContext.send), and the live
    // suite checks that end to end.
    const { logger, entries } = capturingLogger();
    const client = fakeClient();
    const context = fakeContext({});
    client.ftp = context;

    await open(client, {}, logger);
    context.log('> LIST /data\r\n');

    expect(entries).toContainEqual({ level: 'trace', message: '> LIST /data' });
  });
});

/** `basic-ftp`'s `FtpContext`, as far as the channel reads it. */
function fakeContext(socket: Record<string, unknown>): FtpContextLike {
  return {
    socket,
    log: () => undefined,
  };
}

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

  it('refuses a path that would inject a second command, rather than stripping it', async () => {
    // FTP commands are CRLF-terminated and `basic-ftp` sends the string it is
    // given, so `\r\n` in a path appends a command of the attacker's choosing
    // to the control channel. `RemotePath` does not reject control characters,
    // which makes this file the only place that can.
    const client = fakeClient();
    const channel = await open(client);

    for (const nasty of ['/data/a\r\nDELE /etc/passwd', '/data/a\nSTOR x', '/data/a\0b']) {
      await expect(channel.mkdir(nasty), nasty).rejects.toSatisfy(
        (error: unknown) => OmniFsError.is(error) && error.code === 'ProtocolError',
      );
    }
    expect(client.sent).toEqual([]);
  });

  it('guards every path that reaches the control channel, not just the two it builds', async () => {
    // `basic-ftp` interpolates the path itself for DELE, RMD, RNFR/RNTO and
    // LIST (`Client.js:330,342,515,693`), so checking only the MLST and MKD
    // template literals would leave the same hole behind four other methods.
    const channel = await open(fakeClient());
    const nasty = '/data/a\r\nQUIT';
    const isProtocolError = (error: unknown) =>
      OmniFsError.is(error) && error.code === 'ProtocolError';

    await expect(channel.mlst(nasty)).rejects.toSatisfy(isProtocolError);
    await expect(channel.list(nasty)).rejects.toSatisfy(isProtocolError);
    await expect(channel.rmdir(nasty)).rejects.toSatisfy(isProtocolError);
    await expect(channel.unlink(nasty)).rejects.toSatisfy(isProtocolError);
    await expect(channel.rename('/data/ok', nasty)).rejects.toSatisfy(isProtocolError);
    await expect(channel.openReadStream(nasty)).rejects.toSatisfy(isProtocolError);
    await expect(channel.upload(nasty, new Uint8Array())).rejects.toSatisfy(isProtocolError);
    await expect(channel.openWriteStream(nasty)).rejects.toSatisfy(isProtocolError);
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

  it('spends the length budget across chunks, not per chunk', async () => {
    // With `remaining` computed as `limit` rather than `limit - seen`, a
    // transfer that arrives in small chunks over-delivers up to `limit` extra
    // bytes for every chunk after the first. One chunk hides that entirely.
    const client = fakeClient({
      downloadTo: async (destination: Writable, _path: string, startAt = 0) => {
        const body = '0123456789'.slice(startAt);
        for (let at = 0; at < body.length; at += 2) {
          destination.write(Buffer.from(body.slice(at, at + 2)));
        }
        destination.end();
        return { code: 226, message: '226 done' };
      },
    });
    const channel = await open(client);
    const stream = await channel.openReadStream('/data/a.txt', { start: 0, length: 5 });
    const bytes = await collectStream(stream);
    expect(bytes.byteLength).toBe(5);
    expect(new TextDecoder().decode(bytes)).toBe('01234');
  });

  it('holds the download back while the consumer is behind', async () => {
    // Without back-pressure a slow reader on a large file buffers the whole
    // transfer in memory, which is precisely the case a remote filesystem
    // client exists for.
    let secondAccepted = false;
    const client = fakeClient({
      downloadTo: async (destination: Writable) => {
        destination.write(Buffer.alloc(64 * 1024));
        await new Promise<void>((resolve) => {
          destination.write(Buffer.alloc(64 * 1024), () => {
            secondAccepted = true;
            resolve();
          });
        });
        destination.end();
        return { code: 226, message: '226 done' };
      },
    });
    const channel = await open(client);
    const stream = await channel.openReadStream('/data/big.bin');

    // Nobody has read a byte yet, so the second chunk must still be waiting.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondAccepted).toBe(false);

    // Draining the consumer releases it, and nothing is lost on the way.
    expect((await collectStream(stream)).byteLength).toBe(128 * 1024);
    expect(secondAccepted).toBe(true);
  });

  // Explicit timeout: a regression here hangs rather than fails.
  it('releases the download when the consumer cancels the stream', async () => {
    // `ReadableStream.cancel()` destroys the PassThrough without going
    // through finish(), so a sink that afterwards waits on 'drain' or
    // 'close' waits on a stream that can never emit either again. That
    // strands the callback and hangs `basic-ftp` until its 30 s control
    // timeout. Back-pressure created this path: before it, the callback was
    // unconditional and a cancelled download simply drained.
    //
    // It takes a write *after* the cancel to show it: the chunk already
    // parked when the consumer gives up is released by that same 'close'.
    // So the fake keeps feeding, one chunk at a time, the way a real
    // download does.
    let finished = false;
    const client = fakeClient({
      downloadTo: async (destination: Writable) => {
        for (let chunk = 0; chunk < 8; chunk += 1) {
          await new Promise<void>((resolve, reject) => {
            destination.write(Buffer.alloc(64 * 1024), (error) =>
              error === undefined || error === null ? resolve() : reject(error),
            );
          });
        }
        destination.end();
        finished = true;
        return { code: 226, message: '226 done' };
      },
    });
    const channel = await open(client);
    const stream = await channel.openReadStream('/data/big.bin');

    // Back-pressure is engaged: the sink is parked waiting for a reader.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);

    // The reader gives up instead of draining. The download must unwind,
    // not sit on a dead stream.
    await stream.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(finished).toBe(true);
  }, 2_000);

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
      // A 552 is the server's reply to a transfer it has *received*, so the
      // fake takes the payload first and refuses at the end. (Refusing before
      // reading anything is the other ordering, and it is covered on its own
      // below — there the failure reaches the pending write instead, and the
      // WritableStream is already errored by the time close() is called.)
      uploadFrom: async (source: Readable) => {
        for await (const _chunk of source) {
          /* drain */
        }
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

  // Both of the next two carry an explicit timeout: a regression here *hangs*
  // rather than fails, and the suite must not sit on the default timeout to
  // find that out.
  it('rejects a pending write when the server fails mid-stream, instead of hanging', async () => {
    // The 7-byte payload above fits inside the PassThrough's 16 KB
    // high-water mark, so it never exercises this. Past that mark, once
    // `basic-ftp` stops reading, the write callback is simply never called
    // again — and `destroy()` does not settle an in-flight one. A caller
    // that never reaches close() would wait forever on a transfer the
    // server has already refused.
    let fail: ((error: Error) => void) | undefined;
    const client = fakeClient({
      uploadFrom: () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    });
    const channel = await open(client);
    const stream = await channel.openWriteStream('/data/big.bin');
    const writer = stream.getWriter();

    const pending = writer.write(new Uint8Array(64 * 1024));
    await new Promise((resolve) => setTimeout(resolve, 10));
    fail?.(Object.assign(new Error('552 Quota exceeded'), { code: 552 }));

    await expect(pending).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'QuotaExceeded',
    );
  }, 2_000);

  it('rejects a pending write when the caller aborts mid-stream', async () => {
    // Same hang, reached the other way: the stream's own abort() handler
    // only runs when the *consumer* aborts, so a signal abort has to travel
    // through `done` to the writer.
    const controller = new AbortController();
    const client = fakeClient({
      uploadFrom: () =>
        new Promise(() => {
          /* never settles */
        }),
    });
    const channel = await open(client);
    const stream = await channel.openWriteStream('/data/big.bin', {
      signal: controller.signal,
    });
    const writer = stream.getWriter();

    const pending = writer.write(new Uint8Array(64 * 1024));
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    await expect(pending).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled',
    );
    expect(channel.poisoned).toBe(true);
  }, 2_000);
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
