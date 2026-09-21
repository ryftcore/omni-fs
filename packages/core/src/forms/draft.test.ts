import { describe, expect, it } from 'vitest';
import {
  clearSecretField,
  createDraft,
  isDirty,
  setField,
  setColor,
  setLabel,
  toSecretPatch,
} from './draft.js';
import type { ProviderSummary } from './types.js';

const provider: ProviderSummary = {
  id: 'demo',
  displayName: 'Demo',
  settingsSchema: {
    fields: [
      { kind: 'text', key: 'host', label: 'Host', required: true },
      { kind: 'number', key: 'port', label: 'Port', default: 22 },
      { kind: 'boolean', key: 'secure', label: 'Secure', default: true },
      {
        kind: 'select',
        key: 'mode',
        label: 'Mode',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
        default: 'a',
      },
    ],
  },
  secretSchema: {
    fields: [
      { kind: 'password', key: 'password', label: 'Password', required: true },
      { kind: 'password', key: 'token', label: 'Token' },
    ],
  },
};

describe('createDraft', () => {
  it('applies schema defaults for a new connection', () => {
    const draft = createDraft(provider);
    expect(draft.id).toBeUndefined();
    expect(draft.settings).toEqual({ port: 22, secure: true, mode: 'a' });
    expect(draft.label).toBe('');
  });

  it('loads an existing config and marks every secret unchanged', () => {
    const draft = createDraft(provider, {
      id: 'c1',
      providerId: 'demo',
      label: 'prod',
      settings: { host: 'example.com', port: 2222 },
      rootPath: '/srv',
    });
    expect(draft.id).toBe('c1');
    expect(draft.settings['host']).toBe('example.com');
    // A stored value wins over the schema default.
    expect(draft.settings['port']).toBe(2222);
    // A field with no stored value still gets its default.
    expect(draft.settings['secure']).toBe(true);
    // Every secret field starts unchanged, whatever is actually stored — the
    // form learns what is stored from `secretFieldsPresent`, passed
    // separately to `fieldView` and `validateDraft`.
    expect(draft.secret['password']).toEqual({ kind: 'unchanged' });
    expect(draft.secret['token']).toEqual({ kind: 'unchanged' });
  });

  it('starts a new connection with no colour', () => {
    expect(createDraft(provider).color).toBeUndefined();
  });

  it('loads a stored colour in its canonical form', () => {
    const base = { id: 'c1', providerId: 'demo', label: 'prod', settings: {} };
    expect(createDraft(provider, { ...base, color: 'red' }).color).toBe('red');
    expect(createDraft(provider, { ...base, color: '#AABBCC' }).color).toBe('#aabbcc');
  });

  it('drops an unrecognised stored colour instead of carrying it into the form', () => {
    const draft = createDraft(provider, {
      id: 'c1',
      providerId: 'demo',
      label: 'prod',
      settings: {},
      color: 'crimson',
    });
    expect(draft.color).toBeUndefined();
    expect(isDirty(draft)).toBe(false);
  });
});

describe('setColor', () => {
  const draft = createDraft(provider, {
    id: 'c1',
    providerId: 'demo',
    label: 'prod',
    settings: {},
    color: 'red',
  });

  it('marks the draft dirty, and clean again when the colour is put back', () => {
    const blue = setColor(draft, 'blue');
    expect(blue.color).toBe('blue');
    expect(isDirty(blue)).toBe(true);
    expect(isDirty(setColor(blue, 'red'))).toBe(false);
  });

  it('clears with undefined', () => {
    const cleared = setColor(draft, undefined);
    expect(cleared.color).toBeUndefined();
    expect(isDirty(cleared)).toBe(true);
  });

  it('ignores a value that is not a colour', () => {
    expect(setColor(draft, 'not-a-colour').color).toBeUndefined();
  });
});

describe('isDirty', () => {
  it('is false for a freshly loaded draft and true after any edit', () => {
    const draft = createDraft(provider, {
      id: 'c1',
      providerId: 'demo',
      label: 'prod',
      settings: { host: 'example.com' },
    });
    expect(isDirty(draft)).toBe(false);
    expect(isDirty(setLabel(draft, 'staging'))).toBe(true);
    expect(isDirty(setField(draft, 'settings', 'host', 'other.com'))).toBe(true);
  });

  it('notices a touched secret even when nothing else changed', () => {
    const draft = createDraft(provider, {
      id: 'c1',
      providerId: 'demo',
      label: 'prod',
      settings: {},
    });
    expect(isDirty(setField(draft, 'secret', 'password', 'hunter2'))).toBe(true);
    expect(isDirty(clearSecretField(draft, 'token'))).toBe(true);
  });

  it('returns to clean when an edit is reversed', () => {
    const draft = createDraft(provider, {
      id: 'c1',
      providerId: 'demo',
      label: 'prod',
      settings: { host: 'example.com' },
    });
    const there = setLabel(draft, 'staging');
    expect(isDirty(setLabel(there, 'prod'))).toBe(false);
  });
});

describe('toSecretPatch', () => {
  it('emits only touched fields', () => {
    let draft = createDraft(provider, {
      id: 'c1',
      providerId: 'demo',
      label: 'prod',
      settings: {},
    });
    draft = setField(draft, 'secret', 'password', 'hunter2');
    draft = clearSecretField(draft, 'token');
    expect(toSecretPatch(draft)).toEqual({
      password: { set: 'hunter2' },
      token: { clear: true },
    });
  });

  it('is empty when no secret was touched', () => {
    const draft = createDraft(provider, {
      id: 'c1',
      providerId: 'demo',
      label: 'prod',
      settings: {},
    });
    expect(toSecretPatch(draft)).toEqual({});
  });
});
