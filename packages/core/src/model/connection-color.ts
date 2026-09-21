/**
 * The colour a connection is tagged with, so production cannot be mistaken
 * for staging at a glance.
 *
 * Stored in `ConnectionConfig.color` as either a preset id (`'red'`) or a
 * custom lower-case `#rrggbb`. A preset carries a hex per theme, so it stays
 * readable on a light and on a dark background; that is why presets are
 * stored by id and not by value. A custom colour is shown exactly where a host
 * can paint arbitrary colour, and as its closest preset where it can only use
 * a theme colour — VS Code's tree labels and editor tabs are the case in point.
 *
 * Plain data and no host code, so both hosts draw the same palette.
 */

export interface ConnectionColorPreset {
  readonly id: string;
  readonly label: string;
  /** For a light background. */
  readonly light: string;
  /** For a dark background. */
  readonly dark: string;
}

/**
 * Eleven presets: with the custom picker they fill a six-by-two grid. The
 * light values hold text contrast on white, the dark ones on a dark editor.
 */
export const CONNECTION_COLOR_PRESETS: readonly ConnectionColorPreset[] = [
  { id: 'red', label: 'Red', light: '#c62828', dark: '#f47067' },
  { id: 'orange', label: 'Orange', light: '#bc4c00', dark: '#f0883e' },
  { id: 'yellow', label: 'Yellow', light: '#8a6d00', dark: '#e3b341' },
  { id: 'green', label: 'Green', light: '#1a7f37', dark: '#57ab5a' },
  { id: 'teal', label: 'Teal', light: '#0f7b6c', dark: '#39c5bb' },
  { id: 'blue', label: 'Blue', light: '#0969da', dark: '#539bf5' },
  { id: 'indigo', label: 'Indigo', light: '#4f46e5', dark: '#8b8cf6' },
  { id: 'purple', label: 'Purple', light: '#8250df', dark: '#b083f0' },
  { id: 'pink', label: 'Pink', light: '#bf3989', dark: '#ec6cb9' },
  { id: 'brown', label: 'Brown', light: '#8b5a2b', dark: '#c69c6d' },
  { id: 'gray', label: 'Gray', light: '#57606a', dark: '#9aa4ae' },
];

export interface ConnectionColor {
  /** What to store: a preset id, or a lower-case `#rrggbb`. */
  readonly value: string;
  /** The preset itself, or the closest one to a custom colour. */
  readonly preset: ConnectionColorPreset;
  /** The exact custom colour; `undefined` for a preset. */
  readonly custom: string | undefined;
}

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Reads a stored colour. Anything unrecognised is `undefined` rather than an
 * error: the setting is hand-editable, and a typo should cost the tint, not
 * the connection.
 */
export function parseConnectionColor(value: unknown): ConnectionColor | undefined {
  if (typeof value !== 'string') return undefined;

  const preset = CONNECTION_COLOR_PRESETS.find((candidate) => candidate.id === value);
  if (preset !== undefined) return { value, preset, custom: undefined };

  if (!HEX.test(value)) return undefined;
  const custom = value.toLowerCase();
  return { value: custom, preset: nearestPreset(custom), custom };
}

function nearestPreset(hex: string): ConnectionColorPreset {
  const target = rgb(hex);
  let best = CONNECTION_COLOR_PRESETS[0] as ConnectionColorPreset;
  let bestDistance = Infinity;
  for (const preset of CONNECTION_COLOR_PRESETS) {
    const distance = Math.min(
      distanceBetween(target, rgb(preset.light)),
      distanceBetween(target, rgb(preset.dark)),
    );
    if (distance < bestDistance) {
      best = preset;
      bestDistance = distance;
    }
  }
  return best;
}

type Rgb = readonly [number, number, number];

function rgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * The "redmean" approximation: plain Euclidean RGB distance, weighted by how
 * red the pair is. Cheap, and far closer to what an eye calls "nearest" than
 * the unweighted form, which confuses dark reds with browns.
 */
function distanceBetween(a: Rgb, b: Rgb): number {
  const redMean = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return (2 + redMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - redMean) / 256) * db * db;
}
