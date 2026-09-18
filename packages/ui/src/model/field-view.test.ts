import { describe, expect, it } from 'vitest';
import { clearSecretField, createDraft, setField } from '@omni-fs/core';
import type { ProviderSummary } from '@omni-fs/core';
import { fieldView } from './field-view.js';

const provider: ProviderSummary = {
  id: 'demo',
  displayName: 'Demo',
  settingsSchema: {
    fields: [
      { kind: 'text', key: 'host', label: 'Host', required: true, placeholder: 'example.com' },
      { kind: 'number', key: 'port', label: 'Port', default: 22 },
      { kind: 'boolean', key: 'secure', label: 'Secure', default: true, help: 'Use TLS.' },
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
      { kind: 'file', key: 'keyPath', label: 'Private key' },
    ],
  },
  secretSchema: {
    fields: [{ kind: 'password', key: 'password', label: 'Password', required: true }],
  },
};

const field = (key: string) =>
  provider.settingsSchema.fields.find((candidate) => candidate.key === key)!;
const secretField = provider.secretSchema.fields[0]!;

describe('fieldView', () => {
  it('describes a required text field with its placeholder', () => {
    const view = fieldView(field('host'), 'settings', createDraft(provider), undefined, []);
    expect(view.label).toBe('Host');
    expect(view.required).toBe(true);
    expect(view.control).toEqual({
      kind: 'text',
      type: 'text',
      value: '',
      placeholder: 'example.com',
    });
  });

  it('renders a number as a numeric input carrying its default', () => {
    const view = fieldView(field('port'), 'settings', createDraft(provider), undefined, []);
    expect(view.control).toEqual({
      kind: 'text',
      type: 'number',
      value: '22',
      placeholder: undefined,
    });
  });

  it('carries help text and the boolean default', () => {
    const view = fieldView(field('secure'), 'settings', createDraft(provider), undefined, []);
    expect(view.help).toBe('Use TLS.');
    expect(view.control).toEqual({ kind: 'checkbox', checked: true });
  });

  it('passes select options through unchanged', () => {
    const view = fieldView(field('mode'), 'settings', createDraft(provider), undefined, []);
    expect(view.control).toEqual({
      kind: 'select',
      value: 'a',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
  });

  it('describes a file field so the host can open a dialog', () => {
    const view = fieldView(field('keyPath'), 'settings', createDraft(provider), undefined, []);
    expect(view.control).toEqual({ kind: 'file', value: '' });
  });

  it('shows a stored secret as present without revealing it', () => {
    const draft = createDraft(provider, { id: 'c1', providerId: 'demo', label: 'p', settings: {} });
    const view = fieldView(secretField, 'secret', draft, undefined, ['password']);
    expect(view.control).toEqual({
      kind: 'password',
      value: '',
      placeholder: '•••••••• stored — type to replace',
      stored: true,
    });
  });

  it('shows an unset secret as empty', () => {
    const view = fieldView(secretField, 'secret', createDraft(provider), undefined, []);
    expect(view.control).toEqual({
      kind: 'password',
      value: '',
      placeholder: 'Not set',
      stored: false,
    });
  });

  it('shows a typed secret and stops calling it stored', () => {
    const draft = setField(
      createDraft(provider, { id: 'c1', providerId: 'demo', label: 'p', settings: {} }),
      'secret',
      'password',
      'typed',
    );
    const view = fieldView(secretField, 'secret', draft, undefined, ['password']);
    expect(view.control).toEqual({
      kind: 'password',
      value: 'typed',
      placeholder: 'Not set',
      stored: false,
    });
  });

  it('shows an explicitly cleared secret as empty, distinct from never stored', () => {
    const draft = clearSecretField(
      createDraft(provider, { id: 'c1', providerId: 'demo', label: 'p', settings: {} }),
      'password',
    );
    const view = fieldView(secretField, 'secret', draft, undefined, ['password']);
    expect(view.control).toEqual({
      kind: 'password',
      value: '',
      placeholder: 'Not set',
      stored: false,
    });
  });

  it('attaches an error message when one applies', () => {
    const view = fieldView(
      field('host'),
      'settings',
      createDraft(provider),
      {
        section: 'settings',
        key: 'host',
        message: 'Host is required',
      },
      [],
    );
    expect(view.error).toBe('Host is required');
  });
});
