import type { ConnectionConfig } from '../model/connection.js';
import type { ProviderDefinition, SettingsField } from '../provider.js';
import type { ConnectionDraft, DraftSection, ProviderSummary, SecretPatchEntry } from './types.js';

/** Projects a registered provider onto the serializable subset a form needs. */
export function toProviderSummary(definition: ProviderDefinition): ProviderSummary {
  return {
    id: definition.id,
    displayName: definition.displayName,
    settingsSchema: definition.settingsSchema,
    secretSchema: definition.secretSchema,
  };
}

/**
 * Builds a draft. Pass `config` to edit an existing connection.
 */
export function createDraft(provider: ProviderSummary, config?: ConnectionConfig): ConnectionDraft {
  const settings: Record<string, unknown> = {};
  for (const field of provider.settingsSchema.fields) {
    const stored = config?.settings[field.key];
    if (stored !== undefined) {
      settings[field.key] = stored;
      continue;
    }
    const fallback = defaultValue(field);
    if (fallback !== undefined) settings[field.key] = fallback;
  }

  const secret: Record<string, { kind: 'unchanged' }> = {};
  for (const field of provider.secretSchema.fields) {
    secret[field.key] = { kind: 'unchanged' };
  }

  const label = config?.label ?? '';
  const rootPath = config?.rootPath ?? '/';
  const readOnly = config?.readOnly ?? false;

  return {
    id: config?.id,
    providerId: provider.id,
    label,
    settings,
    secret,
    rootPath,
    readOnly,
    baseline: { label, settings: { ...settings }, rootPath, readOnly },
  };
}

export function setLabel(draft: ConnectionDraft, label: string): ConnectionDraft {
  return { ...draft, label };
}

export function setRootPath(draft: ConnectionDraft, rootPath: string): ConnectionDraft {
  return { ...draft, rootPath };
}

export function setReadOnly(draft: ConnectionDraft, readOnly: boolean): ConnectionDraft {
  return { ...draft, readOnly };
}

export function setField(
  draft: ConnectionDraft,
  section: DraftSection,
  key: string,
  value: unknown,
): ConnectionDraft {
  if (section === 'settings') {
    return { ...draft, settings: { ...draft.settings, [key]: value } };
  }
  return {
    ...draft,
    secret: { ...draft.secret, [key]: { kind: 'set', value: String(value) } },
  };
}

export function clearSecretField(draft: ConnectionDraft, key: string): ConnectionDraft {
  return { ...draft, secret: { ...draft.secret, [key]: { kind: 'cleared' } } };
}

export function isDirty(draft: ConnectionDraft): boolean {
  if (draft.label !== draft.baseline.label) return true;
  if (draft.rootPath !== draft.baseline.rootPath) return true;
  if (draft.readOnly !== draft.baseline.readOnly) return true;

  const keys = new Set([...Object.keys(draft.settings), ...Object.keys(draft.baseline.settings)]);
  for (const key of keys) {
    if (draft.settings[key] !== draft.baseline.settings[key]) return true;
  }

  return Object.values(draft.secret).some((state) => state.kind !== 'unchanged');
}

export function toSecretPatch(draft: ConnectionDraft): Readonly<Record<string, SecretPatchEntry>> {
  const patch: Record<string, SecretPatchEntry> = {};
  for (const [key, state] of Object.entries(draft.secret)) {
    if (state.kind === 'set') patch[key] = { set: state.value };
    else if (state.kind === 'cleared') patch[key] = { clear: true };
  }
  return patch;
}

function defaultValue(field: SettingsField): unknown {
  switch (field.kind) {
    case 'number':
      return field.default;
    case 'boolean':
      return field.default;
    case 'select':
      return field.default;
    default:
      return undefined;
  }
}
