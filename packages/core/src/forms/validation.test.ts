import { describe, expect, it } from 'vitest';
import { createDraft, setField, setLabel } from './draft.js';
import { validateDraft } from './validation.js';
import type { ProviderSummary } from './types.js';

const provider: ProviderSummary = {
  id: 'demo',
  displayName: 'Demo',
  settingsSchema: {
    fields: [
      { kind: 'text', key: 'host', label: 'Host', required: true },
      { kind: 'number', key: 'port', label: 'Port', min: 1, max: 65535 },
      {
        kind: 'select',
        key: 'mode',
        label: 'Mode',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      },
    ],
  },
  secretSchema: {
    fields: [{ kind: 'password', key: 'password', label: 'Password', required: true }],
  },
};

describe('validateDraft', () => {
  it('requires a label', () => {
    const errors = validateDraft(createDraft(provider), provider);
    expect(errors).toContainEqual({
      section: 'label',
      key: 'label',
      message: 'A name is required',
    });
  });

  it('requires required settings and reports the field label', () => {
    const errors = validateDraft(createDraft(provider), provider);
    expect(errors).toContainEqual({
      section: 'settings',
      key: 'host',
      message: 'Host is required',
    });
  });

  it('rejects a number outside its range and a non-numeric value', () => {
    let draft = setLabel(createDraft(provider), 'x');
    draft = setField(draft, 'settings', 'host', 'h');
    draft = setField(draft, 'secret', 'password', 'p');

    expect(validateDraft(setField(draft, 'settings', 'port', 0), provider)).toContainEqual({
      section: 'settings',
      key: 'port',
      message: 'Port must be between 1 and 65535',
    });
    expect(validateDraft(setField(draft, 'settings', 'port', 70000), provider)).toContainEqual({
      section: 'settings',
      key: 'port',
      message: 'Port must be between 1 and 65535',
    });
    expect(validateDraft(setField(draft, 'settings', 'port', 'abc'), provider)).toContainEqual({
      section: 'settings',
      key: 'port',
      message: 'Port must be a number',
    });
  });

  it('rejects a select value that is not an option', () => {
    let draft = setLabel(createDraft(provider), 'x');
    draft = setField(draft, 'settings', 'host', 'h');
    draft = setField(draft, 'secret', 'password', 'p');
    draft = setField(draft, 'settings', 'mode', 'zzz');
    expect(validateDraft(draft, provider)).toContainEqual({
      section: 'settings',
      key: 'mode',
      message: 'Mode is not a valid option',
    });
  });

  it('accepts an unchanged required secret on a saved connection', () => {
    // The value lives in the keychain; the draft only knows it was not touched.
    let draft = createDraft(provider, {
      id: 'c1',
      providerId: 'demo',
      label: 'prod',
      settings: { host: 'h' },
    });
    draft = setField(draft, 'settings', 'mode', 'a');
    expect(validateDraft(draft, provider, ['password'])).toEqual([]);
  });

  it('requires a secret when nothing is stored and nothing was typed', () => {
    let draft = setLabel(createDraft(provider), 'x');
    draft = setField(draft, 'settings', 'host', 'h');
    expect(validateDraft(draft, provider)).toContainEqual({
      section: 'secret',
      key: 'password',
      message: 'Password is required',
    });
  });

  it('requires a secret again once it is explicitly cleared', () => {
    let draft = createDraft(provider, {
      id: 'c1',
      providerId: 'demo',
      label: 'prod',
      settings: { host: 'h' },
    });
    draft = { ...draft, secret: { ...draft.secret, password: { kind: 'cleared' } } };
    expect(validateDraft(draft, provider, ['password'])).toContainEqual({
      section: 'secret',
      key: 'password',
      message: 'Password is required',
    });
  });
});
