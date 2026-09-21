# FTP / FTPS provider

**Date:** 2026-09-21
**Status:** Approved, not yet implemented
**Supersedes:** the `TODO(provider-ftp)` block in `packages/provider-ftp/src/index.ts`

## Problem

`packages/provider-ftp` is the last declared skeleton: a settings schema, a
secret schema, a capability set, and seven methods that throw `Unsupported`. It
is also the protocol the repo has been describing to itself since ADR 0002 — `ProviderCapabilities`' own doc comment explains itself with "FTP has no
server-side copy", and `maxConcurrency` exists because "FTP is typically 1 (one
control channel)". Every one of those claims has been load-bearing for a year
and never once executed.

This phase makes it real, and proves it the way WebDAV and SFTP were proved: by
passing `runConformanceSuite()` against a live server. Unlike them, it must do
so three times, because "FTP" in this product's name is three protocols — plain
FTP, explicit `AUTH TLS`, and implicit TLS-on-connect — and a provider that
implements all three while testing one has tested the least interesting one.

FTP is also the hardest of the four, for reasons that have nothing to do with
its age. There is no `stat`. There is no exclusive create. There is no cancel.
There is no end-of-range. And a command channel carries one command at a time,
so the protocol's shape reaches all the way up into how the provider is
structured — which is the thing that makes it worth doing carefully rather than
quickly.

## Goals

- `@omni-fs/provider-ftp` implements `RemoteFileSystem` over `basic-ftp` and
  passes the shared conformance suite in all three `secure` modes.
- A test server built here — `docker/ftp` — serving plain and explicit TLS on
  21 and implicit TLS on 990, replacing `delfer/alpine-ftp-server`.
- A pool of control channels, sized per connection by a new setting, defaulting
  to one and shrinking itself when the server refuses another login.
- A `tlsMinVersion` setting that makes a legacy FTPS server reachable, proven
  against a TLS 1.0 listener rather than asserted.
- A `conformance-live` CI job, which runs the live suite for all four providers
  rather than for FTP alone.
- `pnpm test` stays hermetic and green without Docker.

## Non-goals

- **No `copy` method.** `canCopyServerSide: false` is simply true of FTP, so
  `ManagedFileSystem` streams a copy down and back up. FXP / site-to-site
  transfer is a security liability that most servers disable, and no caller has
  asked for it.
- **No `watch`.** Same answer as the other three: `canWatch: false`, and core
  does not poll.
- **No append method.** `canAppend: true` describes `APPE`, but
  `RemoteFileSystem` exposes no append operation and inventing one is not this
  phase — the same ruling SFTP made.
- **No `MFMT` mtime preservation.** `WriteOptions` carries no client mtime, so
  there is nothing to preserve. `preservesMTime: false` stays honest.
- **No active mode.** Passive only, which is what `basic-ftp` does and what
  works from behind NAT. A server that offers only active mode is unsupported,
  and says so.
- **No download/upload commands.** The extension's local-file stubs stay stubs;
  that phase needs a `LocalFiles` port and is not this one.
- **No `rootPath` / `rootPrefix` consolidation.** Still its own plan, per the
  ruling carried forward from the WebDAV phase.

## Decisions

Ten rulings, each of which changes what gets written.

### 1. Keep `basic-ftp`. There is no library question here

The SFTP phase opened by replacing its declared dependency, because
`ssh2-sftp-client` shipped no types and DefinitelyTyped was three majors
behind. None of that applies here. `basic-ftp@6.2.1` is written in TypeScript
and ships its own `.d.ts` next to every module, so there is no second package
whose version has to be kept in step with the runtime, and nothing for the
`@types/node`-pinning discipline to protect against.

What it does not ship is also settled: no `ABOR`, no `MLST`, and no re-export
of its MLSD line parser. Those are written here — see decisions 5 and 6 — which
is a page of parsing, not a reimplementation of FTP.

The dependency already in `packages/provider-ftp/package.json` is therefore the
right one, and this phase adds none.

### 2. A pool of control channels, not a single session

`basic-ftp`'s `Client` is one control connection and refuses a second command
while one is in flight, so the provider has to serialise internally whatever
else it does. The question this phase answers is whether one connection is all
it ever has.

It is not, by default-overridable choice. A single channel means a 2 GB
download blocks browsing, `stat`, and every other operation until it finishes —
which is not a protocol limitation but a client one, and every desktop FTP
client solves it the same way: open another connection.

So the provider owns a pool. Every operation **leases a channel for its whole
duration**, which is also what makes `RNFR`/`RNTO` safe, since that pair must
not interleave with anything. Channels open lazily; `connect()` opens exactly
one.

The ceiling is a per-connection setting, `maxConnections`, **defaulting to 1**.
That default matters: it means the out-of-the-box behaviour is the conservative
one that no server can object to, and a user who knows their server opts into
more. It also means the serialised path is the one under the most test.

On a `421` refusal naming a connection limit, the pool **lowers its own ceiling
for the life of the session** and retries the operation on an existing channel,
rather than surfacing a failure the user can do nothing about. Shared hosting
caps concurrent logins per account and does not advertise the number.

### 3. `maxConcurrency` is answered per connection

`TransferQueue` reads `capabilities.maxConcurrency` to decide how many
transfers to run at once. With a pool whose size is a setting, the honest
answer is not a constant.

So `capabilities` becomes a getter, exactly as `provider-sftp` did for
`canCopyServerSide`:

- `FTP_CAPABILITIES` — the static `defaultCapabilities` a host renders before
  any connection exists — keeps `maxConcurrency: 1`, the safe assumption.
- The instance's getter returns the configured pool ceiling, and follows it
  down when a `421` shrinks it.

This is the second provider whose capabilities depend on the connection, and
the first whose capabilities depend on a _setting_. `ManagedFileSystem` reads
capabilities at call time, but `TransferQueue` does not: its only caller,
`apps/vscode`'s connect path, calls `setConnectionLimit` once, at connect, so
a ceiling that falls mid-session (a `421` shrinking the pool) is not observed
until the next connect. That is a real gap, not a design this plan closes —
teaching the queue to track a live ceiling is core plus host work outside its
scope, left as future work. The skeleton's comment, "One control channel. Do
not raise this.", is now wrong regardless, and is replaced by one explaining
what the number means and that gap.

### 4. `canDeleteRecursive` is `true` — the skeleton says `false`

The shared suite calls `delete(dir, { recursive: true })` on the raw provider
without gating on the capability, and FTP has only `DELE` for files and `RMD`
for empty directories.

`provider-s3` and `provider-sftp` already settled what the flag means: S3
enumerates and deletes in batches, SFTP walks with `readdir` and `unlink`, and
both declare `true`. The flag means "the provider handles a recursive delete
when asked", not "the server does it in one call" — the sharpened comment on
`ProviderCapabilities.canDeleteRecursive` says so in those words already.

FTP follows: `delete` walks with `LIST` plus `DELE`/`RMD`, depth first, and
declares `true`. `ManagedFileSystem` reads the flag only to decide whether to
walk itself, so this keeps one walk in the system rather than two.

This is the one capability the skeleton declares wrongly. Everything else it
declares survives.

### 5. `stat` is `MLST` where it exists, and a parent listing where it does not

FTP has no stat command. Three ways exist to fake one, and only two of them
work:

- **`MLST <path>`** — RFC 3659's machine-readable single-entry listing, on the
  control channel, no data connection. One round trip, and it answers type,
  size and modification time together. `basic-ftp` does not wrap it and does
  not re-export the parser it uses for `MLSD` lines, so the fact-list parser is
  written here: thirty lines, pure, unit-tested, and no deep import into
  `dist/`. Availability is read from the `FEAT` map, which `basic-ftp` already
  fetches at login for its own `MLSD` decision.
- **Listing the parent and matching by name** — the fallback. One data
  connection per stat, but it answers all three fields, and core caches above
  this line so a tree expansion does not pay it repeatedly.
- **`SIZE` plus `MDTM`** — rejected. `SIZE` fails on directories and refuses
  outright in ASCII mode, and `MDTM` is missing from a good fraction of
  servers, so telling "missing" from "is a directory" needs a third probe. It
  is more round trips than the fallback for less information.

The connection base has no parent inside the connection, so it is answered as a
directory without asking.

### 6. A bounded range read costs a channel, and says so

`downloadTo(destination, path, startAt)` issues `REST`, so `offset` is native
and free. There is no end-of-range in the protocol: `RETR` runs to EOF.

`length` is therefore enforced client-side by counting bytes. When the range
ends before EOF, the transfer has to be stopped early, which leaves the control
channel mid-`RETR` — and a desynchronised control channel is worse than no
channel. So **that channel is poisoned and the pool replaces it**, at the cost
of one reconnect.

`ABOR`-based recovery is deliberately not attempted. It needs the out-of-band
`IP`/`SYNCH` sequence, servers disagree about whether `426` precedes `226`, and
`basic-ftp` has no support for any of it — so the fallback path would be "throw
the channel away" regardless, reached by a more complicated route.

`length: 0` transfers nothing at all, but still stats first, so a zero-length
read of a missing path is `NotFound` rather than a silent empty success. That
is the case the conformance suite's comment says all four providers reached
independently.

### 7. `overwrite: false` is check-then-act, and the comment says so

FTP has no exclusive create. `STOR` truncates whatever is there, and there is
no flag, no `If-None-Match`, no `wx`.

So `overwrite: false` stats the destination first and throws `AlreadyExists`,
with a race window of one round trip. SFTP got this for free from a `wx` open
and WebDAV from `If-None-Match`; FTP cannot, and the difference is written down
at the call site rather than hidden behind an identical-looking method. The
same shape covers `rename`'s `overwrite: false`.

Where FTP's servers disagree is `rename` with `overwrite: true`: vsftpd's
`RNTO` replaces an existing destination, others answer `550`. On that `550` the
provider deletes the destination and retries once, **logging that the replace
was not atomic** — the same warning `provider-sftp` emits on a server without
POSIX rename, and which its live suite asserts on.

### 8. TLS version is one setting, and it carries the security level with it

Node 22 refuses anything below TLS 1.2 by default. That default is right for
new code and wrong for FTPS, which is exactly where the servers that never
moved past TLS 1.0 still live — vsftpd 2.x, IIS 6 and 7, ProFTPD builds from
the same era. A provider that cannot reach them has implemented FTPS for the
servers that least need a dedicated client.

So `tlsMinVersion` is a setting: `auto`, `TLSv1.3`, `TLSv1.2`, `TLSv1.1`,
`TLSv1`. It becomes `secureOptions.minVersion`, which `basic-ftp` keeps as
`ftp.tlsOptions` and spreads into every data connection's `tls.connect`
(`transfer.js:128`) — so the control channel and the transfers agree by
construction. That matters more than it looks: a mismatch would fail the data
connection rather than the login, which is a far worse error to be handed.

**Choosing below TLS 1.2 also relaxes OpenSSL's security level**, by adding
`DEFAULT@SECLEVEL=0` to the cipher string. This is the part that makes the
setting work rather than merely exist: OpenSSL 3 rejects the 1024-bit DH
parameters and legacy signature algorithms those servers offer _regardless_ of
the protocol version, so a version-only knob would be set correctly by the user
and still fail the handshake — and the second knob needed to finish the job is
undiscoverable precisely when it is needed. Coupling them makes the setting
mean "talk to this old server", which is the only thing anyone sets it for.

The relaxation is logged at `warn`, naming the connection, exactly as
`allowSelfSigned` is. Weakened crypto is never silent, even when it is implied.

Two things are deliberately absent. There is **no maximum version**: a server
that breaks on a TLS 1.3 handshake is rarer than one that needs TLS 1.0, and
adding the field later is one line with no design consequence. And the default
is **`auto`, not a named version** — Node's floor moves with Node, and writing
`TLSv1.2` here would freeze this provider's floor on the day Node raises its
own.

The setting is ignored when `secure: 'none'`, where there is no TLS to
configure, rather than being rejected: a user toggling encryption off and back
on should not lose the rest of their form.

### 9. All three TLS modes are proven live, against a container built here

`delfer/alpine-ftp-server` serves plain FTP only, so today there is nothing in
the compose stack to run the suite against over TLS. A provider whose settings
schema offers three modes and whose tests exercise one is a provider with two
untested modes.

`docker/ftp` replaces it, following `docker/sftp`'s precedent exactly — built
rather than pulled, digest-pinned so the test server is not "whatever was
pushed under that tag today", multi-arch so it builds natively on both runners
and laptops. It runs two vsftpd instances under one entrypoint: port 21 with
TLS enabled but not forced, so plain **and** `AUTH TLS` both work against it,
and port 990 with `implicit_ssl`. Each gets its own passive port range, because
two processes cannot hand out the same one.

The certificate is self-signed and generated at build, which makes
`allowSelfSigned` a tested setting rather than a documented one.

**`require_ssl_reuse` was decided `YES` and shipped `NO`.** The decision was
that it should stay at vsftpd's default: real servers have it on, `basic-ftp`
stores the control connection's TLS session and resumes it on data connections
for precisely this reason, and proving that path is worth more than an easy
green.

What was observed is that it did not hold. With the default left in place,
vsftpd refused `basic-ftp`'s own data connections with `522 SSL connection
failed: session reuse required`. The client does pass the control connection's
session when it opens a data socket (`dist/transfer.js`), so the intent is
there, but the resumption did not take against this server and every FTPS
transfer failed. Diagnosing vsftpd's side of that is not what this phase is
for, so `docker/ftp/vsftpd-common.conf` sets `require_ssl_reuse=NO` and says
why in place.

The consequence is therefore stated rather than assumed away: **nothing that
runs against this container exercises the session-reuse path.** Both FTPS
listeners negotiate TLS for real, so decision 9's own claim — three modes
tested rather than one — still holds; it is session reuse specifically that has
no live coverage, and closing it would need either a second FTP image or a
diagnosis of the 522.

### 10. CI runs the live conformance suite, for all four providers

Nothing in CI runs `pnpm test:conformance` today. The live suite is
developer-run, and the compose stack is started only for
`test:extension:live`.

FTP is the protocol most likely to break silently — passive port ranges, TLS
session reuse, and listing formats that differ per server are all invisible to
a hermetic test and to a type checker. A provider "finished exactly when it
passes the live suite" that nothing ever runs is finished exactly once.

So this phase adds a Linux-only `conformance-live` job: `docker compose up -d`,
then `pnpm test:conformance`, with a failure-only `docker compose ps && logs`
step for the one job a contributor cannot reproduce without Docker — the same
shape `extension-tests-live` already has.

It covers all four providers rather than FTP alone. Turbo's `test:conformance`
task already exists and S3, WebDAV and SFTP already define the script, so
filtering to FTP would mean writing _more_ configuration in order to test
_less_.

## Architecture

One package, mirroring `provider-sftp`'s layout, with its single session file
split in two.

| File                           | Responsibility                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/settings.ts`              | `FTP_SETTINGS_SCHEMA`, `FTP_SECRET_SCHEMA`, `FtpSettings`, `readSettings()`                                                    |
| `src/errors.ts`                | `toOmniFsError(cause, path?)`, `isReplyCode()`, `isConnectionLimit()`                                                          |
| `src/ftp-channel.ts`           | one logged-in `basic-ftp` `Client`: TLS mode, login, `FEAT`, base resolution, the abort race, promisified requests and streams |
| `src/ftp-pool.ts`              | lease/release, lazy growth, liveness on lease, poisoning, `421` shrink                                                         |
| `src/ftp-file-system.ts`       | `FTP_CAPABILITIES` and `FtpFileSystem implements RemoteFileSystem`                                                             |
| `src/ftp-helpers.ts`           | path joining, `FileInfo` → `FileStat`/`DirEntry`, `MLST` fact parsing, range arithmetic                                        |
| `src/index.ts`                 | `ftpProvider: ProviderDefinition` plus re-exports, ~20 lines                                                                   |
| `src/settings.test.ts`         | schema and `readSettings`, including the leading-slash rule and `maxConnections` bounds                                        |
| `src/errors.test.ts`           | reply-code mapping, TLS failures, call-site narrowing                                                                          |
| `src/ftp-helpers.test.ts`      | `MLST` facts, listing conversion, range arithmetic                                                                             |
| `src/ftp-pool.test.ts`         | lease/release, lazy growth, dead-on-lease replacement, poisoning, `421` shrink                                                 |
| `src/ftp-file-system.test.ts`  | the provider against a fake channel                                                                                            |
| `src/ftp.live.test.ts`         | `runConformanceSuite()` three times, plus what only a real server shows                                                        |
| `vitest.config.ts`             | default run excludes `*.live.test.ts` and `dist/**`                                                                            |
| `vitest.conformance.config.ts` | includes only `*.live.test.ts`, 30s timeouts                                                                                   |

The pool is its own file rather than a section of the channel, because they
fail differently: a channel's job is one connection's protocol, and the pool's
job is deciding which connections exist. Keeping them apart is also what lets
the hermetic tests drive the pool with a fake channel factory and never open a
socket.

Outside the package: `docker/ftp/`, the FTP services in `compose.yaml`, the
`conformance-live` job in `.github/workflows/ci.yml`, the FTP sections of
`docker/README.md` and `README.md`, and the `maxConcurrency` comment in
`packages/core/src/capabilities.ts`.

## Settings and secrets

The skeleton's schema survives with two fields added. Settings, all
committable
through `omniFs.connections`:

| Key               | Kind    | Notes                                                                             |
| ----------------- | ------- | --------------------------------------------------------------------------------- |
| `host`            | text    | required                                                                          |
| `port`            | number  | default 21; implicit TLS normally wants 990                                       |
| `username`        | text    | required                                                                          |
| `secure`          | select  | `explicit` \| `implicit` \| `none`, default `explicit`                            |
| `allowSelfSigned` | boolean | default false; disables certificate verification                                  |
| `maxConnections`  | number  | **new.** 1–8, default 1. The pool ceiling, and `maxConcurrency`                   |
| `tlsMinVersion`   | select  | **new.** `auto` \| `TLSv1.3` \| `TLSv1.2` \| `TLSv1.1` \| `TLSv1`, default `auto` |
| `rootPrefix`      | text    | see below                                                                         |

The secret is `password`, and goes only through `SecretStore`.

`readSettings()` rejects a missing `host` or `username`, an unknown `secure`
value, an unknown `tlsMinVersion`, a port outside 1–65535 and a
`maxConnections` outside 1–8, all with
`ProtocolError` — the same local-validation line `provider-sftp` and
`provider-webdav` draw, so a typo is caught before it becomes a server round
trip reported in the server's words. A missing password is
`AuthenticationFailed` at connect, not a settings error.

`secure: 'explicit'` is the default because it is the one a modern server
should accept, and a user who needs plain FTP has made that choice knowingly.
The port is not defaulted per mode: a select cannot change a number field's
default, and silently rewriting a port the user typed is worse than the help
text on the `implicit` option that already names 990.

`tlsMinVersion` carries help text saying what decision 8 decided: that anything
below TLS 1.2 also relaxes OpenSSL's cipher policy, and that it is for reaching
an old server rather than for tuning a good one.

## Path model

`rootPrefix` keeps its leading slash, as `provider-sftp`'s does and unlike
`provider-s3` and `provider-webdav`. The reasoning is the skeleton's own and is
unchanged: for those two the absolute part of the location already lives in the
Bucket or Server URL field, while here the server's filesystem root is a real,
reachable place that no other setting names.

- `''` — the login directory.
- `public_html` — below the login directory.
- `/srv/ftp/shared` — that absolute server path.

The login directory is resolved once, at connect, with `PWD` on the first
channel, and shared by every channel afterwards — they log in as the same user
and land in the same place. `#remote(path)` is then pure string work.

**No channel ever changes its working directory.** Every command carries an
absolute path. This is what makes a pooled channel interchangeable, and it is
why `basic-ftp`'s `ensureDir` and `removeDir` are not used: both are built on
`CWD` and would leave a leased channel somewhere the next lease does not expect.

## Operations

| Contract method     | FTP                                                                |
| ------------------- | ------------------------------------------------------------------ |
| `connect`           | one channel: TLS, `USER`/`PASS`, `FEAT`, `TYPE I`, `PWD`           |
| `isAlive`           | the pool holds at least one live channel                           |
| `stat`              | `MLST`, or a parent listing — decision 5                           |
| `list`              | `MLSD`, or `LIST -a`, or `LIST`, whichever the channel settled on  |
| `readFile`          | `createReadStream` collected through core's `collectStream`        |
| `createReadStream`  | `REST` + `RETR`, counted and cut for a bounded length — decision 6 |
| `writeFile`         | `STOR` from a one-shot readable                                    |
| `createWriteStream` | `STOR` from a pipe, resolving `close()` on the server's `226`      |
| `delete`            | `DELE`, `RMD`, or a depth-first walk                               |
| `createDirectory`   | `MKD`, building missing ancestors                                  |
| `rename`            | `RNFR` + `RNTO` on one lease                                       |
| `copy`              | not implemented; core streams it                                   |
| `watch`             | not implemented                                                    |

The parts that are not one-liners:

**`list`** uses `client.list(absolute)`, which probes `MLSD` → `LIST -a` →
`LIST` once per channel and then reuses the winner. `MLSD` is chosen when
`FEAT` advertised `MLST`, which is the same signal decision 5 reads. Entries
come back as an array — FTP has no cursor, so `listIsPaginated` is `false` —
and are yielded one at a time to keep the contract's shape. `.` and `..` are
dropped. A `FileType.SymbolicLink` entry is reported as `'symlink'` and **not**
resolved: unlike SFTP there is no cheap `stat`, so resolving would cost a round
trip per link on every listing.

`modifiedAt` is present only under `MLSD`, which is the only listing format
whose dates are reliable. Under `LIST` the provider leaves `mtime` undefined
rather than parsing a human-readable date whose year is implied and whose
timezone is the server's — the contract allows `undefined`, and a wrong
timestamp is worse than an absent one.

**`createReadStream`** passes `offset` as `startAt`. With no `length`, the
transfer runs to EOF and the channel is returned to the pool clean. With one,
bytes are counted and the transfer is cut, and the channel is poisoned — see
decision 6. `length: 0` stats and returns an empty stream without opening a
data connection.

**`writeFile`** and **`createWriteStream`** both go through `uploadFrom`.
`createParents` (default true) walks `MKD` from the base, treating "already
exists" as success — servers spell that refusal as `550` or `521` and disagree
about which. `contentLength` and `contentType` are ignored, because FTP carries
neither. `onProgress` is wired through `trackProgress`, which is per-`Client`
and therefore safely per-lease, and cleared in a `finally`.

`createWriteStream`'s `close()` resolves only after the server's transfer-
complete reply. A write stream whose `close()` resolves for a transfer the
server rejected is a defect this repo has now fixed three times — S3's
`openUploadStream`, WebDAV's `openWriteStream`, SFTP's fsync-on-close — and the
hermetic suite pins it here with a fake that fails the final reply.

**`delete`** stats first to learn the type, then sends `DELE` or `RMD`. The
`stat` is not overhead: `550` from `DELE` on a directory and `550` from `RMD`
on a non-empty one are the same reply code, and a caller who asked to remove an
empty directory must not silently lose a tree. Recursive walks depth-first,
checking the abort signal between entries.

**`createDirectory`** creates missing ancestors and treats an existing
directory as a no-op, matching `MemoryFileSystem`, which is the contract's
reference implementation. A _file_ in the way is `AlreadyExists`.

**`rename`** holds one lease across `RNFR` and `RNTO`, which is the whole
reason a lease spans an operation rather than a command. `overwrite: false`
stats the destination first; `overwrite: true` falls back to delete-then-retry
on a `550`, logging the loss of atomicity. Per decision 7.

## The pool

`FtpPool` owns channel creation and is the only thing that closes one.

- **Lease.** Hand back an idle channel, or open a new one if the count is below
  the ceiling, or wait in FIFO order. A channel found dead on lease — the
  server idled it out, which vsftpd does after five minutes — is discarded and
  replaced before the operation starts. That is pool bookkeeping, not a retry:
  an operation that fails _on_ a live channel surfaces
  `ConnectionFailed{retryable: true}` and is core's to reconnect, through the
  `isAlive()` check `ConnectionManager.acquire` already performs. Two retry
  layers would only hide the first.
- **Release.** Clean channels return to the idle set. A channel that was
  aborted, that errored, or that was cut mid-transfer is **poisoned**: closed,
  removed, and not counted against the ceiling any more.
- **Shrink.** A `421` whose text names a connection limit lowers the ceiling to
  the number of channels currently open, permanently for this session, and the
  lease retries on an existing channel. The instance's `maxConcurrency` follows
  it down — real and observable on the provider — but `TransferQueue` reads it
  once, at connect, so a ceiling that drops mid-session is not yet something
  the queue acts on. See decision 3.
- **Dispose.** `[Symbol.asyncDispose]` closes every channel, idle or leased.

`connect()` is idempotent: it returns immediately when the pool already holds a
live channel, and otherwise opens one and resolves the base.

## Capabilities

The static set, with the one correction marked.

| Capability           | Value                  | Why                                                                                                   |
| -------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `canWrite`           | `true`                 |                                                                                                       |
| `canRename`          | `true`                 | `RNFR`/`RNTO`                                                                                         |
| `canCopyServerSide`  | `false`                | FTP has no server-side copy; core streams it                                                          |
| `canCreateDirectory` | `true`                 | `MKD`                                                                                                 |
| `canDeleteRecursive` | `true` — **was false** | Decision 4                                                                                            |
| `canAppend`          | `true`                 | `APPE`; no contract method uses it yet                                                                |
| `canReadRange`       | `true`                 | `REST` gives the offset; the end is ours — decision 6                                                 |
| `canStreamWrite`     | `true`                 | `STOR` from a stream needs no length                                                                  |
| `canWatch`           | `false`                | No change notification in the protocol                                                                |
| `hasRealDirectories` | `true`                 |                                                                                                       |
| `preservesMTime`     | `false`                | `MFMT` exists, but no `WriteOption` carries an mtime to preserve                                      |
| `hasVersionTokens`   | `false`                | No etag. Synthesising one from size+mtime would make `ifMatch` look atomic when it would be a re-stat |
| `maxConcurrency`     | `1` statically         | Per connection, decision 3                                                                            |
| `listIsPaginated`    | `false`                | `LIST` and `MLSD` return everything                                                                   |

Both `ifMatch` conformance cases skip on `hasVersionTokens: false`, and the
`copy` case skips because the method is absent.

## Errors

`basic-ftp` throws `FTPError` carrying the three-digit reply as `code`
(`FtpContext.d.ts:26`), so `errors.ts` is a table plus call-site narrowing —
the shape `provider-sftp` uses for status 4 and `provider-webdav` for 412.

| Reply         | Code                                         |
| ------------- | -------------------------------------------- |
| 550           | `NotFound` by default — see below            |
| 553           | `PermissionDenied` (file name not allowed)   |
| 530, 332, 532 | `AuthenticationFailed`                       |
| 421           | `ConnectionFailed`, retryable; pool shrink   |
| 425, 426, 450 | `ConnectionFailed`, retryable (data channel) |
| 452, 552      | `QuotaExceeded`                              |
| 500–504       | `Unsupported`                                |

Beyond reply codes: Node's socket errors (`ECONNREFUSED`, `ENOTFOUND`,
`ECONNRESET`, `EPIPE`, `EHOSTUNREACH`, …) become `ConnectionFailed`, retryable;
`basic-ftp`'s timeout becomes `Timeout`, retryable; an `AbortError` becomes
`Cancelled`.

**TLS verification failures get their own branch.**
`DEPTH_ZERO_SELF_SIGNED_CERT`, `SELF_SIGNED_CERT_IN_CHAIN`,
`UNABLE_TO_VERIFY_LEAF_SIGNATURE` and `ERR_TLS_CERT_ALTNAME_INVALID` become a
**non-retryable** `ConnectionFailed` whose message names the _Allow
self-signed certificates_ setting. Retrying a certificate the client will never
accept is pure cost, and the difference between a message that names the
setting and one that says `self signed certificate` is the difference between a
ten-second fix and a bug report.

**TLS protocol failures get the same treatment**, for the same reason.
`ERR_SSL_UNSUPPORTED_PROTOCOL`, `ERR_SSL_WRONG_VERSION_NUMBER`,
`ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION`, and the `EPROTO` handshake failures
whose message says `no protocols available`, `unsupported protocol` or
`dh key too small`, become a **non-retryable** `ConnectionFailed` naming the
_Minimum TLS version_ setting. `dh key too small` belongs in that list rather
than with the certificate failures because it is the security level talking,
and the security level is what that setting moves.

**550 is the ambiguous one**, as status 4 is for SFTP. Servers answer it for
"no such file", for "permission denied", for "directory not empty" and for a
generic refusal. Unlike SFTP's status 4 it cannot fall through to `Unknown`:
the suite's first case requires `stat` of a missing path to be `NotFound`, and
`NotFound` is what 550 means in the overwhelming majority of its uses. So the
default is `NotFound`, and the call sites narrow:

- `RMD` reads it as `NotEmpty` once a listing confirms a child.
- `MKD` reads it as `AlreadyExists`.
- A message matching `/permission denied|access denied|not allowed/i` reads it
  as `PermissionDenied`, the one place this provider sniffs text. The reply
  text is the server's to choose, so the sniff is additive: it can only turn
  `NotFound` into something more specific, never the reverse.

## Tests

**Hermetic** (`pnpm test`, no Docker). `settings.test.ts`,
`errors.test.ts` and `ftp-helpers.test.ts` are pure. `ftp-pool.test.ts` drives
the pool with a fake channel factory. `ftp-file-system.test.ts` runs the
provider against a fake channel, covering what a live server cannot be made to
do on demand:

- an already-aborted signal, and one aborted mid-transfer
- `overwrite: false` refused after the stat, and the race window it leaves
- a bounded range read poisoning its channel, and an unbounded one not
- `550` narrowed differently by `RMD`, `MKD` and `stat`
- `stat` falling back to a parent listing when `FEAT` omits `MLST`
- a `LIST`-only server yielding entries with `mtime` undefined
- a write stream whose final reply the server rejects after `close()`
- a `421` shrinking the ceiling, and `maxConcurrency` following it down
- the `secureOptions` assembled for each `tlsMinVersion`: the security level
  relaxed below TLS 1.2, untouched at `auto`, and the whole object absent under
  `secure: 'none'`
- a protocol-version handshake failure arriving with the setting's name in it

**Live** (`pnpm test:conformance`, with `docker compose up -d`).
`runConformanceSuite()` runs three times against `docker/ftp` as `omnifs`, with
`rootPrefix: /data` — which is the seeded volume and also what exercises the
absolute-prefix rule:

- `secure: 'none'` on 2121
- `secure: 'explicit'` on 2121
- `secure: 'implicit'` on 2990
- `secure: 'explicit'` with `tlsMinVersion: 'TLSv1'` on 2100, the legacy
  listener

Each case makes and removes its own `/conformance-<timestamp>-<n>` directory,
so the seeded tree is identical before and after, as the WebDAV and SFTP runs
already behave. Setup and teardown go through a transport-only channel rather
than through the methods under test, for the reason `provider-sftp`'s
`withTransport` exists: a cleanup that ran through a method under test cannot
fail safely.

Alongside the shared suite, the cases that are only true of a real server: that
an empty `rootPrefix` lands in the login directory and a relative one below it,
that `allowSelfSigned: false` is _refused_ by this server's self-signed
certificate with the message that names the setting, that a listing over
`MLSD` carries `mtime`, that the non-atomic rename warning is emitted, and that
`maxConnections: 3` genuinely overlaps three transfers.

Two more belong to `tlsMinVersion`, and they pull in opposite directions on
purpose. Lowering the floor must not break a good server: the modern listener
still connects at `tlsMinVersion: 'TLSv1'`, negotiating 1.3 as it would have
anyway. And raising it must bite: `tlsMinVersion: 'TLSv1.3'` against the legacy
listener fails, with the message that names the setting. A knob that is only
ever tested in the direction that succeeds has not been tested.

## Test server

`docker/ftp/Dockerfile` — Alpine plus vsftpd, digest-pinned and multi-arch,
following `docker/sftp`'s comment and reasoning. At build it creates the
`omnifs` user with uid 1001, matching what `file-seed` already chowns, mounts
the seeded volume at `/data` as `docker/sftp` does, and generates a self-signed
certificate with `subjectAltName` covering `localhost`
and `127.0.0.1`.

Three configurations, one entrypoint:

|                | explicit                            | implicit             | legacy               |
| -------------- | ----------------------------------- | -------------------- | -------------------- |
| port           | 21                                  | 990                  | 2100                 |
| `ssl_enable`   | `YES`                               | `YES`                | `YES`                |
| `implicit_ssl` | `NO`                                | `YES`                | `NO`                 |
| forced TLS     | no — plain and `AUTH TLS` both work | yes, by construction | yes                  |
| protocol       | whatever both ends agree on         | same                 | TLS 1.0 only         |
| `ssl_ciphers`  | default                             | default              | `DEFAULT@SECLEVEL=0` |
| passive range  | 21000–21010                         | 21011–21021          | 21022–21032          |

All three enable `write_enable`, turn `require_ssl_reuse` off (decision 9 —
it was meant to stay on, and could not), and set `pasv_address` for the
published ports. None chroots the user: the login
directory is `/data` and the server's filesystem root stays reachable, which is
what gives the absolute `rootPrefix` rule something real to name — the same
reason `docker/sftp` does not chroot either. The entrypoint starts the implicit
and legacy instances in the background and `exec`s the explicit one, so the
container's main process is a real server rather than a shell.

The legacy listener exists for one reason: `tlsMinVersion` is a setting whose
whole purpose is reaching a server this stack would otherwise not contain, and
decision 9's argument — that a schema offering three modes while testing one
has two untested modes — applies to it unchanged. It pins `ssl_tlsv1` on with
`ssl_sslv2`/`ssl_sslv3` off and a security level of 0, which is the
configuration a real 2012-era server has by accident.

`compose.yaml` publishes 2121→21, 2990→990, 2100→2100 and all three passive
ranges, and its FTP comment — which currently explains that the provider is a
skeleton whose server exists "to exercise the connection form now" — is
replaced by one saying what the three listeners are for.

## Tooling and docs

- `packages/provider-ftp/package.json`: `test` becomes `vitest run`, and
  `test:conformance` is added, matching the other three providers.
- `.github/workflows/ci.yml`: the `conformance-live` job, per decision 10.
- `packages/core/src/capabilities.ts`: the `maxConcurrency` comment stops
  saying FTP is "typically 1" and says what the number now means.
- `docker/README.md`: the FTP section moves out of "not yet implemented", names
  the three listeners, the credentials and the root prefix.
- `README.md`: tick the FTP roadmap line and move the table row to
  ✅ Implemented — which makes it the last one.
- `CLAUDE.md`: the "Current state" paragraph stops calling FTP a deliberate
  skeleton.
- Prettier on touched files only (`pnpm exec prettier --write`), never
  `pnpm format`.
- After changing anything in `packages/`, `pnpm build` before a dependent
  typecheck means anything.

## Risks

- **`require_ssl_reuse` may not hold.** `basic-ftp` stores the control
  connection's TLS session and resumes it on data connections, which is what
  vsftpd's default demands — but if the resumption does not satisfy this
  server, every TLS transfer fails at the data connection. The fallback is
  `require_ssl_reuse=NO` with a comment saying the reuse path is therefore
  untested here, not a silent flip. Establishing which it is comes first in
  implementation, because it decides whether two of the three live runs can
  exist at all.
- **Three vsftpd instances in one container.** The alternative is three
  services in `compose.yaml` sharing a volume, which triples the seeding
  problem. If the single container proves awkward, splitting it is a compose
  change and no provider change.
- **The legacy listener may not be buildable.** Alpine's OpenSSL 3 can have
  TLS 1.0 compiled out entirely, in which case no vsftpd setting brings it
  back and `ssl_ciphers=DEFAULT@SECLEVEL=0` changes nothing. The fallback is to
  drop that listener, keep the low-version path covered by the hermetic
  assertion on the assembled `secureOptions`, and say plainly in
  `docker/README.md` that no server here speaks TLS 1.0 — not to quietly leave
  a live test that proves less than its name claims. This is worth
  establishing early, alongside `require_ssl_reuse`.
- **`MLST` parsing is ours.** RFC 3659's fact syntax is simple, but servers
  emit facts we do not know and occasionally malform the ones we do. An
  unparseable response falls back to the parent listing rather than failing the
  `stat`, so the worst case is a slower answer.
- **`LIST` parsing is `basic-ftp`'s**, and it is the part of FTP that genuinely
  varies per server. The compose server is one implementation; a DOS-format
  server is not exercised anywhere. This is inherent to the protocol and is the
  reason the provider prefers `MLSD` wherever it is offered.
- **Poisoning a channel on every bounded read** is cheap at `maxConnections: 1`
  only because a reconnect is cheap. On a slow-authenticating server a preview
  of many large files will feel it. Measuring that belongs to the phase that
  adds previews, and the comment at the cut says so.
- **The abandoned-operation gap is real and wider than SFTP's.** Aborting
  destroys the channel, so an in-flight mutation may still land on the server
  and no reply is ever read. Documented at the helper.
