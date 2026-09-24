# Changelog

Odd minor versions (0.1.x, 0.3.x) are pre-releases; even minor versions are
stable.

## Unreleased

### Fixed

- **Disconnect takes a connection out of the workspace.** A connection opened
  as a workspace folder stayed in the Explorer after Disconnect, and the next
  thing VS Code read from the folder connected it again. Removing a connection
  now removes its folder too, instead of leaving one that no longer opens.
- **Opening a connection that is already a workspace folder** shows that folder,
  instead of an error saying it could not be added.

### Added

- **Remove from Workspace**, offered in place of Open as Workspace Folder once a
  connection is open there. The sidebar marks such a connection _in workspace_.

## 0.1.3

### Fixed

- **FTPS to a TLS 1.0 server inside VS Code.** Choosing TLS 1.0 or 1.1 as the
  minimum version failed with "Unknown error" before a byte reached the server:
  VS Code's TLS library (BoringSSL) rejects the cipher setting that plain
  Node.js needs for those servers. It is now applied only where it is
  understood.

### Changed

- **Logging follows the Omni-FS output channel's own level** (Output panel →
  gear → Set Log Level…), applies without a reload, and says more: connects
  and disconnects with the reason, FTP's negotiated TLS version and cipher,
  per-operation timings at `debug`, and the raw FTP control channel at
  `trace`. `omniFs.logLevel` is deprecated — it could only ever hide lines,
  because the channel dropped anything below its own level first.

## 0.1.2

No change in behaviour from 0.1.1.

- The GitHub release carries the `.vsix` again. 0.1.1's release was published
  without it, and immutable releases cannot have files added afterwards.

## 0.1.1

Documentation only. No change in behaviour from 0.1.0.

- The README described the 0.1.0-beta.1 build — S3 only — and its changelog
  link pointed at a file that does not exist. It now describes what ships, and
  says how to install from the VS Code Marketplace, Open VSX or a `.vsix`.

## 0.1.0

The first build with every protocol. First published to Open VSX.

### New

- **FTP and FTPS.** Explicit TLS (AUTH TLS, the default), implicit TLS on port
  990, or plain FTP. Adjustable minimum TLS version for legacy servers, and an
  opt-in for self-signed certificates. `MLSD`/`MLST` where the server offers
  them, `LIST` parsing where it does not. Byte-range reads, writes that create
  missing parent directories, rename, and recursive delete.
- **Several FTP connections at once.** _Maximum connections_ (1 by default, up
  to 8) lets browsing carry on during a transfer. If the server refuses the
  extra logins, the pool shrinks to what it accepts instead of failing.
- **SFTP.** Password, private key and SSH-agent authentication. A host key is
  checked against `known_hosts`, and a host whose key has changed is refused.
  Byte-range reads, writes that do not overwrite by accident, server-side copy,
  and symlinks resolved when listing. A root prefix of `/` means the server's
  filesystem root.
- **WebDAV.** Nextcloud, ownCloud and other WebDAV servers. Capabilities come
  from what the server actually answers, so unsupported actions are greyed out
  in advance.
- **Connection manager panel.** Connections are added and edited in one panel
  instead of a series of prompts. A draft can be tested before it is saved.
- **Colour-tagged connections.** Eleven preset colours or any custom one. The
  colour tints the connection in the tree and its files in the Explorer and
  editor tabs.
- **Read-only toggle.** _Make Read-only_ / _Make Writable_ on a connection's
  context menu applies to the next write, without reconnecting.

### Fixed

- A zero-length S3 read no longer sends an inverted byte range.
- A failed streamed write no longer leaves a stale cached file size behind.
- Renaming a directory works on protocols where rename is emulated.
- A reconnect closes the dead connection it replaces.
- A connection whose provider cannot be built shows an error instead of hanging.

### Still missing

- The **Download…** and **Upload…** commands are stubs.
- Moving or copying between two different connections is refused.
- No change notifications: refresh is explicit.

## 0.1.0-beta.1

First beta. **S3 works; the other three protocols do not yet.** Please read
[What does not work](#what-does-not-work-yet) before installing.

### Works

- **S3 and S3-compatible storage** — AWS S3, MinIO, Cloudflare R2, Backblaze
  B2, DigitalOcean Spaces, Ceph. Custom endpoints and path-style addressing.
- **Remote files as real files.** An `omnifs://` file system is registered, so
  remote files open in normal editors, save with <kbd>Ctrl</kbd>+<kbd>S</kbd>,
  and work with search and quick-open. A connection can be added to the
  workspace as a folder.
- **Connections sidebar** — add, edit, connect, disconnect, browse, remove.
- **Transfers view** — progress, automatic retry on transient failures,
  cancellation.
- **Credentials in the OS keychain** via VS Code secret storage. Connection
  settings live in `omniFs.connections` and contain no secrets, so that list is
  safe to commit and share with a team.
- **Protocol-aware behaviour.** Each backend declares what it genuinely
  supports and the extension adapts rather than failing after you click — S3
  has no real directories, so a new folder appears once it holds a file, and
  rename is performed as a server-side copy followed by a delete.

### What does not work yet

- **FTP, FTPS, SFTP and WebDAV.** These appear in the protocol picker and their
  connection forms work, but every operation raises "not implemented yet". The
  contracts and capability declarations are in place; the protocol calls are
  not.
- **Download and upload commands** are stubs. The transfer queue, retry and
  progress reporting exist, but the local-file half is not wired up. Editing
  and saving a remote file directly does work.
- **Moving or copying between two different connections** is refused with a
  clear message rather than half-performed.
- **No change notifications.** None of the target protocols offer them, and
  polling a metered bucket in the background is a cost you did not ask for, so
  refresh is explicit.

### Known rough edges

- Directory listings are cached for 15 seconds (`omniFs.cache.ttlSeconds`). A
  change made outside VS Code may take that long to appear.
- Connections close after 5 minutes idle
  (`omniFs.connection.idleTimeoutSeconds`) and reconnect on next use.
- Large-file performance has not been tuned.

### Reporting problems

Set `omniFs.logLevel` to `debug` and include the **Omni-FS** output channel,
plus which server software you are using — S3-compatible servers disagree with
AWS about error codes. **Never paste credentials or an endpoint URL containing
one.**
