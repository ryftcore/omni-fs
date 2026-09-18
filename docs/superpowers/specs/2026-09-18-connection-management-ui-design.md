# Connection management UI

**Date:** 2026-09-18
**Status:** Approved, not yet implemented
**Replaces:** the sequential-prompt connection editor in `apps/vscode/src/commands/index.ts`

## Problem

Adding a connection today means answering eight or more prompts in a row. The
provider is a QuickPick, the name is an InputBox, then `promptForFields()`
(`apps/vscode/src/commands/index.ts:238`) walks `settingsSchema` and
`secretSchema` one field at a time. Nothing is visible at once, there is no way
back, a stray <kbd>Esc</kbd> discards everything, and there is no way to find
out whether the values work short of saving them and clicking Connect. Editing
is worse: a QuickPick asks whether you mean settings, credentials or the name,
then re-walks the whole chain.

The schema was always meant to be rendered as a form. `packages/core/src/provider.ts:144`
says so: the vocabulary is "deliberately not JSON Schema" and is kept small and
closed so hosts can render it "as a native VS Code webview form today and a
React form in the desktop app tomorrow". `apps/desktop/README.md` commits to the
same thing. This work builds that form, once, in a way both hosts use.

## Goals

- One screen listing every connection and editing the selected one.
- Verify a draft against the real server before it is saved anywhere.
- The UI's state machine and components are reused by `apps/desktop` unchanged;
  only an adapter and a theme file differ per host.
- Credentials never enter the webview.

## Non-goals

- Download and upload stay stubs. The transfer queue already exists in core; the
  local-file half is a separate piece of work.
- The connections tree keeps listing connections as roots and expanding into
  files. It is the browse surface and does not change, apart from three commands
  rerouting to the panel.
- No connection import/export, no folder grouping, no sharing UI.

## Architecture

Three new layers, split along the line the repo already draws between
host-agnostic packages and host applications.

```
packages/core/src/forms/        pure draft model - no React, no DOM, no host APIs
        |
packages/ui/  (@omni-fs/ui)     deps: react, react-dom, @omni-fs/core. Nothing else.
  ports/connections-backend.ts  THE SEAM - a Port, the same idiom as core's three
  model/reducer.ts              UI state machine - a pure function, not a hook
  model/use-connection-manager  thin useReducer wrapper
  components/                   our own components over native HTML elements
  theme/tokens.css              --omni-* custom properties with neutral fallbacks
        |
apps/vscode/src/webview/        WebviewBackend (postMessage) + theme-vscode.css
apps/desktop/src/ui/  (MVP 2)   IpcBackend (ipcRenderer)    + theme-desktop.css
```

Dependency arrows point one way only: `ui -> core`, `apps/* -> ui`. Never back.

### Why our own components

No widget library. `@vscode/webview-ui-toolkit` is deprecated (Microsoft
archived it in January 2025) and its successor, `@vscode-elements/elements`,
styles itself from `--vscode-*` CSS variables that do not exist in Electron.
Importing either would hard-couple the shared package to one host's look.

Every control is therefore a native element - `input`, `select`, `button` -
styled by us. Keyboard handling, focus order and screen-reader semantics come
from the platform instead of being reimplemented. The surface cannot sprawl,
because it is bounded by `SettingsField`'s closed union: `text`, `password`,
`number`, `boolean`, `select`, `file`.

### The seam is a Port

Core declares `SecretStore`, `ConfigStore` and `Logger`; each host implements
them. `packages/ui` gets one of its own, one layer up.

```ts
// packages/ui/src/ports/connections-backend.ts
export interface ConnectionsBackend {
  listProviders(): Promise<readonly ProviderSummary[]>;
  listConnections(): Promise<readonly ConnectionSummary[]>;
  save(input: SaveConnectionInput): Promise<ConnectionId>;
  remove(id: ConnectionId): Promise<void>;
  test(input: TestConnectionInput): Promise<ProbeOutcome>;
  connect(id: ConnectionId): Promise<void>;
  pickFile(): Promise<string | undefined>;
  onDidChange(listener: () => void): Disposable;
}
```

Everything crossing this interface is plain serializable data. That is forced
rather than incidental: in VS Code it travels through `postMessage`. So

- `ProviderSummary` is `{id, displayName, settingsSchema, secretSchema}`, not
  `ProviderDefinition` - that carries a `create()` closure and cannot cross.
- `ProbeOutcome.error` is `{code, message, retryable}`, not the `OmniFsError`
  instance that core's `probe()` returns. The panel converts at this boundary,
  the same way `toVsCodeError` converts at the other one.

Keeping the port serializable-only is what guarantees it survives the move to
Electron IPC without redesign.

`pickFile()` exists because `SettingsField` includes `kind: 'file'` - SFTP's
private key path - and a sandboxed webview cannot open a file dialog. VS Code
implements it with `showOpenDialog`, Electron with `dialog.showOpenDialog`.

`InMemoryConnectionsBackend` ships beside the port, mirroring
`InMemoryConfigStore` in core, so reducer tests and early desktop UI work need
no host at all.

### State is reused; only the adapter differs

`model/reducer.ts` is a pure function covering selection, draft, dirty flags,
field errors, test status and the save lifecycle.
`useConnectionManager(backend)` is a thin `useReducer` and effects wrapper over
it. Two payoffs: the state machine is testable in plain vitest with no jsdom,
and Electron reuses it byte for byte.

### Theming

`packages/ui/src/theme/tokens.css` declares the contract with standalone
fallbacks, so the package renders correctly with no host at all:

```css
:root {
  --omni-fg: #1f2328;
  --omni-bg: #ffffff;
  --omni-input-bg: #ffffff;
  --omni-border: #d0d7de;
  --omni-accent: #0969da;
  --omni-error: #cf222e;
  --omni-focus: #0969da;
}
```

`apps/vscode/src/webview/theme-vscode.css` remaps each token to the matching
`var(--vscode-*)`. That file is the only visual coupling to VS Code in the whole
stack, and is roughly 25 lines. The desktop app writes its own.

## Components

### `packages/core/src/forms/`

```
createDraft(provider, config?)     -> ConnectionDraft   applies field defaults
setField(draft, section, key, v)   -> ConnectionDraft   immutable
validateDraft(draft, provider)     -> readonly FieldError[]
isDirty(draft)                     -> boolean
toConfig(draft, id)                -> ConnectionConfig
toSecretPatch(draft)               -> Record<string, SecretPatchEntry>
```

Validation covers what the schema can express and nothing more: `required`,
`number` min/max and NaN, `select` option membership. Provider-specific
validation stays in the provider, where `readSettings()` already does it.

A draft's secret field is a three-state value:

```ts
type SecretFieldState =
  { kind: 'unchanged' } | { kind: 'set'; value: string } | { kind: 'cleared' };
```

`cleared` is not redundant. Without it an optional credential - S3's session
token, for instance - can never be removed once stored, because "empty" is
indistinguishable from "untouched".

This lives in core rather than in `packages/ui` because it validates
`ConnectionConfig`, which is a core model type; because it is the half that must
not drift between hosts; and because core is where vitest already runs.

### `packages/ui/src/components/`

```
ConnectionManagerApp.tsx   two-pane shell
  ConnectionList.tsx       New / Duplicate / Delete, status dot per row
  ConnectionForm.tsx       name, protocol, Settings, Credentials, Test/Revert/Save
    SchemaField.tsx        one switch over SettingsField['kind']
  primitives/              TextField, Checkbox, Select, Button, StatusDot,
                           FormRow, Toolbar, SplitPane
```

Dumb means literally dumb: no effect that fetches, no storage, no `postMessage`,
no knowledge that a keychain exists. `ConnectionForm` takes
`{draft, errors, providers, onFieldChange, onTest, onSave}` and returns
elements. Hand it a plain object in a test and it renders; hand it the same
object from Electron and it renders identically.

### `apps/vscode/src/webview/`

```
connection-manager-panel.ts   singleton panel, CSP+nonce HTML, method table
protocol.ts                   HostToView | ViewToHost discriminated unions
backend.ts                    WebviewBackend implements ConnectionsBackend
index.tsx                     createRoot, binds acquireVsCodeApi() to the backend
theme-vscode.css              --omni-* -> --vscode-*
```

## Data flow

### Message protocol

```ts
export type ViewToHost =
  { kind: 'ready' } | { kind: 'request'; id: number; method: MethodName; params: unknown };

export type HostToView =
  | { kind: 'response'; id: number; ok: true; value: unknown }
  | { kind: 'response'; id: number; ok: false; error: SerializedError }
  | { kind: 'event'; event: 'connectionsChanged' }
  | { kind: 'event'; event: 'stateChanged'; connectionId: string; state: ConnectionState };
```

`WebviewBackend` wraps request/response in promises keyed by a correlation id.
`connection-manager-panel.ts` holds the method table and is the only place that
touches `ConfigStore`, `SecretStore`, `ProviderRegistry` and
`ConnectionManager`.

The panel subscribes to `configStore.onDidChange` (already present at
`apps/vscode/src/host/vscode-ports.ts:146`) and to `manager.onDidChangeState`,
forwarding both as events. Hand-editing `settings.json` therefore updates an
open panel, and connection status dots track the tree.

### Panel lifecycle

Singleton: `reveal()` when already open. `retainContextWhenHidden` is `false`;
the webview posts `ready` on every load and the host replies with full state,
while an in-progress draft survives hiding through `vscode.setState()`.
`localResourceRoots` is `out/` only. Both subscriptions are disposed with the
panel.

### Credentials

Credentials never enter the webview. This shapes three types:

- `ConnectionSummary` carries `secretFieldsPresent: readonly string[]` - which
  keys hold a stored value, never the values themselves.
- Password inputs render empty, with the placeholder
  `•••••••• stored — type to replace` and a per-field Clear control.
- `SaveConnectionInput.secretPatch` carries only touched fields.

The merge - start from the stored secret, apply the patch, drop keys the current
`secretSchema` no longer declares - happens in the extension host. `test`
performs the same merge in memory and persists nothing.

Content Security Policy:

```
default-src 'none';
script-src 'nonce-{nonce}';
style-src {cspSource} 'unsafe-inline';
font-src {cspSource};
img-src {cspSource} data:;
```

Scripts are nonce-only. Inline styles are permitted because the split pane sets
a width attribute.

### Testing a draft

`ConnectionManager.acquire()` only works on a saved id: it reads the config from
the store and the secret from the keychain, both by id. Testing an unsaved draft
needs a new core method.

```ts
probe(
  target: ProbeTarget,          // providerId + settings + rootPath, no id
  secret: ConnectionSecret,     // merged in the host, never persisted
  signal?: AbortSignal,
): Promise<ProbeResult>
```

It builds a throwaway provider from the in-memory draft, calls `connect()`, then
`stat('/')` for a real round trip, and always disposes. It touches none of
`#live`, `#states` or `#idleTimers`, so a failing draft cannot poison the state
of an existing connection. It returns `ProbeResult`

- `{ok, capabilities?, error?: OmniFsError, durationMs}` - which lets the UI report "Connected in 340 ms · no rename, 16 parallel" rather
  than a bare tick - the capability set is the most useful thing a successful test
  can tell you.

## Commands

| Command                    | Today                                | After                                         |
| -------------------------- | ------------------------------------ | --------------------------------------------- |
| `omniFs.addConnection`     | eight or more sequential prompts     | opens the panel on a fresh draft              |
| `omniFs.editConnection`    | QuickPick, then re-walks the prompts | opens the panel with that connection selected |
| `omniFs.manageConnections` | -                                    | new; opens the panel                          |
| `omniFs.removeConnection`  | unchanged                            | unchanged; the panel also offers Delete       |

`promptForFields()` and `pickProvider()` are deleted - roughly 100 lines - and
`commands/index.ts` returns to being command wiring.

Protocol is locked after the first save. Changing it would invalidate every
settings field at once, so Duplicate is the path to "same server, different
protocol".

## Build and tooling

- `apps/vscode/esbuild.mjs` gains a second bundle: entry `src/webview/index.tsx`,
  `platform: 'browser'`, `format: 'esm'`, `jsx: 'automatic'`, producing
  `out/webview.js` and `out/webview.css`. Watch mode needs two contexts.
- `packages/ui` builds with `tsc -b` like every other package. Its `exports` map
  adds `"./tokens.css": "./src/theme/tokens.css"`: tsc does not copy CSS into
  `dist/`, and esbuild bundles it from source.
- `packages/ui/tsconfig.json` sets `jsx: "react-jsx"`,
  `lib: ["ES2023", "ESNext.Disposable", "DOM", "DOM.Iterable"]` and `types: []`.
  `ESNext.Disposable` is required because `ConnectionsBackend.onDidChange`
  returns a `Disposable`, matching core's ports. Dropping
  `@types/node` is deliberate - `process`, `Buffer` and `require` stop
  typechecking, so a component cannot reach a host API even by accident.
- `apps/vscode/package.json` adds `@omni-fs/ui`, `react` and `react-dom` as real
  dependencies. `.npmrc` sets `hoist=false`, so esbuild resolves only what is
  declared.
- `.vscodeignore` needs no change: `out/**` already ships minus `.d.ts` and
  `.map`.
- ESLint gains a `packages/ui/**/*.tsx` block with `react-hooks` rules, and a
  rule keeping transport globals (`acquireVsCodeApi`, `window.parent`) out of
  `packages/ui`.
- `.github/workflows/ci.yml:70` greps `packages/` with `--include='*.ts'`. It
  must gain `--include='*.tsx'` or the host-boundary check silently stops
  covering the new package. The `format:check` globs need the same treatment for
  `.tsx` and `.css`.

## Enforcement

The separation is enforced by the build, not by convention:

1. `types: []` in `packages/ui/tsconfig.json` removes Node globals.
2. The existing `packages/*` ESLint block bans `vscode` and `electron` imports.
3. A new restricted-globals rule bans transport globals in `packages/ui`, so
   transport cannot leak in through a global instead of an import.
4. The CI grep, once it covers `.tsx`, re-checks all of it independently of
   ESLint.
5. `packages/ui` declares only `react`, `react-dom` and `@omni-fs/core`, and
   `hoist=false` means an undeclared import fails to resolve.

## Tests

| Where                                                | What                                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/forms/*.test.ts`                  | defaults applied; required, min/max and select-membership validation; dirty tracking; `toConfig` / `toSecretPatch`; the three-state secret merge |
| `packages/core/src/connection/manager.probe.test.ts` | probe leaves `getState()` untouched; disposes on connect failure; wraps errors as `OmniFsError`                                                  |
| `packages/ui/src/model/reducer.test.ts`              | selection changes, the unsaved-changes guard, validation gating Save, the test lifecycle                                                         |

The probe tests use a stub `ProviderDefinition` declared in the test file. Core
cannot import `@omni-fs/testing` for `memoryProvider`, because that package
depends on core and the cycle would not resolve.

`packages/ui/src/model/reducer.test.ts` needs no jsdom, because the reducer is a
pure function. That is the reason the state machine is a reducer rather than a
hook.

This makes `packages/ui` the third package with tests, so the line in
`CLAUDE.md` stating that only `@omni-fs/core` and `@omni-fs/testing` have tests
must be updated with it.

Manual verification in the F5 extension host: add an S3 connection end to end,
Test before saving, edit it without retyping credentials, clear an optional
credential, hand-edit `settings.json` with the panel open, and confirm a
`kind: 'file'` field opens a native dialog.

## Migration

None. `ConnectionConfig` and the keychain key format are unchanged, so existing
connections keep working untouched.

## Risks

- **vsix size.** React and react-dom add roughly 140 KB minified against a 2 MB
  budget. The packaging job verifies it.
- **`exactOptionalPropertyTypes` with React props** is fussy. Expect explicit
  `| undefined` on optional props throughout `packages/ui`, matching what core
  already carries.
- **Webview state loss.** Mitigated by `vscode.setState()` for the draft plus a
  full resync on `ready`.
