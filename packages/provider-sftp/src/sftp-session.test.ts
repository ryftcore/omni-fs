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

    await expect(fs.stat('/data/a.txt', controller.signal)).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled',
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
