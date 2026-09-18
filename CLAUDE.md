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

Single test:

```bash
pnpm --filter @omni-fs/core exec vitest run src/model/path.test.ts
pnpm --filter @omni-fs/core exec vitest run -t "derives parent and basename"
```

`pnpm package:vsix` goes through turbo on purpose — the extension bundles the
workspace packages' `dist/`, so `pnpm --filter omni-fs-vscode package` fails on
a clean checkout. Press <kbd>F5</kbd> in VS Code for a dev extension host.

## The rule everything depends on

**Nothing in `packages/` may import `vscode` or `electron`. Nothing in
`packages/core` may import a protocol SDK.**

MVP 1 is the VS Code extension; MVP 2 is a desktop app (Electron, not started)
that must reuse the entire protocol layer rather than reimplement it. That is
only possible if the boundary holds, so it is enforced by ESLint
(`eslint.config.mjs`) and re-checked by a grep job in CI — not by convention.

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
`apps/vscode/src/fs/omni-file-system-provider.ts`). `retryable` is the only
thing `TransferQueue` consults when deciding to retry.

**`ProviderRegistry`** is the extension point. There is no `switch` on provider
id anywhere in core, so a new protocol is a new package plus one `register()`
call per host.

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

## Repo constraints

- **Commits are a single title line**: `:emoji: <type> <description>`, no body.
  Never add `Co-Authored-By`, `Generated with Claude Code`, or any session
  attribution — this repo is being open-sourced. CI enforces the format
  (bot-authored PRs exempt).
- **TypeScript is held at 6.0.x.** typescript-eslint 8.70 declares
  `typescript: ">=4.8.4 <6.1.0"`; TS 7 would silently disable type-aware
  linting, including the boundary rule. Dependabot ignores `typescript >=7`.
- **`@types/node` is held at 22** to match `engines.node`, so code cannot
  compile against APIs missing at runtime. Same for `@types/vscode` vs
  `engines.vscode`.
- `tsconfig.base.json` names `lib`/`types` explicitly because TS 6 stopped
  auto-including `@types` packages.
- GitHub Actions are pinned to commit SHAs. CodeQL, Dependency Review and
  Scorecard are gated on repo visibility — they skip while the repo is private
  and activate on going public.

## Current state

S3 is implemented. FTP, SFTP and WebDAV are deliberate skeletons: capabilities
and schemas declared, methods throwing `Unsupported`. Download/upload commands
are stubs — the queue, retry and progress already exist in core; only the
local-file half is missing. `turbo.json` defines a `test:conformance` task that
no package implements yet.
