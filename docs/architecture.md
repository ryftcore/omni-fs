# Architecture

omni-fs is a universal file system client for remote storage. It ships as two
applications built on one shared core:

1. **VS Code extension** (`apps/vscode`) — the current MVP.
2. **Desktop app** (`apps/desktop`) — planned, not started.

Everything here follows from one goal: when the desktop app starts, it should be
a new user interface over existing, already-tested logic — not a second
implementation of omni-fs.

---

## The shape

```
┌──────────────────────────┐   ┌──────────────────────────┐
│      apps/vscode         │   │   apps/desktop (later)   │
│                          │   │                          │
│  FileSystemProvider      │   │  React renderer          │
│  TreeViews, commands     │   │  Electron main           │
│  VsCodeSecretStore  ─────┼───┼──►  ElectronSecretStore  │  ← adapters
│  VsCodeConfigStore       │   │     ElectronConfigStore  │     implement
│  VsCodeLogger            │   │     ElectronLogger       │     the Ports
└───────────┬──────────────┘   └───────────┬──────────────┘
            │                              │
            └──────────────┬───────────────┘
                           ▼
              ┌─────────────────────────┐
              │     @omni-fs/core       │   no vscode, no electron,
              │                         │   no protocol SDKs
              │  RemoteFileSystem  ◄────┼── the provider contract
              │  ProviderCapabilities   │
              │  OmniFsError            │
              │  ConnectionManager      │
              │  ManagedFileSystem      │
              │  TransferQueue          │
              │  EntryCache             │
              │  Ports: SecretStore,    │
              │         ConfigStore,    │
              │         Logger          │
              └────────────┬────────────┘
                           │  implemented by
     ┌──────────┬──────────┼──────────┬──────────────┐
     ▼          ▼          ▼          ▼              ▼
 provider-s3  -ftp      -sftp     -webdav      (your protocol here)
```

## The one rule

**Nothing in `packages/` may import `vscode` or `electron`. Nothing in
`packages/core` may import a protocol SDK.**

This is enforced by ESLint (`eslint.config.js`), not by convention, because a
rule this important should fail a build rather than depend on a reviewer
noticing. Try it: add `import * as vscode from 'vscode'` to any file under
`packages/` and `pnpm lint` fails with an explanation of where the code belongs.

When core genuinely needs something only a host can do — a keychain, a settings
file, a log window — that need is expressed as a **Port**: an interface in
`packages/core/src/ports/` that each host implements. There are three today, and
adding a fourth is the correct response to "core needs to ask the user
something", not reaching for a host API.

## The four layers

### 1. Providers — translate one protocol

A provider implements `RemoteFileSystem` and does nothing else. Its entire job
is to turn protocol-specific calls and errors into the shared vocabulary.

Rules for a provider:

- **Throw only `OmniFsError`.** Translate native failures at this boundary. S3's
  `NoSuchKey`, FTP's `550`, SFTP's `ENOENT` and WebDAV's `404` all become
  `code: 'NotFound'` exactly once, here. Above this line nothing knows those
  names exist, so adding a protocol never changes a consumer.
- **Never cache.** Caching is core's job so that all protocols behave alike and
  a staleness bug is fixed once.
- **Declare capabilities honestly.** Do not emulate an operation you cannot
  perform and claim you can.
- **Accept an `AbortSignal`** on anything touching the network.

`packages/provider-s3` is the reference implementation. It is the hardest case —
S3 has no directories — so if the contract fits S3 it fits the rest.

### 2. Capabilities — let protocols differ honestly

Protocols differ more than one interface can hide, and pretending otherwise is
how universal file clients get bad. S3 has no directories, no rename and no
append. FTP has no server-side copy. WebDAV has no partial write.

So every provider declares `ProviderCapabilities` up front. The UI greys out a
menu item instead of showing an error after the user clicks it, and the transfer
queue reads `maxConcurrency` to know that FTP's single control channel takes one
operation at a time while S3 happily takes sixteen.

|                       | S3  | FTP/FTPS | SFTP | WebDAV |
| --------------------- | --- | -------- | ---- | ------ |
| Real directories      | ✗   | ✓        | ✓    | ✓      |
| Native rename         | ✗   | ✓        | ✓    | ✓      |
| Server-side copy      | ✓   | ✗        | ✗    | ✓      |
| Append                | ✗   | ✓        | ✓    | ✗      |
| Version tokens (ETag) | ✓   | ✗        | ✗    | ✓      |
| Safe concurrency      | 16  | **1**    | 4    | 6      |

### 3. `ManagedFileSystem` — make them look alike again

Providers stay small and honest; this decorator fills the gaps so hosts see one
predictable surface:

- **Caching** of stat and listing results, invalidated precisely on every
  mutation rather than only by TTL.
- **Rename on S3** becomes server-side copy + delete.
- **Recursive delete** on a protocol without one becomes a depth-first walk.
- **Copy** without server-side support becomes a stream, and only buffers in
  memory as a last resort (with a log line, because that is worth knowing).
- **`mkdir` on an object store** succeeds silently, because a prefix needs no
  creating and the folder appears with its first object.
- **Read-only connections** are rejected before a request leaves the machine.

These are product decisions, not VS Code decisions, which is precisely why they
live here and not in the extension.

### 4. Hosts — UI and ports only

`apps/vscode` contains the `FileSystemProvider`, two tree views, commands, and
the three port adapters. It contains no protocol logic, no caching policy and no
retry policy. `apps/vscode/src/extension.ts` is a composition root: construct
core services, register four providers, plug in three adapters.

The desktop app's `main.ts` will be recognisably that same function with
different adapters. **If a change ever makes that stop being true, the change is
in the wrong layer.**

## Why `FileSystemProvider` _and_ a tree view

Registering `omnifs://` as a `vscode.FileSystemProvider` is what makes remote
files first-class: they open in normal editors, <kbd>Ctrl</kbd>+<kbd>S</kbd>
uploads, search and quick-open work, and a connection can be added to the
workspace as a folder. The alternative — a bespoke tree with
download-edit-reupload — is what most FTP extensions do, and it is why they feel
like a separate application bolted onto the side of the editor.

The tree view exists alongside it for what the Explorer cannot express:
connection status, connect/disconnect, credential management, and browsing a
server you have not mounted. Both read through the same `ConnectionManager` and
`EntryCache`, so expanding a folder in one warms the cache for the other.

Which connections are mounted is a third piece of state, and VS Code owns it:
the user can remove a folder from the Explorer, and a saved workspace brings
one back on the next start. So the tree keeps no copy — `WorkspaceMounts` reads
`vscode.workspace.workspaceFolders` each time it is asked. A mounted folder
reconnects on use, since VS Code reads from it whenever it likes; that is what
mounting consents to. An explicit Disconnect therefore unmounts too, or the next
read would undo it. An idle or config-changed disconnect does not, because the
user never asked for the folder to go.

## Credentials

`ConnectionConfig` and `ConnectionSecret` are separate types on purpose.

Config is safe to persist, sync, export and commit — it lives in the
`omniFs.connections` setting so a team can share connection definitions through
`.vscode/settings.json`. Secrets never touch it; they go through the
`SecretStore` port into the OS keychain via VS Code's `SecretStorage`.

Keeping them as distinct types means writing a secret into a config object is a
compile error rather than an access key in someone's repository.

## Testing: one contract, every provider

`packages/testing` exports `runConformanceSuite()` — a single behavioural
contract that every provider must satisfy. This is the mechanism that keeps
"universal" honest: four protocols with four hand-written test suites drift,
where S3 grows a test for an edge case FTP silently gets wrong.

Adding a case to `conformance.ts` immediately holds every provider to it, and a
new provider is finished exactly when the suite passes. Tests skip themselves
based on declared capabilities, so a provider is never penalised for something
it genuinely cannot do — only for lying about it.

`MemoryFileSystem` is a complete in-memory provider whose capabilities can be
overridden to impersonate any protocol. The suite runs against it twice, once as
a POSIX-like filesystem and once pinned to an object-store profile, which is
what catches a test that accidentally assumes real directories exist.

## Adding a protocol

1. `packages/provider-<name>/` with a class implementing `RemoteFileSystem`.
2. Map native errors to `OmniFsError` in a dedicated `errors.ts`.
3. Declare `ProviderCapabilities` honestly.
4. Export a `ProviderDefinition` with its settings and secret schemas.
5. Run the conformance suite against a container.
6. Register it in each host — one import, one line.

No edits to core. No `switch` on provider id anywhere. No UI work: the
connection editor is generated from the declarative `SettingsSchema`.

## When the desktop app starts

Reused as-is: all of `packages/` — four providers, the provider contract,
capabilities, error taxonomy, connection lifecycle, transfer queue, cache,
emulation rules, and the conformance suite.

Written new: an Electron main process, a React renderer, and one
`electron-ports.ts` implementing the same three ports.

The estimate that matters: roughly 85% of non-UI code is shared, and the
protocol layer — the part with genuine complexity and the part that is expensive
to get wrong twice — is shared in full.

## Decisions

See `docs/adr/` for the reasoning behind the significant choices.
