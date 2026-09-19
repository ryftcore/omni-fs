# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Node 22+, pnpm 12+ (`allowBuilds` in `pnpm-workspace.yaml` needs pnpm 12).

```bash
pnpm build          # turbo, dependency-ordered
pnpm typecheck
pnpm lint           # eslint at the repo root (not per-package)
pnpm test
pnpm format:check   # CI enforces this
pnpm package:vsix   # -> apps/vscode/*.vsix
```

CI runs `build && typecheck && lint && test` on Linux, macOS and Windows, plus
`format:check` and the commit-title check in a separate workflow.

Single test:

```bash
pnpm --filter @omni-fs/core exec vitest run src/model/path.test.ts
pnpm --filter @omni-fs/core exec vitest run -t "derives parent and basename"
```

Only `@omni-fs/core`, `@omni-fs/testing` and `@omni-fs/ui` have tests today; the
provider packages run `vitest --passWithNoTests`. `pnpm test` in
`packages/testing` is the conformance suite, and is where most behaviour is
actually verified. `packages/ui` runs its tests without jsdom — its state
machine is a pure reducer, so there is no DOM to simulate.

`pnpm package:vsix` goes through turbo on purpose — the extension bundles the
workspace packages' `dist/`, so `pnpm --filter omni-fs-vscode package` fails on
a clean checkout. Press <kbd>F5</kbd> in VS Code for a dev extension host.

`packages/*` build with `tsc -b` (composite projects); `apps/vscode` builds with
esbuild and type checks separately (`tsc -p tsconfig.json --noEmit`). So after
changing core, run `pnpm build` before the extension's typecheck means anything
— it resolves `@omni-fs/core` through `dist/`, not source.

## The rule everything depends on

**Nothing in `packages/` may import `vscode` or `electron`. Nothing in
`packages/core` may import a protocol SDK.**

MVP 1 is the VS Code extension; MVP 2 is a desktop app (Electron, not started —
`apps/desktop` is a README describing its intended shape) that must reuse the
entire protocol layer rather than reimplement it. That is only possible if the
boundary holds, so it is enforced by ESLint (`eslint.config.mjs`, with
`no-restricted-imports` messages that say where the code belongs) and re-checked
by a grep job in CI — not by convention.

When core needs something only a host can do, add a **Port** under
`packages/core/src/ports/` and implement it per host. There are three:
`SecretStore`, `ConfigStore`, `Logger`. `apps/vscode/src/host/vscode-ports.ts`
is the entire VS Code adapter layer; the desktop app gets an
`electron-ports.ts` of comparable size and nothing else changes.

## Architecture

Four layers, described fully in `docs/architecture.md`; decisions in `docs/adr/`.

**Providers** (`packages/provider-*`) translate one protocol and do nothing
else. Each must: throw only `OmniFsError` (translate native errors in its own
`errors.ts`), never cache, declare capabilities honestly, and accept an
`AbortSignal` on anything touching the network. `provider-s3` is the reference
implementation — it is the hardest case because S3 has no directories.

Optional methods on `RemoteFileSystem` (`createDirectory`, `rename`, `copy`,
`createWriteStream`, `watch`) exist only when the matching capability is true.
Do not implement one and declare the capability false, or vice versa.

**`ProviderCapabilities`** is how protocols are allowed to differ honestly.
Callers check it instead of calling and interpreting a failure; the UI greys
out actions in advance, and `TransferQueue` reads `maxConcurrency` so FTP's
single control channel serialises while S3 fans out sixteen ways. Adding a
capability defaults to "no" for existing providers via `MINIMAL_CAPABILITIES`.

**`ManagedFileSystem`** (`packages/core/src/fs/`) decorates a raw provider and
makes every protocol look alike: caching with precise invalidation on mutation,
rename-as-copy+delete on S3, recursive delete by walk, streamed copy, silent
`mkdir` on prefix-only stores, read-only enforcement. These are product
behaviours, not VS Code behaviours — which is why they must not drift into the
extension.

**`OmniFsError`** is the single error vocabulary. Providers translate inward
once; hosts translate outward once (`toVsCodeError` in
`apps/vscode/src/fs/omni-file-system-provider.ts`, where the mapping decides
whether a remote file feels native — `FileNotFound` drives create-on-save,
`NoPermissions` a read-only editor). `retryable` is the only thing
`TransferQueue` consults when deciding to retry.

**`ProviderRegistry`** is the extension point. There is no `switch` on provider
id anywhere in core, so a new protocol is a new package plus one `register()`
call per host. `apps/vscode/src/extension.ts` is the composition root and should
stay one: construct core services, register providers, plug in adapters.

**`@omni-fs/ui`** is the connection manager, shared by both hosts. It depends on
React and `@omni-fs/core` and nothing else — no widget library, no host APIs.
Its single seam is the `ConnectionsBackend` port: `apps/vscode` implements it
over `postMessage`, `apps/desktop` will implement it over IPC, and the
components above it do not change. Everything crossing that port is plain
serializable data, because in VS Code it is structured-cloned.

**`RemotePath`** is the one path shape: POSIX, absolute, no trailing slash,
`.`/`..` resolved, normalised at the provider boundary. VS Code URIs are
`omnifs://<connectionId>/<path>` — authority is the connection id.

`ConnectionConfig` and `ConnectionSecret` are separate types deliberately:
config is committable (it lives in the `omniFs.connections` setting so teams
can share it), secrets go only through `SecretStore` to the OS keychain.
Writing one into the other is a compile error.

## Adding a protocol

New `packages/provider-<name>/` implementing `RemoteFileSystem`, exporting a
`ProviderDefinition` with declarative `settingsSchema`/`secretSchema` (both
hosts render these, so no UI work), then one line in
`apps/vscode/src/extension.ts`. No core changes — if you need one, the contract
is probably missing something real.

## Tests

`packages/testing` exports `runConformanceSuite()` — one behavioural contract
every provider must pass. Adding a case there holds _all_ providers to it,
which is what stops "universal" drifting into four different implementations.
Tests skip themselves based on declared capabilities, so a provider is only
penalised for lying.

`MemoryFileSystem` is a complete in-memory provider whose capabilities can be
overridden to impersonate any protocol. `pnpm test` runs the suite against it
twice — full-featured, then pinned to an object-store profile — which is what
catches a test that assumes real directories exist.

The same contract has a live target: a provider package's `test:conformance`
script runs it against that protocol's server in `compose.yaml`. The hermetic
runs prove the suite is coherent; the live run is the one that says a real
protocol meets it, which is why a provider is finished exactly when it passes.

## Repo constraints

- **Commits are a single title line**: `:emoji: <type> <description>`, no body.
  Never add `Co-Authored-By`, `Generated with Claude Code`, or any session
  attribution — this repo is being open-sourced. CI enforces both the title
  pattern and the empty body (bot-authored PRs exempt).
- **TypeScript is held at 6.0.x.** typescript-eslint 8.70 declares
  `typescript: ">=4.8.4 <6.1.0"`; TS 7 would silently disable type-aware
  linting, including the boundary rule. Dependabot ignores `typescript >=7`.
- **`@types/node` is held at 22** to match `engines.node`, so code cannot
  compile against APIs missing at runtime. Same for `@types/vscode` vs
  `engines.vscode`.
- `tsconfig.base.json` names `lib`/`types` explicitly because TS 6 stopped
  auto-including `@types` packages. Strictness is high:
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax` — hence the `| undefined` on optional properties
  throughout core.
- `.npmrc` sets `hoist=false`: a package may only import what its own
  `package.json` declares.
- The packaging job fails if the `.vsix` exceeds 2 MB — usually a
  `.vscodeignore` miss rather than a real size problem.
- GitHub Actions are pinned to commit SHAs. CodeQL, Dependency Review and
  Scorecard are gated on repo visibility — they skip while the repo is private
  and activate on going public.

## Current state

S3 and WebDAV are implemented; FTP and SFTP are deliberate skeletons:
capabilities and schemas declared, methods throwing `Unsupported`. WebDAV
declares `canWatch: false` because the protocol has no change notification at
all, so core polls it. Download/upload commands are stubs — the queue, retry
and progress already exist in core; only the local-file half is missing.
`pnpm test:conformance` runs the shared suite against the live servers in
`compose.yaml`; `packages/provider-webdav` implements it today.
