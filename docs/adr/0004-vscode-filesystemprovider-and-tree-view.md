# ADR-0004: Register a FileSystemProvider _and_ ship a tree view

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

A VS Code extension can surface remote files two ways. It can register a
`FileSystemProvider` under a custom scheme, so files open in normal editors and
can be added to the workspace. Or it can render its own tree with explicit
download/edit/upload actions, which is what most existing FTP and SFTP
extensions do.

## Decision

Both. `omnifs://` is registered as a `FileSystemProvider`, and a dedicated
sidebar shows connections and transfers.

## Consequences

**Good.** Remote files are first-class: normal editors, <kbd>Ctrl</kbd>+<kbd>S</kbd>
to upload, search, quick-open, and remote roots as workspace folders — all for
free from one interface. The sidebar covers what the Explorer cannot express:
connection status, connect/disconnect, credentials, and browsing an unmounted
server. Both read through the same `ConnectionManager` and `EntryCache`, so
expanding a folder in one warms the cache for the other.

**Bad.** Two surfaces to keep consistent, and `FileSystemProvider` obliges us to
implement operations VS Code may call at any time, including on protocols where
they are awkward.

**Mitigation.** `OmniFileSystemProvider` is a pure translator with no logic of
its own — URI to `RemotePath`, `OmniFsError` to `FileSystemError`. Shared state
lives in core, so consistency is structural rather than maintained by hand.

`watch()` is intentionally a no-op: none of the four protocols offers change
notifications, and quietly polling a metered S3 bucket in the background is a
cost the user did not agree to. Refresh is explicit.
