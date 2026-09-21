import type { ChangeEvent, CSSProperties, ReactNode } from 'react';
import { CONNECTION_COLOR_PRESETS, parseConnectionColor } from '@omni-fs/core';
import { presetSwatch } from '../model/swatch.js';
import { Button } from './primitives/index.js';

/**
 * Eleven preset swatches and a custom cell, six to a row. The custom cell is a
 * native `<input type="color">` stretched invisibly over the swatch, so the
 * host's own colour dialog opens and nothing here has to draw one.
 */
export function ColorPicker(props: {
  readonly id: string;
  readonly value: string | undefined;
  readonly onChange: (value: string | undefined) => void;
}): ReactNode {
  const color = parseConnectionColor(props.value);
  const custom = color?.custom;

  return (
    <div className="omni-color-picker">
      <div className="omni-swatches" id={props.id} role="group" aria-label="Color">
        {CONNECTION_COLOR_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="omni-swatch"
            title={preset.label}
            aria-label={preset.label}
            aria-pressed={color !== undefined && custom === undefined && color.preset === preset}
            style={swatchStyle(presetSwatch(preset))}
            onClick={() => props.onChange(preset.id)}
          />
        ))}
        <label
          className="omni-swatch omni-swatch-custom"
          title="Custom color…"
          data-selected={custom !== undefined}
          style={custom === undefined ? undefined : swatchStyle(custom)}
        >
          <input
            type="color"
            aria-label="Custom color"
            // A native colour input has no empty state; start from the nearest
            // preset so the dialog does not open on black.
            value={custom ?? color?.preset.light ?? '#808080'}
            onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(event.target.value)}
          />
        </label>
      </div>
      <Button disabled={color === undefined} onClick={() => props.onChange(undefined)}>
        None
      </Button>
    </div>
  );
}

function swatchStyle(swatch: string): CSSProperties {
  return { '--omni-swatch': swatch } as CSSProperties;
}
