import type { ReactNode } from 'react';
import type {
  ConnectionDraft,
  DraftSection,
  FieldError,
  ProviderSummary,
  SettingsField,
} from '@omni-fs/core';
import { fieldView } from '../model/field-view.js';
import type { TestState } from '../model/reducer.js';
import { Button, Checkbox, FormRow, TextField } from './primitives/index.js';
import { SchemaField } from './SchemaField.js';

export function ConnectionForm(props: {
  readonly draft: ConnectionDraft;
  readonly provider: ProviderSummary;
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

  return (
    <div className="omni-form">
      <FormRow
        label="Name"
        htmlFor="omni-label"
        required
        error={errorFor('label', 'label')?.message}
      >
        <TextField
          id="omni-label"
          type="text"
          value={props.draft.label}
          placeholder="production-bucket"
          invalid={errorFor('label', 'label') !== undefined}
          onChange={props.onLabelChange}
        />
      </FormRow>

      <FormRow label="Protocol" htmlFor="omni-protocol">
        {/* Locked after the first save: changing it would invalidate every
            settings field at once. Duplicate is the path to "same server,
            different protocol". */}
        <TextField
          id="omni-protocol"
          type="text"
          value={props.provider.displayName}
          readOnly
          onChange={() => undefined}
        />
      </FormRow>

      <h2 className="omni-section-heading">Settings</h2>
      {renderSection(props.provider.settingsSchema.fields, 'settings')}

      <FormRow label="Root path" htmlFor="omni-root" help="Folder to treat as the connection root.">
        <TextField
          id="omni-root"
          type="text"
          value={props.draft.rootPath}
          onChange={props.onRootPathChange}
        />
      </FormRow>

      <FormRow label="Read only" htmlFor="omni-readonly">
        <Checkbox
          id="omni-readonly"
          checked={props.draft.readOnly}
          onChange={props.onReadOnlyChange}
        />
      </FormRow>

      <h2 className="omni-section-heading">Credentials (stored in the OS keychain)</h2>
      {renderSection(props.provider.secretSchema.fields, 'secret')}

      <div className="omni-actions">
        <Button disabled={props.test.kind === 'running'} onClick={props.onTest}>
          {props.test.kind === 'running' ? 'Testing…' : 'Test Connection'}
        </Button>
        <Button disabled={!props.dirty} onClick={props.onRevert}>
          Revert
        </Button>
        <Button variant="primary" disabled={props.saving || !props.canSave} onClick={props.onSave}>
          {props.saving ? 'Saving…' : 'Save'}
        </Button>
        <Button disabled={props.draft.id === undefined || props.dirty} onClick={props.onConnect}>
          Connect
        </Button>
      </div>

      <TestReport test={props.test} />
      {props.lastError !== undefined && (
        <p className="omni-error" role="alert">
          {props.lastError}
        </p>
      )}
    </div>
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
