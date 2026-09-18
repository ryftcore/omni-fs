import type { ConnectionDraft, DraftSection, FieldError, SettingsField } from '@omni-fs/core';

export const STORED_SECRET_PLACEHOLDER = '•••••••• stored — type to replace';

export type FieldControl =
  | {
      readonly kind: 'text';
      readonly type: 'text' | 'number';
      readonly value: string;
      readonly placeholder: string | undefined;
    }
  | {
      readonly kind: 'password';
      readonly value: string;
      readonly placeholder: string;
      /** True when the keychain holds a value the user has not replaced. */
      readonly stored: boolean;
    }
  | { readonly kind: 'checkbox'; readonly checked: boolean }
  | {
      readonly kind: 'select';
      readonly value: string;
      readonly options: readonly { readonly value: string; readonly label: string }[];
    }
  | { readonly kind: 'file'; readonly value: string };

export interface FieldView {
  readonly key: string;
  readonly section: DraftSection;
  readonly label: string;
  readonly required: boolean;
  readonly help: string | undefined;
  readonly error: string | undefined;
  readonly control: FieldControl;
}

/**
 * Turns one schema field plus the current draft into everything the renderer
 * needs. Pure, so the branching that actually matters is unit-tested without a
 * DOM and `SchemaField` stays a dumb switch.
 */
export function fieldView(
  field: SettingsField,
  section: DraftSection,
  draft: ConnectionDraft,
  error: FieldError | undefined,
  secretFieldsPresent: readonly string[],
): FieldView {
  return {
    key: field.key,
    section,
    label: field.label,
    required: 'required' in field && field.required === true,
    help: 'help' in field ? field.help : undefined,
    error: error?.message,
    control:
      section === 'secret'
        ? secretControl(field, draft, secretFieldsPresent)
        : settingsControl(field, draft.settings[field.key]),
  };
}

function settingsControl(field: SettingsField, value: unknown): FieldControl {
  switch (field.kind) {
    case 'boolean':
      return { kind: 'checkbox', checked: value === true };
    case 'select':
      return {
        kind: 'select',
        value: typeof value === 'string' ? value : '',
        options: field.options,
      };
    case 'file':
      return { kind: 'file', value: typeof value === 'string' ? value : '' };
    case 'number':
      return {
        kind: 'text',
        type: 'number',
        value: value === undefined ? '' : String(value),
        placeholder: undefined,
      };
    case 'password':
      return { kind: 'password', value: '', placeholder: 'Not set', stored: false };
    default:
      return {
        kind: 'text',
        type: 'text',
        value: typeof value === 'string' ? value : '',
        placeholder: field.placeholder,
      };
  }
}

function secretControl(
  field: SettingsField,
  draft: ConnectionDraft,
  secretFieldsPresent: readonly string[],
): FieldControl {
  const state = draft.secret[field.key] ?? { kind: 'unchanged' as const };

  if (state.kind === 'set') {
    return { kind: 'password', value: state.value, placeholder: 'Not set', stored: false };
  }
  if (state.kind === 'cleared') {
    return { kind: 'password', value: '', placeholder: 'Not set', stored: false };
  }

  const stored = secretFieldsPresent.includes(field.key);
  return {
    kind: 'password',
    value: '',
    placeholder: stored ? STORED_SECRET_PLACEHOLDER : 'Not set',
    stored,
  };
}
