import type { ConnectionSecret } from '../model/connection.js';
import type { SettingsSchema } from '../provider.js';
import type { SecretPatchEntry } from './types.js';

/**
 * Applies a patch from the UI to whatever the keychain already holds.
 *
 * This runs in the host, never in a webview: the stored secret is one of its
 * two inputs, and the whole design keeps stored secrets out of the UI process.
 */
export function mergeSecret(
  stored: ConnectionSecret | undefined,
  patch: Readonly<Record<string, SecretPatchEntry>>,
  schema: SettingsSchema,
): ConnectionSecret {
  const declared = new Set(schema.fields.map((field) => field.key));
  const next: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(stored ?? {})) {
    if (declared.has(key)) next[key] = value;
  }

  for (const [key, entry] of Object.entries(patch)) {
    if (!declared.has(key)) continue;
    if ('clear' in entry) delete next[key];
    else next[key] = entry.set;
  }

  return next;
}
