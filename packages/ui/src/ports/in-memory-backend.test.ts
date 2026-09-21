import { describe, expect, it } from 'vitest';
import { InMemoryConnectionsBackend } from './in-memory-backend.js';
import type { ProviderSummary } from '@omni-fs/core';

const provider: ProviderSummary = {
  id: 'demo',
  displayName: 'Demo',
  settingsSchema: { fields: [{ kind: 'text', key: 'host', label: 'Host', required: true }] },
  secretSchema: { fields: [{ kind: 'password', key: 'password', label: 'Password' }] },
};

function backend(): InMemoryConnectionsBackend {
  return new InMemoryConnectionsBackend([provider]);
}

describe('InMemoryConnectionsBackend', () => {
  it('creates a connection and reports which secret fields are present', async () => {
    const api = backend();
    const id = await api.save({
      id: undefined,
      providerId: 'demo',
      label: 'prod',
      settings: { host: 'example.com' },
      rootPath: undefined,
      readOnly: false,
      color: undefined,
      secretPatch: { password: { set: 'hunter2' } },
    });

    const [saved] = await api.listConnections();
    expect(saved?.id).toBe(id);
    expect(saved?.label).toBe('prod');
    expect(saved?.secretFieldsPresent).toEqual(['password']);
    // The summary is what reaches the UI; it must never carry the value.
    expect(JSON.stringify(saved)).not.toContain('hunter2');
  });

  it('keeps an untouched secret when the connection is updated', async () => {
    const api = backend();
    const id = await api.save({
      id: undefined,
      providerId: 'demo',
      label: 'prod',
      settings: { host: 'example.com' },
      rootPath: undefined,
      readOnly: false,
      color: undefined,
      secretPatch: { password: { set: 'hunter2' } },
    });

    await api.save({
      id,
      providerId: 'demo',
      label: 'renamed',
      settings: { host: 'example.com' },
      rootPath: undefined,
      readOnly: false,
      color: undefined,
      secretPatch: {},
    });

    expect(api.secretFor(id)).toEqual({ password: 'hunter2' });
  });

  it('removes a secret the patch clears', async () => {
    const api = backend();
    const id = await api.save({
      id: undefined,
      providerId: 'demo',
      label: 'prod',
      settings: { host: 'example.com' },
      rootPath: undefined,
      readOnly: false,
      color: undefined,
      secretPatch: { password: { set: 'hunter2' } },
    });

    await api.save({
      id,
      providerId: 'demo',
      label: 'prod',
      settings: { host: 'example.com' },
      rootPath: undefined,
      readOnly: false,
      color: undefined,
      secretPatch: { password: { clear: true } },
    });

    expect(api.secretFor(id)).toEqual({});
  });

  it('notifies listeners on save and remove, and stops after dispose', async () => {
    const api = backend();
    let calls = 0;
    const subscription = api.onDidChange(() => (calls += 1));

    const id = await api.save({
      id: undefined,
      providerId: 'demo',
      label: 'prod',
      settings: {},
      rootPath: undefined,
      readOnly: false,
      color: undefined,
      secretPatch: {},
    });
    expect(calls).toBe(1);

    await api.remove(id);
    expect(calls).toBe(2);

    subscription[Symbol.dispose]();
    await api.save({
      id: undefined,
      providerId: 'demo',
      label: 'other',
      settings: {},
      rootPath: undefined,
      readOnly: false,
      color: undefined,
      secretPatch: {},
    });
    expect(calls).toBe(2);
  });

  it('round-trips a colour', async () => {
    const api = backend();
    await api.save({
      id: undefined,
      providerId: 'demo',
      label: 'prod',
      settings: { host: 'example.com' },
      rootPath: undefined,
      readOnly: false,
      color: 'red',
      secretPatch: {},
    });

    const [saved] = await api.listConnections();
    expect(saved?.color).toBe('red');
  });
});
