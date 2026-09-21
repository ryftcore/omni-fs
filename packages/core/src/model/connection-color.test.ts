import { describe, expect, it } from 'vitest';
import { CONNECTION_COLOR_PRESETS, parseConnectionColor } from './connection-color.js';

describe('CONNECTION_COLOR_PRESETS', () => {
  it('fills a six-by-two grid with one cell left for the custom picker', () => {
    expect(CONNECTION_COLOR_PRESETS).toHaveLength(11);
  });

  it('has unique ids and a lower-case #rrggbb for each theme', () => {
    const ids = CONNECTION_COLOR_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of CONNECTION_COLOR_PRESETS) {
      expect(preset.light).toMatch(/^#[0-9a-f]{6}$/);
      expect(preset.dark).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('parseConnectionColor', () => {
  it('resolves a preset id to that preset', () => {
    const color = parseConnectionColor('red');
    expect(color?.value).toBe('red');
    expect(color?.preset.id).toBe('red');
    expect(color?.custom).toBeUndefined();
  });

  it('keeps a custom hex exactly and lower-cases it', () => {
    const color = parseConnectionColor('#AbCdEf');
    expect(color?.value).toBe('#abcdef');
    expect(color?.custom).toBe('#abcdef');
  });

  it('pairs a custom hex with the closest preset, for surfaces limited to theme colours', () => {
    expect(parseConnectionColor('#ff0000')?.preset.id).toBe('red');
    expect(parseConnectionColor('#1e90ff')?.preset.id).toBe('blue');
    expect(parseConnectionColor('#00b000')?.preset.id).toBe('green');
    expect(parseConnectionColor('#808080')?.preset.id).toBe('gray');
  });

  it('matches a preset’s own hex back to that preset', () => {
    for (const preset of CONNECTION_COLOR_PRESETS) {
      expect(parseConnectionColor(preset.light)?.preset.id).toBe(preset.id);
      expect(parseConnectionColor(preset.dark)?.preset.id).toBe(preset.id);
    }
  });

  it.each([undefined, null, '', 'crimson', '#fff', '#12345g', 'ff0000', 42, {}])(
    'ignores %j rather than failing, since settings.json is hand-editable',
    (value) => {
      expect(parseConnectionColor(value)).toBeUndefined();
    },
  );
});
