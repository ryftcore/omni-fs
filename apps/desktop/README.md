# omni-fs desktop (planned)

Not started. This directory is a placeholder that records the intended shape, so
the decision is written down rather than rediscovered later.

## What it will be

An Electron application: Node in the main process, React in the renderer.

## What it will reuse

All of `packages/` — unchanged:

- Four protocol providers.
- `RemoteFileSystem`, `ProviderCapabilities`, `OmniFsError`.
- `ConnectionManager` — lazy connect, de-duplicated concurrent connects, idle
  eviction.
- `ManagedFileSystem` — caching and capability emulation.
- `TransferQueue` — priority, per-connection concurrency, backoff retry.
- `EntryCache`.
- The conformance suite.

## What it will add

1. **`electron-ports.ts`** — the same three ports `apps/vscode` implements:
   - `SecretStore` → `safeStorage` + keytar, in place of VS Code `SecretStorage`
   - `ConfigStore` → a JSON file in `userData`, in place of the settings API
   - `Logger` → electron-log, in place of an `OutputChannel`

2. **A renderer**: connection manager, dual-pane browser, transfer panel. The
   connection editor renders the same declarative `SettingsSchema` the extension
   does, as a React form instead of a QuickPick — so protocols added for the
   extension appear here with no extra work.

3. **`main.ts`** — a composition root that will look like
   `apps/vscode/src/extension.ts`: construct core services, register providers,
   plug in adapters. If it ever needs to do more than that, something belongs in
   `packages/core` that has leaked into a host.

## Boundary

Nothing here may be imported by `packages/` — enforced by ESLint. See
[`../../docs/architecture.md`](../../docs/architecture.md).
