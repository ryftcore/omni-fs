# VS Code extension tests

**Date:** 2026-09-20
**Status:** Approved, not yet implemented

## Problem

`apps/vscode` has no tests. It is 1,598 lines of host code — the filesystem
provider, both port adapters, two tree providers, twelve commands and a webview
— and `pnpm test` says nothing about any of it.

What is untested is precisely the layer that decides whether a remote file feels
native. `OmniFileSystemProvider` translates `vscode.Uri` to `RemotePath` and
`OmniFsError` to `vscode.FileSystemError`, and its own comment explains the
stakes: "`FileNotFound` triggers a create-on-save flow, `NoPermissions` shows a
read-only editor — so getting this mapping right is the difference between a
remote file feeling native and feeling broken." Break that table and every
provider still passes conformance while the editor misbehaves.

The manifest is unchecked too. `package.json` contributes twelve commands and
two views; `registerCommands` registers some list of ids. Nothing compares them,
so a command can be contributed and never registered — a menu entry that throws
"command not found" when clicked.

And the shipped artifact is unchecked. esbuild flattens four protocol SDKs into
one minified CommonJS file. That transformation is not free: `cpu-features`
cannot be bundled at all and is already externalised, `ssh2` requires it inside
a `try` and silently falls back to pure-JS crypto, and `@aws-sdk` resolves parts
of itself lazily. CI's `package` job proves the `.vsix` builds and stays under
2 MB. Nothing proves `ssh2` still opens a connection after being bundled.

Three gaps, one harness: run the real extension inside a real Extension
Development Host.

## Goals

- The extension activates in a real host, and its manifest agrees with its code:
  every contributed command id is registered, both views exist, every
  `omniFs.*` setting is contributed.
- `vscode.workspace.fs` round-trips over `omnifs://` against an in-memory
  provider — stat, readDirectory, readFile, writeFile, createDirectory, rename,
  delete.
- The `OmniFsError` to `FileSystemError` table is asserted through the API
  VS Code itself calls, not through a unit test of the mapping function.
- `VsCodeConfigStore` is proved against real VS Code configuration, and
  `VsCodeSecretStore`'s serialisation behaviour against a `SecretStorage`
  double.
- The **bundled** extension connects to a live SFTP and WebDAV server and moves
  bytes, proving esbuild did not break those SDKs.
- `pnpm test` stays hermetic, headless and fast. This suite is a separate task.

## Non-goals

- **Webview automation.** The Connection Manager panel's rendering and
  `postMessage` protocol stay untested here. Driving a webview from the
  extension host is slow and brittle, and `@omni-fs/ui` already tests the
  reducer underneath it.
- **Tree provider rendering.** `ConnectionsTreeProvider` and
  `TransfersTreeProvider` produce `TreeItem`s; asserting their labels and
  context values is a unit-test job that does not need an Electron host.
- **Command bodies.** Every command opens a quick pick, an input box or a modal.
  Testing them needs UI automation; a test that only proves a command "did not
  throw" asserts nothing and would be worse than no test.
- **Re-testing `@omni-fs/core`.** `runConformanceSuite()` owns provider
  behaviour and `packages/core` owns its own. This suite tests the host.
- **A second conformance suite over the editor.** The live label is a smoke
  test, deliberately shallow. Depth belongs in `test:conformance`.
- **Coverage measurement.** Not wired for any package in this repo.
- **FTP and S3 live coverage.** `provider-ftp` is still a skeleton
  (`TODO(provider-ftp): implement against basic-ftp`), and `provider-s3` has no
  live conformance config despite minio being in `compose.yaml`. Both join the
  live label when they are ready; see Risks.

## Decisions

### 1. `@vscode/test-cli` with `@vscode/test-electron`, running Mocha

This is the setup the VS Code documentation prescribes, and the only one that
boots a real extension host. Vitest cannot provide the `vscode` module.

The consequence is two test frameworks in one repo: Vitest for hermetic units,
Mocha inside the extension host. Accepted, because they never meet — different
turbo task, different directory, different compile output, different runner.
Mocha's `tdd` interface (`suite`/`test`) is used to match VS Code's own samples.

### 2. `activate` returns a public `OmniFsApi`

The extension registers four providers and exposes nothing, so a test has no way
to put a fake in front of it.

`activate` returns `{ registry }` behind a named `OmniFsApi` interface. This is
a genuine public extension API, not only a test hook: `ProviderRegistry` is
already the documented extension point — "a new protocol is a new package plus
one `register()` call per host" — so publishing it means a third-party extension
could add a protocol to omni-fs. It is documented as unstable before 1.0.

**`OmniFsApi` deliberately does not expose `SecretStore`.** Any extension can
call another extension's exported API, so publishing a credential store would
let unrelated code read omni-fs passwords and keys out of the OS keychain.
Tests that need a credential supply it through a wrapped provider definition
instead (Decision 4).

### 3. Test files bundle to CommonJS with esbuild, as part of `build`

`tsc` emitting CommonJS would produce `require('@omni-fs/testing')` against a
workspace package that is `"type": "module"` with an ESM-only `exports` map.
That fails at runtime inside the extension host, where a type checker cannot
warn about it. esbuild bundles the ESM dependency into the CJS test file, which
is exactly what it already does for the extension itself.

Test bundles are produced by `build`, not by the test script, and skipped under
`--production`. The reason is turbo: `build` declares `out/**` as its output, so
a cached `build` restore can remove files another task wrote there. Keeping
everything under `out/` owned by one task avoids that entirely.

`.vscodeignore` gains `out/test/**` as a backstop. The `package` script already
does `rm -rf out` first, but the packaged artifact should not depend on that.

### 4. Each test file registers its own provider id, and disposes it

`ProviderRegistry.register()` returns a `Disposable`, and the extension
activates once per run, so the registry is shared across test files. Each file
registers a definition under an id and scheme unique to itself, and disposes it
in `suiteTeardown`.

Distinct **schemes** matter as much as distinct ids: the registry maps schemes
to definitions, so reusing `'sftp'` would overwrite the real entry and disposal
would then delete it outright, breaking every later test.

For the live label this pattern also solves credentials without widening the
API. The test takes the real definition out of the registry — which is the
bundle's own object — and wraps only its `getSecret`:

```ts
const real = api.registry.get('sftp');
const registration = api.registry.register({
  ...real,
  id: 'sftp-live-test',
  schemes: ['sftp-live-test'],
  create: (context) => real.create({ ...context, getSecret: async () => ({ password: PASSWORD }) }),
});
```

`real.create` is the bundled `SftpFileSystem` closing over the bundled `ssh2`,
which is the whole point of the live label. Importing `@omni-fs/provider-sftp`
into the test file would bundle a second, freshly-built copy and prove nothing
about the shipped one.

### 5. Two labels: `hermetic` by default, `live` opt-in

`@vscode/test-cli` takes an array of configurations, each with a `label`, and
`vscode-test --label <name>` runs one.

`hermetic` needs no network and no Docker, so it runs on ubuntu, macOS and
Windows in the normal PR path. `live` needs `compose.yaml` running, so it is
Linux-only and runs in its own job.

Neither joins `pnpm test`. That mirrors `test:conformance`, which is kept out
for the same reason: `pnpm test` is the fast hermetic loop, and a 150 MB editor
download plus an Electron launch does not belong in it.

### 6. Assertions derive from the manifest, never from a hardcoded list

The activation tests read `contributes.commands`, `contributes.views` and
`contributes.configuration.properties` out of the extension's own
`package.json` and assert each entry is live. Asserting "twelve commands are
registered" would pass after someone deletes a command and its registration
together, and would fail for the wrong reason when a thirteenth is added. A
manifest-derived assertion fails exactly when the manifest and the code
disagree, which is the bug being hunted.

## Architecture

```
apps/vscode/
  .vscode-test.mjs                      # two labelled configurations
  esbuild.mjs                           # + a third build: test bundles
  src/
    extension.ts                        # + OmniFsApi return
    test/
      helpers.ts                        # activate, register, seed, clean up
      fixtures/workspace/.gitkeep       # a real folder for the host to open
      hermetic/
        activation.test.ts
        file-system.test.ts
        errors.test.ts
        ports.test.ts
      live/
        bundled-sdk.test.ts
```

Compiled output mirrors this under `out/test/`, with esbuild's `outbase` set to
`src/test` so `hermetic/` and `live/` survive as directories and the two `files`
globs can select them.

`src/test/**` is already inside `apps/vscode/tsconfig.json`'s `include`, so the
tests type check with the extension's own program. That program's `types` array
gains `"mocha"` — `tsconfig.base.json` names types explicitly because
TypeScript 6 stopped auto-including `@types` packages.

## The seam

`extension.ts` gains a return type and a return statement, and nothing else:

```ts
export interface OmniFsApi {
  /**
   * The protocol registry. Register a `ProviderDefinition` to add a protocol.
   * Unstable before 1.0.
   */
  readonly registry: ProviderRegistry;
}

export function activate(context: vscode.ExtensionContext): OmniFsApi {
  // ... unchanged ...
  return { registry };
}
```

Tests reach it through the extension id `ryftcore.omni-fs-vscode` — publisher
plus `name`, both from `package.json`:

```ts
const extension = vscode.extensions.getExtension<OmniFsApi>('ryftcore.omni-fs-vscode');
const api = await extension.activate();
```

Activation is explicit because `activationEvents` is `onFileSystem:omnifs`, so
nothing would activate the extension until a URI is touched.

## Test isolation

Three separate hazards, three separate mitigations.

**Settings.** `VsCodeConfigStore` writes to `ConfigurationTarget.Global`. Every
test restores what it wrote in `teardown` by updating the key back to
`undefined`, so the suite is correct whether or not the runner isolates the user
data directory. Implementation additionally confirms `@vscode/test-cli`'s
isolation and, if it is not guaranteed, passes `--user-data-dir` under
`.vscode-test/` in `launchArgs`.

**The entry cache.** `EntryCache` is constructed once at activation with a 15
second TTL and shared by every `ManagedFileSystem`. A test that seeds the
in-memory disk directly _after_ a `readDirectory` on the same path will read a
stale listing. Rule: seed before first access, and make mid-test mutations
through `vscode.workspace.fs`, which invalidates on write.

**The registry.** Covered by Decision 4 — unique id and scheme per file, and
disposal in `suiteTeardown`.

## The in-memory disk

`MemoryFileSystem` keeps its state private, so tests seed it through its own
`RemoteFileSystem` interface rather than by reaching inside. `connect()` only
sets a flag and no operation checks it, so seeding before or after connection
both work, and the double `connect()` that `ConnectionManager` performs is
harmless.

`memoryProvider.create` returns a **new** `MemoryFileSystem` per call, which
would give the test no handle on the bytes it is asserting about. The helper
therefore spreads the definition and pins the instance:

```ts
const disk = new MemoryFileSystem();
const registration = api.registry.register({
  ...memoryProvider,
  id,
  schemes: [id],
  create: () => disk,
});
```

`ConnectionManager` calls `getSecret` lazily and `MemoryFileSystem` never calls
it, so these connections need no keychain entry at all.

## Tests

### `hermetic/activation.test.ts`

- the extension activates and returns an API exposing a `ProviderRegistry`
- the registry resolves each of `s3`, `ftp`, `sftp` and `webdav`, and
  `list()` contains no duplicate ids (test-registered providers may also be
  present, so this is a containment check, not an equality one)
- every id in `contributes.commands` appears in `vscode.commands.getCommands(true)`
- both ids in `contributes.views['omni-fs']` resolve to a registered view
- every key in `contributes.configuration.properties` is readable through
  `workspace.getConfiguration()` and reports the manifest's default

### `hermetic/file-system.test.ts`

Against a seeded disk, through `vscode.workspace.fs` on `omnifs://<id>/…`:

- `stat` on a file returns `FileType.File` with the seeded size
- `stat` on a directory returns `FileType.Directory`
- `readDirectory` returns `[name, FileType]` tuples for a mixed directory, with
  names only — not paths
- `readFile` returns the seeded bytes
- `writeFile` creates a file, and the bytes are visible on the disk afterwards
- `writeFile` over an existing file replaces it
- `createDirectory` creates a directory that `stat` then reports
- `rename` moves a file: the new path reads, the old path is gone
- `delete` with `recursive: true` removes a populated directory
- a URI with no authority fails as `FileNotFound` rather than crashing

### `hermetic/errors.test.ts`

The table in `toVsCodeError`, asserted end to end.

`MemoryFileSystem` only ever produces a few of these codes, so this file
registers a second double: a `RemoteFileSystem` whose methods throw a
configurable `OmniFsError`, reusing `memoryProvider.defaultCapabilities` so
`ManagedFileSystem` does not switch on an emulation path.

Errors are injected on `stat` and asserted through `vscode.workspace.fs.stat`.
That matters: `ManagedFileSystem` emulates missing operations — rename becomes
copy-plus-delete, recursive delete becomes a walk — so an error thrown from
those can be caught and replaced before it ever reaches the host. `stat`
delegates straight through, which is what makes it the honest probe for a
translation table.

Each case injects one `OmniFsError` code and checks the `FileSystemError` code
VS Code receives:

| `OmniFsError`          | `vscode.FileSystemError` |
| ---------------------- | ------------------------ |
| `NotFound`             | `FileNotFound`           |
| `AlreadyExists`        | `FileExists`             |
| `NotADirectory`        | `FileNotADirectory`      |
| `IsADirectory`         | `FileIsADirectory`       |
| `PermissionDenied`     | `NoPermissions`          |
| `AuthenticationFailed` | `NoPermissions`          |
| `Unsupported`          | `NoPermissions`          |
| anything else          | `Unavailable`            |

Plus the two cross-connection refusals: `rename` and `copy` between two
different authorities each fail as `NoPermissions`, without touching either
provider.

### `hermetic/ports.test.ts`

- `VsCodeConfigStore.save` then `list` round-trips a `ConnectionConfig`
- `list` drops entries that are not shaped like a `ConnectionConfig`
- `delete` removes one connection and leaves the others
- `onDidChange` fires when `omniFs.connections` changes and not for an
  unrelated `omniFs` key
- `VsCodeSecretStore` round-trips a `ConnectionSecret` through real
  `SecretStorage`
- a corrupt secret entry reads back as `undefined` rather than throwing
- `delete` removes the secret

`VsCodeConfigStore` runs against the real configuration API, because that is
what it wraps. `VsCodeSecretStore` cannot: it is constructed over
`ExtensionContext.secrets`, a Mocha test has no `ExtensionContext`, and putting
the store on `OmniFsApi` to reach it is exactly what Decision 2 refuses. Those
cases therefore run against a small in-test `vscode.SecretStorage`
implementation, which proves the key namespacing, the JSON round-trip and the
corrupt-entry fallback — but not the keychain itself. See Risks.

### `live/bundled-sdk.test.ts`

Requires `docker compose up`. One suite per implemented provider — SFTP and
WebDAV today — each wrapping the registry's own definition as in Decision 4:

- connect, then `createDirectory` a unique scratch path under the seeded root
- `writeFile` a known payload and `readFile` it back byte-identically
- `readDirectory` lists the file with `FileType.File`
- `delete` the scratch path recursively, leaving the seeded tree as found

Connection details follow the existing live tests' convention — an environment
variable with a development default:

| Variable                                                        | Default                                                         |
| --------------------------------------------------------------- | --------------------------------------------------------------- |
| `OMNI_FS_SFTP_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_ROOT` | `localhost` / `2222` / `omnifs` / `omnifs-dev-secret` / `/data` |
| `OMNI_FS_WEBDAV_URL` / `_USER` / `_PASSWORD`                    | `http://localhost:8081` / `omnifs` / `omnifs-dev-secret`        |

A suite whose server is unreachable fails. It does not skip: a live label that
silently passes with nothing running is the failure mode this exists to prevent.

## Runner configuration

`.vscode-test.mjs`, discovered automatically by the CLI, with
`extensionDevelopmentPath` defaulting to the config file's own directory:

```js
import { defineConfig } from '@vscode/test-cli';

export default defineConfig([
  {
    label: 'hermetic',
    files: 'out/test/hermetic/**/*.test.js',
    version: 'stable',
    workspaceFolder: 'src/test/fixtures/workspace',
    launchArgs: ['--disable-extensions', '--disable-gpu'],
    mocha: { ui: 'tdd', timeout: 20_000 },
  },
  {
    label: 'live',
    files: 'out/test/live/**/*.test.js',
    version: 'stable',
    workspaceFolder: 'src/test/fixtures/workspace',
    launchArgs: ['--disable-extensions', '--disable-gpu'],
    mocha: { ui: 'tdd', timeout: 60_000 },
  },
]);
```

`--disable-extensions` turns off the user's installed extensions; the one under
development still loads. The workspace folder is committed rather than
generated, so the host always opens a known, empty folder.

## Tooling

**`apps/vscode/package.json`** — new devDependencies `@vscode/test-cli`,
`@vscode/test-electron`, `@types/mocha`, and `@omni-fs/testing` as
`workspace:*`. `.npmrc` sets `hoist=false`, so each must be declared here to be
importable. New scripts:

```json
"test:extension": "vscode-test --label hermetic",
"test:extension:live": "vscode-test --label live"
```

**`turbo.json`** — two tasks, both `"dependsOn": ["build"]` (which itself
depends on `^build`, so the workspace packages and the extension bundle are
both ready) and both `"cache": false`, matching `test:conformance`.

**Root `package.json`** — `"test:extension": "turbo run test:extension"` and
`"test:extension:live": "turbo run test:extension:live"`.

**`.gitignore`** — already ignores `.vscode-test/` and `out/`. No change.

**`.vscodeignore`** — add `out/test/**`.

## CI

Two jobs in `.github/workflows/ci.yml`, following the existing pinning and
`persist-credentials: false` conventions.

`extension tests`, on the same three-OS matrix as `verify`, for the reason that
matrix already states — the extension ships on all three desktop platforms:

```yaml
# The editor build is ~150 MB. Cache it so only a lockfile change or a new
# VS Code release pays the download; test-electron stores versions
# side by side, so a stale restore is additive rather than wrong.
- uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0
  with:
    path: apps/vscode/.vscode-test
    key: vscode-test-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
    restore-keys: vscode-test-${{ runner.os }}-

# Electron needs a display. Linux runners are headless, so xvfb provides a
# virtual one; macOS and Windows runners have a real window server.
- if: runner.os == 'Linux'
  run: xvfb-run -a pnpm test:extension
- if: runner.os != 'Linux'
  run: pnpm test:extension
```

`extension tests (live)`, ubuntu only, starting the containers the same way a
developer does:

```yaml
- run: docker compose up -d
- run: xvfb-run -a pnpm test:extension:live
```

`docker compose up -d` is the command `docker/README.md` already documents, and
readiness is the suite's job rather than a compose flag: `suiteSetup` retries
its first connection for up to 60 seconds before failing with a message naming
the unreachable server. A developer who runs `docker compose up -d` and starts
the tests a second later hits exactly the same race, so the wait belongs in the
suite where both callers get it.

Whether either job blocks a merge is a branch-protection setting rather than a
file in this repo. The recommendation is that `extension tests` is required and
`extension tests (live)` is not, so a container flake cannot block an unrelated
change — but a failure stays visibly red either way. `continue-on-error` is
deliberately not used, because it hides real failures.

## Risks

**Electron on macOS and Windows runners is flakier than on Linux.** Extension
host tests time out under load more often on those images. Mitigation: a 20
second Mocha timeout rather than the 2 second default, and `--disable-gpu`. If
flake persists, the honest fix is to pin the job to Linux and say so, not to
add retries — a retried test that fails half the time is not evidence.

**`version: 'stable'` does not test the engine floor.** `engines.vscode` claims
`^1.90.0`, and nothing verifies the extension still works there. Adding a third
label pinned to `1.90.0` is cheap and is the obvious next step if that claim
ever matters; it is left out now because the cost is a second editor download
per run and the claim is currently untested in either direction.

**`@omni-fs/testing` becomes a dependency of the extension package.** It is a
devDependency and the production build never compiles `src/test/`, so it cannot
reach the `.vsix`. The hazard is a future import of it from `src/` outside
`src/test/`, which would bundle a test double into a shipped extension. Worth an
ESLint `no-restricted-imports` rule if it ever looks likely.

**The live label covers two of four providers.** `provider-ftp` is a skeleton
and `provider-s3` has no live conformance config even though minio is already in
`compose.yaml`. Each joins `live/bundled-sdk.test.ts` as one more suite when it
is implemented — the wrapping pattern in Decision 4 is provider-agnostic, so
the cost is a handful of lines per provider, not new infrastructure.

**The keychain path is never exercised.** `VsCodeSecretStore`'s tests use a
`SecretStorage` double, so the store's own logic is covered but the real
`ExtensionContext.secrets` binding — the thing that actually talks to Keychain,
DPAPI and libsecret — is proved only by manual use. Reaching it from a test
requires publishing a credential store on the extension API, which is a worse
trade than the gap.

**A public `OmniFsApi` is a compatibility commitment.** Exposing
`ProviderRegistry` means its shape is observable by other extensions. Documented
as unstable before 1.0, and the surface is deliberately one property — the
credential store is not on it.
