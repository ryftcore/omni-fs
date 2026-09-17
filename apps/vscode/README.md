# Omni-FS

**One file system client for S3, FTP, FTPS, SFTP and WebDAV — inside VS Code.**

Open a remote file, edit it, press <kbd>Ctrl</kbd>+<kbd>S</kbd>. That's it. No
download, no re-upload, no separate window.

> **Early development.** The S3 provider is implemented and usable. FTP, SFTP
> and WebDAV are scaffolded but not yet functional — see
> [Status](#status) before installing.

## What it does

- **Remote files are real files.** Omni-FS registers an `omnifs://` file system,
  so remote files open in normal editors, save normally, and work with search,
  quick-open and diff. Add a bucket to your workspace and it behaves like a
  folder.
- **A connections sidebar** for status, connect/disconnect, credentials, and
  browsing a server you haven't mounted.
- **A transfers view** with progress, automatic retry on transient failures, and
  cancellation.
- **Protocol-aware behaviour.** Each backend declares what it can genuinely do,
  and Omni-FS adapts instead of failing after you click. S3 has no real
  directories, so a new folder appears once it holds a file. FTP allows one
  operation at a time, so bulk work serialises there while S3 runs sixteen
  transfers in parallel. You don't have to think about any of it.

## Status

| Protocol               | Status                | Notes                                                                 |
| ---------------------- | --------------------- | --------------------------------------------------------------------- |
| **S3 / S3-compatible** | ✅ Implemented        | AWS S3, MinIO, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, Ceph |
| **FTP / FTPS**         | 🚧 Not yet functional | Explicit and implicit TLS planned                                     |
| **SFTP (SSH)**         | 🚧 Not yet functional | Password, private key, SSH agent planned                              |
| **WebDAV**             | 🚧 Not yet functional | Nextcloud, ownCloud planned                                           |

Download and upload commands are also not wired up yet. Everything else listed
above works against S3.

## Getting started

1. Open the **Omni-FS** view in the Activity Bar.
2. Click **Add Connection** and pick a protocol.
3. Fill in the settings, then the credentials.
4. Click **Connect**.

To work in a remote folder as if it were local, right-click the connection and
choose **Open as Workspace Folder**.

### Connecting to S3-compatible storage

Leave **Endpoint** empty for AWS. For anything else, set it and turn on
**Force path-style addressing**, which most self-hosted servers require:

| Service             | Endpoint                                     | Path-style |
| ------------------- | -------------------------------------------- | ---------- |
| AWS S3              | _(leave empty)_                              | off        |
| MinIO               | `https://minio.example.com`                  | on         |
| Cloudflare R2       | `https://<account>.r2.cloudflarestorage.com` | on         |
| Backblaze B2        | `https://s3.<region>.backblazeb2.com`        | on         |
| DigitalOcean Spaces | `https://<region>.digitaloceanspaces.com`    | on         |

**Root prefix** scopes a connection to a subfolder of the bucket, which is handy
for keeping a production connection pointed at exactly one deploy directory.

## Your credentials

Credentials go to your operating system's keychain — Keychain on macOS, DPAPI on
Windows, libsecret on Linux — through VS Code's secret storage. They are never
written to a settings file.

Connection _settings_ (endpoint, bucket, host, username) live in the
`omniFs.connections` setting, which contains no secrets and is safe to commit to
`.vscode/settings.json` and share with your team. Each person supplies their own
credentials on first connect.

## Settings

| Setting                                | Default | What it does                                                |
| -------------------------------------- | ------- | ----------------------------------------------------------- |
| `omniFs.connections`                   | `[]`    | Connection definitions. No credentials.                     |
| `omniFs.cache.ttlSeconds`              | `15`    | How long directory listings stay cached                     |
| `omniFs.connection.idleTimeoutSeconds` | `300`   | Close an idle connection after this long; `0` keeps it open |
| `omniFs.transfers.maxConcurrent`       | `4`     | Simultaneous transfers across all connections               |
| `omniFs.logLevel`                      | `info`  | Verbosity of the **Omni-FS** output channel                 |

## Troubleshooting

Set `omniFs.logLevel` to `debug` and open the **Omni-FS** output channel.

S3-compatible servers disagree with AWS about error codes, so when reporting a
problem please say which server you're using. Never paste credentials or an
endpoint URL containing one.

## Contributing

Omni-FS is open source and built so that adding a protocol touches no existing
code. The repository, architecture notes and contribution guide are at
[github.com/ryftcore/omni-fs](https://github.com/ryftcore/omni-fs).

## License

[MIT](https://github.com/ryftcore/omni-fs/blob/main/LICENSE) © ryftcore
