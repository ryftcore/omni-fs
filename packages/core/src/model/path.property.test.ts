import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { RemotePath } from './path.js';

/**
 * The invariants at the top of `path.ts`, held against inputs nobody thought
 * to write down.
 *
 * `path.test.ts` covers the cases a person imagines: `..` past the root, a
 * trailing slash, a dotfile. This covers the ones they do not — a segment that
 * is only dots, a path of nothing but separators, `..` interleaved with names
 * until it is no longer obvious what should be left. Every provider normalises
 * its own protocol's spelling into this shape at the boundary, so a path that
 * escapes the invariants escapes into all four of them at once.
 *
 * Scorecard counts property-based tests as fuzzing, which is the other reason
 * these are here; the reason they are *here* rather than anywhere else is that
 * `RemotePath` is the one type every layer handles.
 */

/** Raw input: separators, names, and the two segments that mean something. */
const rawPath = fc
  .array(fc.constantFrom('a', 'b', '.', '..', '...', '', 'x.txt', ' ', '/'), { maxLength: 12 })
  .map((parts) => parts.join('/'));

/** A segment that names something, rather than navigating. */
const name = fc.stringMatching(/^[a-zA-Z0-9._-]+$/).filter((s) => s !== '.' && s !== '..');

describe('RemotePath.parse invariants', () => {
  it('always produces an absolute, non-empty path', () => {
    fc.assert(
      fc.property(rawPath, (raw) => {
        const value = RemotePath.parse(raw).value;
        expect(value.startsWith('/')).toBe(true);
        expect(value).not.toBe('');
      }),
    );
  });

  it('never leaves a trailing slash except on the root', () => {
    fc.assert(
      fc.property(rawPath, (raw) => {
        const path = RemotePath.parse(raw);
        if (!path.isRoot) expect(path.value.endsWith('/')).toBe(false);
      }),
    );
  });

  it('resolves away every empty, "." and ".." segment', () => {
    fc.assert(
      fc.property(rawPath, (raw) => {
        for (const segment of RemotePath.parse(raw).segments) {
          expect(segment).not.toBe('');
          expect(segment).not.toBe('.');
          expect(segment).not.toBe('..');
        }
      }),
    );
  });

  it('is idempotent: parsing its own value changes nothing', () => {
    fc.assert(
      fc.property(rawPath, (raw) => {
        const once = RemotePath.parse(raw);
        expect(RemotePath.parse(once.value).value).toBe(once.value);
      }),
    );
  });

  it('cannot be walked above the root', () => {
    fc.assert(
      fc.property(rawPath, fc.nat({ max: 20 }), (raw, depth) => {
        const climbed = RemotePath.parse(`${raw}/${'../'.repeat(depth)}`);
        expect(climbed.value.startsWith('/')).toBe(true);
        // A segment of `..`, not a value containing one: `...` is an ordinary
        // name that survives normalisation, which is what this first caught.
        expect(climbed.segments).not.toContain('..');
      }),
    );
  });
});

describe('RemotePath relationships', () => {
  it('parent then basename rebuilds the path', () => {
    fc.assert(
      fc.property(rawPath, (raw) => {
        const path = RemotePath.parse(raw);
        if (path.isRoot) return;
        expect(path.basename).not.toBe('');
        expect(path.parent.join(path.basename).equals(path)).toBe(true);
      }),
    );
  });

  it('a path contains what it joins, and reports it back as relative', () => {
    fc.assert(
      fc.property(rawPath, name, (raw, segment) => {
        const path = RemotePath.parse(raw);
        const child = path.join(segment);
        expect(path.contains(child)).toBe(true);
        expect(path.relative(child)).toBe(segment);
      }),
    );
  });

  it('the root contains everything, and every path contains itself', () => {
    fc.assert(
      fc.property(rawPath, (raw) => {
        const path = RemotePath.parse(raw);
        expect(RemotePath.ROOT.contains(path)).toBe(true);
        expect(path.contains(path)).toBe(true);
        expect(path.relative(path)).toBe('');
      }),
    );
  });

  it('the object-store spellings agree: a prefix is its key plus a slash', () => {
    fc.assert(
      fc.property(rawPath, (raw) => {
        const path = RemotePath.parse(raw);
        if (path.isRoot) {
          expect(path.toKey()).toBe('');
          expect(path.toPrefix()).toBe('');
          return;
        }
        expect(path.toKey().startsWith('/')).toBe(false);
        expect(path.toPrefix()).toBe(`${path.toKey()}/`);
      }),
    );
  });

  it('segments rebuild the path they came from', () => {
    fc.assert(
      fc.property(rawPath, (raw) => {
        const path = RemotePath.parse(raw);
        expect(RemotePath.ROOT.join(...path.segments).equals(path)).toBe(true);
      }),
    );
  });
});
