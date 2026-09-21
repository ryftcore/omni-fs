import { parseConnectionColor } from '@omni-fs/core';
import type { ConnectionColorPreset } from '@omni-fs/core';

/**
 * A preset paints through `--omni-color-<id>`, so a host can hand it the
 * theme-correct shade: `apps/vscode` maps it onto the colours the extension
 * contributes, which have light, dark and high-contrast values. The fallback
 * is the light hex, matching the standalone tokens in `tokens.css`.
 */
export function presetSwatch(preset: ConnectionColorPreset): string {
  return `var(--omni-color-${preset.id}, ${preset.light})`;
}

/** The CSS colour for a stored `ConnectionConfig.color`, or `undefined` for none. */
export function swatchFor(value: string | undefined): string | undefined {
  const color = parseConnectionColor(value);
  if (color === undefined) return undefined;
  return color.custom ?? presetSwatch(color.preset);
}
