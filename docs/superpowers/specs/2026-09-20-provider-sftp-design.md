# SFTP provider

**Date:** 2026-09-20
**Status:** Approved, not yet implemented
**Supersedes:** the `TODO(provider-sftp)` block in `packages/provider-sftp/src/index.ts`

## Problem

`packages/provider-sftp` is a declared skeleton: a settings schema, a secret
schema, a capability set, and eight methods that throw `Unsupported`. Its own
header comment says why it matters — SFTP is "the closest of the four to a real
POSIX filesystem", the provider where the fewest emulations kick in, and
therefore the control case when a bug might be in `ManagedFileSystem` rather
than in a protocol. It is also the protocol most users already have, because
every host with SSH serves it.

This phase makes it real, and proves it the way WebDAV was proved: by passing
`runConformanceSuite()` against the live server in `compose.yaml`.

## Goals

- `@omni-fs/provider-sftp` implements `RemoteFileSystem` and passes the shared
  conformance suite against `docker/sftp` on `localhost:2222`.
- `pnpm test:conformance` covers SFTP alongside WebDAV.
- Capabilities that describe this protocol honestly, including the two the
  skeleton declared wrongly.
- Host key verification that stops the case which actually means an attack.
- `pnpm test` stays hermetic and green without Docker.

## Non-goals

- FTP stays a skeleton. It is the next phase and the harder one.
- No `watch`. SFTP has no change notification, so `canWatch: false` and core
  polls — the same answer WebDAV gives.
- No append operation. `canAppend` is true because the protocol has it, but
  `RemoteFileSystem` exposes no append method and inventing one is not this
  phase.
- No SSH certificates, no `ProxyJump`, no keyboard-interactive or 2FA auth.
  All three need to ask the user something mid-connect, and no port for that
  exists.
- No `rootPath` / `rootPrefix` consolidation. Still its own plan, per the
  ruling in `docs/superpowers/plans/2026-09-19-provider-webdav.md`.

## Decisions

Six rulings, each of which changes what gets written.

### 1. Write against `ssh2`, not `ssh2-sftp-client`

The declared dependency is `ssh2-sftp-client@^12.1.1`. It ships no type
declarations (`src/*.js` only, no `types` field), and the DefinitelyTyped
package `@types/ssh2-sftp-client` is at **9.0.6** — three majors behind the
runtime, across releases that added `rcopy` and changed `rmdir` and `list`.
Installing those types would have the compiler assert a v9 API over a v12
runtime, in a repo that pins `@types/node` to 22 and TypeScript to 6.0.x
precisely so that types cannot drift from what runs.

`@types/ssh2` is at 1.15.6 against `ssh2@1.17.0` — same major, and `ssh2` is
what the wrapper wraps.

Going direct also buys what the wrapper hides:

- `open()` with real flags, so `overwrite: false` is `wx` and the exclusion is
  the server's, not a check-then-act race.
- `ext_openssh_rename` — POSIX rename, which replaces the destination
  atomically instead of failing on it.
- `ext_openssh_fsync`, so a closed write stream can mean the bytes are durable.
- `ext_copy_data` — see decision 6.
- Unflattened errors. `fmtError` (`src/index.js:57`) rewrites every failure into
  an `Error` whose `code` comes from a seven-value table (`src/constants.js`),
  so SFTP status 4 arrives as `ERR_GENERIC_CLIENT` and the difference between
  "directory not empty" and "destination exists" is gone before this package
  sees it.

What we write ourselves is a promise wrapper around the callback API and a
connect sequence — roughly a hundred lines, in `sftp-session.ts`.

`pnpm-workspace.yaml` already carries `ssh2: true` in `allowBuilds` with
`cpu-features: false` beside it, and its comment already calls `ssh2`'s install
script "a native speedup for the SFTP provider". Only `provider-sftp` declares
the wrapper, so the swap touches one `package.json`.

### 2. `AbortSignal` is honoured as a race, and the gap is documented

SFTP has no cancel on the wire. Every request goes through one helper that
rejects immediately when the signal is already aborted, and otherwise races the
SFTP callback against the abort, rejecting with `Cancelled`.

Streams are cancelled for real: `destroy()` closes the handle. A mutation
already on the wire is not, and may still land on the server. That is stated in
a comment rather than papered over, in the same spirit as the WebDAV provider's
notes on its own races.

This is what the conformance case "surfaces an aborted operation as Cancelled"
requires, and WebDAV got it free from `fetch`.

### 3. Recursive delete lives in the provider; `canDeleteRecursive` is true

The shared suite calls `delete(dir, { recursive: true })` on the raw provider
without gating on the capability, while the protocol has only `SSH_FXP_REMOVE`
for files and `SSH_FXP_RMDIR` for empty directories.

`provider-s3` already settles what the flag means: it declares
`canDeleteRecursive: true` and implements recursion as enumerate-then-batch-
delete from the client (`packages/provider-s3/src/s3-file-system.ts:301`). So
the flag means "the provider handles a recursive delete when asked", not "the
server does it in one call", and SFTP follows: `delete` walks the tree with
`readdir` plus `unlink`/`rmdir`, and declares true.

`ManagedFileSystem` reads the flag only to decide whether to walk itself
(`packages/core/src/fs/managed-file-system.ts:146`), so declaring true keeps one
walk in the system rather than two, and keeps SFTP's tree delete under live
test.

**Core change:** the doc comment on `ProviderCapabilities.canDeleteRecursive`
(`packages/core/src/capabilities.ts`) is sharpened to say this. One comment, no
behaviour.

### 4. The provider reads key material and the agent socket itself

Private key auth needs the file at `privateKeyPath` (expanding a leading `~`),
and agent auth needs `SSH_AUTH_SOCK`. Both are read in this package with
`node:fs` and `process.env`.

The boundary rule bans `vscode` and `electron` from `packages/`, not Node — and
the design already assumed a path on disk: the settings field is
`kind: 'file'`, and `packages/ui` grew `pickFile()` on its backend port
specifically for "SFTP's private key"
(`packages/ui/src/ports/connections-backend.ts:37`). Key material therefore
never enters `omniFs.connections`; only its path does, and the passphrase goes
to the keychain through `SecretStore` like any other secret.

A `LocalFiles` port would be the alternative. It is deferred to the
download/upload phase, which is the one that actually needs local file IO in
both directions, rather than being shaped now by a single caller.

### 5. Host keys: `known_hosts`, refuse a changed key, trust an unseen one

`ssh2` accepts any host key unless given a `hostVerifier`. Shipping that means a
file manager that cannot tell the real server from a machine answering in its
place.

The provider passes a verifier that reads `~/.ssh/known_hosts` (or the path in
the optional `knownHostsPath` setting) and answers:

- **match** — the host is listed with this key. Connect.
- **mismatch** — the host is listed with a _different_ key of the same type, or
  the entry is `@revoked`. Refuse with `AuthenticationFailed`, naming the
  fingerprint we saw and the one on file. This is the case that means an attack.
- **unknown** — the host is not listed. Connect, and log the key's OpenSSH-style
  `SHA256:` fingerprint at `info`.

Trust-on-first-use rather than refusal, because refusing would make a first
connection impossible: nothing in core can ask the user to confirm a
fingerprint, and inventing that port belongs with the phase that adds a prompt
surface. Nothing is written back to `known_hosts` — the file is read, never
authored, so a user who wants pinning can `ssh-keyscan` once and get strict
behaviour from then on.

`@cert-authority` lines are ignored, since certificate auth is a non-goal.

### 6. Server-side copy is answered per connection

`ssh2` implements `ext_copy_data` (`lib/protocol/SFTP.js:1609`, documented at
`SFTP.md:346`) — the `copy-data` extension OpenSSH has served since 9.0, and the
compose image is Alpine 3.20 with OpenSSH 9.7. The wrapper's `rcopy` was never
this: it pipes `createReadStream` into `createWriteStream` through the client
(`src/index.js:1403`).

But `copy-data` is announced per connection, in `SSH_FXP_VERSION`. So:

- `SFTP_CAPABILITIES` — the static `defaultCapabilities` a host renders before
  any connection exists — keeps `canCopyServerSide: false`.
- The instance's `capabilities` is a getter: the same object until connect, then
  with `canCopyServerSide: true` when the server announced `copy-data`.
- `copy()` is always defined. It throws `Unsupported` when the extension is
  absent.

`ManagedFileSystem.copy` checks `#inner.copy !== undefined` **and**
`capabilities.canCopyServerSide`, at call time
(`packages/core/src/fs/managed-file-system.ts:204`), so both states are correct
without core changing: on an OpenSSH 9+ server the copy stays on the server, and
on an older one core streams it as it does today.

This is the first provider whose capabilities depend on the connection. The
WebDAV provider's `hasVersionTokens` comment already argues for exactly this
("the argument for reading it per connection rather than hard-coding it here"),
but it is a new pattern here and is stated as one, in this package and in the
sharpened comment on `ProviderCapabilities`.

Detection reads the extensions `ssh2` recorded at version exchange. That field
is private (`sftp._extensions`), so it is read through one narrow, named,
documented cast whose failure mode is "no extensions", i.e. the capability stays
false and copies stream. `ext_copy_data` also throws synchronously when the
extension is missing, which is the backstop.

## Architecture

One package, mirroring `provider-webdav`'s layout, plus one file WebDAV had no
need for.

| File                           | Responsibility                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/settings.ts`              | `SFTP_SETTINGS_SCHEMA`, `SFTP_SECRET_SCHEMA`, `SftpSettings`, `readSettings()`                                                        |
| `src/errors.ts`                | `toOmniFsError(cause, path?)`, `isFailure()`                                                                                          |
| `src/known-hosts.ts`           | `readKnownHosts()`, `verifyHostKey()` — parsing and matching, no IO in the matcher                                                    |
| `src/sftp-session.ts`          | connect, auth assembly, host verification, promisified `SFTPWrapper`, the abort race, login-directory resolution, extension detection |
| `src/sftp-file-system.ts`      | `SFTP_CAPABILITIES` and `SftpFileSystem implements RemoteFileSystem`                                                                  |
| `src/index.ts`                 | `sftpProvider: ProviderDefinition` plus re-exports, ~20 lines                                                                         |
| `src/settings.test.ts`         | schema and `readSettings`, including the leading-slash rule                                                                           |
| `src/errors.test.ts`           | status-code mapping                                                                                                                   |
| `src/known-hosts.test.ts`      | plain, hashed, `[host]:port`, wildcard, `@revoked`, missing file                                                                      |
| `src/sftp-file-system.test.ts` | a fake `SFTPWrapper`: abort race, overwrite guard, symlink resolution, status-4 narrowing, a write stream the server rejects          |
| `src/sftp.live.test.ts`        | `runConformanceSuite()` against the compose server, plus the cases it cannot portably express                                         |
| `vitest.config.ts`             | default run excludes `*.live.test.ts` and `dist/**`                                                                                   |
| `vitest.conformance.config.ts` | includes only `*.live.test.ts`, 30s timeouts                                                                                          |

Outside the package: the `canDeleteRecursive` comment in
`packages/core/src/capabilities.ts`, the SFTP section of `docker/README.md`, and
the roadmap line in `README.md`.

`sftp-session.ts` exists because `ssh2` is callback-shaped and connection-shaped
in a way the `webdav` client was not. Keeping it separate means
`sftp-file-system.ts` reads as the contract being implemented — one method per
operation, no `new Promise` in sight — and means the fake used by the hermetic
tests replaces one small interface rather than a network library.

## Settings and secrets

The skeleton's schema survives with one field added. Settings, all of which are
committable through `omniFs.connections`:

| Key              | Kind   | Notes                                                        |
| ---------------- | ------ | ------------------------------------------------------------ |
| `host`           | text   | required                                                     |
| `port`           | number | default 22                                                   |
| `username`       | text   | required                                                     |
| `authMethod`     | select | `password` \| `privateKey` \| `agent`, default `password`    |
| `privateKeyPath` | file   | used when `authMethod` is `privateKey`                       |
| `knownHostsPath` | file   | **new.** Optional override; defaults to `~/.ssh/known_hosts` |
| `rootPrefix`     | text   | see below                                                    |

Secrets, which only ever go through `SecretStore`: `password` and `passphrase`.

`readSettings()` rejects a missing `host` or `username` and an unknown
`authMethod` with `ProtocolError`, the way `provider-webdav`'s does, so a
misconfiguration is caught locally instead of becoming a server round-trip
reported in the server's words. Credentials are checked at connect, not here —
a missing password for `authMethod: 'password'` is `AuthenticationFailed`.

## Path model

`rootPrefix` is the one setting whose leading slash survives `readSettings`,
which is the opposite of `provider-s3` and `provider-webdav`. For them the
absolute part of the location lives in the Bucket or Server URL field; here the
server's filesystem root is a real, reachable place no other setting names:

- `''` — the login directory.
- `projects` — `projects` below the login directory.
- `/var/www` — that absolute server path.

The login directory is resolved once, at connect, with `realpath('.')`. After
that `#remote(path)` is pure string work: POSIX-join the resolved base with
`path.value`. `RemotePath` already guarantees absolute, normalised, no trailing
slash, so no re-normalisation happens here.

## Operations

| Contract method     | SFTP                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| `connect`           | `Client.connect` then `sftp()`; idempotent when alive, reconnects when not |
| `isAlive`           | tracks `ready` against `close`/`end`/`error`                               |
| `stat`              | `SSH_FXP_STAT`, which follows links                                        |
| `list`              | `readdir`, then one `stat` per link entry                                  |
| `readFile`          | `createReadStream` collected through core's `collectStream`                |
| `createReadStream`  | `createReadStream({ start, end })`, Node stream translated to web          |
| `writeFile`         | `open` + `write` + `close`, flags `w` or `wx`                              |
| `createWriteStream` | `createWriteStream`, resolving on `close` after `fsync`                    |
| `delete`            | `unlink`, `rmdir`, or a walk                                               |
| `createDirectory`   | `mkdir`, building missing ancestors                                        |
| `rename`            | `ext_openssh_rename`, or plain `rename`                                    |
| `copy`              | `ext_copy_data`, per decision 6                                            |
| `watch`             | not implemented                                                            |

The parts that are not one-liners:

**`stat`** maps `attrs.mode` to `FileType`, `mtime` to epoch millis (SFTP counts
seconds), keeps `mode`, and puts `uid`/`gid` in `raw`. `ctime` is left
`undefined`: SFTP version 3 carries no creation time. Status 2 becomes
`NotFound`.

`SSH_FXP_STAT` follows links, so a dangling link would be `NotFound` — while
`list` shows that same entry as a symlink, which would make the tree fail on a
node it had just drawn. So a `NotFound` from `stat` falls back to `lstat` once,
and a link whose target is gone reports `type: 'symlink'` with the link's own
attributes. A path that genuinely does not exist fails both and is `NotFound`,
which is what the conformance suite's first case asks for.

**`list`** yields entries from `readdir`, whose attributes are `lstat`-shaped: a
symlink reports as a link, not as what it points at. Each link gets one
follow-up `stat` so a link to a directory opens as a directory and a link to a
file opens in the editor — which is how the same file already behaves over S3
and WebDAV. A link whose target is gone keeps `type: 'symlink'`. The follow-ups
run at `maxConcurrency` and are only paid on directories that contain links.

**Ranged reads** pass `start` and `end` (inclusive, as `ssh2` wants them). A
zero-length range has no meaningful spelling, so it is answered with a `stat`
followed by an empty stream — the same shape, and the same reasoning, as
`buildRange`'s `'empty'` case in the WebDAV provider: without the `stat`, a
zero-length read of a missing path would succeed emptily where
`MemoryFileSystem` raises `NotFound`.

**`writeFile`** opens with `wx` when `overwrite: false`. The server refuses an
existing path, so unlike WebDAV this guard has no race: status 4 on a `wx` open
narrows to `AlreadyExists`. `createParents` (default true) creates the missing
ancestor chain and retries once.

**`createWriteStream`** resolves its `close()` only after the write stream's
`close` event, having issued `ext_openssh_fsync` on the handle where the server
offers it. A write stream whose `close()` resolves for a transfer the server
rejected is the defect this repo has now fixed twice — in `openUploadStream`
(S3) and `openWriteStream` (WebDAV) — and the hermetic suite pins it here with a
fake that fails the flush.

**`delete`** unlinks a file, `rmdir`s an empty directory, and walks depth-first
when `recursive` is true. A non-recursive delete of a non-empty directory is
status 4 from `rmdir`; that is narrowed to `NotEmpty` by listing one child, for
the same reason the WebDAV provider refuses it — a caller who asked to remove an
empty directory must not silently lose a tree.

**`createDirectory`** creates missing ancestors and treats an existing directory
as a no-op, matching `MemoryFileSystem`, which is the contract's reference. A
_file_ in the way is `AlreadyExists`.

**`rename`** uses `ext_openssh_rename` when overwriting, because plain
`SSH_FXP_RENAME` fails when the destination exists and OpenSSH's POSIX rename
replaces it atomically. With `overwrite: false` it uses plain `rename` and
narrows the failure to `AlreadyExists`. On a server without the extension,
overwriting falls back to `unlink` then `rename`, which is racy — and is logged
and commented as such rather than presented as atomic.

## Capabilities

The static set, with the two corrections marked.

| Capability           | Value                  | Why                                                                                                                                                                                          |
| -------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canWrite`           | `true`                 |                                                                                                                                                                                              |
| `canRename`          | `true`                 | `SSH_FXP_RENAME` always exists                                                                                                                                                               |
| `canCopyServerSide`  | `false` statically     | Per connection, decision 6                                                                                                                                                                   |
| `canCreateDirectory` | `true`                 | `SSH_FXP_MKDIR`                                                                                                                                                                              |
| `canDeleteRecursive` | `true` — **was false** | Decision 3                                                                                                                                                                                   |
| `canAppend`          | `true`                 | `open` with `a`; no contract method uses it yet                                                                                                                                              |
| `canReadRange`       | `true`                 | Read at offset is native                                                                                                                                                                     |
| `canStreamWrite`     | `true`                 | Write at offset is native                                                                                                                                                                    |
| `canWatch`           | `false`                | No change notification in the protocol                                                                                                                                                       |
| `hasRealDirectories` | `true`                 |                                                                                                                                                                                              |
| `preservesMTime`     | `false` — **was true** | No `WriteOption` carries a client mtime, so there is nothing to preserve. `setstat`/`futimes` could keep one the day the contract grows one; S3 and WebDAV declare false for the same reason |
| `hasVersionTokens`   | `false`                | SFTP has no etag. Synthesising one from mtime+size would make `ifMatch` look atomic when it would be a racy re-stat, so the two `ifMatch` conformance cases skip                             |
| `maxConcurrency`     | `4`                    | One SSH connection multiplexes channels comfortably                                                                                                                                          |
| `listIsPaginated`    | `false`                |                                                                                                                                                                                              |

## Errors

`toOmniFsError` is the only place that knows SFTP status codes. `ssh2` reports
them as `err.code` — the numeric `STATUS_CODE` from
`lib/protocol/SFTP.js:32` — with the server's message where it sent one.

| Status                | Code                          |
| --------------------- | ----------------------------- |
| 2 `NO_SUCH_FILE`      | `NotFound`                    |
| 3 `PERMISSION_DENIED` | `PermissionDenied`            |
| 4 `FAILURE`           | _not classified_ — see below  |
| 5 `BAD_MESSAGE`       | `ProtocolError`               |
| 6 `NO_CONNECTION`     | `ConnectionFailed`, retryable |
| 7 `CONNECTION_LOST`   | `ConnectionFailed`, retryable |
| 8 `OP_UNSUPPORTED`    | `Unsupported`                 |

Connection-level failures translate too: `ECONNREFUSED`, `ENOTFOUND`,
`EAI_AGAIN`, `ECONNRESET` to `ConnectionFailed` (retryable), a handshake timeout
to `Timeout`, and "All configured authentication methods failed" — plus our own
host-key mismatch and missing-credential refusals — to `AuthenticationFailed`.

**Status 4 is deliberately left to fall through to `Unknown`.** OpenSSH answers
4 for "directory not empty", for "destination exists" and for a generic
failure, so only the call site can tell them apart: `rmdir` narrows it to
`NotEmpty`, a `wx` open and a non-overwriting `rename` narrow it to
`AlreadyExists`. This is the shape `provider-webdav` already uses for 412 and
405 via `isPreconditionFailed` and `isMethodNotAllowed`, and the reason is the
same — a shared mapping that guessed would be confidently wrong in two cases out
of three.

## Tests

**Hermetic** (`pnpm test`, no Docker): `settings.test.ts`, `errors.test.ts` and
`known-hosts.test.ts` are pure. `sftp-file-system.test.ts` runs the provider
against a fake `SFTPWrapper`, which is what the session seam is for, and covers
what a live server cannot be made to do on demand:

- an already-aborted signal, and one aborted mid-request
- `overwrite: false` refused by the server on a `wx` open
- symlink resolution, including a dangling link
- status 4 narrowed differently by `rmdir`, `open` and `rename`
- a write stream whose flush the server rejects after `close()` was called
- `copy()` throwing `Unsupported` when `copy-data` was not announced

**Live** (`pnpm test:conformance`, with `docker compose up -d`):
`runConformanceSuite()` against `localhost:2222` as `omnifs`, with
`rootPrefix: /data` — which is the seeded volume and also what exercises the
absolute-prefix rule. Each case makes and removes its own
`/conformance-<timestamp>-<n>` directory, so the seeded tree is identical before
and after, exactly as the WebDAV run behaves today.

Alongside the shared suite, live tests for the things that are true only of a
real server: that the login directory resolves when `rootPrefix` is empty, that
a relative `rootPrefix` lands below it, that `copy-data` is detected on this
image so the `canCopyServerSide` getter flips, and that POSIX rename really
replaces an existing destination.

Both `ifMatch` cases skip themselves on `hasVersionTokens: false`, and the
`copy` case runs because the extension is there.

## Tooling and docs

- `package.json`: `ssh2` in dependencies, `@types/ssh2` in devDependencies,
  `ssh2-sftp-client` removed; `test` becomes `vitest run`, and
  `test:conformance` is added, matching `provider-webdav`.
- `docker/README.md`: SFTP moves out of "will fail for those two" into the
  conformance section, with the root prefix `/data` named.
- `README.md`: tick the SFTP roadmap line and move the table row to
  ✅ Implemented.
- Prettier on touched files only (`pnpm exec prettier --write`), never
  `pnpm format`.
- After changing anything in `packages/`, `pnpm build` before a dependent
  typecheck means anything.

## Risks

- **`@types/ssh2` 1.15.6 against `ssh2` 1.17.0.** Same major, and the SFTP API
  has been stable for years. Anything missing gets a narrow local declaration in
  this package, never an `any` that spreads.
- **`sftp._extensions` is private.** One documented cast, and a failure mode of
  "no extensions detected", which costs a server-side copy and nothing else.
  `ext_copy_data`'s synchronous throw is the backstop.
- **`known_hosts` parsing is fiddly** — hashed entries are HMAC-SHA1 over the
  hostname keyed by a per-line salt, and non-22 ports are written `[host]:port`.
  It is `node:crypto` and no dependency, and it is unit-tested against real
  entries. A file we cannot parse is treated as empty, which degrades to
  trust-on-first-use rather than to refusing every connection.
- **Agent auth is untestable in the compose stack** (the container takes a
  password), so it is covered by a settings-level test that the right `ssh2`
  config is assembled, and left as a manual check on a real host.
- **The abandoned-request gap is real**: an aborted mutation may still land.
  Documented at the helper, and unchanged by anything in this phase.
