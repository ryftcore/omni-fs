import type { ReactNode } from 'react';
import type { ConnectionsBackend } from '../ports/connections-backend.js';
import { useConnectionManager } from '../model/use-connection-manager.js';
import { selectedConnection, selectedProvider } from '../model/reducer.js';
import { ConnectionForm } from './ConnectionForm.js';
import { ConnectionList } from './ConnectionList.js';
import { Button } from './primitives/index.js';

/**
 * The whole UI. It takes a Port and nothing else, so `apps/vscode` and
 * `apps/desktop` render the identical tree over different transports.
 */
export function ConnectionManagerApp(props: { readonly backend: ConnectionsBackend }): ReactNode {
  const manager = useConnectionManager(props.backend);
  const { state, dispatch } = manager;
  const provider = selectedProvider(state);

  if (state.status === 'loading') {
    return <div className="omni-root omni-help">Loading…</div>;
  }

  return (
    <div className="omni-root">
      <div className="omni-split">
        <ConnectionList
          connections={state.connections}
          providers={state.providers}
          selection={state.selection}
          onSelect={(target) => dispatch({ type: 'selectRequested', target })}
          onDuplicate={() => dispatch({ type: 'duplicateRequested' })}
          onDelete={() => void manager.remove()}
        />

        {state.draft === undefined || provider === undefined ? (
          <div className="omni-form omni-help">
            Select a connection, or add one with a button on the left.
          </div>
        ) : (
          <ConnectionForm
            draft={state.draft}
            provider={provider}
            errors={state.errors}
            showErrors={state.showErrors}
            dirty={state.dirty}
            saving={state.saving}
            test={state.test}
            lastError={state.lastError}
            secretFieldsPresent={selectedConnection(state)?.secretFieldsPresent ?? []}
            onLabelChange={(value) => dispatch({ type: 'labelChanged', value })}
            onFieldChange={(section, key, value) =>
              dispatch({ type: 'fieldChanged', section, key, value })
            }
            onSecretClear={(key) => dispatch({ type: 'secretCleared', key })}
            onRootPathChange={(value) => dispatch({ type: 'rootPathChanged', value })}
            onReadOnlyChange={(value) => dispatch({ type: 'readOnlyChanged', value })}
            onPickFile={(key) => void manager.pickFile(key)}
            onTest={() => void manager.test()}
            onRevert={() => dispatch({ type: 'reverted' })}
            onSave={() => void manager.save()}
          />
        )}
      </div>

      {state.pendingSelection !== undefined && (
        <div
          className="omni-actions"
          style={{ padding: 8, borderTop: '1px solid var(--omni-border)' }}
        >
          <span>Discard unsaved changes?</span>
          <Button variant="primary" onClick={() => dispatch({ type: 'selectConfirmed' })}>
            Discard
          </Button>
          <Button onClick={() => dispatch({ type: 'selectCancelled' })}>Keep editing</Button>
        </div>
      )}
    </div>
  );
}
