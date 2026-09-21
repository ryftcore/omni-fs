# Contributing to omni-fs

Thanks for taking a look. The most valuable contribution right now is a protocol
implementation — the interface is designed so that adding one touches no
existing code.

## Setup

```bash
pnpm install
pnpm build
```

Requires Node 22+ and pnpm 12+ (the `allowBuilds` key in `pnpm-workspace.yaml` needs pnpm 12). Open the repo in VS Code and press
<kbd>F5</kbd> to launch the extension in a development host.

## Commands

| Command             | What it does                                                     |
| ------------------- | ---------------------------------------------------------------- |
| `pnpm build`        | Build every package in dependency order                          |
| `pnpm dev`          | Watch mode across the workspace                                  |
| `pnpm typecheck`    | Type check without emitting                                      |
| `pnpm test`         | Unit tests and the conformance suite                             |
| `pnpm lint`         | ESLint, including the architecture boundary rules                |
| `pnpm format`       | Prettier                                                         |
| `pnpm package:vsix` | Build a `.vsix` into `apps/vscode/` (builds the workspace first) |

Run `pnpm build && pnpm typecheck && pnpm test && pnpm lint` before opening a PR.
CI runs exactly that.

## The architecture rule

**Nothing in `packages/` may import `vscode` or `electron`. Nothing in
`packages/core` may import a protocol SDK.**

This is what lets the planned desktop app reuse the entire protocol layer
instead of reimplementing it. ESLint enforces it, so you will get a clear error
rather than a surprise later.

If core seems to need something only a host can provide, the answer is a new
**Port** in `packages/core/src/ports/` that each host implements — not a host
import. There are three today: `SecretStore`, `ConfigStore`, `Logger`.

Please read [`docs/architecture.md`](docs/architecture.md) before a structural
change, and add an ADR under [`docs/adr/`](docs/adr) when you make one.

## Adding a protocol

1. Create `packages/provider-<name>/`, modelled on `packages/provider-s3` — it
   is the reference implementation and the hardest case, since S3 has no
   directories.

2. Implement `RemoteFileSystem`. Four rules:
   - **Throw only `OmniFsError`.** Translate native failures in a dedicated
     `errors.ts`. Above your package, nothing knows your protocol's error names.
   - **Never cache.** `ManagedFileSystem` handles that for every protocol
     identically.
   - **Declare `ProviderCapabilities` honestly.** Do not emulate an operation
     and claim it as native. Core emulates what it can; the UI adapts to what
     you declare.
   - **Accept an `AbortSignal`** on anything that touches the network.

3. Export a `ProviderDefinition` with `settingsSchema` and `secretSchema`. These
   are declarative, and both hosts render them — so you get a connection editor
   without writing any UI.

4. Add a conformance test:

   ```ts
   import { runConformanceSuite } from '@omni-fs/testing';

   runConformanceSuite({
     name: 'FTP (vsftpd)',
     setup: async () => ({ fs: await connectToTestServer(), root: RemotePath.parse('/test') }),
     teardown: (fs) => fs.delete(RemotePath.parse('/test'), { recursive: true }),
   });
   ```

   Your provider is finished when this passes. Tests skip themselves based on
   your declared capabilities, so you are never penalised for something the
   protocol genuinely cannot do — only for claiming something it cannot.

5. Register it in `apps/vscode/src/extension.ts`: one import, one line.

No changes to `packages/core`. If you find yourself needing one, that is worth
discussing in an issue first — it usually means the contract is missing
something real.

## Tests

`packages/testing` holds the shared conformance suite. Adding a case there holds
**every** provider to it, which is how "universal" stays honest rather than
drifting into four subtly different implementations.

`MemoryFileSystem` is a complete in-memory provider whose capabilities can be
overridden to impersonate any protocol, so you can test emulation paths without
a network.

## Commits

Single-line messages, emoji prefix, no body:

```
:sparkles: feat add SFTP provider
:bug: fix handle FTP 550 as NotFound
:memo: docs explain capability emulation
:recycle: refactor extract path normalisation
:white_check_mark: test cover recursive delete on object stores
```

## Releasing

The version lives in `apps/vscode/package.json`, and an odd minor (0.1.x,
0.3.x) marks a pre-release. Do not use a semver suffix such as
`0.2.0-beta.1`: the VS Code Marketplace rejects it.

1. Open a PR that bumps the version and adds its entry to
   `apps/vscode/CHANGELOG.md`. The READMEs carry no version numbers, so they
   only change when features do.
2. After it merges, push a matching tag: `git tag -s v0.1.1 && git push origin v0.1.1`.
3. The **Release** workflow verifies and packages the extension, publishes it to
   Open VSX, then creates a GitHub release with the `.vsix` attached.
4. Upload that same `.vsix` to the VS Code Marketplace by hand.

Running the Release workflow by hand from a branch is a dry run: it packages,
checks that the Open VSX token can publish, and publishes nothing.

## Reporting bugs

Please include the protocol and server software (AWS S3 vs MinIO vs R2 matters —
they disagree on error codes), what you expected, what happened, and the
relevant part of the **Omni-FS** output channel with `omniFs.logLevel` set to
`debug`.

Never paste credentials or a full endpoint URL containing one.
