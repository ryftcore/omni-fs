import { useEffect, useRef, type ReactNode } from 'react';
import type {
  ConnectionDraft,
  ConnectionState,
  DraftSection,
  FieldError,
  ProviderSummary,
  SettingsField,
} from '@omni-fs/core';
import { fieldView } from '../model/field-view.js';
import type { TestState } from '../model/reducer.js';
import {
  Button,
  Checkbox,
  errorId,
  FormRow,
  StatusDot,
  statusLabel,
  TextField,
} from './primitives/index.js';
import { SchemaField } from './SchemaField.js';

export function ConnectionForm(props: {
  readonly draft: ConnectionDraft;
  readonly provider: ProviderSummary;
  readonly connectionState: ConnectionState | undefined;
  readonly errors: readonly FieldError[];
  readonly showErrors: boolean;
  readonly dirty: boolean;
  readonly canSave: boolean;
  readonly saving: boolean;
  readonly test: TestState;
  readonly lastError: string | undefined;
  readonly secretFieldsPresent: readonly string[];
  readonly onLabelChange: (value: string) => void;
  readonly onFieldChange: (section: DraftSection, key: string, value: unknown) => void;
  readonly onSecretClear: (key: string) => void;
  readonly onRootPathChange: (value: string) => void;
  readonly onReadOnlyChange: (value: boolean) => void;
  readonly onPickFile: (key: string) => void;
  readonly onTest: () => void;
  readonly onRevert: () => void;
  readonly onSave: () => void;
  readonly onConnect: () => void;
}): ReactNode {
  const errorFor = (section: DraftSection | 'label', key: string): FieldError | undefined =>
    props.showErrors
      ? props.errors.find((error) => error.section === section && error.key === key)
      : undefined;

  const renderSection = (fields: readonly SettingsField[], section: DraftSection): ReactNode =>
    fields.map((field) => (
      <SchemaField
        key={field.key}
        view={fieldView(
          field,
          section,
          props.draft,
          errorFor(section, field.key),
          props.secretFieldsPresent,
        )}
        onChange={(value) => props.onFieldChange(section, field.key, value)}
        onClear={() => props.onSecretClear(field.key)}
        onPickFile={() => props.onPickFile(field.key)}
      />
    ));

  // Switching connections must start at the top of the form. The body is the
  // scroll container, so without this the next connection opens at whatever
  // offset the previous one was left at.
  const bodyRef = useRef<HTMLDivElement>(null);
  const draftKey = props.draft.id ?? `new:${props.draft.providerId}`;
  useEffect(() => {
    const body = bodyRef.current;
    if (body !== null) body.scrollTop = 0;
  }, [draftKey]);

  const labelError = errorFor('label', 'label');
  const trimmed = props.draft.label.trim();
  const title =
    trimmed !== '' ? trimmed : props.draft.id === undefined ? 'New connection' : 'Untitled';
  const hasStatusStrip = props.test.kind === 'done' || props.lastError !== undefined;

  return (
    <div className="omni-pane">
      <header className="omni-pane-header">
        <div className="omni-pane-inner">
          <div className="omni-pane-heading">
            <h1 className="omni-pane-title">{title}</h1>
            <span className="omni-badge">{props.provider.displayName}</span>
          </div>
          {props.connectionState !== undefined && (
            <span className="omni-pane-status">
              <StatusDot state={props.connectionState} />
              {statusLabel(props.connectionState)}
            </span>
          )}
        </div>
      </header>

      <div className="omni-pane-body" ref={bodyRef}>
        <div className="omni-form">
          <Group title="Connection">
            <FormRow label="Name" htmlFor="omni-label" required error={labelError?.message}>
              <TextField
                id="omni-label"
                type="text"
                value={props.draft.label}
                placeholder="production-bucket"
                invalid={labelError !== undefined}
                describedBy={errorId('omni-label', labelError !== undefined)}
                onChange={props.onLabelChange}
              />
            </FormRow>

            <FormRow
              label="Protocol"
              htmlFor="omni-protocol"
              help="Locked after the first save. Use Duplicate for the same server on another protocol."
            >
              {/* Changing it would invalidate every settings field at once. */}
              <TextField
                id="omni-protocol"
                type="text"
                value={props.provider.displayName}
                readOnly
                onChange={() => undefined}
              />
            </FormRow>
          </Group>

          {props.provider.settingsSchema.fields.length > 0 && (
            <Group title="Settings">
              {renderSection(props.provider.settingsSchema.fields, 'settings')}
            </Group>
          )}

          {props.provider.secretSchema.fields.length > 0 && (
            <Group
              title="Credentials"
              note="Stored in your operating system's keychain, never in settings.json."
            >
              {renderSection(props.provider.secretSchema.fields, 'secret')}
            </Group>
          )}

          <Group title="Advanced">
            <FormRow
              label="Root path"
              htmlFor="omni-root"
              help="Folder to treat as the connection root."
            >
              <TextField
                id="omni-root"
                type="text"
                value={props.draft.rootPath}
                onChange={props.onRootPathChange}
              />
            </FormRow>

            <FormRow
              label="Open as read-only"
              htmlFor="omni-readonly"
              help="Blocks writes, renames and deletes for this connection."
              inline
            >
              <Checkbox
                id="omni-readonly"
                checked={props.draft.readOnly}
                onChange={props.onReadOnlyChange}
              />
            </FormRow>
          </Group>
        </div>
      </div>

      {/* Outside the scroll container: on a long schema the actions would
          otherwise sit below the fold. */}
      <footer className="omni-pane-footer">
        <div className="omni-pane-inner">
          {hasStatusStrip && (
            <div className="omni-status-strip">
              <TestReport test={props.test} />
              {props.lastError !== undefined && (
                <p className="omni-error" role="alert">
                  {props.lastError}
                </p>
              )}
            </div>
          )}

          <div className="omni-footer-actions">
            <Button disabled={props.test.kind === 'running'} onClick={props.onTest}>
              {props.test.kind === 'running' ? 'Testing…' : 'Test Connection'}
            </Button>
            {props.dirty && <span className="omni-help">Unsaved changes</span>}

            <span className="omni-spacer" />

            <Button disabled={!props.dirty} onClick={props.onRevert}>
              Revert
            </Button>
            <Button
              variant="primary"
              disabled={props.saving || !props.canSave}
              onClick={props.onSave}
            >
              {props.saving ? 'Saving…' : 'Save'}
            </Button>
            <Button
              disabled={props.draft.id === undefined || props.dirty}
              title={
                props.draft.id === undefined
                  ? 'Save the connection first.'
                  : props.dirty
                    ? 'Save your changes first.'
                    : undefined
              }
              onClick={props.onConnect}
            >
              Connect
            </Button>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Group(props: {
  readonly title: string;
  readonly note?: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className="omni-group">
      <h2 className="omni-group-title">{props.title}</h2>
      {props.note !== undefined && <p className="omni-group-note omni-help">{props.note}</p>}
      {props.children}
    </section>
  );
}

function TestReport(props: { readonly test: TestState }): ReactNode {
  if (props.test.kind !== 'done') return null;
  const { outcome } = props.test;

  if (!outcome.ok) {
    return (
      <p className="omni-error" role="alert">
        {outcome.error?.message ?? 'Connection failed.'}
      </p>
    );
  }

  const capabilities = outcome.capabilities;
  const notes =
    capabilities === undefined
      ? ''
      : ` · ${capabilities.canRename ? 'rename' : 'no rename'}, ${String(capabilities.maxConcurrency)} parallel`;

  return (
    <p style={{ color: 'var(--omni-success)' }} role="status">
      Connected in {outcome.durationMs} ms{notes}
    </p>
  );
}
