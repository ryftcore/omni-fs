import { describe, expect, it } from 'vitest';
import { CONNECTION_COLOR_PRESETS } from '@omni-fs/core';
import { presetSwatch, swatchFor } from './swatch.js';

describe('swatchFor', () => {
  it('paints a preset through a host-overridable token, falling back to its light hex', () => {
    expect(swatchFor('red')).toBe('var(--omni-color-red, #c62828)');
  });

  it('paints a custom colour exactly', () => {
    expect(swatchFor('#AABBCC')).toBe('#aabbcc');
  });

  it('paints nothing for no colour or an unrecognised one', () => {
    expect(swatchFor(undefined)).toBeUndefined();
    expect(swatchFor('crimson')).toBeUndefined();
  });

  it('gives every preset its own token', () => {
    const tokens = CONNECTION_COLOR_PRESETS.map(presetSwatch);
    expect(new Set(tokens).size).toBe(CONNECTION_COLOR_PRESETS.length);
  });
});
