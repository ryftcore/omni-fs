import { useState, type ReactNode } from 'react';
import type { ProviderId, ProviderSummary } from '@omni-fs/core';
import type { ConnectionSummary } from '../ports/connections-backend.js';
import type { Selection } from '../model/reducer.js';
import { Button, StatusDot } from './primitives/index.js';

export function ConnectionList(props: {
  readonly connections: readonly ConnectionSummary[];
  readonly providers: readonly ProviderSummary[];
  readonly selection: Selection;
  readonly onSelect: (target: Selection) => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
}): ReactNode {
  // The only local state in the package: which protocol menu is open. It is
  // presentation with no bearing on the draft, so it stays out of the reducer.
  const [menuOpen, setMenuOpen] = useState(false);
  const selectedId = props.selection.kind === 'connection' ? props.selection.id : undefined;
  const providerNames = new Map(
    props.providers.map((provider) => [provider.id, provider.displayName]),
  );

  const startNew = (providerId: ProviderId): void => {
    setMenuOpen(false);
    props.onSelect({ kind: 'new', providerId });
  };

  return (
    <div className="omni-list">
      <div className="omni-list-header">
        <h2 className="omni-list-title">Connections</h2>

        {/* One menu rather than a button per protocol: four buttons in a 260px
            column wrap into a stack that reads as a pile, and the list grows
            by one every time a provider package is added. */}
        <div
          className="omni-menu-anchor"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setMenuOpen(false);
          }}
        >
          <Button
            variant="primary"
            hasPopup
            expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            New ▾
          </Button>

          {menuOpen && (
            <>
              {/* Closes on an outside click without a document listener, so
                  this component needs no effect and no cleanup. */}
              <div className="omni-menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="omni-menu" role="menu">
                {props.providers.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    role="menuitem"
                    className="omni-menu-item"
                    onClick={() => startNew(provider.id)}
                  >
                    {provider.displayName}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {props.connections.length === 0 ? (
        <div className="omni-list-scroll">
          <div className="omni-empty">
            <p className="omni-empty-title">No connections yet</p>
            <p className="omni-help">Choose New to add your first server.</p>
          </div>
        </div>
      ) : (
        <ul className="omni-list-scroll">
          {props.connections.map((connection) => (
            <li key={connection.id}>
              <button
                type="button"
                className="omni-list-item"
                aria-current={connection.id === selectedId}
                onClick={() => props.onSelect({ kind: 'connection', id: connection.id })}
              >
                <StatusDot state={connection.state} />
                <span className="omni-list-item-text">
                  <span className="omni-list-item-label">{connection.label}</span>
                  <span className="omni-list-item-meta">
                    {providerNames.get(connection.providerId) ?? connection.providerId}
                    {connection.readOnly ? ' · read-only' : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="omni-list-footer">
        <Button
          disabled={selectedId === undefined}
          title="Copy the selected connection's settings into a new one"
          onClick={props.onDuplicate}
        >
          Duplicate
        </Button>
        <Button variant="danger" disabled={selectedId === undefined} onClick={props.onDelete}>
          Delete
        </Button>
      </div>
    </div>
  );
}
