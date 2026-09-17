# ADR-0002: Providers declare capabilities instead of failing on unsupported calls

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

The four MVP protocols differ substantially. S3 has no directories, no rename
and no append. FTP has no server-side copy and tolerates only one operation at a
time per control channel. WebDAV has no partial write. SFTP is close to POSIX.

A single `RemoteFileSystem` interface has to span all of them. The question is
what happens when a caller asks for something a protocol cannot do.

Two options: let the call fail and have callers interpret the error, or have
each provider declare what it supports before anyone calls it.

## Decision

Every provider exposes a `ProviderCapabilities` object. Callers check it;
`ManagedFileSystem` emulates what it can; the UI adapts in advance.

## Consequences

**Good.** The UI greys out an action instead of showing an error after the user
clicks. The transfer queue reads `maxConcurrency` and serialises FTP work while
fanning S3 out sixteen ways, without knowing what either protocol is. Emulation
is written once in `ManagedFileSystem` rather than being rediscovered per host.
Capabilities double as executable documentation of how the protocols differ, and
the conformance suite uses them to skip tests honestly.

**Bad.** `ProviderCapabilities` grows as protocols are added, and every provider
technically has to answer every question.

**Mitigation.** `MINIMAL_CAPABILITIES` provides a spread-and-override default,
so a new capability defaults to "no" for existing providers rather than breaking
them. A provider that lies about a capability is caught by the conformance
suite, which is the real enforcement.
