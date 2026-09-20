import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_LOGGER, OmniFsError } from '@omni-fs/core';
import type { SFTPWrapper } from 'ssh2';
import { SftpSession, detectExtensions, type SftpExtensions } from './sftp-session.js';

const NO_EXTENSIONS: SftpExtensions = { posixRename: false, fsync: false, copyData: false };

/** The callback shape `ssh2` uses: an optional error first, then the value. */
type Reply<T = void> = (error?: Error | null, value?: T) => void;

const attrs = { mode: 0o100644, size: 12, mtime: 1_700_000_000, uid: 1000, gid: 1000 };

function channel(over: Record<string, unknown>): SFTPWrapper {
  return over as unknown as SFTPWrapper;
}

function session(over: Record<string, unknown>, extensions = NO_EXTENSIONS): SftpSession {
  return new SftpSession(channel(over), extensions, NOOP_LOGGER);
}

describe('SftpSession requests', () => {
  it('maps stat attributes into the shape the provider uses', async () => {
    const fs = session({ stat: (_p: string, cb: Reply<typeof attrs>) => cb(undefined, attrs) });
    expect(await fs.stat('/data/a.txt')).toEqual(attrs);
  });

  it('maps a directory listing to filenames and attributes', async () => {
    const fs = session({
      readdir: (_p: string, cb: Reply<{ filename: string; attrs: typeof attrs }[]>) =>
        cb(undefined, [{ filename: 'a.txt', attrs }]),
    });
    expect(await fs.readdir('/data')).toEqual([{ filename: 'a.txt', attrs }]);
  });

  it('rejects an already-aborted call without touching the wire', async () => {
    const stat = vi.fn();
    const fs = session({ stat });
    const controller = new AbortController();
    controller.abort();

    // `providerId` is asserted here because the `OmniFsError.cancelled` factory
    // drops it, which would leave this provider emitting two shapes of
    // `Cancelled` that a caller filtering by provider cannot both attribute.
    await expect(fs.stat('/data/a.txt', controller.signal)).rejects.toSatisfy(
      (error: unknown) =>
        OmniFsError.is(error) && error.code === 'Cancelled' && error.providerId === 'sftp',
    );
    expect(stat).not.toHaveBeenCalled();
  });

  it('rejects with Cancelled when the signal fires mid-request, and ignores the late reply', async () => {
    let reply: (() => void) | undefined;
    const fs = session({
      stat: (_p: string, cb: (error: undefined, value: typeof attrs) => void) => {
        reply = () => cb(undefined, attrs);
      },
    });

    const controller = new AbortController();
    const pending = fs.stat('/data/a.txt', controller.signal);
    controller.abort();

    await expect(pending).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled',
    );

    // The request was abandoned, not cancelled: the server still answers, and
    // that answer must settle nothing.
    expect(() => reply?.()).not.toThrow();
  });

  it('passes a failure through untranslated, because translation is the file system layer job', async () => {
    const failure = Object.assign(new Error('No such file'), { code: 2 });
    const fs = session({ stat: (_p: string, cb: Reply) => cb(failure) });
    await expect(fs.stat('/data/gone.txt')).rejects.toBe(failure);
  });

  it('renames through the POSIX extension when the server offers it', async () => {
    const posix = vi.fn((_f: string, _t: string, cb: Reply) => cb(undefined));
    const plain = vi.fn((_f: string, _t: string, cb: Reply) => cb(undefined));
    const fs = session({ ext_openssh_rename: posix, rename: plain });

    await fs.posixRename('/a', '/b');
    await fs.rename('/a', '/b');

    expect(posix).toHaveBeenCalledTimes(1);
    expect(plain).toHaveBeenCalledTimes(1);
  });

  it('resolves the login directory through realpath', async () => {
    const fs = session({
      realpath: (_p: string, cb: Reply<string>) => cb(undefined, '/home/omnifs'),
    });
    expect(await fs.realpath('.')).toBe('/home/omnifs');
  });
});

describe('SftpSession lifecycle', () => {
  it('reports a fresh session as usable', () => {
    expect(session({}).isAlive()).toBe(true);
  });

  it('stops claiming to be usable once it is closed', async () => {
    const fs = session({});
    await fs.close();
    expect(fs.isAlive()).toBe(false);
  });
});

describe('SftpSession writes', () => {
  interface WriteLog {
    opened: { path: string; flags: string }[];
    written: Buffer[];
    fsynced: number;
    closed: number;
  }

  function writeChannel(over: Record<string, unknown> = {}): {
    channel: Record<string, unknown>;
    log: WriteLog;
  } {
    const log: WriteLog = { opened: [], written: [], fsynced: 0, closed: 0 };
    const channel = {
      open: (path: string, flags: string, cb: Reply<Buffer>) => {
        log.opened.push({ path, flags });
        cb(undefined, Buffer.from('handle'));
      },
      write: (_h: Buffer, buffer: Buffer, _o: number, _l: number, _p: number, cb: Reply) => {
        log.written.push(Buffer.from(buffer));
        cb(undefined);
      },
      ext_openssh_fsync: (_h: Buffer, cb: Reply) => {
        log.fsynced += 1;
        cb(undefined);
      },
      close: (_h: Buffer, cb: Reply) => {
        log.closed += 1;
        cb(undefined);
      },
      ...over,
    };
    return { channel, log };
  }

  it('writes a whole buffer through one open, flush and close', async () => {
    const { channel, log } = writeChannel();
    const fs = session(channel, { posixRename: false, fsync: true, copyData: false });

    await fs.writeAll('/data/a.txt', new TextEncoder().encode('hello'), 'w');

    expect(log.opened).toEqual([{ path: '/data/a.txt', flags: 'w' }]);
    expect(Buffer.concat(log.written).toString('utf8')).toBe('hello');
    expect(log.fsynced).toBe(1);
    expect(log.closed).toBe(1);
  });

  it('opens exclusively when asked to, so the server refuses an existing file', async () => {
    const { channel, log } = writeChannel();
    await session(channel).writeAll('/data/a.txt', new Uint8Array(), 'wx');
    expect(log.opened[0]?.flags).toBe('wx');
  });

  it('skips the flush on a server without fsync@openssh.com', async () => {
    const { channel, log } = writeChannel();
    await session(channel).writeAll('/data/a.txt', new TextEncoder().encode('hi'), 'w');
    expect(log.fsynced).toBe(0);
    expect(log.closed).toBe(1);
  });

  it('closes the handle even when the write fails, and reports the write failure', async () => {
    const failure = Object.assign(new Error('Failure'), { code: 4 });
    const { channel, log } = writeChannel({
      write: (_h: Buffer, _b: Buffer, _o: number, _l: number, _p: number, cb: Reply) => cb(failure),
    });

    await expect(
      session(channel).writeAll('/data/a.txt', new TextEncoder().encode('hi'), 'w'),
    ).rejects.toBe(failure);
    expect(log.closed).toBe(1);
  });

  it('refuses a server-side copy the server never announced', async () => {
    const { channel } = writeChannel();
    await expect(session(channel).copyData('/a', '/b', 'w')).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Unsupported',
    );
  });

  it('copies with copy-data, reading to EOF and closing both handles', async () => {
    let call: { srcOffset: number; len: number; dstOffset: number } | undefined;
    const { channel, log } = writeChannel({
      ext_copy_data: (
        _src: Buffer,
        srcOffset: number,
        len: number,
        _dst: Buffer,
        dstOffset: number,
        cb: Reply,
      ) => {
        call = { srcOffset, len, dstOffset };
        cb(undefined);
      },
    });
    const fs = session(channel, { posixRename: false, fsync: false, copyData: true });

    await fs.copyData('/data/from.txt', '/data/to.txt', 'w');

    expect(log.opened).toEqual([
      { path: '/data/from.txt', flags: 'r' },
      { path: '/data/to.txt', flags: 'w' },
    ]);
    // length 0 means "read the source until EOF"
    expect(call).toEqual({ srcOffset: 0, len: 0, dstOffset: 0 });
    expect(log.closed).toBe(2);
  });

  it('holds the write stream open until the bytes are flushed and the handle is closed', async () => {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));
    const { channel, log } = writeChannel({ createWriteStream: () => sink });
    const fs = session(channel, { posixRename: false, fsync: true, copyData: false });

    const stream = await fs.openWriteStream('/data/streamed.txt', 'w');
    const writer = stream.getWriter();
    await writer.write(new TextEncoder().encode('first-'));
    await writer.write(new TextEncoder().encode('second'));
    await writer.close();

    expect(Buffer.concat(chunks).toString('utf8')).toBe('first-second');
    expect(log.fsynced).toBe(1);
    expect(log.closed).toBe(1);
  });

  it('fails close() when the server rejects the flush, rather than claiming the write landed', async () => {
    const sink = new PassThrough();
    sink.resume();
    const { channel } = writeChannel({
      createWriteStream: () => sink,
      ext_openssh_fsync: (_h: Buffer, cb: Reply) => cb(new Error('Quota exceeded')),
    });
    const fs = session(channel, { posixRename: false, fsync: true, copyData: false });

    const stream = await fs.openWriteStream('/data/streamed.txt', 'w');
    const writer = stream.getWriter();
    await writer.write(new TextEncoder().encode('bytes'));

    await expect(writer.close()).rejects.toThrow('Quota exceeded');
  });

  it('passes an inclusive byte range to the read stream', async () => {
    let options: { start?: number; end?: number } | undefined;
    const { channel } = writeChannel({
      createReadStream: (_path: string, opts: { start?: number; end?: number }) => {
        options = opts;
        return Readable.from([Buffer.from('234')]);
      },
    });

    const stream = await session(channel).openReadStream('/data/ranged.txt', { start: 2, end: 4 });
    const reader = stream.getReader();
    const first = await reader.read();

    expect(options).toEqual({ start: 2, end: 4 });
    expect(Buffer.from(first.value as Uint8Array).toString('utf8')).toBe('234');
  });
});

describe('detectExtensions', () => {
  it('reads what the server announced at version exchange', () => {
    const sftp = channel({
      _extensions: {
        'posix-rename@openssh.com': '1',
        'fsync@openssh.com': '1',
        'copy-data': '1',
      },
    });
    expect(detectExtensions(sftp)).toEqual({ posixRename: true, fsync: true, copyData: true });
  });

  it('treats an unannounced extension as absent', () => {
    expect(detectExtensions(channel({ _extensions: { 'statvfs@openssh.com': '2' } }))).toEqual(
      NO_EXTENSIONS,
    );
  });

  it('degrades to no extensions when the field is not there at all', () => {
    expect(detectExtensions(channel({}))).toEqual(NO_EXTENSIONS);
  });
});
