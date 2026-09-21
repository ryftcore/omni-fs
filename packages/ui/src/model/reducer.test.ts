import { describe, expect, it } from 'vitest';
import { initialManagerState, managerReducer, saveInputFrom } from './reducer.js';
import type { ManagerAction, ManagerState } from './reducer.js';
import type { ConnectionSummary } from '../ports/connections-backend.js';
import type { ProviderSummary } from '@omni-fs/core';

const provider: ProviderSummary = {
  id: 'demo',
  displayName: 'Demo',
  settingsSchema: {
    fields: [
      { kind: 'text', key: 'host', label: 'Host', required: true },
      { kind: 'number', key: 'port', label: 'Port', required: true },
    ],
  },
  secretSchema: {
    fields: [{ kind: 'password', key: 'password', label: 'Password', required: true }],
  },
};

const prod: ConnectionSummary = {
  id: 'c1',
  providerId: 'demo',
  label: 'prod',
  settings: { host: 'example.com', port: 21 },
  rootPath: undefined,
  readOnly: false,
  color: undefined,
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

describe('managerReducer: colour', () => {
  const tagged = run([
    { type: 'loaded', providers: [provider], connections: [{ ...prod, color: 'red' }, staging] },
  ]);

  it('loads the stored colour into the draft', () => {
    expect(tagged.draft?.color).toBe('red');
    expect(tagged.dirty).toBe(false);
  });

  it('marks the draft dirty on a change and reverts it', () => {
    const changed = managerReducer(tagged, { type: 'colorChanged', value: '#123456' });
    expect(changed.draft?.color).toBe('#123456');
    expect(changed.dirty).toBe(true);

    const reverted = managerReducer(changed, { type: 'reverted' });
    expect(reverted.draft?.color).toBe('red');
    expect(reverted.dirty).toBe(false);
  });

  it('clears with undefined', () => {
    const cleared = managerReducer(tagged, { type: 'colorChanged', value: undefined });
    expect(cleared.draft?.color).toBeUndefined();
    expect(cleared.dirty).toBe(true);
  });

  it('is sent on save, and is clean once saved', () => {
    const changed = managerReducer(tagged, { type: 'colorChanged', value: 'blue' });
    expect(changed.draft && saveInputFrom(changed.draft).color).toBe('blue');

    const saved = run([{ type: 'saveStarted' }, { type: 'saveSucceeded', id: 'c1' }], changed);
    expect(saved.dirty).toBe(false);
    expect(saved.draft?.color).toBe('blue');
  });

  it('is carried into a duplicate, which is most likely the same environment', () => {
    const copy = managerReducer(tagged, { type: 'duplicateRequested' });
    expect(copy.draft?.color).toBe('red');
  });
});

describe('managerReducer: number fields', () => {
  it('coerces a typed value to a number rather than storing the raw string', () => {
    const edited = managerReducer(loaded, {
      type: 'fieldChanged',
      section: 'settings',
      key: 'port',
      value: '2121',
    });
    expect(edited.draft?.settings['port']).toBe(2121);
  });

  it('clears an emptied number field to undefined and reports it required', () => {
    // `Number('')` is `0`, which would satisfy the required check and defeat
    // it — clearing the field must produce `undefined`, not `0`.
    const cleared = managerReducer(loaded, {
      type: 'fieldChanged',
      section: 'settings',
      key: 'port',
      value: '',
    });
    expect(cleared.draft?.settings['port']).toBeUndefined();
    expect(cleared.errors).toContainEqual({
      section: 'settings',
      key: 'port',
      message: 'Port is required',
    });
  });

  it('leaves a non-numeric value as NaN so it is reported as invalid', () => {
    const invalid = managerReducer(loaded, {
      type: 'fieldChanged',
      section: 'settings',
      key: 'port',
      value: 'abc',
    });
    expect(invalid.draft?.settings['port']).toBeNaN();
    expect(invalid.errors).toContainEqual({
      section: 'settings',
      key: 'port',
      message: 'Port must be a number',
    });
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
    // Untouched, so not dirty — dirty drives the unsaved-changes guard and
    // Revert, neither of which applies to a blank form.
    expect(fresh.dirty).toBe(false);
    // Never saved, so nothing to compare against: Save must still be reachable.
    expect(fresh.canSave).toBe(true);
  });

  it('switches provider on a fresh, untouched draft without the unsaved-changes guard', () => {
    // The regression this guards: "Add Connection" opens on the first
    // provider, then "+ SFTP" used to be treated as discarding changes the
    // user never made.
    const fresh = managerReducer(loaded, {
      type: 'selectRequested',
      target: { kind: 'new', providerId: 'demo' },
    });
    const switched = managerReducer(fresh, {
      type: 'selectRequested',
      target: { kind: 'connection', id: 'c2' },
    });
    expect(switched.selection).toEqual({ kind: 'connection', id: 'c2' });
    expect(switched.pendingSelection).toBeUndefined();
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
    // Untouched relative to its own baseline, so not dirty...
    expect(copy.dirty).toBe(false);
    // ...but never saved, so nothing to compare against: Save must still be
    // reachable, and clicking "+ SFTP" right after must not pop a discard
    // prompt for changes the user never made.
    expect(copy.canSave).toBe(true);
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
