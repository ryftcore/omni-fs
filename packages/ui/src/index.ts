export type {
  ConnectionSummary,
  ConnectionsBackend,
  InitialSelection,
  ProbeOutcome,
  SaveConnectionInput,
  TestConnectionInput,
} from './ports/connections-backend.js';
export { InMemoryConnectionsBackend } from './ports/in-memory-backend.js';
export {
  initialManagerState,
  managerReducer,
  saveInputFrom,
  selectedConnection,
  selectedProvider,
} from './model/reducer.js';
export type { ManagerAction, ManagerState, Selection, TestState } from './model/reducer.js';
export { fieldView, STORED_SECRET_PLACEHOLDER } from './model/field-view.js';
export type { FieldControl, FieldView } from './model/field-view.js';
