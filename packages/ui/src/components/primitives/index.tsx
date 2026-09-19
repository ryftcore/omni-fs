import type { ChangeEvent, ReactNode } from 'react';
import type { ConnectionState } from '@omni-fs/core';

/**
 * Our own controls over native HTML elements.
 *
 * No widget library: @vscode/webview-ui-toolkit is deprecated and its
 * successor styles itself from --vscode-* variables that do not exist in
 * Electron, which would hard-couple this shared package to one host.
 * Native elements also bring keyboard and screen-reader behaviour for free.
 */

/**
 * The id FormRow's error message renders under, when it renders one at all.
 * Exported so a caller can pass the same id to TextField/Select as
 * `describedBy`, associating the input with its error for a screen reader.
 */
export function errorId(htmlFor: string, hasError: boolean): string | undefined {
  return hasError ? `${htmlFor}-error` : undefined;
}

export function FormRow(props: {
  readonly label: string;
  readonly htmlFor: string;
  readonly required?: boolean | undefined;
  readonly help?: string | undefined;
  readonly error?: string | undefined;
  /**
   * `inline` puts the control before its label on one line. Checkboxes use it:
   * a fixed-size control in a stretch column gets stretched to the full row
   * width, leaving the glyph stranded in the middle of the pane.
   */
  readonly inline?: boolean | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const describedBy = errorId(props.htmlFor, props.error !== undefined);
  const label = (
    <label htmlFor={props.htmlFor}>
      {props.label}
      {props.required === true ? ' *' : ''}
    </label>
  );

  return (
    <div className="omni-row">
      {props.inline === true ? (
        <span className="omni-check-line">
          {props.children}
          {label}
        </span>
      ) : (
        <>
          {label}
          {props.children}
        </>
      )}
      {props.help !== undefined && <small className="omni-help">{props.help}</small>}
      {props.error !== undefined && (
        <small className="omni-error" id={describedBy} role="alert">
          {props.error}
        </small>
      )}
    </div>
  );
}

export function TextField(props: {
  readonly id: string;
  readonly type: 'text' | 'password' | 'number';
  readonly value: string;
  readonly placeholder?: string | undefined;
  readonly invalid?: boolean | undefined;
  readonly readOnly?: boolean | undefined;
  readonly describedBy?: string | undefined;
  readonly onChange: (value: string) => void;
}): ReactNode {
  return (
    <input
      className="omni-input"
      id={props.id}
      type={props.type}
      value={props.value}
      placeholder={props.placeholder}
      readOnly={props.readOnly === true}
      aria-invalid={props.invalid === true}
      aria-describedby={props.describedBy}
      onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(event.target.value)}
    />
  );
}

export function Checkbox(props: {
  readonly id: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}): ReactNode {
  return (
    <input
      id={props.id}
      type="checkbox"
      checked={props.checked}
      onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(event.target.checked)}
    />
  );
}

export function Select(props: {
  readonly id: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly describedBy?: string | undefined;
  readonly onChange: (value: string) => void;
}): ReactNode {
  return (
    <select
      className="omni-select"
      id={props.id}
      value={props.value}
      aria-describedby={props.describedBy}
      onChange={(event: ChangeEvent<HTMLSelectElement>) => props.onChange(event.target.value)}
    >
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Button(props: {
  readonly variant?: 'primary' | 'danger' | 'default' | undefined;
  readonly disabled?: boolean | undefined;
  readonly title?: string | undefined;
  readonly hasPopup?: boolean | undefined;
  readonly expanded?: boolean | undefined;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <button
      className="omni-button"
      type="button"
      data-variant={props.variant ?? 'default'}
      disabled={props.disabled === true}
      title={props.title}
      aria-haspopup={props.hasPopup === true ? 'menu' : undefined}
      aria-expanded={props.hasPopup === true ? props.expanded === true : undefined}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function StatusDot(props: { readonly state: ConnectionState }): ReactNode {
  return <span className="omni-dot" data-status={props.state.status} aria-hidden="true" />;
}

/** The one place connection status is turned into words, for header and list. */
export function statusLabel(state: ConnectionState): string {
  switch (state.status) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting…';
    case 'error':
      return 'Error';
    default:
      return 'Not connected';
  }
}
