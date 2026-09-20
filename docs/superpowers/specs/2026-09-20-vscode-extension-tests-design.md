# VS Code extension tests

**Date:** 2026-09-20
**Status:** Approved, revised after review, not yet implemented

## Problem

`apps/vscode` has no tests. It is 1,598 lines of host code — the filesystem
provider, three port adapters, two tree providers, twelve commands and a webview
— and `pnpm test` says nothing about any of it.

What is untested is precisely the layer that decides whether a remote file feels
native. `OmniFileSystemProvider` translates `vscode.Uri` to `RemotePath` and
`OmniFsError` to `vscode.FileSystemError`, and its own comment explains the
stakes: "`FileNotFound` triggers a create-on-save flow, `NoPermissions` shows a
read-only editor — so getting this mapping right is the difference between a
remote file feeling native and feeling broken." Break that table and every
provider still passes conformance while the editor misbehaves.

That is not hypothetical. **A connection marked read-only is writable from the
editor today.** `ConnectionConfig.readOnly` is editable in the Connection
Manager and drawn as a lock in the tree; `ManagedFileSystem` implements it
properly, clearing `canWrite`, `canRename`, `canCreateDirectory` and
`canDeleteRecursive` and refusing writes outright. But
`OmniFileSystemProvider.#resolve` constructs `ManagedFileSystem` without the
flag and never reads the config at all. Every layer is individually correct and
the wiring between them is wrong, which is exactly the failure this suite
exists to catch.

The manifest is unchecked too. `package.json` contributes twelve commands;
`registerCommands` registers some list of ids. Nothing compares them, so a
command can be contributed and never registered — a menu entry that throws
"command not found" when clicked.

And the shipped artifact is unchecked. esbuild flattens four protocol SDKs into
one minified CommonJS file. That transformation is not free: `cpu-features`
cannot be bundled at all and is already externalised, `ssh2` requires it inside
a `try` and silently falls back to pure-JS crypto, `@aws-sdk` resolves parts of
itself lazily, and minification mangles names that a dependency may read back
off `constructor.name`. CI's `package` job proves the `.vsix` builds and stays
under 2 MB. Nothing proves `ssh2` still opens a connection after being bundled.

Three gaps, one harness: run the real extension inside a real Extension
Development Host.

## Goals

- The extension activates in a real host, and the contributed commands are all
  registered.
- `vscode.workspace.fs` round-trips over `omnifs://` against an in-memory
  provider — stat, readDirectory, readFile, writeFile, createDirectory, rename,
  copy, delete.
- The `OmniFsError` to `FileSystemError` table is asserted against the
  translator, and its end-to-end path is proved through `workspace.fs`.
- A read-only connection refuses writes from the editor.
- `VsCodeConfigStore` is proved against real VS Code configuration;
  `VsCodeSecretStore` and `VsCodeLogger` against doubles.
- The **minified production** bundle connects to live SFTP, WebDAV and S3
  servers and moves bytes, proving esbuild did not break those SDKs.
- `pnpm test` stays hermetic, headless and fast. This suite is a separate task.

## Non-goals

- **Webview automation.** The Connection Manager panel's rendering and
  `postMessage` protocol stay untested here. Driving a webview from the
  extension host is slow and brittle, and `@omni-fs/ui` already tests the
  reducer underneath it.
- **Tree provider rendering.** `ConnectionsTreeProvider` and
  `TransfersTreeProvider` build `TreeItem`, `ThemeIcon` and `MarkdownString`
  instances, so they do need a host — but they are presentation, and the
  connection state they render is `ConnectionManager`'s, which is better tested
  directly. They are out of scope here, not out of scope forever.
- **Command bodies.** Every command opens a quick pick, an input box or a modal.
  Testing them needs UI automation; a test that only proves a command "did not
  throw" asserts nothing and would be worse than no test.
- **Re-testing provider behaviour.** `runConformanceSuite()` owns that.
- **A second conformance suite over the editor.** The live label is a smoke
  test, deliberately shallow. Depth belongs in `test:conformance`.
- **Coverage measurement.** Not wired for any package in this repo.
- **FTP live coverage.** `provider-ftp` is still a skeleton
  (`TODO(provider-ftp): implement against basic-ftp`). It joins the live label
  when it exists. SFTP, WebDAV and S3 are all in the first cut.

## Decisions

### 1. `@vscode/test-cli` with `@vscode/test-electron`, running Mocha

This is the setup the VS Code documentation prescribes, and the only one that
boots a real extension host. Vitest cannot provide the `vscode` module.

The consequence is two test frameworks in one repo: Vitest for hermetic units,
Mocha inside the extension host. Accepted, because they never meet — different
turbo task, different directory, different compile output, different runner.
Mocha's `tdd` interface (`suite`/`test`) is used to match VS Code's own samples.

### 2. `OmniFsError.is` becomes a brand check — a production fix

```ts
// packages/core/src/errors.ts, today
static is(value: unknown): value is OmniFsError {
  return value instanceof OmniFsError;
}
```

`instanceof` is identity across realms. A test file bundled by esbuild inlines
`@omni-fs/testing` and, through it, a second copy of `@omni-fs/core`, so an
`OmniFsError` thrown by the test's `MemoryFileSystem` is an instance of the
_test bundle's_ class and the extension bundle's `is()` returns `false` for it.
`toVsCodeError` then returns it untranslated and VS Code reports a generic
failure, so the error table would report `Unknown` for every row and
`ManagedFileSystem.#exists` would rethrow a `NotFound` it does not recognise —
breaking create-parents on write and the "old path is gone" assertion after a
rename.

This is not a test artefact. Decision 3 publishes the registry, so a
third-party extension registering a provider bundles its own core for exactly
the same reason, and its errors are foreign **in production**. The fix belongs
in core: a brand set in the constructor and checked by `is()`.

```ts
const BRAND = Symbol.for('omni-fs.error');
// constructor: Object.defineProperty(this, BRAND, { value: true });
static is(value: unknown): value is OmniFsError {
  return typeof value === 'object' && value !== null && BRAND in value;
}
```

`Symbol.for` is realm-global, so both copies agree. A core unit test asserts
that a structurally identical error built from a second module instance passes
`is()`. `RemotePath` needs no equivalent: nothing does `instanceof RemotePath`
and its constructor is TypeScript-private only.

### 3. `activate` returns a public `OmniFsApi`, and definitions are frozen

The extension registers four providers and exposes nothing, so a test has no way
to put a fake in front of it. `activate` returns `{ registry }` behind a named
`OmniFsApi` interface.

This is a genuine public extension API, not only a test hook: `ProviderRegistry`
is already the documented extension point — "a new protocol is a new package
plus one `register()` call per host" — so publishing it means a third-party
extension could add a protocol. It is documented as unstable before 1.0.

`OmniFsApi` deliberately does not expose `SecretStore`. **This is a smaller
protection than it looks and the spec must not overstate it:**
`ProviderDefinition.create` receives `getSecret`, `readonly` is compile-time
only, and `registry.get('sftp')` hands back the live definition object — so a
co-resident extension can replace `create` in place and observe every SFTP
credential. VS Code does not isolate extensions from one another, so this is
not a new class of exposure, but withholding the secret store is hygiene, not a
boundary. `register()` therefore `Object.freeze`es the definition it stores,
which closes the in-place mutation without changing any caller: Decision 5's
`{ ...real, create }` spread produces a new object and is unaffected.

### 4. Test bundles are separate from the extension bundle

esbuild, not `tsc`: emitting CommonJS with `tsc` would produce
`require('@omni-fs/testing')` against a workspace package that is
`"type": "module"` with an ESM-only `exports` map. That fails at runtime inside
the extension host, where a type checker cannot warn about it.

Tests compile to **`out-test/`**, not `out/`, under their own turbo task
`build:tests`. Two reasons, and the second is the one that matters:

- turbo's `build` declares `out/**` as its output, so a cached restore can
  remove files another task wrote there.
- `out/` must be free to hold the **production** bundle. The live label's whole
  claim is about the shipped artifact, and the earlier draft made that
  impossible: test bundles were skipped under `--production`, so no
  configuration existed in which minified code and tests were both present.
  Separating the directories decouples the two — `--production` controls
  minification and sourcemaps, `build:tests` controls the test build, and the
  live job runs `pnpm package:vsix` first so `out/` holds exactly what ships.

This also removes the need for a `.vscodeignore` backstop: nothing under
`out-test/` is ever inside the packaged extension. `.gitignore` gains
`out-test/` — the existing `out/` entry does not match it.

### 5. Per file: its own provider id, scheme, and saved connection

`ProviderRegistry.register()` returns a `Disposable`, and the extension
activates once per run, so the registry is shared across test files. Each file
registers a definition under an id and scheme unique to itself and disposes it
in `suiteTeardown`.

Distinct **schemes** matter as much as distinct ids: the registry maps schemes
to definitions, so reusing `'sftp'` would overwrite the real entry and disposal
would then delete it outright.

**Registering a provider is necessary and not sufficient.** The URI authority is
a _connection id_, not a provider id: `#resolve` calls
`manager.acquire(uri.authority)`, which calls `configStore.get(id)` and fails
with `Unknown connection` before the registry is consulted. Every file that
opens an `omnifs://` URI must also save a `ConnectionConfig` whose `providerId`
is its registered provider. The activated extension's only `ConfigStore` is
`VsCodeConfigStore`, so that means writing the `omniFs.connections` setting at
`ConfigurationTarget.Global`.

For the live label this pattern also supplies credentials without widening the
API. The test takes the real definition out of the registry — the bundle's own
object — and wraps only its `getSecret`:

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
which is the whole point. Importing `@omni-fs/provider-sftp` into the test file
would bundle a second, freshly-built copy and prove nothing about the shipped
one. The connection's `settings` must still be complete — for SFTP that is
`host`, `port`, `username`, `authMethod`, `rootPrefix` and `knownHostsPath`,
exactly as `sftp.live.test.ts` builds it.

### 6. Two labels: `hermetic` by default, `live` opt-in

`@vscode/test-cli` takes an array of configurations, each with a `label`, and
`vscode-test --label <name>` runs one.

`hermetic` needs no network and no Docker, so it runs on ubuntu, macOS and
Windows in the normal PR path. `live` needs `compose.yaml` running and the
production bundle built, so it is Linux-only and runs in its own job.

Neither joins `pnpm test`. That mirrors `test:conformance`, which is kept out
for the same reason: `pnpm test` is the fast hermetic loop, and a 150 MB editor
download plus an Electron launch does not belong in it.

### 7. Two ways in, because one of them cannot reach everything

Most hermetic tests drive `vscode.workspace.fs`, which is what proves the
_activated composition_: manifest, registration, connection lookup, URI
parsing, the whole path a user's keystroke takes.

But `workspace.fs` is a narrowed API. It always sends
`create: true, overwrite: true`, so `writeFile`'s `create: false` branch — the
one piece of genuine logic in the class, written because "core has no
equivalent flag" — is unreachable through it, as is `overwrite: false`. Change
events fire on a private emitter that `workspace.fs` does not surface either.

So one file constructs `OmniFileSystemProvider` directly, with core's
`ConnectionManager` over in-memory `ConfigStore`/`SecretStore` and a
`MemoryFileSystem`, and calls its methods. Everything in that file comes from
one bundle, so it needs no saved connection and no global settings — and it
reaches the branches `workspace.fs` hides. It tests the class rather than the
composition, so it complements the `workspace.fs` tests instead of replacing
them.

### 8. Assertions derive from the manifest only where the manifest is the authority

The commands test reads `contributes.commands` out of `package.json` and
asserts each id appears in `vscode.commands.getCommands(true)` — which lists
_registered_ commands, so a contributed-but-unregistered id is caught. That is a
real failure mode and the assertion fails exactly on it.

The same trick does not generalise, and the earlier draft over-applied it:

- **Views have no observing mechanism.** No public API enumerates tree views or
  data providers, and the auto-generated `<viewId>.focus` command is derived
  from the manifest itself, so asserting on it is tautological. The bullet is
  dropped, and the gap is recorded in Risks.
- **Settings run the other way.** Asserting that a manifest key reads back the
  manifest default tests VS Code's configuration registry, not this extension.
  The real bug is code reading a key the manifest does not contribute, and that
  cannot be derived from the manifest — so it is asserted from the _code_ side,
  against the five keys `extension.ts` and `VsCodeConfigStore` actually read
  (`connections`, `cache.ttlSeconds`, `connection.idleTimeoutSeconds`,
  `transfers.maxConcurrent`, `logLevel`), each checked with
  `inspect(key).defaultValue` so a user setting cannot mask it.
- **The provider list is derived from `dependencies`.** Every
  `@omni-fs/provider-*` entry in the extension's `package.json` must resolve to
  a registered provider id. That catches the failure this architecture actually
  invites — a package added and the `register()` line forgotten — where a
  hardcoded list of four would not.

## Production changes this requires

The suite is not purely additive. Three changes land in shipped code, each with
its own justification above:

1. `OmniFsError.is` becomes a brand check (`packages/core/src/errors.ts`),
   with a core unit test for the cross-realm case. — Decision 2
2. `ProviderRegistry.register` freezes the definition it stores
   (`packages/core/src/registry.ts`). — Decision 3
3. `activate` returns `OmniFsApi`, and `OmniFileSystemProvider` is given the
   connection's `readOnly` flag. — Decision 3 and the Problem section

The third is a bug fix, not test scaffolding. `#resolve` currently has the
`connectionId` but never the `ConnectionConfig`; it must fetch the config and
pass `readOnly` into the `ManagedFileSystem` it builds. Because the
`ManagedFileSystem` is memoised per provider instance in a `WeakMap`, the flag
is read when that wrapper is created, and a `readOnly` change takes effect on
the next connect — consistent with how every other connection setting behaves.

## Architecture

```
apps/vscode/
  .vscode-test.mjs                      # two labelled configurations
  esbuild.mjs                           # + a test-bundle target -> out-test/
  tsconfig.test.json                    # test program, mocha types
  src/
    extension.ts                        # + OmniFsApi, + readOnly wiring
    fs/omni-file-system-provider.ts     # + readOnly
    test/
      helpers.ts                        # activate, register, save connection, seed, clean up
      fixtures/workspace/.gitkeep       # a real folder for the host to open
      fixtures/known_hosts              # empty, pinned for the live SFTP suite
      hermetic/
        activation.test.ts
        file-system.test.ts
        provider-direct.test.ts
        errors.test.ts
        ports.test.ts
      live/
        bundled-sdk.test.ts
```

esbuild's `outbase` is `src/test`, so `hermetic/` and `live/` survive as
directories under `out-test/` and the two `files` globs can select them.

**`"mocha"` must not go in the main program's `types`.** Adding it to
`apps/vscode/tsconfig.json` makes `suite`, `test`, `setup` and `teardown`
ambient in every file under `src/` — precisely what that file's own comment
rejects for `dom` ("a stray browser global is a compile error here, not a
silent pass"). Instead `tsconfig.test.json` sits alongside the existing
`tsconfig.webview.json`, owns `src/test/**` with `types: ["node", "vscode",
"mocha"]`, the main program excludes `src/test/**`, and `typecheck` runs all
three.

## Test isolation

Four hazards, four mitigations.

**Settings.** Every file that saves a connection writes the same global
`omniFs.connections` array, and `ports.test.ts` reads it. So: write in
`suiteSetup`, remove in `suiteTeardown`, and **also reset in `suiteSetup`** —
the runner's user-data directory persists between local runs, so a crashed run
otherwise leaves entries behind and the next run fails for no visible reason.
`ports.test.ts` asserts on its own entries rather than on array equality.

**The entry cache.** `EntryCache` is constructed once at activation with a 15
second TTL and shared by every `ManagedFileSystem`. `ManagedFileSystem.stat`
and `list` both consult it, so a test that seeds the in-memory disk directly
after a `stat` or a `readDirectory` on the same path reads a stale answer. Rule:
seed before first access, and make mid-test mutations through
`vscode.workspace.fs`, which invalidates on write.

**The registry.** Unique id and scheme per file, disposed in `suiteTeardown`.

**Live connections.** `OmniFsApi` exposes no `ConnectionManager` and the idle
timeout is 300 seconds, so each live socket stays open until the host exits.
Acceptable for a smoke test, and stated here so nobody hunts a leak.

## The in-memory disk

`MemoryFileSystem` exposes a public `seed(files)` test helper that writes
content without going through the write path, which is how these tests set up a
known tree. `connect()` only sets a flag; no _filesystem operation_ consults it,
though `ConnectionManager.acquire` does via `isAlive()`, so seeding before
connection is safe.

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

- every id in `contributes.commands` appears in `vscode.commands.getCommands(true)`
- every `@omni-fs/provider-*` dependency in `package.json` resolves to a
  registered provider id on the returned `OmniFsApi`
- every configuration key the code reads has a contributed default, via
  `inspect(key).defaultValue`

### `hermetic/file-system.test.ts`

Through `vscode.workspace.fs` on `omnifs://<connectionId>/…`, against a seeded
disk. Each assertion is about **what the host layer adds** — the tuple shape,
the `FileType`, the `FileSystemError` code — not about the bytes, which are
conformance's job:

- `stat` reports `FileType.File` and `FileType.Directory` for the right entries
  (one table-driven test)
- `readDirectory` returns `[name, FileType]` tuples with names only, not paths
- `readFile` returns the seeded bytes
- `writeFile` creates, and replaces on a second call (one table-driven test)
- `createDirectory` creates a directory that `stat` then reports
- `rename` moves a file: the new path reads, the old path fails as
  `FileNotFound` — which is also the end-to-end proof of Decision 2's brand
  check, since that error crosses the bundle boundary
- `copy` within one connection duplicates a file
- `delete` with `recursive: true` removes a populated directory
- a connection saved with `readOnly: true` refuses `writeFile`, `delete`,
  `rename` and `createDirectory` as `NoPermissions`
- an authority naming no saved connection fails as `FileNotFound`

### `hermetic/provider-direct.test.ts`

`OmniFileSystemProvider` constructed directly (Decision 7) — no activation, no
settings, one bundle:

- `writeFile` with `create: false` on a missing file fails as `FileNotFound`
- `writeFile` with `overwrite: false` on an existing file fails as `FileExists`
- `onDidChangeFile` fires `Created` for a new file and `Changed` for an
  overwrite, `Deleted` for a delete, and both `Deleted` and `Created` for a
  rename
- `stat` on a read-only entry reports `FilePermission.Readonly`
- a `symlink` entry maps to `FileType.SymbolicLink`

The change-event cases are written against intended behaviour, and the second
one is expected to fail first: `writeFile` fires
`options.create ? Created : Changed`, and `create` is true on every overwrite,
so an overwrite currently reports `Created`. Treat it as a bug to fix in the
provider, not an assertion to relax.

### `hermetic/errors.test.ts`

The table in `toVsCodeError`, asserted against a directly-constructed provider
whose inner filesystem throws a configurable `OmniFsError`. Injection happens on
`stat`: `ManagedFileSystem` emulates missing operations — rename becomes
copy-plus-delete, recursive delete becomes a walk — so an error thrown from
those can be caught and replaced before it reaches the host, while `stat` only
consults the cache (which never stores a throw) before delegating.

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

Plus: a plain `Error` from a provider passes through unwrapped; a connection
whose `connect` throws `AuthenticationFailed` surfaces as `NoPermissions` from
`acquire`, which is the second call site of `toVsCodeError` and the one `stat`
injection never reaches; and `rename` and `copy` across two different
authorities fail as `NoPermissions` — asserted as "neither filesystem receives
a `rename`, `copy`, `writeFile` or `delete`", because both connections _are_
acquired and both do see `stat` calls, from `#resolve` and from VS Code's own
pre-validation.

### `hermetic/ports.test.ts`

`VsCodeConfigStore` runs against the real configuration API, because that is
what it wraps:

- `save` then `list` round-trips a `ConnectionConfig`
- `list` drops entries that are not shaped like a `ConnectionConfig`
- `delete` removes one connection and leaves the others
- `onDidChange` fires for `omniFs.connections` and not for an unrelated
  `omniFs` key

`VsCodeSecretStore` cannot: it is constructed over `ExtensionContext.secrets`,
a Mocha test has no `ExtensionContext`, and putting the store on `OmniFsApi` to
reach it is what Decision 3 refuses. Those cases run against a small in-test
`vscode.SecretStorage`, proving key namespacing, the JSON round-trip and the
corrupt-entry fallback — but not the keychain. Same for `VsCodeLogger` against
a `LogOutputChannel` double: level filtering drops everything below the minimum,
and `child` nests scopes as `parent/child`.

### `live/bundled-sdk.test.ts`

Requires `docker compose up -d` and the production bundle. One suite per
implemented provider — SFTP, WebDAV and S3 — each wrapping the registry's own
definition as in Decision 5:

- `createDirectory` a unique scratch path under the seeded root
- `writeFile` a known payload and `readFile` it back byte-identically
- `readDirectory` lists the file with `FileType.File`
- `delete` the scratch path recursively, leaving the seeded tree as found

**Readiness is proved by the scratch `createDirectory`, not by `connect`.**
`compose.yaml` seeds the tree from a one-shot `file-seed` container that starts
_after_ the servers and ends with `chown -R 1000:1000`, so there is a window in
which SFTP accepts a login and `createDirectory` fails with `PermissionDenied`.
`suiteSetup` retries the scratch directory for up to 60 seconds, then fails with
a message naming the unreachable server. It never skips: a live label that
passes silently with nothing running is the failure mode it exists to prevent.

Connection details follow the existing live tests' convention — an environment
variable with a development default:

| Variable                                                           | Default                                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `OMNI_FS_SFTP_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_ROOT`    | `localhost` / `2222` / `omnifs` / `omnifs-dev-secret` / `/data`                         |
| `OMNI_FS_WEBDAV_URL` / `_USER` / `_PASSWORD`                       | `http://localhost:8081` / `omnifs` / `omnifs-dev-secret`                                |
| `OMNI_FS_S3_ENDPOINT` / `_BUCKET` / `_REGION` / `_KEY` / `_SECRET` | `http://localhost:9000` / `omni-fs-test` / `us-east-1` / `omnifs` / `omnifs-dev-secret` |

S3 also needs `forcePathStyle: true` for MinIO. The SFTP connection pins
`knownHostsPath` to the empty `fixtures/known_hosts`: the provider reads
`~/.ssh/known_hosts` by default, and a developer with a stale
`[localhost]:2222` entry from a previous container would otherwise be refused
for a host-key mismatch — correct behaviour, wrong context.

## Runner configuration

`.vscode-test.mjs`, discovered automatically, with `extensionDevelopmentPath`
defaulting to the config file's own directory:

```js
import { defineConfig } from '@vscode/test-cli';

const shared = {
  version: 'stable',
  workspaceFolder: 'src/test/fixtures/workspace',
  launchArgs: ['--disable-extensions', '--disable-gpu'],
};

export default defineConfig([
  {
    ...shared,
    label: 'hermetic',
    files: 'out-test/hermetic/**/*.test.js',
    mocha: { ui: 'tdd', timeout: 20_000 },
  },
  {
    ...shared,
    label: 'live',
    files: 'out-test/live/**/*.test.js',
    mocha: { ui: 'tdd', timeout: 60_000 },
  },
]);
```

`--disable-extensions` turns off the user's installed extensions; the one under
development still loads. The workspace folder is committed rather than
generated, so the host always opens a known, empty folder.

If an explicit `--user-data-dir` proves necessary for settings isolation, it
must be a **short** temp path, not one under `.vscode-test/`: a deep checkout
can push the runner's Unix socket past the 103-character limit on macOS and
Linux, a known `@vscode/test-electron` papercut.

## Tooling

**`apps/vscode/package.json`** — new devDependencies `@vscode/test-cli`,
`@vscode/test-electron`, `@types/mocha`, and `@omni-fs/testing` as
`workspace:*`. `.npmrc` sets `hoist=false`, so each must be declared here.
New scripts:

```json
"build:tests": "node esbuild.mjs --tests",
"test:extension": "vscode-test --label hermetic",
"test:extension:live": "vscode-test --label live"
```

`esbuild.mjs` gains a `--tests` flag and joins watch mode under `dev`, so the
F5 loop rebuilds tests too. A `.vscode/launch.json` entry for debugging the
hermetic label pays for itself the first time a test fails only in CI.

**`turbo.json`** — `build:tests` (`dependsOn: ["^build"]`, outputs
`out-test/**`), plus `test:extension` and `test:extension:live`, both
`dependsOn: ["build", "build:tests"]` and both `"cache": false`, matching
`test:conformance`.

**Root `package.json`** — `test:extension` and `test:extension:live` turbo
passthroughs.

**`.gitignore`** — add `out-test/`. The existing `out/` entry does not cover it.
`.vscode-test/` is already ignored. `.vscodeignore` needs no change, because
nothing under `out-test/` is inside the packaged extension.

## CI

Two jobs in `.github/workflows/ci.yml`, following the existing pinning and
`persist-credentials: false` conventions.

`extension tests`, on the same three-OS matrix as `verify`, for the reason that
matrix already states — the extension ships on all three desktop platforms:

```yaml
# The download key must change when VS Code does, or actions/cache never
# saves: it skips the upload on an exact key hit, so a key pinned only to
# the lockfile would re-download 150 MB on every run after a release and
# store none of it. A weekly stamp bounds that to one run in seven days.
- id: stamp
  run: echo "week=$(date -u +%Y-%V)" >> "$GITHUB_OUTPUT"
  shell: bash

# Only the editor download. The rest of .vscode-test is the runner's
# user-data and extensions directories, which must not persist between
# runs — stale omniFs.connections state would leak across jobs.
- uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
  with:
    path: apps/vscode/.vscode-test/vscode-*
    key: vscode-test-${{ runner.os }}-${{ steps.stamp.outputs.week }}
    restore-keys: vscode-test-${{ runner.os }}-

# Electron needs a display. Linux runners are headless, so xvfb provides a
# virtual one; macOS and Windows runners have a real window server.
- if: runner.os == 'Linux'
  run: xvfb-run -a pnpm test:extension
- if: runner.os != 'Linux'
  run: pnpm test:extension
```

`extension tests (live)`, ubuntu only, against the production bundle:

```yaml
# package:vsix leaves out/ holding the minified production build, which is
# the artifact the live label exists to test.
- run: pnpm package:vsix
- run: docker compose up -d
- run: xvfb-run -a pnpm test:extension:live
```

`docker compose up -d` is the command `docker/README.md` already documents;
readiness is the suite's job, not a compose flag, so a developer who starts the
tests a second after `up` gets the same wait.

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

**View registration is not observable.** No public API reports whether
`createTreeView` was called, so a deleted view registration is caught only by a
human opening the sidebar. Recorded rather than papered over with a
manifest-derived assertion that cannot fail.

**The keychain path is never exercised.** `VsCodeSecretStore`'s tests use a
`SecretStorage` double, so its logic is covered but the real
`ExtensionContext.secrets` binding — Keychain, DPAPI, libsecret — is proved
only by manual use. Reaching it from a test requires publishing a credential
store on the extension API, which is a worse trade than the gap.

**Streaming paths survive untested.** `workspace.fs` only uses whole-buffer
`readFile`/`writeFile`, so `createWriteStream` — S3 multipart through
`@aws-sdk/lib-storage`, SFTP write streams — is driven only by `TransferQueue`,
and the download/upload commands are stubs. The live label cannot prove those
survive bundling until that work lands.

**`version: 'stable'` does not test the engine floor.** `engines.vscode` claims
`^1.90.0` and nothing verifies it. A third label pinned to `1.90.0` is the
obvious next step if that claim ever matters; left out now because the cost is a
second editor download per run.

**The live label tests the production bundle but not the packaged one.**
Pointing `extensionDevelopmentPath` at the unpacked `.vsix` would additionally
catch a `.vscodeignore` that drops a needed file. Worth doing if packaging ever
bites; the current `package` job already guards size and build success.

**`@omni-fs/testing` reaches the test bundle through one entry point that
imports `vitest`.** esbuild tree-shakes `runConformanceSuite` out, so a bundle
using only `MemoryFileSystem` loads under plain Node — but that holds by
tree-shaking, not by structure. A `@omni-fs/testing/memory` subpath export
would make it explicit if it ever breaks.

**A public `OmniFsApi` is a compatibility commitment.** Exposing
`ProviderRegistry` makes its shape observable by other extensions. Documented as
unstable before 1.0, with the credential store deliberately off it.

## Follow-ups this surfaced

Recorded here because they are out of scope, not because they are unimportant.

**`packages/core`'s own tests — done, ahead of this phase.** The review found
that nothing constructed a `ManagedFileSystem`, an `EntryCache`, a
`ProviderRegistry` or a `TransferQueue`, which would have left this Electron
suite as the only thing exercising that code, incidentally and on the
full-capability profile only. That gap is now closed: `ManagedFileSystem` runs
against `MemoryFileSystem` in both capability profiles in `packages/testing`,
and the other four have colocated tests in core.

It found six bugs, three of which change what this phase must assume:
`createWriteStream` invalidated its cache when the stream opened rather than
when the bytes landed; an emulated rename could not move a directory at all,
because the copy it falls back to had no directory branch; and a connection
whose provider could not be built was parked on `connecting` forever. The
others: a reconnect dropped the dead filesystem without closing its socket, a
failed streamed write left a stale stat cached, and work enqueued before
`setExecutor` never started.

**`VsCodeConfigStore` writes `Global` but reads the merged value.** With a
workspace-level `omniFs.connections` — the team-sharing case the setting's own
description advertises — the workspace array shadows the global one, so a saved
connection never appears. The fixture workspace has no settings, so
`ports.test.ts` cannot see it. Needs a decision about intended behaviour before
it can have a test.
