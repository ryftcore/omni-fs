import { describe, expect, it } from 'vitest';
import { RemotePath } from '@omni-fs/core';
import { buildRange, copySource, keyFor, prefixFor } from './s3-helpers.js';
import type { S3Settings } from './settings.js';

/**
 * The translation between the one path shape the rest of the system uses and
 * the flat keyspace S3 actually has. Everything here used to be private to
 * `S3FileSystem`, which meant the only way to reach it was over the network.
 */

function settings(overrides: Partial<S3Settings> = {}): S3Settings {
  return {
    bucket: 'omni-fs-test',
    region: 'us-east-1',
    endpoint: undefined,
    forcePathStyle: true,
    rootPrefix: '',
    storageClass: undefined,
    serverSideEncryption: undefined,
    ...overrides,
  };
}

const p = (value: string): RemotePath => RemotePath.parse(value);

describe('keyFor', () => {
  it('drops the leading slash, because S3 keys have none', () => {
    expect(keyFor(settings(), p('/a.txt'))).toBe('a.txt');
    expect(keyFor(settings(), p('/docs/guide.md'))).toBe('docs/guide.md');
  });

  it('prepends the connection root prefix', () => {
    expect(keyFor(settings({ rootPrefix: 'projects/site' }), p('/a.txt'))).toBe(
      'projects/site/a.txt',
    );
  });

  it('gives the bucket root an empty key when the connection is unscoped', () => {
    expect(keyFor(settings(), RemotePath.ROOT)).toBe('');
  });

  it('gives the root of a scoped connection the prefix itself', () => {
    // Asymmetric with the unscoped case on purpose. The one caller that reaches
    // here with the root is the recursive delete's trailing sweep, and
    // `docs/` is exactly the directory-placeholder key it wants to remove.
    // Every other caller guards the root before calling.
    expect(keyFor(settings({ rootPrefix: 'docs' }), RemotePath.ROOT)).toBe('docs/');
  });
});

describe('prefixFor', () => {
  it('ends with a slash, so a listing cannot match a sibling by prefix', () => {
    // Without the separator, listing `/a/tree` would also return everything
    // under `/a/tree-other`.
    expect(prefixFor(settings(), p('/a/tree'))).toBe('a/tree/');
  });

  it('is empty at the root of an unscoped connection, meaning the whole bucket', () => {
    expect(prefixFor(settings(), RemotePath.ROOT)).toBe('');
  });

  it('is the root prefix itself at the root of a scoped connection', () => {
    expect(prefixFor(settings({ rootPrefix: 'docs' }), RemotePath.ROOT)).toBe('docs/');
  });

  it('prepends the root prefix below the root', () => {
    expect(prefixFor(settings({ rootPrefix: 'docs' }), p('/nested'))).toBe('docs/nested/');
  });
});

describe('copySource', () => {
  it('names the bucket and the key', () => {
    expect(copySource('omni-fs-test', 'docs/guide.md')).toBe('omni-fs-test/docs/guide.md');
  });

  it('encodes a key that would otherwise break the header', () => {
    // A space or a `+` left raw is read by S3 as a different key, so the copy
    // silently reads the wrong object or 404s.
    expect(copySource('b', 'my file.txt')).toBe('b/my%20file.txt');
    expect(copySource('b', 'a+b.txt')).toBe('b/a%2Bb.txt');
    expect(copySource('b', 'café.txt')).toBe('b/caf%C3%A9.txt');
  });

  it('leaves the slashes between key segments literal', () => {
    // Encoding these to %2F addresses one object whose name contains slashes,
    // which is not the same object at all.
    expect(copySource('b', 'a/b/c.txt')).toBe('b/a/b/c.txt');
  });
});

describe('buildRange', () => {
  it('asks for no range when the caller gave no offset', () => {
    expect(buildRange(undefined)).toBeUndefined();
    expect(buildRange({})).toBeUndefined();
  });

  it('spells an open-ended range as everything from the offset', () => {
    expect(buildRange({ offset: 5 })).toEqual({ header: 'bytes=5-' });
  });

  it('spells a counted range with an inclusive end', () => {
    // HTTP ranges are inclusive at both ends, so N bytes from `start` ends at
    // `start + N - 1`. Off by one here reads one byte too many.
    expect(buildRange({ offset: 0, length: 7 })).toEqual({ header: 'bytes=0-6' });
    expect(buildRange({ offset: 5, length: 10 })).toEqual({ header: 'bytes=5-14' });
  });

  it('reports a zero-length read as empty rather than as an inverted range', () => {
    // `bytes=0--1` is what the arithmetic produces unguarded. S3 answers an
    // invalid range with 416, or ignores the header and sends the whole
    // object back for a request that wanted nothing at all. There is no Range
    // spelling for zero bytes, so the caller has to answer it without one —
    // which is what `provider-webdav` and `provider-sftp` already do.
    expect(buildRange({ offset: 0, length: 0 })).toBe('empty');
    expect(buildRange({ offset: 5, length: 0 })).toBe('empty');
  });

  it('treats a negative length as empty too', () => {
    expect(buildRange({ offset: 5, length: -1 })).toBe('empty');
  });

  it('ignores a length given without an offset', () => {
    // Consistent with `MemoryFileSystem`, the contract's reference, which
    // returns the whole file when no offset was given.
    expect(buildRange({ length: 10 })).toBeUndefined();
  });
});
