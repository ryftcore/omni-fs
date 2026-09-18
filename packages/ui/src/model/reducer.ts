import {
  clearSecretField,
  createDraft,
  isDirty,
  setField,
  setLabel,
  setReadOnly,
  setRootPath,
  toSecretPatch,
  validateDraft,
} from '@omni-fs/core';
import type {
  ConnectionDraft,
  ConnectionId,
  DraftSection,
  FieldError,
  ProviderId,
  ProviderSummary,
} from '@omni-fs/core';
import type {
  ConnectionSummary,
  InitialSelection,
  ProbeOutcome,
  SaveConnectionInput,
} from '../ports/connections-backend.js';

export type Selection =
  | { readonly kind: 'none' }
  | { readonly kind: 'connection'; readonly id: ConnectionId }
  | { readonly kind: 'new'; readonly providerId: ProviderId };

export type TestState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly outcome: ProbeOutcome };

export interface ManagerState {
  readonly status: 'loading' | 'ready';
  readonly providers: readonly ProviderSummary[];
  readonly connections: readonly ConnectionSummary[];
  readonly selection: Selection;
  readonly draft: ConnectionDraft | undefined;
  readonly errors: readonly FieldError[];
  /** Errors exist from the first keystroke; they are shown from the first save. */
  readonly showErrors: boolean;
  readonly dirty: boolean;
  readonly test: TestState;
  readonly saving: boolean;
  /** A selection change held back by the unsaved-changes guard. */
  readonly pendingSelection: Selection | undefined;
  readonly lastError: string | undefined;
}

export type ManagerAction =
  | {
      readonly type: 'loaded';
      readonly providers: readonly ProviderSummary[];
      readonly connections: readonly ConnectionSummary[];
      /** Where to open, when the host asked for somewhere specific. */
      readonly selection?: InitialSelection | undefined;
    }
  | { readonly type: 'connectionsChanged'; readonly connections: readonly ConnectionSummary[] }
  | { readonly type: 'selectRequested'; readonly target: Selection }
  | { readonly type: 'selectConfirmed' }
  | { readonly type: 'selectCancelled' }
  | { readonly type: 'duplicateRequested' }
  | { readonly type: 'labelChanged'; readonly value: string }
  | {
      readonly type: 'fieldChanged';
      readonly section: DraftSection;
      readonly key: string;
      readonly value: unknown;
    }
  | { readonly type: 'secretCleared'; readonly key: string }
  | { readonly type: 'rootPathChanged'; readonly value: string }
  | { readonly type: 'readOnlyChanged'; readonly value: boolean }
  | { readonly type: 'reverted' }
  | { readonly type: 'validationRevealed' }
  | { readonly type: 'testStarted' }
  | { readonly type: 'testFinished'; readonly outcome: ProbeOutcome }
  | { readonly type: 'saveStarted' }
  | { readonly type: 'saveSucceeded'; readonly id: ConnectionId }
  | { readonly type: 'saveFailed'; readonly message: string };

export const initialManagerState: ManagerState = {
  status: 'loading',
  providers: [],
  connections: [],
  selection: { kind: 'none' },
  draft: undefined,
  errors: [],
  showErrors: false,
  dirty: false,
  test: { kind: 'idle' },
  saving: false,
  pendingSelection: undefined,
  lastError: undefined,
};

export function managerReducer(state: ManagerState, action: ManagerAction): ManagerState {
  switch (action.type) {
    case 'loaded': {
      const base: ManagerState = {
        ...state,
        status: 'ready',
        providers: action.providers,
        connections: action.connections,
      };
      if (action.selection !== undefined) return applySelection(base, action.selection);

      const first = action.connections[0];
      return first === undefined
        ? base
        : applySelection(base, { kind: 'connection', id: first.id });
    }

    case 'connectionsChanged': {
      const next = { ...state, connections: action.connections };
      // A dirty draft is the user's work in progress; an external change must
      // update the list without discarding it.
      return state.dirty ? next : applySelection(next, next.selection);
    }

    case 'selectRequested':
      return state.dirty
        ? { ...state, pendingSelection: action.target }
        : applySelection(state, action.target);

    case 'selectConfirmed':
      return state.pendingSelection === undefined
        ? state
        : applySelection(state, state.pendingSelection);

    case 'selectCancelled':
      return { ...state, pendingSelection: undefined };

    case 'duplicateRequested': {
      const source = selectedConnection(state);
      const provider = providerFor(state, source?.providerId);
      if (source === undefined || provider === undefined) return state;

      // No id and no stored credentials: a copy is a new connection, and its
      // secrets live under a different key.
      const draft = createDraft(provider, {
        id: `${source.id}-copy`,
        providerId: source.providerId,
        label: `${source.label} (copy)`,
        settings: source.settings,
        ...(source.rootPath !== undefined ? { rootPath: source.rootPath } : {}),
        readOnly: source.readOnly,
      });

      return withDraft(
        { ...state, selection: { kind: 'new', providerId: source.providerId } },
        { ...draft, id: undefined },
        [],
      );
    }

    case 'labelChanged':
      return editDraft(state, (draft) => setLabel(draft, action.value));

    case 'fieldChanged':
      return editDraft(state, (draft) => setField(draft, action.section, action.key, action.value));

    case 'secretCleared':
      return editDraft(state, (draft) => clearSecretField(draft, action.key));

    case 'rootPathChanged':
      return editDraft(state, (draft) => setRootPath(draft, action.value));

    case 'readOnlyChanged':
      return editDraft(state, (draft) => setReadOnly(draft, action.value));

    case 'reverted':
      return applySelection(state, state.selection);

    case 'validationRevealed':
      return { ...state, showErrors: true };

    case 'testStarted':
      return { ...state, test: { kind: 'running' }, lastError: undefined };

    case 'testFinished':
      return { ...state, test: { kind: 'done', outcome: action.outcome } };

    case 'saveStarted':
      return { ...state, saving: true, lastError: undefined };

    case 'saveSucceeded': {
      if (state.draft === undefined) return { ...state, saving: false };

      // Rebaseline in place rather than re-deriving from `connections`: the
      // list is refreshed by a separate event, and relying on it arriving
      // first would make saving a new connection a race.
      const secret = Object.fromEntries(
        Object.keys(state.draft.secret).map((key) => [key, { kind: 'unchanged' } as const]),
      );
      const draft: ConnectionDraft = {
        ...state.draft,
        id: action.id,
        secret,
        baseline: {
          label: state.draft.label,
          settings: { ...state.draft.settings },
          rootPath: state.draft.rootPath,
          readOnly: state.draft.readOnly,
        },
      };

      return {
        ...state,
        draft,
        dirty: false,
        selection: { kind: 'connection', id: action.id },
        ...cleared(),
      };
    }

    case 'saveFailed':
      return { ...state, saving: false, lastError: action.message };
  }
}

/** Builds the payload the backend's `save` expects. */
export function saveInputFrom(draft: ConnectionDraft): SaveConnectionInput {
  return {
    id: draft.id,
    providerId: draft.providerId,
    label: draft.label.trim(),
    settings: draft.settings,
    rootPath: draft.rootPath === '/' ? undefined : draft.rootPath,
    readOnly: draft.readOnly,
    secretPatch: toSecretPatch(draft),
  };
}

export function selectedProvider(state: ManagerState): ProviderSummary | undefined {
  return providerFor(state, state.draft?.providerId);
}

export function selectedConnection(state: ManagerState): ConnectionSummary | undefined {
  const selection = state.selection;
  return selection.kind === 'connection'
    ? state.connections.find((candidate) => candidate.id === selection.id)
    : undefined;
}

function providerFor(state: ManagerState, id: ProviderId | undefined): ProviderSummary | undefined {
  return id === undefined ? undefined : state.providers.find((candidate) => candidate.id === id);
}

/** Rebuilds the draft for a selection and clears everything derived from the old one. */
function applySelection(state: ManagerState, selection: Selection): ManagerState {
  if (selection.kind === 'none') {
    return { ...state, selection, draft: undefined, ...cleared() };
  }

  if (selection.kind === 'new') {
    const provider = providerFor(state, selection.providerId);
    if (provider === undefined) return state;
    return withDraft({ ...state, selection }, createDraft(provider), []);
  }

  const connection = state.connections.find((candidate) => candidate.id === selection.id);
  const provider = providerFor(state, connection?.providerId);
  if (connection === undefined || provider === undefined) {
    return { ...state, selection: { kind: 'none' }, draft: undefined, ...cleared() };
  }

  const draft = createDraft(
    provider,
    {
      id: connection.id,
      providerId: connection.providerId,
      label: connection.label,
      settings: connection.settings,
      ...(connection.rootPath !== undefined ? { rootPath: connection.rootPath } : {}),
      readOnly: connection.readOnly,
    },
    connection.secretFieldsPresent,
  );

  return withDraft({ ...state, selection }, draft, connection.secretFieldsPresent);
}

/**
 * A draft that has never been saved counts as dirty: there is nothing to
 * compare it against, and Save has to be reachable for a new connection.
 */
function dirtyFor(draft: ConnectionDraft): boolean {
  return draft.id === undefined || isDirty(draft);
}

function editDraft(
  state: ManagerState,
  change: (draft: ConnectionDraft) => ConnectionDraft,
): ManagerState {
  if (state.draft === undefined) return state;
  const draft = change(state.draft);
  const provider = providerFor(state, draft.providerId);
  if (provider === undefined) return state;

  return {
    ...state,
    draft,
    dirty: dirtyFor(draft),
    errors: validateDraft(draft, provider, secretFieldsFor(state)),
    // A result that described the previous values is worse than no result.
    test: { kind: 'idle' },
  };
}

function withDraft(
  state: ManagerState,
  draft: ConnectionDraft,
  secretFieldsPresent: readonly string[],
): ManagerState {
  const provider = providerFor(state, draft.providerId);
  return {
    ...state,
    draft,
    dirty: dirtyFor(draft),
    errors: provider === undefined ? [] : validateDraft(draft, provider, secretFieldsPresent),
    ...cleared(),
  };
}

function secretFieldsFor(state: ManagerState): readonly string[] {
  return selectedConnection(state)?.secretFieldsPresent ?? [];
}

function cleared(): Pick<
  ManagerState,
  'showErrors' | 'test' | 'pendingSelection' | 'lastError' | 'saving'
> {
  return {
    showErrors: false,
    test: { kind: 'idle' },
    pendingSelection: undefined,
    lastError: undefined,
    saving: false,
  };
}
