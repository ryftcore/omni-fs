import { useCallback, useEffect, useReducer } from 'react';
import type { ConnectionsBackend } from '../ports/connections-backend.js';
import {
  initialManagerState,
  managerReducer,
  saveInputFrom,
  selectedConnection,
} from './reducer.js';
import type { ManagerAction, ManagerState } from './reducer.js';

export interface ConnectionManagerController {
  readonly state: ManagerState;
  readonly dispatch: (action: ManagerAction) => void;
  readonly save: () => Promise<void>;
  readonly test: () => Promise<void>;
  readonly remove: () => Promise<void>;
  readonly connect: () => Promise<void>;
  readonly pickFile: (key: string) => Promise<void>;
}

/**
 * The only stateful piece in the package, and a thin one: every decision lives
 * in `managerReducer`, so this wrapper just performs effects against the Port.
 */
export function useConnectionManager(backend: ConnectionsBackend): ConnectionManagerController {
  const [state, dispatch] = useReducer(managerReducer, initialManagerState);

  useEffect(() => {
    let cancelled = false;

    const load = async (initial: boolean): Promise<void> => {
      if (!initial) {
        const [connections, selection] = await Promise.all([
          backend.listConnections(),
          backend.initialSelection(),
        ]);
        if (cancelled) return;
        dispatch({ type: 'connectionsChanged', connections });
        // A deep link into an already-open panel (e.g. "Edit Connection" on a
        // tree node): route through the guard rather than assigning the
        // selection directly, so a pending edit is not silently discarded.
        if (selection !== undefined) dispatch({ type: 'selectRequested', target: selection });
        return;
      }

      const [providers, connections, selection] = await Promise.all([
        backend.listProviders(),
        backend.listConnections(),
        backend.initialSelection(),
      ]);
      if (cancelled) return;
      dispatch({ type: 'loaded', providers, connections, selection });
    };

    void load(true);
    const subscription = backend.onDidChange(() => void load(false));

    return () => {
      cancelled = true;
      subscription[Symbol.dispose]();
    };
  }, [backend]);

  const save = useCallback(async (): Promise<void> => {
    if (state.draft === undefined) return;
    if (state.errors.length > 0) {
      dispatch({ type: 'validationRevealed' });
      return;
    }

    dispatch({ type: 'saveStarted' });
    try {
      const id = await backend.save(saveInputFrom(state.draft));
      dispatch({ type: 'saveSucceeded', id });
    } catch (error) {
      dispatch({ type: 'saveFailed', message: messageOf(error) });
    }
  }, [backend, state.draft, state.errors]);

  const test = useCallback(async (): Promise<void> => {
    if (state.draft === undefined) return;
    dispatch({ type: 'testStarted' });
    try {
      const { readOnly: _readOnly, color: _color, ...input } = saveInputFrom(state.draft);
      dispatch({ type: 'testFinished', outcome: await backend.test(input) });
    } catch (error) {
      dispatch({
        type: 'testFinished',
        outcome: {
          ok: false,
          durationMs: 0,
          error: { code: 'Unknown', message: messageOf(error), retryable: false },
        },
      });
    }
  }, [backend, state.draft]);

  const remove = useCallback(async (): Promise<void> => {
    const connection = selectedConnection(state);
    if (connection === undefined) return;
    try {
      await backend.remove(connection.id);
    } catch (error) {
      // `saveFailed` is the shared "operation failed" path, not save-specific:
      // it sets `lastError`, which `ConnectionForm` renders generically.
      dispatch({ type: 'saveFailed', message: messageOf(error) });
    }
  }, [backend, state]);

  const connect = useCallback(async (): Promise<void> => {
    const id = state.draft?.id;
    if (id === undefined) return;
    try {
      await backend.connect(id);
    } catch (error) {
      // Same shared "operation failed" path as `remove`.
      dispatch({ type: 'saveFailed', message: messageOf(error) });
    }
  }, [backend, state.draft]);

  const pickFile = useCallback(
    async (key: string): Promise<void> => {
      try {
        const path = await backend.pickFile();
        if (path !== undefined) {
          dispatch({ type: 'fieldChanged', section: 'settings', key, value: path });
        }
      } catch (error) {
        // Same shared "operation failed" path as `remove`.
        dispatch({ type: 'saveFailed', message: messageOf(error) });
      }
    },
    [backend],
  );

  return { state, dispatch, save, test, remove, connect, pickFile };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
