import type { ReactNode } from 'react';
import type { ProviderSummary } from '@omni-fs/core';
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
  const selectedId = props.selection.kind === 'connection' ? props.selection.id : undefined;

  return (
    <div className="omni-list">
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, flex: 1 }}>
        {props.connections.map((connection) => (
          <li key={connection.id}>
            <button
              type="button"
              className="omni-list-item"
              aria-current={connection.id === selectedId}
              onClick={() => props.onSelect({ kind: 'connection', id: connection.id })}
            >
              <StatusDot state={connection.state} />
              <span>{connection.label}</span>
            </button>
          </li>
        ))}
        {props.connections.length === 0 && (
          <li className="omni-help" style={{ padding: 10 }}>
            No connections yet.
          </li>
        )}
      </ul>

      <div className="omni-actions" style={{ padding: 8, flexWrap: 'wrap' }}>
        {props.providers.map((provider) => (
          <Button
            key={provider.id}
            onClick={() => props.onSelect({ kind: 'new', providerId: provider.id })}
          >
            + {provider.displayName}
          </Button>
        ))}
        <Button disabled={selectedId === undefined} onClick={props.onDuplicate}>
          Duplicate
        </Button>
        <Button disabled={selectedId === undefined} onClick={props.onDelete}>
          Delete
        </Button>
      </div>
    </div>
  );
}
