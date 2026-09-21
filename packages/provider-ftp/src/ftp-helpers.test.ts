import { describe, expect, it, vi } from 'vitest';
import { RemotePath, collectStream, streamFrom } from '@omni-fs/core';
import {
  buildRange,
  fromFileInfo,
  joinRemote,
  parseMlstResponse,
  releasingStream,
  resolveBase,
  toDirEntry,
  toFileStat,
  toFileType,
} from './ftp-helpers.js';

describe('toFileType', () => {
  it('maps basic-ftp numbering to the shared vocabulary', () => {
    expect(toFileType(1)).toBe('file');
    expect(toFileType(2)).toBe('directory');
    expect(toFileType(3)).toBe('symlink');
    expect(toFileType(0)).toBe('unknown');
    expect(toFileType(99)).toBe('unknown');
  });
});

describe('fromFileInfo', () => {
  it('carries a modification date through as epoch millis', () => {
    const at = new Date('2026-09-21T12:00:00.000Z');
    const entry = fromFileInfo({ name: 'readme.txt', type: 1, size: 18, modifiedAt: at });
    expect(entry).toMatchObject({ name: 'readme.txt', type: 'file', size: 18 });
    expect(entry.mtime).toBe(at.getTime());
  });

  it('leaves mtime undefined when the listing had no reliable date', () => {
    // Only MLSD guarantees a parseable date. Under LIST the year is implied and
    // the timezone is the server's, so an absent timestamp beats a wrong one.
    expect(fromFileInfo({ name: 'old.txt', type: 1, size: 3 }).mtime).toBeUndefined();
  });

  it('packs unix permissions back into mode bits', () => {
    const entry = fromFileInfo({
      name: 'script.sh',
      type: 1,
      size: 10,
      permissions: { user: 7, group: 5, world: 5 },
    });
    expect(entry.mode).toBe(0o755);
  });

  it('leaves mode undefined on a server that is not unix', () => {
    expect(fromFileInfo({ name: 'a.txt', type: 1, size: 1 }).mode).toBeUndefined();
  });
});

describe('toFileStat and toDirEntry', () => {
  it('does not invent an etag, because FTP has no version token', () => {
    const stat = toFileStat({ name: 'a.txt', type: 'file', size: 4, mtime: 1, mode: undefined });
    expect(stat.etag).toBeUndefined();
  });

  it('places a directory entry under its parent', () => {
    const entry = toDirEntry(
      { name: 'docs', type: 'directory', size: 0, mtime: undefined, mode: undefined },
      RemotePath.parse('/data'),
    );
    expect(entry.name).toBe('docs');
    expect(entry.path.value).toBe('/data/docs');
    expect(entry.type).toBe('directory');
  });
});

describe('resolveBase', () => {
  it('uses the login directory when the prefix is empty', () => {
    expect(resolveBase('', '/home/omnifs')).toBe('/home/omnifs');
  });

  it('puts a relative prefix below the login directory', () => {
    expect(resolveBase('public_html', '/home/omnifs')).toBe('/home/omnifs/public_html');
  });

  it('uses an absolute prefix as it stands', () => {
    expect(resolveBase('/srv/ftp/shared', '/home/omnifs')).toBe('/srv/ftp/shared');
  });

  it('answers the filesystem root for a lone slash', () => {
    expect(resolveBase('/', '/home/omnifs')).toBe('/');
  });

  it('collapses doubled slashes and drops a trailing one', () => {
    expect(resolveBase('docs/', '/home/omnifs/')).toBe('/home/omnifs/docs');
  });
});

describe('joinRemote', () => {
  it('returns the base itself for the connection root', () => {
    expect(joinRemote('/home/omnifs', RemotePath.ROOT)).toBe('/home/omnifs');
  });

  it('concatenates below the base', () => {
    expect(joinRemote('/home/omnifs', RemotePath.parse('/docs/guide.md'))).toBe(
      '/home/omnifs/docs/guide.md',
    );
  });

  it('does not double the slash when the base is the filesystem root', () => {
    expect(joinRemote('/', RemotePath.parse('/docs/guide.md'))).toBe('/docs/guide.md');
  });
});

describe('buildRange', () => {
  it('is undefined when no offset was asked for', () => {
    expect(buildRange(undefined)).toBeUndefined();
    expect(buildRange({})).toBeUndefined();
  });

  it('is an open-ended range when only an offset was given', () => {
    expect(buildRange({ offset: 5 })).toEqual({ start: 5 });
  });

  it('carries the length through, because FTP has no end-of-range on the wire', () => {
    expect(buildRange({ offset: 5, length: 10 })).toEqual({ start: 5, length: 10 });
  });

  it('answers empty for a zero-length range rather than an inverted one', () => {
    // Every range syntax in use is inclusive at both ends, so the arithmetic
    // alone would produce `bytes=5--1`. All four providers reached this case
    // independently; the conformance suite exists so the fifth does not have to.
    expect(buildRange({ offset: 5, length: 0 })).toBe('empty');
    expect(buildRange({ offset: 5, length: -1 })).toBe('empty');
  });
});

describe('parseMlstResponse', () => {
  const response = [
    '250-Listing /data/readme.txt',
    ' type=file;size=18;modify=20260921120000;UNIX.mode=0644; /data/readme.txt',
    '250 End',
  ].join('\n');

  it('reads the facts from the middle line of a multiline reply', () => {
    const entry = parseMlstResponse(response);
    expect(entry).toMatchObject({ name: 'readme.txt', type: 'file', size: 18, mode: 0o644 });
    expect(entry?.mtime).toBe(Date.UTC(2026, 8, 21, 12, 0, 0));
  });

  it('reads a directory', () => {
    const text = ['250-Listing', ' type=dir;size=4096; /data/docs', '250 End'].join('\n');
    expect(parseMlstResponse(text)?.type).toBe('directory');
  });

  it('reads cdir and pdir as directories too', () => {
    expect(parseMlstResponse('250-x\n type=cdir; /data\n250 End')?.type).toBe('directory');
    expect(parseMlstResponse('250-x\n type=pdir; /\n250 End')?.type).toBe('directory');
  });

  it('reads a unix symlink fact as a symlink', () => {
    const text = '250-x\n type=OS.unix=slink:/elsewhere; /data/link\n250 End';
    expect(parseMlstResponse(text)?.type).toBe('symlink');
  });

  it('is case-insensitive about fact names, as RFC 3659 requires', () => {
    const text = '250-x\n Type=File;Size=7; /data/a.txt\n250 End';
    expect(parseMlstResponse(text)).toMatchObject({ type: 'file', size: 7 });
  });

  it('keeps fractional seconds out of the way', () => {
    const text = '250-x\n type=file;size=1;modify=20260921120000.123; /data/a\n250 End';
    expect(parseMlstResponse(text)?.mtime).toBe(Date.UTC(2026, 8, 21, 12, 0, 0, 123));
  });

  it('tolerates a name containing spaces', () => {
    const text = '250-x\n type=file;size=2; /data/my file.txt\n250 End';
    expect(parseMlstResponse(text)?.name).toBe('my file.txt');
  });

  it('returns undefined when there is no fact line to read', () => {
    // The caller falls back to listing the parent, so an unparseable answer
    // costs a round trip rather than the whole stat.
    expect(parseMlstResponse('250 Command okay.')).toBeUndefined();
    expect(parseMlstResponse('')).toBeUndefined();
  });

  it('falls back to a zero size when the size fact is nonsense', () => {
    // The entry is still usable — type and name are what a listing needs — so
    // one bad fact does not cost the whole answer.
    expect(parseMlstResponse('250-x\n type=file;size=lots; /data/a\n250 End')?.size).toBe(0);
  });
});

describe('releasingStream', () => {
  it('releases once the source is drained', async () => {
    const release = vi.fn();
    const stream = releasingStream(streamFrom(new TextEncoder().encode('hello')), release);
    expect(new TextDecoder().decode(await collectStream(stream))).toBe('hello');
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases when the consumer walks away', async () => {
    // A tree view that closes a preview halfway through must not strand a
    // control channel for the life of the connection.
    const release = vi.fn();
    const stream = releasingStream(streamFrom(new Uint8Array([1, 2, 3])), release);
    await stream.cancel('done looking');
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases when the source fails', async () => {
    const release = vi.fn();
    const failing = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('connection lost');
      },
    });
    await expect(collectStream(releasingStream(failing, release))).rejects.toThrow(
      'connection lost',
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases exactly once however the stream ends', async () => {
    const release = vi.fn();
    const stream = releasingStream(streamFrom(new Uint8Array([1])), release);
    await collectStream(stream);
    await stream.cancel().catch(() => undefined);
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases exactly once when a cancel lands on an in-flight read', async () => {
    // The race the single-release guard actually exists for: `cancel` releases
    // and then cancels the reader, which resolves the read already in flight
    // with `done` — so the pull continuation reaches the drained path as well.
    // A second release there would hand one control channel to two callers.
    const release = vi.fn();
    let unblock = (): void => undefined;
    let reached = (): void => undefined;
    const pulling = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const slow = new ReadableStream<Uint8Array>({
      pull(): Promise<void> {
        reached();
        return new Promise<void>((resolve) => {
          unblock = resolve;
        });
      },
    });
    const reader = releasingStream(slow, release).getReader();
    const reading = reader.read();
    // Waiting for the source to be pulled is what puts the wrapper's own pull
    // in flight. Cancelling before that reaches a stream that never pulled, and
    // the race the guard exists for never happens.
    await pulling;

    await reader.cancel('changed my mind');
    unblock();
    await reading.catch(() => undefined);

    expect(release).toHaveBeenCalledOnce();
  });
});
