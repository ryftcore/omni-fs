import { beforeAll, describe, expect, it } from 'vitest';
import { NOOP_LOGGER, OmniFsError, RemotePath } from '@omni-fs/core';
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
    // Counted rather than timed. `FtpPool.open` resolves the secret once per
    // control channel it opens, so this is an exact login count — and a login
    // count is the only evidence available here that the three reads were
    // actually in flight together. A pool pinned to one channel would finish
    // all three too, serially, on a single login: asserting only that the bytes
    // came back would pass either way and the name would be a lie.
    let logins = 0;
    const fs = new FtpFileSystem({
      config: {
        id: 'live',
        providerId: 'ftp',
        label: 'live',
        settings: { ...BASE, maxConnections: 3 },
      },
      getSecret: async () => {
        logins += 1;
        return { password: PASSWORD };
      },
      logger: NOOP_LOGGER,
    });

    await fs.connect();
    try {
      expect(fs.capabilities.maxConcurrency).toBe(3);
      // `connect` resolves the base through a lease of its own, which it then
      // returns to the pool.
      expect(logins).toBe(1);

      const reads = await Promise.all([
        fs.readFile(RemotePath.parse('/data/large.bin')),
        fs.readFile(RemotePath.parse('/data/large.bin')),
        fs.readFile(RemotePath.parse('/data/large.bin')),
      ]);

      // Three transfers, three control channels: the first reuses the idle one,
      // and the other two could only have been served by opening more, which
      // the pool does exactly when a channel is already busy.
      expect(logins).toBe(3);

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
