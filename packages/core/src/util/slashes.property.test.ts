import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { trimLeadingSlashes, trimSlashes, trimTrailingSlashes } from './slashes.js';

/**
 * The rewrite that replaced `/^\/+|\/+$/g` has to mean the same thing.
 *
 * These were swapped in across four files to take the quadratic regular
 * expression out of every provider's settings parsing, and "means the same
 * thing" is a claim about all inputs, not the handful anyone lists. So the
 * regular expression stays here as an oracle — the one place it is safe,
 * because the input is bounded — and the properties below say the two agree.
 */

/** Short, so the regex oracle stays cheap; slash-dense, so the trimming bites. */
const slashy = fc.string({ unit: fc.constantFrom('/', 'a', 'b'), maxLength: 24 });

describe('agreement with the regular expression it replaced', () => {
  it('trimTrailingSlashes matches /\\/+$/', () => {
    fc.assert(
      fc.property(slashy, (value) => {
        expect(trimTrailingSlashes(value)).toBe(value.replace(/\/+$/, ''));
      }),
    );
  });

  it('trimLeadingSlashes matches /^\\/+/', () => {
    fc.assert(
      fc.property(slashy, (value) => {
        expect(trimLeadingSlashes(value)).toBe(value.replace(/^\/+/, ''));
      }),
    );
  });

  it('trimSlashes matches /^\\/+|\\/+$/g', () => {
    fc.assert(
      fc.property(slashy, (value) => {
        expect(trimSlashes(value)).toBe(value.replace(/^\/+|\/+$/g, ''));
      }),
    );
  });
});

describe('invariants, on any string at all', () => {
  it('leaves nothing to trim, and trimming again changes nothing', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const trimmed = trimSlashes(value);
        expect(trimmed.startsWith('/')).toBe(false);
        expect(trimmed.endsWith('/')).toBe(false);
        expect(trimSlashes(trimmed)).toBe(trimmed);
      }),
    );
  });

  it('only ever removes slashes, and only from the ends', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const trimmed = trimSlashes(value);
        expect(value).toContain(trimmed);
        // What came off was slashes and nothing else.
        expect(value.replaceAll('/', '')).toBe(trimmed.replaceAll('/', ''));
      }),
    );
  });

  it('a value of nothing but slashes empties, and any other keeps its core', () => {
    fc.assert(
      fc.property(fc.nat({ max: 40 }), fc.nat({ max: 40 }), slashy, (before, after, middle) => {
        const core = trimSlashes(middle);
        const padded = `${'/'.repeat(before)}${core}${'/'.repeat(after)}`;
        expect(trimSlashes(padded)).toBe(core);
      }),
    );
  });
});
