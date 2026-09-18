# Changelog

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
