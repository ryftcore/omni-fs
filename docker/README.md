# Local test servers

```bash
docker compose up -d      # start (first run builds the SFTP image)
docker compose ps         # check
docker compose down -v    # stop and delete all test data
```

Every server binds to `127.0.0.1` only. The credentials below are committed
deliberately and must never be used anywhere real.

All four are seeded with the same tree, so one manual test script works against
each of them:

```
readme.txt
data/sample.json
data/large.bin          1 MiB (3 MiB on S3) — for ranged reads
docs/guide.md
docs/nested/deep/deep.txt
```

## What you can actually test today

`provider-s3`, `provider-webdav` and `provider-sftp` are implemented. FTP still
throws `Unsupported` from `connect()`, so **Test Connection will fail for it**
with "… is not implemented yet". That is the correct result, and it is still
worth running: it exercises the probe path, the error mapping and the form's
error display. Browsing files works on S3, WebDAV and SFTP.

The FTP server is here so that provider can be written against something real.

## Conformance suite

With the stack up, the shared behavioural contract runs against the live
servers:

```bash
docker compose up -d
pnpm test:conformance
```

`packages/provider-webdav` and `packages/provider-sftp` define the script today,
so WebDAV and SFTP are what runs. A provider is finished exactly when this
passes for it.

Every case makes its own `/conformance-<timestamp>-<n>` directory and removes
it again, so the seeded tree above is what a `PROPFIND` should show both before
and after a run. Anything called `conformance-*` left behind is a bug in the
harness, not in the server.

## S3 — MinIO

Console at <http://localhost:9001> (`omnifs` / `omnifs-dev-secret`).

| Field                       | Value                                                    |
| --------------------------- | -------------------------------------------------------- |
| Bucket                      | `omni-fs-test` (`omni-fs-empty` tests the empty listing) |
| Region                      | `us-east-1`                                              |
| Endpoint                    | `http://localhost:9000`                                  |
| Force path-style addressing | **checked** — MinIO requires it                          |
| Root prefix                 | empty, or `docs` to scope the connection                 |
| Storage class               | Default                                                  |
| Access key ID               | `omnifs`                                                 |
| Secret access key           | `omnifs-dev-secret`                                      |
| Session token               | leave empty                                              |

## FTP

| Field      | Value                                                      |
| ---------- | ---------------------------------------------------------- |
| Host       | `localhost`                                                |
| Port       | `2121`                                                     |
| Username   | `omnifs`                                                   |
| Encryption | **Plain FTP — unencrypted** — this container serves no TLS |
| Password   | `omnifs-dev-secret`                                        |

Passive data ports 21000-21010 are published; without them listings hang.

## SFTP

| Field          | Value               |
| -------------- | ------------------- |
| Host           | `localhost`         |
| Port           | `2222`              |
| Username       | `omnifs`            |
| Authentication | Password            |
| Password       | `omnifs-dev-secret` |
| Root prefix    | `/data`             |

Files live under `/data`, so the root prefix is absolute — the one provider where
that form is the common one. Leave it empty and the connection starts in the
account's home directory instead, which is empty on this image.

Host keys: the provider reads `~/.ssh/known_hosts` and refuses a host listed
there with a different key. `localhost:2222` is normally absent, so the first
connection is accepted and its fingerprint logged. If you have an old entry for
that port from another project, delete it or point `known_hosts file` at
somewhere else.

Built from `docker/sftp/Dockerfile` rather than pulled: the common SFTP images
are amd64-only, so they emulate on Apple Silicon.

## WebDAV

| Field          | Value                   |
| -------------- | ----------------------- |
| Server URL     | `http://localhost:8081` |
| Authentication | Username and password   |
| Username       | `omnifs`                |
| Password       | `omnifs-dev-secret`     |

## Ports

| Port              | Service                    |
| ----------------- | -------------------------- |
| 9000 / 9001       | MinIO API / console        |
| 2121, 21000-21010 | FTP control / passive data |
| 2222              | SFTP                       |
| 8081              | WebDAV                     |
