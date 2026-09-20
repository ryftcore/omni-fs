import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOOP_LOGGER, OmniFsError, RemotePath } from '@omni-fs/core';
import type { ConnectionConfig, Logger, LogLevel, RemoteFileSystem } from '@omni-fs/core';
import { runConformanceSuite } from '@omni-fs/testing';
import { SftpFileSystem } from './sftp-file-system.js';
import { SftpSession } from './sftp-session.js';
import { readSettings } from './settings.js';

const HOST = process.env['OMNI_FS_SFTP_HOST'] ?? 'localhost';
const PORT = Number(process.env['OMNI_FS_SFTP_PORT'] ?? '2222');
const USERNAME = process.env['OMNI_FS_SFTP_USER'] ?? 'omnifs';
const PASSWORD = process.env['OMNI_FS_SFTP_PASSWORD'] ?? 'omnifs-dev-secret';
/** The seeded volume. Absolute on purpose: it is also the test of that rule. */
const ROOT_PREFIX = process.env['OMNI_FS_SFTP_ROOT'] ?? '/data';

function connect(
  settings: Readonly<Record<string, unknown>> = {},
  logger: Logger = NOOP_LOGGER,
): SftpFileSystem {
  const config: ConnectionConfig = {
    id: 'live',
    providerId: 'sftp',
    label: 'live',
    settings: {
      host: HOST,
      port: PORT,
      username: USERNAME,
      authMethod: 'password',
      rootPrefix: ROOT_PREFIX,
      ...settings,
    },
  };
  return new SftpFileSystem({
    config,
    getSecret: async () => ({ password: PASSWORD }),
    logger,
  });
}

interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly data: Record<string, unknown> | undefined;
}

/**
 * A logger that keeps what it was told.
 *
 * Two cases below are about something the provider only *says*: the fingerprint
 * of a host accepted on first use, and the warning a non-atomic rename has to
 * announce. Neither changes the tree afterwards, so `NOOP_LOGGER` would let
 * both disappear without a failing test.
 */
function capturingLogger(): { logger: Logger; entries: readonly LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger: Logger = {
    log: (level, message, data) => {
      entries.push({ level, message, data });
    },
    child: () => logger,
  };
  return { logger, entries };
}

/** A transport-only session, for setup and cleanup that must not use the methods under test. */
async function session(): Promise<SftpSession> {
  return SftpSession.open({
    settings: readSettings({ host: HOST, port: PORT, username: USERNAME, authMethod: 'password' }),
    secret: { password: PASSWORD },
    logger: NOOP_LOGGER,
  });
}

/**
 * Runs `body` on a transport-only session and closes it on every path. Every
 * session this file opens goes through here: one that leaks stays authenticated
 * for the life of the process, and the vitest worker then hangs after the last
 * case rather than failing in it.
 */
async function withTransport<T>(body: (transport: SftpSession) => Promise<T>): Promise<T> {
  const transport = await session();
  try {
    return await body(transport);
  } finally {
    await transport.close();
  }
}

/**
 * Removes an absolute server path, through the transport rather than through
 * `fs.delete`: a cleanup that ran through a method under test could not fail
 * safely, and one failure leaves a `conformance-*` directory behind for every
 * run after it.
 */
async function remove(absolute: string): Promise<void> {
  await withTransport((transport) => removeTree(transport, absolute));
}

async function removeTree(transport: SftpSession, absolute: string): Promise<void> {
  let entries: readonly { filename: string }[];
  try {
    entries = await transport.readdir(absolute);
  } catch {
    await transport.unlink(absolute).catch(() => undefined);
    return;
  }

  for (const entry of entries) {
    if (entry.filename === '.' || entry.filename === '..') continue;
    await removeTree(transport, `${absolute}/${entry.filename}`);
  }
  await transport.rmdir(absolute).catch(() => undefined);
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * The shared behavioural contract, run against the live server. This is what
 * decides the provider is finished; the cases below it are this package's own.
 *
 * Declared ahead of them on purpose. The suite creates and removes a directory
 * per case, and `leaves the seeded root exactly as it found it` at the bottom
 * of this file then runs after all of them and proves nothing survived. That
 * ordering is load-bearing, and it rests on vitest's default of running suites
 * in declaration order: turn on `sequence.shuffle`, mark either suite
 * `.concurrent`, or add a second `*.live.test.ts` to this package — the
 * conformance config runs them in parallel workers — and the cross-check stops
 * holding silently, with no failure pointing at the cause.
 *
 * `runConformanceSuite` calls `setup()` inside every case and hands `teardown`
 * only the filesystem, so the pairing is remembered here — the same arrangement
 * `provider-webdav`'s live test uses, and for the same reasons. Two cases can
 * enter the same millisecond, hence the counter alongside the timestamp.
 */
let conformanceRuns = 0;
const conformanceRoots = new WeakMap<RemoteFileSystem, RemotePath>();

runConformanceSuite({
  name: 'SFTP (OpenSSH)',
  setup: async () => {
    const fs = connect();
    await fs.connect();
    conformanceRuns += 1;
    const root = RemotePath.parse(`/conformance-${String(Date.now())}-${String(conformanceRuns)}`);
    await fs.createDirectory(root);
    conformanceRoots.set(fs, root);
    return { fs, root };
  },
  teardown: async (fs) => {
    const root = conformanceRoots.get(fs);
    conformanceRoots.delete(fs);
    // The dispose is in a `finally` because `remove` opens a connection of its
    // own: one transient failure there would otherwise skip it and leave this
    // case's authenticated socket alive, sixteen times a run.
    try {
      if (root !== undefined) await remove(`${ROOT_PREFIX}${root.value}`);
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  },
});

describe('SFTP root prefix, against the live server', () => {
  it('starts at the login directory when no prefix is set', async () => {
    const name = `login-probe-${String(Date.now())}.txt`;
    const home = await withTransport((transport) => transport.realpath('.'));

    const fs = connect({ rootPrefix: '' });
    try {
      await fs.connect();
      // The login directory is the account's home, which exists and is a
      // directory — that it resolves at all is what `realpath('.')` is for.
      expect((await fs.stat(RemotePath.ROOT)).type).toBe('directory');

      // That assertion alone cannot fail for the right reason: the server root
      // is a directory too, so a base that regressed from the login directory
      // to `/` would still pass it. Writing through the connection and finding
      // the file in the account's home is what pins the branch — the same shape
      // the relative-prefix case below uses.
      await fs.writeFile(RemotePath.parse(`/${name}`), encode('at home'));
      expect(await withTransport(async (check) => (await check.stat(`${home}/${name}`)).size)).toBe(
        'at home'.length,
      );
    } finally {
      await fs[Symbol.asyncDispose]();
      await remove(`${home}/${name}`);
    }
  });

  it('puts a relative prefix below the login directory', async () => {
    const name = `relative-${String(Date.now())}`;
    const home = await withTransport(async (transport) => {
      const directory = await transport.realpath('.');
      await transport.mkdir(`${directory}/${name}`);
      return directory;
    });

    const fs = connect({ rootPrefix: name });
    try {
      await fs.connect();
      await fs.writeFile(RemotePath.parse('/inside.txt'), encode('below home'));

      expect(
        await withTransport(async (check) => (await check.stat(`${home}/${name}/inside.txt`)).size),
      ).toBe('below home'.length);
    } finally {
      await fs[Symbol.asyncDispose]();
      await remove(`${home}/${name}`);
    }
  });
});

describe('SFTP OpenSSH extensions, against the live server', () => {
  it('detects copy-data on this image and copies without moving bytes through the client', async () => {
    const fs = connect();
    const root = RemotePath.parse(`/extensions-${String(Date.now())}`);
    try {
      await fs.connect();
      expect(fs.capabilities.canCopyServerSide).toBe(true);

      await fs.createDirectory(root);
      await fs.writeFile(root.join('source.txt'), encode('payload'));
      await fs.copy(root.join('source.txt'), root.join('copy.txt'));

      expect(decode(await fs.readFile(root.join('copy.txt')))).toBe('payload');
      expect((await fs.stat(root.join('source.txt'))).type).toBe('file');
    } finally {
      await fs[Symbol.asyncDispose]();
      await remove(`${ROOT_PREFIX}${root.value}`);
    }
  });

  it('replaces an existing destination with POSIX rename', async () => {
    const { logger, entries } = capturingLogger();
    const fs = connect({}, logger);
    const root = RemotePath.parse(`/posix-rename-${String(Date.now())}`);
    try {
      await fs.connect();
      await fs.createDirectory(root);
      await fs.writeFile(root.join('from.txt'), encode('winner'));
      await fs.writeFile(root.join('to.txt'), encode('loser'));

      await fs.rename(root.join('from.txt'), root.join('to.txt'));

      expect(decode(await fs.readFile(root.join('to.txt')))).toBe('winner');
      await expect(fs.stat(root.join('from.txt'))).rejects.toSatisfy(
        (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
      );

      // The tree above is what unlink-then-rename leaves too, so it says
      // nothing about which one ran. The fallback announces itself before it
      // unlinks — that warning's absence is what says the atomic extension did
      // the work.
      expect(entries.filter((entry) => entry.level === 'warn' || entry.level === 'error')).toEqual(
        [],
      );
    } finally {
      await fs[Symbol.asyncDispose]();
      await remove(`${ROOT_PREFIX}${root.value}`);
    }
  });
});

describe('SFTP host key verification, against the live server', () => {
  it('refuses a host whose key does not match the one on file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omni-fs-known-hosts-'));
    const path = join(dir, 'known_hosts');
    // A syntactically valid ed25519 line for this host, carrying the wrong key.
    const wrongKey = Buffer.concat([
      Buffer.from([0, 0, 0, 11]),
      Buffer.from('ssh-ed25519', 'utf8'),
      Buffer.from([0, 0, 0, 32]),
      Buffer.alloc(32, 7),
    ]);
    await writeFile(path, `[${HOST}]:${String(PORT)} ssh-ed25519 ${wrongKey.toString('base64')}\n`);

    const fs = connect({ knownHostsPath: path });
    try {
      await expect(fs.connect()).rejects.toSatisfy(
        (error: unknown) => OmniFsError.is(error) && error.code === 'AuthenticationFailed',
      );
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('connects to a host it has never seen, logging the fingerprint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omni-fs-known-hosts-'));
    const { logger, entries } = capturingLogger();
    const fs = connect({ knownHostsPath: join(dir, 'known_hosts') }, logger);
    try {
      await fs.connect();
      expect(fs.isAlive()).toBe(true);

      // Trust on first use is only defensible because the key is recorded: this
      // line is the user's one chance to compare the fingerprint against what
      // the server's operator published. Asserting the connection succeeded
      // would not notice it going missing.
      const announced = entries.filter((entry) => typeof entry.data?.['fingerprint'] === 'string');
      expect(announced).toHaveLength(1);
      expect(announced[0]?.level).toBe('info');
      expect(announced[0]?.data?.['fingerprint']).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });
});

describe('SFTP cleanliness', () => {
  it('leaves the seeded root exactly as it found it', async () => {
    const fs = connect();
    try {
      await fs.connect();
      const names: string[] = [];
      for await (const entry of fs.list(RemotePath.ROOT)) names.push(entry.name);

      expect(names.filter((name) => name.startsWith('conformance-'))).toEqual([]);
      expect(names.filter((name) => name.startsWith('extensions-'))).toEqual([]);
      expect(names.filter((name) => name.startsWith('posix-rename-'))).toEqual([]);
      expect(names.sort()).toEqual(['data', 'docs', 'readme.txt']);
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });
});
