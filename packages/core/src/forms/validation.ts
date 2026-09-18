import type { SettingsField } from '../provider.js';
import type { ConnectionDraft, FieldError, ProviderSummary } from './types.js';

/**
 * Validates only what the schema can express: required, number range, select
 * membership. Provider-specific rules stay in the provider, where
 * `readSettings()` already enforces them.
 */
export function validateDraft(
  draft: ConnectionDraft,
  provider: ProviderSummary,
  secretFieldsPresent: readonly string[] = [],
): readonly FieldError[] {
  const errors: FieldError[] = [];

  if (draft.label.trim() === '') {
    errors.push({ section: 'label', key: 'label', message: 'A name is required' });
  }

  for (const field of provider.settingsSchema.fields) {
    const error = validateField(field, draft.settings[field.key]);
    if (error !== undefined) errors.push({ section: 'settings', key: field.key, ...error });
  }

  for (const field of provider.secretSchema.fields) {
    // `required` isn't declared on the `boolean` field kind, so it must be
    // narrowed with `in` before it can be read on the general union.
    if (!('required' in field) || field.required !== true) continue;
    const state = draft.secret[field.key] ?? { kind: 'unchanged' as const };

    // Satisfied if the user typed something, or if it is untouched and the
    // keychain already holds a value.
    const satisfied =
      (state.kind === 'set' && state.value !== '') ||
      (state.kind === 'unchanged' && secretFieldsPresent.includes(field.key));

    if (!satisfied) {
      errors.push({
        section: 'secret',
        key: field.key,
        message: `${field.label} is required`,
      });
    }
  }

  return errors;
}

export function validateField(
  field: SettingsField,
  value: unknown,
): { message: string } | undefined {
  const missing = value === undefined || value === null || value === '';

  // Same narrowing as above: `boolean` fields have no `required` key.
  if ('required' in field && field.required === true && missing) {
    return { message: `${field.label} is required` };
  }
  if (missing) return undefined;

  if (field.kind === 'number') {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(numeric)) return { message: `${field.label} must be a number` };

    const min = field.min;
    const max = field.max;
    if (min !== undefined && max !== undefined && (numeric < min || numeric > max)) {
      return { message: `${field.label} must be between ${min} and ${max}` };
    }
    if (min !== undefined && numeric < min) {
      return { message: `${field.label} must be at least ${min}` };
    }
    if (max !== undefined && numeric > max) {
      return { message: `${field.label} must be at most ${max}` };
    }
  }

  if (field.kind === 'select') {
    const allowed = field.options.some((option) => option.value === value);
    if (!allowed) return { message: `${field.label} is not a valid option` };
  }

  return undefined;
}
