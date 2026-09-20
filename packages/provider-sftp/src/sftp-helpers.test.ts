import { describe, expect, it } from 'vitest';
import { RemotePath } from '@omni-fs/core';
import { joinRemote, resolveBase, toFileStat, toFileType } from './sftp-helpers.js';

describe('toFileType', () => {
  it.each([
    [0o100644, 'file'],
    [0o040755, 'directory'],
    [0o120777, 'symlink'],
    [0o010644, 'unknown'],
  ])('reads mode %s as %s', (mode, type) => {
    expect(toFileType(mode)).toBe(type);
  });
});

describe('toFileStat', () => {
  it('converts SFTP seconds into the epoch millis core expects', () => {
    const stat = toFileStat({
      mode: 0o100644,
      size: 12,
      mtime: 1_700_000_000,
      uid: 1000,
      gid: 1000,
    });
    expect(stat).toMatchObject({ type: 'file', size: 12, mtime: 1_700_000_000_000 });
    expect(stat.mode).toBe(0o100644);
    expect(stat.raw).toEqual({ uid: 1000, gid: 1000 });
  });

  it('never reports a version token, because SFTP has none', () => {
    expect(toFileStat({ mode: 0o100644, size: 1, mtime: 1, uid: 0, gid: 0 }).etag).toBeUndefined();
  });
});

describe('resolveBase', () => {
  it('uses the login directory when no prefix is set', () => {
    expect(resolveBase('', '/home/omnifs')).toBe('/home/omnifs');
  });

  it('puts a relative prefix below the login directory', () => {
    expect(resolveBase('projects', '/home/omnifs')).toBe('/home/omnifs/projects');
  });

  it('takes an absolute prefix as the server path it is', () => {
    expect(resolveBase('/var/www', '/home/omnifs')).toBe('/var/www');
  });

  it('collapses repeated slashes and drops a trailing one', () => {
    expect(resolveBase('projects', '/home/omnifs/')).toBe('/home/omnifs/projects');
  });

  it('keeps the filesystem root usable as a base', () => {
    expect(resolveBase('/', '/home/omnifs')).toBe('/');
  });
});

describe('joinRemote', () => {
  it('joins a connection path onto the base', () => {
    expect(joinRemote('/home/omnifs', RemotePath.parse('/docs/a.txt'))).toBe(
      '/home/omnifs/docs/a.txt',
    );
  });

  it('maps the connection root onto the base itself', () => {
    expect(joinRemote('/home/omnifs', RemotePath.ROOT)).toBe('/home/omnifs');
  });

  it('does not double the slash when the base is the filesystem root', () => {
    expect(joinRemote('/', RemotePath.parse('/a.txt'))).toBe('/a.txt');
    expect(joinRemote('/', RemotePath.ROOT)).toBe('/');
  });
});
