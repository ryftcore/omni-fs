import { describe, expect, it } from 'vitest';
import { initialManagerState, managerReducer } from './reducer.js';
import type { ManagerAction, ManagerState } from './reducer.js';
import type { ConnectionSummary } from '../ports/connections-backend.js';
import type { ProviderSummary } from '@omni-fs/core';

const provider: ProviderSummary = {
  id: 'demo',
  displayName: 'Demo',
  settingsSchema: { fields: [{ kind: 'text', key: 'host', label: 'Host', required: true }] },
  secretSchema: {
    fields: [{ kind: 'password', key: 'password', label: 'Password', required: true }],
  },
};

const prod: ConnectionSummary = {
  id: 'c1',
  providerId: 'demo',
  label: 'prod',
  settings: { host: 'example.com' },
  rootPath: undefined,
  readOnly: false,
  secretFieldsPresent: ['password'],
  state: { status: 'disconnected' },
};

const staging: ConnectionSummary = { ...prod, id: 'c2', label: 'staging' };

function run(actions: readonly ManagerAction[], from = initialManagerState): ManagerState {
  return actions.reduce(managerReducer, from);
}

const loaded = run([{ type: 'loaded', providers: [provider], connections: [prod, staging] }]);

describe('managerReducer: loading', () => {
  it('becomes ready and selects the first connection', () => {
    expect(loaded.status).toBe('ready');
    expect(loaded.selection).toEqual({ kind: 'connection', id: 'c1' });
    expect(loaded.draft?.label).toBe('prod');
    expect(loaded.dirty).toBe(false);
    // A stored secret satisfies the required credential, so a freshly loaded
    // connection is valid without retyping anything.
    expect(loaded.errors).toEqual([]);
  });

  it('opens on the connection the host asked for', () => {
    const deepLinked = run([
      {
        type: 'loaded',
        providers: [provider],
        connections: [prod, staging],
        selection: { kind: 'connection', id: 'c2' },
      },
    ]);
    expect(deepLinked.selection).toEqual({ kind: 'connection', id: 'c2' });
    expect(deepLinked.draft?.label).toBe('staging');
  });

  it('opens on a blank draft when the host asks for a new connection', () => {
    const fresh = run([
      {
        type: 'loaded',
        providers: [provider],
        connections: [prod],
        selection: { kind: 'new', providerId: 'demo' },
      },
    ]);
    expect(fresh.selection).toEqual({ kind: 'new', providerId: 'demo' });
    expect(fresh.draft?.label).toBe('');
  });

  it('shows an empty state when there are no connections', () => {
    const empty = run([{ type: 'loaded', providers: [provider], connections: [] }]);
    expect(empty.selection).toEqual({ kind: 'none' });
    expect(empty.draft).toBeUndefined();
  });
});

describe('managerReducer: editing', () => {
  it('marks the draft dirty and recomputes errors on every change', () => {
    const edited = run(
      [{ type: 'fieldChanged', section: 'settings', key: 'host', value: '' }],
      loaded,
    );
    expect(edited.dirty).toBe(true);
    expect(edited.errors).toContainEqual({
      section: 'settings',
      key: 'host',
      message: 'Host is required',
    });
    // Errors exist but stay hidden until a save is attempted.
    expect(edited.showErrors).toBe(false);
  });

  it('reveals errors when a save is attempted', () => {
    const revealed = run(
      [
        { type: 'fieldChanged', section: 'settings', key: 'host', value: '' },
        { type: 'validationRevealed' },
      ],
      loaded,
    );
    expect(revealed.showErrors).toBe(true);
    expect(revealed.saving).toBe(false);
  });

  it('invalidates a test result as soon as a field changes', () => {
    // A green tick next to edited settings would be a lie.
    const tested = run([{ type: 'testFinished', outcome: { ok: true, durationMs: 12 } }], loaded);
    expect(tested.test.kind).toBe('done');

    const after = managerReducer(tested, {
      type: 'fieldChanged',
      section: 'settings',
      key: 'host',
      value: 'other.com',
    });
    expect(after.test.kind).toBe('idle');
  });

  it('reverts to the loaded values', () => {
    const reverted = run(
      [
        { type: 'fieldChanged', section: 'settings', key: 'host', value: 'changed' },
        { type: 'reverted' },
      ],
      loaded,
    );
    expect(reverted.draft?.settings['host']).toBe('example.com');
    expect(reverted.dirty).toBe(false);
  });
});

describe('managerReducer: the unsaved-changes guard', () => {
  it('switches immediately when the draft is clean', () => {
    const next = managerReducer(loaded, {
      type: 'selectRequested',
      target: { kind: 'connection', id: 'c2' },
    });
    expect(next.selection).toEqual({ kind: 'connection', id: 'c2' });
    expect(next.pendingSelection).toBeUndefined();
    expect(next.draft?.label).toBe('staging');
  });

  it('holds the switch when the draft is dirty', () => {
    const dirty = managerReducer(loaded, {
      type: 'fieldChanged',
      section: 'settings',
      key: 'host',
      value: 'changed',
    });
    const held = managerReducer(dirty, {
      type: 'selectRequested',
      target: { kind: 'connection', id: 'c2' },
    });

    expect(held.selection).toEqual({ kind: 'connection', id: 'c1' });
    expect(held.pendingSelection).toEqual({ kind: 'connection', id: 'c2' });
    expect(held.draft?.settings['host']).toBe('changed');
  });

  it('applies the held switch on confirm and drops it on cancel', () => {
    const dirty = managerReducer(loaded, {
      type: 'fieldChanged',
      section: 'settings',
      key: 'host',
      value: 'changed',
    });
    const held = managerReducer(dirty, {
      type: 'selectRequested',
      target: { kind: 'connection', id: 'c2' },
    });

    const confirmed = managerReducer(held, { type: 'selectConfirmed' });
    expect(confirmed.selection).toEqual({ kind: 'connection', id: 'c2' });
    expect(confirmed.dirty).toBe(false);

    const cancelled = managerReducer(held, { type: 'selectCancelled' });
    expect(cancelled.selection).toEqual({ kind: 'connection', id: 'c1' });
    expect(cancelled.pendingSelection).toBeUndefined();
    expect(cancelled.draft?.settings['host']).toBe('changed');
  });

  it('does not leave dirty state stale when the pending selection disappears', () => {
    // settings.json edited by hand: while a dirty edit is pending and another
    // selection is held back by the guard, the target of that pending
    // selection is itself removed. Once the confirm discards the draft with
    // nothing to replace it, `dirty` and `errors` must not still describe it.
    const dirty = managerReducer(loaded, {
      type: 'fieldChanged',
      section: 'settings',
      key: 'host',
      value: '',
    });
    const held = managerReducer(dirty, {
      type: 'selectRequested',
      target: { kind: 'connection', id: 'c2' },
    });
    const changed = managerReducer(held, { type: 'connectionsChanged', connections: [prod] });
    const confirmed = managerReducer(changed, { type: 'selectConfirmed' });

    expect(confirmed.draft).toBeUndefined();
    expect(confirmed.dirty).toBe(false);
    expect(confirmed.errors).toEqual([]);

    // With no draft left to lose, a further selection must apply immediately
    // rather than being held back by a stale dirty flag.
    const next = managerReducer(confirmed, {
      type: 'selectRequested',
      target: { kind: 'connection', id: 'c1' },
    });
    expect(next.selection).toEqual({ kind: 'connection', id: 'c1' });
    expect(next.pendingSelection).toBeUndefined();
  });
});

describe('managerReducer: new and duplicate', () => {
  it('starts a blank draft for a new connection', () => {
    const fresh = managerReducer(loaded, {
      type: 'selectRequested',
      target: { kind: 'new', providerId: 'demo' },
    });
    expect(fresh.selection).toEqual({ kind: 'new', providerId: 'demo' });
    expect(fresh.draft?.id).toBeUndefined();
    expect(fresh.draft?.label).toBe('');
    // Never saved, so nothing to compare against: Save must be reachable.
    expect(fresh.dirty).toBe(true);
  });

  it('duplicates settings but never credentials', () => {
    const copy = managerReducer(loaded, { type: 'duplicateRequested' });
    expect(copy.draft?.id).toBeUndefined();
    expect(copy.draft?.label).toBe('prod (copy)');
    expect(copy.draft?.settings['host']).toBe('example.com');
    // The copy has its own id, so nothing is in the keychain for it yet and
    // the required credential must be retyped.
    expect(copy.errors).toContainEqual({
      section: 'secret',
      key: 'password',
      message: 'Password is required',
    });
    // Never saved, so nothing to compare against: Save must be reachable.
    expect(copy.dirty).toBe(true);
  });
});

describe('managerReducer: saving', () => {
  it('rebaselines and selects the saved connection', () => {
    const dirty = managerReducer(loaded, { type: 'labelChanged', value: 'renamed' });
    const saved = run(
      [
        { type: 'saveStarted' },
        {
          type: 'connectionsChanged',
          connections: [{ ...prod, label: 'renamed' }, staging],
        },
        { type: 'saveSucceeded', id: 'c1' },
      ],
      dirty,
    );

    expect(saved.saving).toBe(false);
    expect(saved.dirty).toBe(false);
    expect(saved.draft?.label).toBe('renamed');
    expect(saved.selection).toEqual({ kind: 'connection', id: 'c1' });
  });

  it('rebaselines a brand-new draft even if no connectionsChanged arrives first', () => {
    // The race the in-place rebaseline guards against: the backend acks the
    // save before (or without) a list-changed event ever mentioning the new
    // connection's id.
    const fresh = managerReducer(loaded, {
      type: 'selectRequested',
      target: { kind: 'new', providerId: 'demo' },
    });
    const filled = run(
      [
        { type: 'labelChanged', value: 'newconn' },
        { type: 'fieldChanged', section: 'settings', key: 'host', value: 'new.example.com' },
        { type: 'fieldChanged', section: 'secret', key: 'password', value: 'hunter2' },
      ],
      fresh,
    );

    const saved = run([{ type: 'saveStarted' }, { type: 'saveSucceeded', id: 'c3' }], filled);

    expect(saved.draft?.id).toBe('c3');
    expect(saved.dirty).toBe(false);
    expect(saved.draft?.label).toBe('newconn');
    expect(saved.draft?.settings['host']).toBe('new.example.com');
    expect(saved.selection).toEqual({ kind: 'connection', id: 'c3' });
  });

  it('keeps the draft and surfaces the message when a save fails', () => {
    const failed = run(
      [{ type: 'saveStarted' }, { type: 'saveFailed', message: 'keychain locked' }],
      managerReducer(loaded, { type: 'labelChanged', value: 'renamed' }),
    );
    expect(failed.saving).toBe(false);
    expect(failed.lastError).toBe('keychain locked');
    expect(failed.draft?.label).toBe('renamed');
  });

  it('does not clobber a dirty draft when connections change underneath', () => {
    // settings.json edited by hand while the user is mid-edit.
    const dirty = managerReducer(loaded, { type: 'labelChanged', value: 'mine' });
    const changed = managerReducer(dirty, {
      type: 'connectionsChanged',
      connections: [{ ...prod, label: 'theirs' }, staging],
    });

    expect(changed.draft?.label).toBe('mine');
    expect(changed.connections[0]?.label).toBe('theirs');
  });

  it('refreshes a clean draft when connections change underneath', () => {
    const changed = managerReducer(loaded, {
      type: 'connectionsChanged',
      connections: [{ ...prod, label: 'theirs' }, staging],
    });
    expect(changed.draft?.label).toBe('theirs');
  });
});
