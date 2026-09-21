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
  const connection = selectedConnection(state);

  if (state.status === 'loading') {
    return (
      <div className="omni-root">
        <div className="omni-empty">
          <p className="omni-help">Loading…</p>
        </div>
      </div>
    );
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
          <div className="omni-pane">
            <div className="omni-pane-body">
              <div className="omni-empty">
                <p className="omni-empty-title">No connection selected</p>
                <p className="omni-help">Pick one on the left, or choose New to add a server.</p>
              </div>
            </div>
          </div>
        ) : (
          <ConnectionForm
            draft={state.draft}
            provider={provider}
            connectionState={connection?.state}
            errors={state.errors}
            showErrors={state.showErrors}
            dirty={state.dirty}
            canSave={state.canSave}
            saving={state.saving}
            test={state.test}
            lastError={state.lastError}
            secretFieldsPresent={connection?.secretFieldsPresent ?? []}
            onLabelChange={(value) => dispatch({ type: 'labelChanged', value })}
            onFieldChange={(section, key, value) =>
              dispatch({ type: 'fieldChanged', section, key, value })
            }
            onSecretClear={(key) => dispatch({ type: 'secretCleared', key })}
            onRootPathChange={(value) => dispatch({ type: 'rootPathChanged', value })}
            onReadOnlyChange={(value) => dispatch({ type: 'readOnlyChanged', value })}
            onColorChange={(value) => dispatch({ type: 'colorChanged', value })}
            onPickFile={(key) => void manager.pickFile(key)}
            onTest={() => void manager.test()}
            onRevert={() => dispatch({ type: 'reverted' })}
            onSave={() => void manager.save()}
            onConnect={() => void manager.connect()}
          />
        )}
      </div>

      {state.pendingSelection !== undefined && (
        <div className="omni-banner" role="alertdialog" aria-label="Unsaved changes">
          <span>This connection has unsaved changes.</span>
          <span className="omni-spacer" />
          <Button onClick={() => dispatch({ type: 'selectCancelled' })}>Keep editing</Button>
          <Button variant="danger" onClick={() => dispatch({ type: 'selectConfirmed' })}>
            Discard
          </Button>
        </div>
      )}
    </div>
  );
}
