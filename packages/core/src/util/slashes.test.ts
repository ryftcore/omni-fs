import { describe, expect, it } from 'vitest';

import { trimLeadingSlashes, trimSlashes, trimTrailingSlashes } from './slashes.js';

describe('trimTrailingSlashes', () => {
  it('drops a trailing slash', () => {
    expect(trimTrailingSlashes('/a/b/')).toBe('/a/b');
  });

  it('drops a run of them', () => {
    expect(trimTrailingSlashes('/a/b///')).toBe('/a/b');
  });

  it('leaves the separators between segments alone', () => {
    expect(trimTrailingSlashes('/a//b')).toBe('/a//b');
  });

  it('empties a value that is nothing but slashes', () => {
    expect(trimTrailingSlashes('///')).toBe('');
  });

  it('passes through a value with nothing to trim', () => {
    expect(trimTrailingSlashes('')).toBe('');
    expect(trimTrailingSlashes('a/b')).toBe('a/b');
  });
});

describe('trimLeadingSlashes', () => {
  it('drops a run of leading slashes', () => {
    expect(trimLeadingSlashes('//a/b')).toBe('a/b');
  });

  it('empties a value that is nothing but slashes', () => {
    expect(trimLeadingSlashes('///')).toBe('');
  });

  it('passes through a value with nothing to trim', () => {
    expect(trimLeadingSlashes('a/b')).toBe('a/b');
  });
});

describe('trimSlashes', () => {
  it('trims both ends and keeps the middle', () => {
    expect(trimSlashes('//a/b//')).toBe('a/b');
  });

  it('empties a value that is nothing but slashes', () => {
    expect(trimSlashes('///')).toBe('');
  });
});

/**
 * The reason these exist rather than `value.replace(/\/+$/, '')`.
 *
 * A regular expression restarts `\/+` at every position in the run and walks
 * to the end of it before `$` fails, so a long run of slashes followed by one
 * other character costs O(n²) — seconds here, and the finding CodeQL raised
 * against every settings file that trimmed a `rootPrefix`. Scanning from the
 * end is linear, so this returns before the test's timeout rather than long
 * after it.
 */
describe('cost', () => {
  const runThenOneMore = `${'/'.repeat(200_000)}a`;

  it('stays linear on a long run of slashes that does not reach the end', () => {
    expect(trimTrailingSlashes(runThenOneMore)).toBe(runThenOneMore);
  });

  it('stays linear from the other side', () => {
    expect(trimLeadingSlashes(`a${'/'.repeat(200_000)}`)).toBe(`a${'/'.repeat(200_000)}`);
  });
});
