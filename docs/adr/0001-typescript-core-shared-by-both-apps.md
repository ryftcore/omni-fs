# ADR-0001: A TypeScript core shared by both applications

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

omni-fs ships two applications: a VS Code extension first, a desktop app later.
Both need the same protocol handling, connection lifecycle, transfer queue and
caching. The desktop app has not started, so the choice made now decides whether
it begins by reusing working code or by reimplementing it.

The realistic options were a TypeScript core with an Electron desktop app, or a
Rust core with a Tauri desktop app exposed to the extension over a sidecar
binary or NAPI addon.

## Decision

A TypeScript core in `packages/core`, consumed directly by both hosts. The
desktop app will be Electron.

## Consequences

**Good.** The extension imports the core as a normal dependency — no IPC layer,
no serialisation boundary, no platform-specific binaries to build and ship for
three operating systems. One language across the repo lowers the barrier for
outside contributors, which matters for an open-source project. The protocol
SDKs we want (`@aws-sdk/client-s3`, `basic-ftp`, `ssh2-sftp-client`, `webdav`)
are mature in the Node ecosystem.

**Bad.** The desktop binary will be large (~150 MB) where Tauri would be ~10 MB.
Very large transfers will be slower than a Rust implementation.

**Mitigation.** The `RemoteFileSystem` contract is deliberately RPC-shaped:
serialisable arguments, `AbortSignal` for cancellation, streams for payloads, no
callbacks across the boundary. If performance later justifies a Rust core, it
can be introduced behind this same interface without touching either host.
