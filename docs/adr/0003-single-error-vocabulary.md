# ADR-0003: One error vocabulary, translated at the provider boundary

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

Each protocol reports failure differently. A missing file is `NoSuchKey` on S3,
`550` on FTP, `ENOENT` over SFTP and `404` on WebDAV. Meanwhile VS Code needs
`FileSystemError.FileNotFound` specifically, because it drives a different
behaviour — a create-on-save flow — than a generic failure does.

Without a shared vocabulary, every consumer would need to know all four
protocols' error dialects, and adding a fifth would mean editing all of them.

## Decision

`OmniFsError` with a closed `OmniFsErrorCode` union. Each provider translates
its native failures exactly once, in its own `errors.ts`. Each host translates
`OmniFsError` outward exactly once.

## Consequences

**Good.** Adding a protocol cannot break a consumer. Retry policy becomes a
single `retryable` flag the transfer queue reads, rather than per-protocol
knowledge scattered through the queue. Getting the VS Code mapping right is what
makes a remote file feel native rather than broken, and it is one function.

**Bad.** Some protocol nuance is lost in translation, and a mistranslation in a
provider is invisible from above.

**Mitigation.** The original error is kept in `cause` for logs. `raw` on
`FileStat` carries protocol-specific extras for display. The conformance suite
asserts the mapping directly — that a missing path raises `NotFound` and never a
bare `Error` — so a mistranslation fails a test rather than reaching a user.
