# Local test servers

```bash
docker compose up -d --build --wait minio sftp ftp webdav   # start
docker compose ps                                           # check
docker compose down -v                                      # stop, delete all test data
```

`--build` is worth typing: two of the four servers are built from
`docker/sftp/` and `docker/ftp/` rather than pulled, so a change to either
Dockerfile is otherwise ignored.

`--wait` is worth more. Plain `up -d` returns once the containers have been
_created_, which on a cold machine is well before any of them is listening —
and only the FTP conformance suite retries its first call, so the other three
would race it. Every service has a healthcheck that completes a real exchange
in its own protocol (an FTP `220` on all three listeners, sshd's identification
string, a WebDAV `PROPFIND` answered `207`), and the two seed jobs run ahead of
the servers, so `--wait` returns once the stack is answering _and_ seeded.

The four services are named because `--wait` given no names also waits on
`minio-init` and `file-seed`, and treats their clean exit as a failure —
`container … exited (0)`, exit code 1. Naming the long-running four still
pulls both seed jobs in and still waits for them.

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

## Conformance suite

With the stack up, the shared behavioural contract runs against the live
servers:

```bash
docker compose up -d --build --wait minio sftp ftp webdav
pnpm test:conformance
```

All four provider packages define the script, so all four run — and
`packages/provider-ftp` runs the whole contract four times over, once per
listener below. A provider is finished exactly when this passes for it.

CI runs both of these, in that order, in the `conformance (live)` job, on
Linux only.

Every case makes its own `/conformance-<timestamp>-<n>` directory and removes
it again, so the seeded tree above is what a `PROPFIND` should show both before
and after a run. Anything called `conformance-*` left behind is a bug in the
harness, not in the server.

## VS Code extension, against the live servers

The extension's own test suite has a second label that drives the **minified
production bundle** at these servers through `vscode.workspace.fs` — the only
thing that proves esbuild did not break a protocol SDK while flattening four of
them into one file:

```bash
pnpm package:vsix        # leaves out/ holding the minified build
docker compose up -d
pnpm test:extension:live
```

`pnpm package:vsix` first is not optional: a plain `pnpm build` leaves an
unminified bundle in `out/`, and the label would then test something that is
not what ships. On a headless Linux box, prefix the last command with
`xvfb-run -a`.

It creates one `/omnifs-ext-live-<timestamp>-<pid>` directory per server and
removes it again, so the seeded tree above is what you should see both before
and after. It never skips: with nothing running it retries for up to 60 seconds
and then fails, naming the server.

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

## FTP / FTPS — vsftpd

One container, three listeners, all serving the same `/data` volume as the same
user. Which one you point at decides which encryption mode you are testing:

| Port   | Encryption setting                              | What it is for                                            |
| ------ | ----------------------------------------------- | --------------------------------------------------------- |
| `2121` | **Plain FTP** _or_ **explicit TLS (AUTH TLS)**  | Both, on one listener: TLS is offered, not forced         |
| `2990` | **Implicit TLS**                                | TLS on connect, no `AUTH` negotiation                     |
| `2100` | **Explicit TLS** with minimum TLS version `1.0` | A 2012-era server — the target `tlsMinVersion` exists for |

| Field                          | Value                                               |
| ------------------------------ | --------------------------------------------------- |
| Host                           | `localhost`                                         |
| Port                           | `2121`, `2990` or `2100` — see above                |
| Username                       | `omnifs`                                            |
| Password                       | `omnifs-dev-secret`                                 |
| Allow self-signed certificates | **checked** — the certificate is generated at build |
| Root prefix                    | `/data`                                             |

The certificate is a self-signed `CN=localhost` made in the Dockerfile, so a
connection that leaves **Allow self-signed certificates** unticked is refused,
and the error names that setting. That is the correct result and worth seeing
once.

Files live under `/data`, which is also the login directory, so the root prefix
can be written either way: `/data` as an absolute server path, or left empty to
land in the login directory. The container is deliberately not chrooted, so the
server's filesystem root stays reachable and an absolute prefix names something
real. `docs` is a relative prefix that scopes the connection one level down.

`2100` accepts **only** TLS 1.0: raise the minimum TLS version against it and
the handshake is refused, which is what proves the setting reaches the socket.
Lowering the floor below TLS 1.2 also relaxes the cipher policy, because
OpenSSL 3 otherwise refuses the key sizes such a server offers.

Passive data ports 21000-21032 are published — eleven per listener — and without
them listings hang.

Known gap, stated rather than hidden: `require_ssl_reuse` is **off** on all
three listeners, so **nothing here covers a server that demands TLS session
reuse on the data connection**. See `docker/ftp/vsftpd-common.conf`. vsftpd
3.0.5 also implements no `MLST`/`MLSD`, so `stat` here always answers from a
parent `LIST` — and consequently reports no modification time, which is the
provider declining to guess a timezone rather than a defect.

## SFTP

| Field          | Value               |
| -------------- | ------------------- |
| Host           | `localhost`         |
| Port           | `2222`              |
| Username       | `omnifs`            |
| Authentication | Password            |
| Password       | `omnifs-dev-secret` |
| Root prefix    | `/data`             |

Files live under `/data`, so the root prefix is absolute — the form this
provider and FTP share, and that S3 and WebDAV have no use for. Leave it empty
and the connection starts in the account's home directory instead, which is
empty on this image.

Host keys: the provider reads `~/.ssh/known_hosts` and refuses a host listed
there with a different key of the same type. `localhost:2222` is normally
absent, so the first connection is accepted and its fingerprint logged. If you
have an old entry for that port from another project, delete it or point
`known_hosts file` at somewhere else.

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

| Port        | Service                               |
| ----------- | ------------------------------------- |
| 9000 / 9001 | MinIO API / console                   |
| 2121        | FTP control — plain and explicit TLS  |
| 2990        | FTP control — implicit TLS            |
| 2100        | FTP control — TLS 1.0 only            |
| 21000-21032 | FTP passive data, for all three above |
| 2222        | SFTP                                  |
| 8081        | WebDAV                                |
