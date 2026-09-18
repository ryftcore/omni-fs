import type { ReactNode } from 'react';
import type { FieldView } from '../model/field-view.js';
import { Button, Checkbox, errorId, FormRow, Select, TextField } from './primitives/index.js';

/** A dumb switch over `FieldControl`. All decisions were made by `fieldView`. */
export function SchemaField(props: {
  readonly view: FieldView;
  readonly onChange: (value: unknown) => void;
  readonly onClear: () => void;
  readonly onPickFile: () => void;
}): ReactNode {
  const { view } = props;
  const id = `omni-${view.section}-${view.key}`;
  const control = view.control;
  const describedBy = errorId(id, view.error !== undefined);

  const inner = ((): ReactNode => {
    switch (control.kind) {
      case 'checkbox':
        return <Checkbox id={id} checked={control.checked} onChange={props.onChange} />;
      case 'select':
        return (
          <Select
            id={id}
            value={control.value}
            options={control.options}
            describedBy={describedBy}
            onChange={props.onChange}
          />
        );
      case 'file':
        return (
          <span className="omni-actions">
            <TextField
              id={id}
              type="text"
              value={control.value}
              describedBy={describedBy}
              onChange={props.onChange}
            />
            <Button onClick={props.onPickFile}>Browse…</Button>
          </span>
        );
      case 'password':
        return (
          <span className="omni-actions">
            <TextField
              id={id}
              type="password"
              value={control.value}
              placeholder={control.placeholder}
              invalid={view.error !== undefined}
              describedBy={describedBy}
              onChange={props.onChange}
            />
            {control.stored && <Button onClick={props.onClear}>Clear</Button>}
          </span>
        );
      default:
        return (
          <TextField
            id={id}
            type={control.type}
            value={control.value}
            placeholder={control.placeholder}
            invalid={view.error !== undefined}
            describedBy={describedBy}
            onChange={props.onChange}
          />
        );
    }
  })();

  return (
    <FormRow
      label={view.label}
      htmlFor={id}
      required={view.required}
      help={view.help}
      error={view.error}
    >
      {inner}
    </FormRow>
  );
}
