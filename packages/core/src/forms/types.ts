import type { ConnectionId, ProviderId } from '../model/connection.js';
import type { SettingsSchema } from '../provider.js';

/** Which half of a connection a field belongs to. */
export type DraftSection = 'settings' | 'secret';

/**
 * A secret field in an unsaved draft. Three states, not two: without
 * `cleared`, an optional credential (S3's session token) could never be
 * removed once stored, because "empty" is indistinguishable from "untouched".
 */
export type SecretFieldState =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'set'; readonly value: string }
  | { readonly kind: 'cleared' };

/** The serializable subset of a provider a form needs. `ProviderDefinition`
 *  carries a `create()` closure and cannot cross a `postMessage` boundary. */
export interface ProviderSummary {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly settingsSchema: SettingsSchema;
  readonly secretSchema: SettingsSchema;
}

export interface DraftBaseline {
  readonly label: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly rootPath: string;
  readonly readOnly: boolean;
  readonly color: string | undefined;
}

export interface ConnectionDraft {
  /** `undefined` means this draft has never been saved. */
  readonly id: ConnectionId | undefined;
  readonly providerId: ProviderId;
  readonly label: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly secret: Readonly<Record<string, SecretFieldState>>;
  readonly rootPath: string;
  readonly readOnly: boolean;
  /** A preset id or `#rrggbb`, already normalised; `undefined` for none. */
  readonly color: string | undefined;
  /** What was loaded, so `isDirty` can compare without a second source. */
  readonly baseline: DraftBaseline;
}

export interface FieldError {
  readonly section: DraftSection | 'label';
  readonly key: string;
  readonly message: string;
}

export type SecretPatchEntry = { readonly set: string } | { readonly clear: true };
