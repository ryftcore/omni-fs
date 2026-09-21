import { beforeAll, describe, expect, it } from 'vitest';
import { EntryCache, ManagedFileSystem, NOOP_LOGGER, OmniFsError, RemotePath } from '@omni-fs/core';
import type { ConnectionConfig, FileType, Logger, LogLevel, RemoteFileSystem } from '@omni-fs/core';
import { runConformanceSuite } from '@omni-fs/testing';
import { FtpControlChannel } from './ftp-channel.js';
import { FtpFileSystem } from './ftp-file-system.js';
import { readSettings } from './settings.js';

const HOST = process.env['OMNI_FS_FTP_HOST'] ?? 'localhost';
const PORT = Number(process.env['OMNI_FS_FTP_PORT'] ?? '2121');
const IMPLICIT_PORT = Number(process.env['OMNI_FS_FTP_IMPLICIT_PORT'] ?? '2990');
const LEGACY_PORT = Number(process.env['OMNI_FS_FTP_LEGACY_PORT'] ?? '2100');
const USERNAME = process.env['OMNI_FS_FTP_USER'] ?? 'omnifs';
const PASSWORD = process.env['OMNI_FS_FTP_PASSWORD'] ?? 'omnifs-dev-secret';
/** The seeded volume. Absolute on purpose: it is also the test of that rule. */
const ROOT_PREFIX = process.env['OMNI_FS_FTP_ROOT'] ?? '/data';

/** The server's certificate is self-signed at build, so every run must say so. */
const BASE = {
  host: HOST,
  port: PORT,
  username: USERNAME,
  secure: 'explicit',
  allowSelfSigned: true,
  rootPrefix: ROOT_PREFIX,
} as const;

function connect(
  settings: Readonly<Record<string, unknown>> = {},
  logger: Logger = NOOP_LOGGER,
): FtpFileSystem {
  const config: ConnectionConfig = {
    id: 'live',
    providerId: 'ftp',
    label: 'live',
    settings: { ...BASE, ...settings },
  };
  return new FtpFileSystem({
    config,
    getSecret: async () => ({ password: PASSWORD }),
    logger,
  });
}

/**
 * A connection that counts its logins.
 *
 * `FtpPool` resolves the secret once per control channel it opens, so
 * `getSecret` is an exact count of the connections this filesystem has made to
 * the server — the only evidence available from outside the package about how
 * many channels the pool really used. Two cases below turn on that number, and
 * neither could assert what its name claims without it: three transfers that
 * came back whole say nothing about whether they overlapped, and an operation
 * that succeeded after a torn-down one says nothing about whether the dead
 * channel was reused or replaced.
 */
function countingConnect(settings: Readonly<Record<string, unknown>>): {
  fs: FtpFileSystem;
  logins: () => number;
} {
  let logins = 0;
  const fs = new FtpFileSystem({
    config: { id: 'live', providerId: 'ftp', label: 'live', settings: { ...BASE, ...settings } },
    getSecret: async () => {
      logins += 1;
      return { password: PASSWORD };
    },
    logger: NOOP_LOGGER,
  });
  return { fs, logins: () => logins };
}

/**
 * A transport-only channel, for setup and cleanup that must not use the
 * methods under test. A cleanup that ran through one could not fail safely,
 * and one failure leaves a `conformance-*` directory behind for every run
 * after it — the reason `provider-sftp` has `withTransport` too.
 */
async function withTransport<T>(body: (channel: FtpControlChannel) => Promise<T>): Promise<T> {
  const channel = await FtpControlChannel.open({
    settings: readSettings({ ...BASE }),
    secret: { password: PASSWORD },
    logger: NOOP_LOGGER,
  });
  try {
    return await body(channel);
  } finally {
    await channel.close();
  }
}

/**
 * The type travels with the recursion rather than being probed for. `LIST` on a
 * *file* answers with that file on several servers, so a type-blind walk would
 * recurse forever on a name that is never going to be a directory — and this
 * runs in cleanup, where a hang is a stuck CI job rather than a failed test.
 */
async function removeTree(
  channel: FtpControlChannel,
  absolute: string,
  type: FileType,
): Promise<void> {
  if (type !== 'directory') {
    await channel.unlink(absolute).catch(() => undefined);
    return;
  }
  const entries = await channel.list(absolute).catch(() => []);
  for (const child of entries) {
    await removeTree(channel, `${absolute}/${child.name}`, child.type);
  }
  await channel.rmdir(absolute).catch(() => undefined);
}

/**
 * Readiness is the suite's job, not a compose flag: `docker compose up -d`
 * returns before vsftpd is listening, and the workflow starts the tests a
 * second later.
 */
beforeAll(async () => {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await withTransport(async (channel) => channel.pwd());
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}, 70_000);

const roots = new WeakMap<RemoteFileSystem, RemotePath>();
let counter = 0;

function runLiveSuite(name: string, settings: Readonly<Record<string, unknown>>): void {
  runConformanceSuite({
    name,
    setup: async () => {
      const fs = connect(settings);
      await fs.connect();
      counter += 1;
      const root = RemotePath.parse(`/conformance-${String(Date.now())}-${String(counter)}`);
      await fs.createDirectory(root);
      roots.set(fs, root);
      return { fs, root };
    },
    teardown: async (fs) => {
      const root = roots.get(fs);
      roots.delete(fs);
      // The dispose is in a `finally` because the cleanup opens a connection of
      // its own: one transient failure there would otherwise skip it and leave
      // this case's authenticated socket alive, sixteen times a run.
      try {
        if (root !== undefined) {
          await withTransport((channel) =>
            removeTree(channel, `${ROOT_PREFIX}${root.value}`, 'directory'),
          );
        }
      } finally {
        await fs[Symbol.asyncDispose]();
      }
    },
  });
}

runLiveSuite('FTP (plain, vsftpd)', { secure: 'none' });
runLiveSuite('FTPS (explicit AUTH TLS, vsftpd)', { secure: 'explicit' });
runLiveSuite('FTPS (implicit TLS, vsftpd)', { secure: 'implicit', port: IMPLICIT_PORT });
runLiveSuite('FTPS (TLS 1.0 legacy, vsftpd)', {
  secure: 'explicit',
  port: LEGACY_PORT,
  tlsMinVersion: 'TLSv1',
});

describe('FTP live behaviour the shared suite cannot express', () => {
  it('lands in the login directory when the root prefix is empty', async () => {
    const fs = connect({ rootPrefix: '' });
    await fs.connect();
    try {
      const entries = await collect(fs.list(RemotePath.ROOT));
      expect(entries.map((entry) => entry.name)).toContain('readme.txt');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('puts a relative root prefix below the login directory', async () => {
    const fs = connect({ rootPrefix: 'docs' });
    await fs.connect();
    try {
      const entries = await collect(fs.list(RemotePath.ROOT));
      expect(entries.map((entry) => entry.name)).toContain('guide.md');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  /**
   * The brief for this task expected the opposite — "carries a modification
   * time, because this server offers MLSD". It does not: vsftpd 3.0.5 has never
   * implemented `MLST`/`MLSD`, and its `FEAT` reply here lists only `EPRT EPSV
   * MDTM PASV PBSZ PROT REST SIZE TVFS UTF8`. Asserting a non-zero `mtime`
   * would therefore have failed, and asserting the `MLST` path ran would have
   * failed too.
   *
   * So this pins what is actually true, which is the more interesting half
   * anyway: on a server with no `MLST`, `stat` falls back to the parent
   * listing, and `basic-ftp` sets `modifiedAt` *only* from the MLSD parser
   * (`parseListMLSD.js` is the sole assignment in the package) precisely
   * because a `LIST` date carries no timezone. The provider passes that
   * `undefined` through rather than guessing a year or a zone, which is the
   * decision `fromFileInfo` documents.
   *
   * The consequence for coverage is stated rather than hidden: **the `MLST`
   * branch of `#stat` and `parseMlstResponse` have no live coverage against
   * this container.** Both are exercised hermetically in `ftp-channel.test.ts`
   * and `ftp-helpers.test.ts`; reaching them live would need a second FTP image.
   */
  it('falls back to a parent listing, and declines to invent an mtime, on a server with no MLST', async () => {
    expect(await withTransport(async (channel) => channel.hasMlst)).toBe(false);

    const fs = connect();
    await fs.connect();
    try {
      const stat = await fs.stat(RemotePath.parse('/readme.txt'));
      expect(stat.type).toBe('file');
      expect(stat.size).toBeGreaterThan(0);
      expect(stat.mtime).toBeUndefined();
      // A `LIST` does carry the mode, so the fallback is not simply lossy.
      expect(stat.mode).toBe(0o644);

      // And the same entry seen through `list`, so the two routes to a
      // `FileStat` agree rather than only the one under test being checked.
      const entries = await collect(fs.list(RemotePath.ROOT));
      const readme = entries.find((entry) => entry.name === 'readme.txt');
      expect(readme?.mtime).toBeUndefined();
      expect(readme?.size).toBe(stat.size);
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('refuses a self-signed certificate when the setting is off, and says which setting', async () => {
    const fs = connect({ allowSelfSigned: false });
    await expect(fs.connect()).rejects.toSatisfy(
      (error: unknown) =>
        OmniFsError.is(error) &&
        error.code === 'ConnectionFailed' &&
        /Allow self-signed certificates/.test(error.message),
    );
  });

  // Lowering the floor must not break a good server: this connection should
  // negotiate the same version it always would have.
  it('still reaches a modern server with the TLS floor lowered', async () => {
    const fs = connect({ tlsMinVersion: 'TLSv1' });
    await expect(fs.connect()).resolves.toBeUndefined();
    await fs[Symbol.asyncDispose]();
  });

  it('traces the control channel without ever writing the password', async () => {
    // The protocol log is the one place a credential could leak into a file
    // the user attaches to a bug report. `basic-ftp` masks `PASS`; this holds
    // it to that against a real login, and proves the trace is wired at all.
    const lines: string[] = [];
    const logger: Logger = {
      log: (_level, message, data) => {
        lines.push(`${message} ${JSON.stringify(data ?? {})}`);
      },
      child: () => logger,
    };
    const fs = connect({ port: LEGACY_PORT, tlsMinVersion: 'TLSv1' }, logger);
    await fs.connect();
    for await (const _entry of fs.list(RemotePath.ROOT)) void _entry;
    await fs[Symbol.asyncDispose]();

    expect(lines.some((line) => line.startsWith('> PASS'))).toBe(true);
    expect(lines.some((line) => line.startsWith('> LIST') || line.startsWith('> MLSD'))).toBe(true);
    expect(lines.find((line) => line.includes(PASSWORD))).toBeUndefined();
    expect(lines.find((line) => line.startsWith('FTP connected'))).toMatch(/"tls":"TLSv1"/);
  });

  // The other direction, which is the one that proves the setting is wired to
  // the socket at all. A knob only ever tested where it succeeds has not been
  // tested.
  it('is refused by the legacy server when the TLS floor is raised above it', async () => {
    const fs = connect({ port: LEGACY_PORT, tlsMinVersion: 'TLSv1.3' });
    await expect(fs.connect()).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && /Minimum TLS version/.test(error.message),
    );
  });

  it('overlaps transfers when the pool is allowed more than one channel', async () => {
    const { fs, logins } = countingConnect({ maxConnections: 3 });

    await fs.connect();
    try {
      expect(fs.capabilities.maxConcurrency).toBe(3);
      // `connect` resolves the base through a lease of its own, which it then
      // returns to the pool.
      expect(logins()).toBe(1);

      const reads = await Promise.all([
        fs.readFile(RemotePath.parse('/data/large.bin')),
        fs.readFile(RemotePath.parse('/data/large.bin')),
        fs.readFile(RemotePath.parse('/data/large.bin')),
      ]);

      // Three transfers, three control channels: the first reuses the idle one,
      // and the other two could only have been served by opening more, which
      // the pool does exactly when a channel is already busy.
      expect(logins()).toBe(3);

      // And each came back whole, which is what breaks if the pool ever hands
      // the same control channel to two of them. `large.bin` is the 1 MiB file
      // `file-seed` writes.
      expect(reads.map((bytes) => bytes.byteLength)).toEqual([1048576, 1048576, 1048576]);

      // And that the ceiling never fell, i.e. the server really did allow three.
      expect(fs.capabilities.maxConcurrency).toBe(3);
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  /**
   * The shared suite's `reads a byte range` case reaches this code live four
   * times over, but it never asks the connection for anything afterwards — so
   * on its own it proves the bytes were right, not that the connection
   * survived. That gap is the whole of spec decision 6: `RETR` has no
   * end-of-range, so a bounded read stops by tearing the control channel down
   * mid-command, and the channel must then be discarded rather than handed to
   * the next caller, who would read the abandoned reply as their own.
   *
   * Both halves are pinned hermetically (`ftp-file-system.test.ts` >
   * "replaces the channel a bounded read poisoned", `ftp-pool.test.ts` >
   * "discards a poisoned channel on release rather than handing it on"), but
   * against a fake whose `downloadTo` settles on demand. Whether a *real*
   * vsftpd transfer settles once its data socket is destroyed, and whether the
   * pool really recovers from that, is only answerable here.
   *
   * The pool defends this twice — `release` discards a channel that is no
   * longer alive, and `acquire` re-checks any channel it pops from the idle
   * list — so this case is named for the behaviour rather than for either
   * guard. Removing one guard alone leaves it passing; removing both makes it
   * fail with `Client is closed because User closed client during task`, which
   * is the symptom a user would have seen.
   */
  it('discards the channel a bounded read tore down, and logs in again for the next call', async () => {
    // Pool of one, so a channel that was wrongly kept would be the *only*
    // channel and the next call would hang or read the wrong reply.
    const { fs, logins } = countingConnect({ maxConnections: 1 });
    await fs.connect();
    try {
      expect(logins()).toBe(1);

      // The control, without which the count below would prove nothing: an
      // *unbounded* read of the same file runs to completion, so its channel
      // goes back to the pool healthy and no second login happens. This is the
      // case that fails if transfers simply cost a login each.
      const whole = await fs.readFile(RemotePath.parse('/data/sample.json'));
      expect(new TextDecoder().decode(whole)).toContain('"ok"');
      expect(logins()).toBe(1);

      // `{"ok":true}` — bytes 2..4 are `ok"`.
      const slice = await fs.readFile(RemotePath.parse('/data/sample.json'), {
        offset: 2,
        length: 3,
      });
      expect(new TextDecoder().decode(slice)).toBe('ok"');

      const names = (await collect(fs.list(RemotePath.ROOT))).map((entry) => entry.name);
      expect(names).toContain('readme.txt');

      // The listing above could only have been served by a second login, which
      // is what says the poisoned channel was discarded rather than reused.
      expect(logins()).toBe(2);
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  /**
   * Nothing else in this repo runs `FtpFileSystem` inside `ManagedFileSystem`,
   * which is the composition both hosts actually use — and that gap is exactly
   * where the copy deadlock lived. The emulated copy (FTP has no server-side
   * copy) used to open a read stream and then, with it still open, ask for a
   * write stream. A read stream holds its pool channel for its whole life, so
   * at the default `maxConnections: 1` the second acquire queued behind a
   * stream that could only drain once the acquire was granted. No timeout, and
   * VS Code's copy passes no signal, so the connection stayed wedged until
   * dispose.
   *
   * The `stat` afterwards is the half that proves the fix rather than merely
   * exercising it: a copy that returned the right bytes says nothing about
   * whether the channel went back to the pool usable. Before the fix this call
   * never returned either.
   *
   * The explicit timeout is so a regression fails in thirty seconds instead of
   * hanging CI until the job's own limit.
   */
  it('copies through ManagedFileSystem on a one-channel pool and leaves the connection usable', async () => {
    const inner = connect({ maxConnections: 1 });
    await inner.connect();
    // The premise. If this were ever not 1 the case below would prove nothing.
    expect(inner.capabilities.maxConcurrency).toBe(1);

    const managed = new ManagedFileSystem({
      connectionId: 'live',
      inner,
      cache: new EntryCache(),
      logger: NOOP_LOGGER,
    });

    const dir = RemotePath.parse(`/copy-${String(Date.now())}`);
    try {
      await managed.createDirectory(dir);
      await managed.writeFile(dir.join('from.txt'), new TextEncoder().encode('copied'));

      await managed.copy(dir.join('from.txt'), dir.join('to.txt'));
      expect(new TextDecoder().decode(await managed.readFile(dir.join('to.txt')))).toBe('copied');

      // A real round trip: `copy` invalidates its destination, so this cannot
      // be served from the cache. It is the connection, not the copy, under
      // test here.
      expect((await managed.stat(dir.join('to.txt'))).size).toBe(6);
    } finally {
      await withTransport((channel) =>
        removeTree(channel, `${ROOT_PREFIX}${dir.value}`, 'directory'),
      );
      await managed[Symbol.asyncDispose]();
    }
  }, 30_000);

  // Named for what it asserts. The brief called this "warns that a replacing
  // rename was not atomic", which is the opposite of the assertion below: on
  // vsftpd the atomic path is the one that runs, so the *absence* of the
  // warning is the result. The warning itself is pinned hermetically, in
  // `ftp-file-system.test.ts`, against a server that refuses `RNTO`.
  it('replaces an existing destination in one step, without the non-atomic warning', async () => {
    const entries: { level: LogLevel; message: string }[] = [];
    const logger: Logger = {
      log: (level, message) => {
        entries.push({ level, message });
      },
      child: () => logger,
    };

    const fs = connect({}, logger);
    await fs.connect();
    const dir = RemotePath.parse(`/rename-${String(Date.now())}`);
    try {
      await fs.createDirectory(dir);
      await fs.writeFile(dir.join('from.txt'), new TextEncoder().encode('a'));
      await fs.writeFile(dir.join('to.txt'), new TextEncoder().encode('b'));
      await fs.rename(dir.join('from.txt'), dir.join('to.txt'));

      // The replace happened, whichever route it took.
      expect(new TextDecoder().decode(await fs.readFile(dir.join('to.txt')))).toBe('a');

      // And on *this* server it took the atomic one: vsftpd's RNTO replaces an
      // existing destination, so the delete-then-retry fallback must not have
      // run. The warning itself is pinned by the hermetic test in
      // ftp-file-system.test.ts, against a server that refuses. If this ever
      // starts warning, vsftpd changed behaviour and the two-step path is now
      // live here — which is worth knowing, and is what makes this assertion
      // strict rather than decorative.
      expect(entries.some((entry) => entry.level === 'warn' && /atomic/i.test(entry.message))).toBe(
        false,
      );
    } finally {
      await withTransport((channel) =>
        removeTree(channel, `${ROOT_PREFIX}${dir.value}`, 'directory'),
      );
      await fs[Symbol.asyncDispose]();
    }
  });
});

/**
 * Declared last on purpose. Every suite above creates and removes a directory
 * of its own, and this is the only thing that checks the removals actually
 * happened — a teardown that silently stopped working would otherwise leave a
 * `conformance-*` directory per case, growing the seeded root every run until
 * something unrelated failed. The ordering rests on vitest running suites in
 * declaration order, which is its default: turn on `sequence.shuffle`, mark a
 * suite `.concurrent`, or add a second `*.live.test.ts` to this package — the
 * conformance config runs files in parallel workers — and this stops holding
 * silently. The same arrangement, and the same warning, as `provider-sftp`'s.
 */
describe('FTP cleanliness', () => {
  it('leaves the seeded root exactly as it found it', async () => {
    const fs = connect();
    await fs.connect();
    try {
      const names = (await collect(fs.list(RemotePath.ROOT))).map((entry) => entry.name);
      expect(names.filter((name) => name.startsWith('conformance-'))).toEqual([]);
      expect(names.filter((name) => name.startsWith('rename-'))).toEqual([]);
      expect(names.filter((name) => name.startsWith('copy-'))).toEqual([]);
      expect(names.sort()).toEqual(['data', 'docs', 'readme.txt']);
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
