import { describe, expect, it } from 'vitest';
import {
  clearSecretField,
  createDraft,
  isDirty,
  setField,
  setLabel,
  toConfig,
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
    const draft = createDraft(
      provider,
      {
        id: 'c1',
        providerId: 'demo',
        label: 'prod',
        settings: { host: 'example.com', port: 2222 },
        rootPath: '/srv',
      },
      ['password'],
    );
    expect(draft.id).toBe('c1');
    expect(draft.settings['host']).toBe('example.com');
    // A stored value wins over the schema default.
    expect(draft.settings['port']).toBe(2222);
    // A field with no stored value still gets its default.
    expect(draft.settings['secure']).toBe(true);
    expect(draft.secret['password']).toEqual({ kind: 'unchanged' });
    // Not in secretFieldsPresent, so there is nothing stored to keep.
    expect(draft.secret['token']).toEqual({ kind: 'unchanged' });
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

describe('toConfig', () => {
  it('produces a ConnectionConfig and never leaks a secret into it', () => {
    let draft = createDraft(provider);
    draft = setLabel(draft, '  prod  ');
    draft = setField(draft, 'settings', 'host', 'example.com');
    draft = setField(draft, 'secret', 'password', 'hunter2');

    const config = toConfig(draft, 'c9');
    expect(config).toEqual({
      id: 'c9',
      providerId: 'demo',
      label: 'prod',
      settings: { host: 'example.com', port: 22, secure: true, mode: 'a' },
      readOnly: false,
    });
    expect(JSON.stringify(config)).not.toContain('hunter2');
  });

  it('includes rootPath only when it is not the default root', () => {
    const draft = createDraft(provider);
    expect(toConfig(draft, 'c9').rootPath).toBeUndefined();
    expect(toConfig({ ...draft, rootPath: '/srv' }, 'c9').rootPath).toBe('/srv');
  });
});
