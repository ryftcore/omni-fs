<div align="center">

# omni-fs

**One file system client for S3, FTP, FTPS, SFTP and WebDAV.**

Browse, edit and transfer remote files without leaving your editor.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

---

> **Status: beta (`v0.1.0-beta.1`).** The architecture, core and S3 provider
> are in place. FTP, SFTP and WebDAV are scaffolded but not yet implemented —
> see [Roadmap](#roadmap) and the
> [extension changelog](apps/vscode/CHANGELOG.md).

## What it is

A universal client for remote storage, shipping as two applications over one
shared core:

- **VS Code extension** — remote files as first-class citizens. Open them in
  normal editors, save with <kbd>Ctrl</kbd>+<kbd>S</kbd>, add a bucket to your
  workspace, search it like a local folder.
- **Desktop app** — planned. It will reuse the entire protocol layer.

## Why another one

Most remote-filesystem extensions implement one protocol, then bolt on a second
one that behaves subtly differently. omni-fs takes the differences seriously
instead of hiding them: every provider **declares what it can actually do**, and
a shared layer fills the gaps consistently.

S3 has no directories, so "New Folder" does nothing until you put a file in it.
FTP allows one operation at a time, so bulk uploads serialise while the same
upload to S3 fans out sixteen ways. You do not have to know any of that — but
the software does, and it behaves correctly because of it.

## Supported storage

| Protocol               | Status         | Notes                                                                 |
| ---------------------- | -------------- | --------------------------------------------------------------------- |
| **S3 / S3-compatible** | ✅ Implemented | AWS S3, MinIO, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, Ceph |
| **FTP / FTPS**         | 🚧 Scaffolded  | Explicit and implicit TLS                                             |
| **SFTP (SSH)**         | 🚧 Scaffolded  | Password, private key, SSH agent                                      |
| **WebDAV**             | 🚧 Scaffolded  | Nextcloud, ownCloud                                                   |

## Quick start

```bash
git clone https://github.com/ryftcore/omni-fs.git
cd omni-fs
pnpm install
pnpm build
```

Then open the repo in VS Code and press <kbd>F5</kbd> to launch the extension in
a development host.

To build an installable package instead:

```bash
pnpm package:vsix   # -> apps/vscode/omni-fs-vscode-<version>.vsix
```

Requires Node 22+ and pnpm 12+ (the `allowBuilds` key in `pnpm-workspace.yaml` needs pnpm 12).

## Layout

```
packages/
  core/            Host-agnostic contracts and orchestration. No vscode,
                   no electron, no protocol SDKs.
  provider-s3/     One package per protocol. Each implements RemoteFileSystem
  provider-ftp/    and nothing else.
  provider-sftp/
  provider-webdav/
  testing/         Shared conformance suite + in-memory fake provider.

apps/
  vscode/          The VS Code extension: UI and port adapters only.
  desktop/         Planned. Will reuse all of packages/.
```

**The rule that makes this work:** nothing in `packages/` may import `vscode` or
`electron`, and `packages/core` may not import a protocol SDK. This is enforced
by ESLint, so it fails a build rather than depending on a reviewer noticing.

Read [`docs/architecture.md`](docs/architecture.md) for how the pieces fit, and
[`docs/adr/`](docs/adr) for why.

## Credentials

Connection settings — endpoint, bucket, host, username — live in the
`omniFs.connections` setting, so they are safe to commit and share with a team.

Credentials never go there. They go to the OS keychain through VS Code's secret
storage. `ConnectionConfig` and `ConnectionSecret` are separate types precisely
so that mixing them up is a compile error.

## Roadmap

- [x] Core contracts, capabilities, error taxonomy
- [x] Connection lifecycle, transfer queue, caching, capability emulation
- [x] Shared provider conformance suite
- [x] S3 / S3-compatible provider
- [x] VS Code `FileSystemProvider`, connections tree, transfers view
- [ ] FTP / FTPS provider
- [ ] SFTP provider
- [ ] WebDAV provider
- [ ] Download / upload wired to the local filesystem
- [ ] Conformance suite running against containers in CI
- [ ] Desktop app (Electron)

## Contributing

Contributions are welcome — the provider interface is designed so that adding a
protocol touches no existing code. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © ryftcore
