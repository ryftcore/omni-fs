# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it through GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/ryftcore/omni-fs/security/advisories/new).

If that is unavailable, open an issue saying only that you have a security
report and asking for a contact address — no details.

You can expect an acknowledgement within a few days. omni-fs is maintained by
volunteers, so please allow reasonable time for a fix before public disclosure.

When reporting, the most useful things to include are the affected protocol and
server software, what an attacker can do, and the smallest reproduction you
have. **Never include real credentials, endpoints or bucket names** — redact
them.

## Supported versions

omni-fs is pre-1.0. Only the latest release receives fixes.

## What we consider a vulnerability

omni-fs holds credentials for other people's storage and moves their files, so
the things that matter most are:

- **Credential exposure** — a credential reaching a log, a settings file, an
  error message, a crash report, the extension bundle, or any store other than
  the OS keychain.
- **Path traversal** — a remote path escaping its connection root, or a remote
  filename escaping the intended directory when written to local disk.
- **Transport weaknesses** — TLS verification skipped when not explicitly
  requested, credentials sent over an unencrypted channel without the user
  choosing that, or an SSH host key accepted without verification.
- **Confused deputy** — a crafted remote path, listing entry or server response
  causing an operation against an unintended target.
- **Supply chain** — a malicious or compromised dependency, or a build that
  produces an artifact not matching this source.

## Design decisions that are intentional

These are deliberate, so please do not report them as vulnerabilities on their
own. If you can demonstrate a concrete attack that turns one into a real
compromise, that is very much worth reporting.

- **Plain FTP and self-signed TLS are selectable.** Both are opt-in per
  connection and clearly labelled. Many users have to reach legacy servers, and
  removing the option pushes them to worse tools rather than better security.
- **Connection settings are stored in plain text.** `omniFs.connections` holds
  endpoints, hostnames and usernames so the list can be committed and shared
  with a team. Credentials are never stored there — they go to the OS keychain.
- **`raw` fields carry protocol-specific data.** These are for display only and
  are never used for control flow in core.

## How omni-fs handles credentials

- Credentials go only to the `SecretStore` port. In VS Code that is
  `ExtensionContext.secrets` — Keychain on macOS, DPAPI on Windows, libsecret
  on Linux.
- `ConnectionConfig` and `ConnectionSecret` are separate types. Writing a
  secret into a config object is a compile error rather than a leak.
- Secrets are resolved lazily at connect time and held in memory only for the
  duration of that connection.
- Nothing in `packages/` may import a host API, so there is exactly one place
  per application where credentials touch storage.

## Automated checks

Every push and pull request runs dependency auditing, secret scanning across
full git history, and the architecture boundary checks. CodeQL, dependency
review and OpenSSF Scorecard are configured and activate automatically when
this repository becomes public — several of them require a public repo or
GitHub Advanced Security.

All GitHub Actions are pinned to commit SHAs, and workflow tokens are
least-privilege (`contents: read` by default).
