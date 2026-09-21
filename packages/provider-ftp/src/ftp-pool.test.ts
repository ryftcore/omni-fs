import { describe, expect, it, vi } from 'vitest';
import { NOOP_LOGGER, OmniFsError } from '@omni-fs/core';
import type { Logger, LogLevel } from '@omni-fs/core';
import { FtpPool } from './ftp-pool.js';
import type { FtpChannel } from './ftp-channel.js';

interface FakeChannel extends FtpChannel {
  alive: boolean;
}

function fakeChannel(): FakeChannel {
  const channel: FakeChannel = {
    alive: true,
    hasMlst: true,
    poisoned: false,
    isAlive: () => channel.alive && !channel.poisoned,
    poison: () => {
      (channel as { poisoned: boolean }).poisoned = true;
    },
    close: vi.fn(async () => {
      channel.alive = false;
    }),
    pwd: async () => '/home/alice',
    mlst: async () => undefined,
    list: async () => [],
    mkdir: async () => undefined,
    rmdir: async () => undefined,
    unlink: async () => undefined,
    rename: async () => undefined,
    openReadStream: async () => new ReadableStream<Uint8Array>(),
    upload: async () => undefined,
    openWriteStream: async () => new WritableStream<Uint8Array>(),
  };
  return channel;
}

function poolOf(
  maxConnections: number,
  open: (signal?: AbortSignal) => Promise<FtpChannel> = async () => fakeChannel(),
  logger: Logger = NOOP_LOGGER,
): FtpPool {
  return new FtpPool({ maxConnections, open, logger });
}

function replyError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function capturingLogger(): { logger: Logger; entries: { level: LogLevel; message: string }[] } {
  const entries: { level: LogLevel; message: string }[] = [];
  const logger: Logger = {
    log: (level, message) => {
      entries.push({ level, message });
    },
    child: () => logger,
  };
  return { logger, entries };
}

/** Resolves once the microtask queue and one timer tick have drained. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('FtpPool', () => {
  it('opens nothing until something is leased', async () => {
    const open = vi.fn(async () => fakeChannel());
    const pool = poolOf(4, open);
    expect(open).not.toHaveBeenCalled();
    expect(pool.size).toBe(0);
  });

  it('reuses one channel for sequential leases', async () => {
    const open = vi.fn(async () => fakeChannel());
    const pool = poolOf(4, open);
    const first = await pool.lease(async (channel) => channel);
    const second = await pool.lease(async (channel) => channel);
    expect(second).toBe(first);
    expect(open).toHaveBeenCalledOnce();
  });

  it('serialises concurrent work at a ceiling of one, which is the default', async () => {
    const open = vi.fn(async () => fakeChannel());
    const pool = poolOf(1, open);
    let inFlight = 0;
    let peak = 0;

    await Promise.all(
      [1, 2, 3].map(() =>
        pool.lease(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await settle();
          inFlight -= 1;
        }),
      ),
    );

    expect(peak).toBe(1);
    expect(open).toHaveBeenCalledOnce();
  });

  it('overlaps work up to the ceiling and no further', async () => {
    const open = vi.fn(async () => fakeChannel());
    const pool = poolOf(3, open);
    let inFlight = 0;
    let peak = 0;

    await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        pool.lease(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await settle();
          inFlight -= 1;
        }),
      ),
    );

    expect(peak).toBe(3);
    expect(open).toHaveBeenCalledTimes(3);
  });

  it('replaces a channel the server idled out, before the operation starts', async () => {
    // vsftpd closes an idle connection after five minutes and says nothing
    // until the next command. Replacing it here is bookkeeping, not a retry.
    const channels: FakeChannel[] = [];
    const pool = poolOf(1, async () => {
      const channel = fakeChannel();
      channels.push(channel);
      return channel;
    });

    const first = (await pool.lease(async (channel) => channel)) as FakeChannel;
    first.alive = false;
    const second = await pool.lease(async (channel) => channel);

    expect(second).not.toBe(first);
    expect(channels).toHaveLength(2);
    expect(first.close).toHaveBeenCalled();
  });

  it('discards a poisoned channel on release rather than handing it on', async () => {
    const channels: FakeChannel[] = [];
    const pool = poolOf(1, async () => {
      const channel = fakeChannel();
      channels.push(channel);
      return channel;
    });

    const first = await pool.lease(async (channel) => {
      channel.poison();
      return channel;
    });
    expect(pool.size).toBe(0);

    const second = await pool.lease(async (channel) => channel);
    expect(second).not.toBe(first);
  });

  it('releases the channel even when the body throws', async () => {
    const pool = poolOf(1);
    const first = await pool.lease(async (channel) => channel);
    await expect(pool.lease(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await pool.lease(async (channel) => channel)).toBe(first);
  });

  it('lowers its own ceiling when the server refuses another login', async () => {
    // Shared hosting caps concurrent logins per account and does not advertise
    // the number. Surfacing that as a failure gives the user nothing to act on.
    const { logger, entries } = capturingLogger();
    let opened = 0;
    const pool = new FtpPool({
      maxConnections: 4,
      logger,
      open: async () => {
        opened += 1;
        if (opened > 2) throw replyError(421, '421 There are too many connections from your IP');
        return fakeChannel();
      },
    });

    let peak = 0;
    let inFlight = 0;
    await Promise.all(
      [1, 2, 3, 4].map(() =>
        pool.lease(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await settle();
          inFlight -= 1;
        }),
      ),
    );

    expect(peak).toBe(2);
    expect(pool.ceiling).toBe(2);
    expect(entries.some((entry) => entry.level === 'warn' && /ceiling/i.test(entry.message))).toBe(
      true,
    );
  });

  it('keeps the lowered ceiling for the rest of the session', async () => {
    let opened = 0;
    const pool = new FtpPool({
      maxConnections: 4,
      logger: NOOP_LOGGER,
      open: async () => {
        opened += 1;
        if (opened > 1) throw replyError(421, '421 Session limit reached');
        return fakeChannel();
      },
    });

    await Promise.all([pool.lease(async () => settle()), pool.lease(async () => settle())]);
    expect(pool.ceiling).toBe(1);
    await pool.lease(async () => undefined);
    expect(pool.ceiling).toBe(1);
  });

  it('fails rather than shrinking when the very first login is refused', async () => {
    // There is no existing channel to retry on, so this is a real failure and
    // has to reach the user.
    const pool = poolOf(4, async () => {
      throw replyError(421, '421 Too many connections');
    });
    await expect(pool.lease(async () => undefined)).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'ConnectionFailed',
    );
  });

  it('does not shrink on a 421 that merely means the connection was idle', async () => {
    let opened = 0;
    const pool = new FtpPool({
      maxConnections: 3,
      logger: NOOP_LOGGER,
      open: async () => {
        opened += 1;
        if (opened === 2) throw replyError(421, '421 Timeout.');
        return fakeChannel();
      },
    });

    await pool.lease(async () => settle());
    await expect(
      Promise.all([pool.lease(async () => settle()), pool.lease(async () => settle())]),
    ).rejects.toThrow();
    expect(pool.ceiling).toBe(3);
  });

  it('rejects an acquire whose signal is already aborted', async () => {
    const pool = poolOf(1);
    const controller = new AbortController();
    controller.abort();
    await expect(pool.acquire(controller.signal)).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled',
    );
  });

  it('rejects a waiter whose signal aborts while it is queued', async () => {
    const pool = poolOf(1);
    const controller = new AbortController();
    let finish: (() => void) | undefined;

    const held = pool.lease(
      async () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const queued = pool.acquire(controller.signal);
    await settle();
    controller.abort();

    await expect(queued).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled',
    );
    finish?.();
    await held;
  });

  it('reports liveness from the channels it holds', async () => {
    const pool = poolOf(1);
    expect(pool.isAlive()).toBe(false);
    const channel = (await pool.lease(async (c) => c)) as FakeChannel;
    expect(pool.isAlive()).toBe(true);
    channel.alive = false;
    expect(pool.isAlive()).toBe(false);
  });

  it('closes every channel it holds, busy or idle', async () => {
    const channels: FakeChannel[] = [];
    const pool = poolOf(2, async () => {
      const channel = fakeChannel();
      channels.push(channel);
      return channel;
    });

    await Promise.all([pool.lease(async () => settle()), pool.lease(async () => settle())]);
    await pool.close();

    expect(channels).toHaveLength(2);
    for (const channel of channels) expect(channel.close).toHaveBeenCalled();
    expect(pool.isAlive()).toBe(false);
  });

  it('refuses to hand out a channel after it is closed', async () => {
    const pool = poolOf(1);
    await pool.close();
    await expect(pool.acquire()).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'ConnectionFailed',
    );
  });

  it('asks the server for another login once after a refusal, not in a loop', async () => {
    // The lowered ceiling is what makes the next pass wait rather than dial
    // again; without it this is a failed login per operation for the life of
    // the connection. The sixth attempt succeeds only so a pool that did spin
    // terminates and can be counted instead of wedging the suite.
    let opened = 0;
    const pool = new FtpPool({
      maxConnections: 4,
      logger: NOOP_LOGGER,
      open: async () => {
        opened += 1;
        if (opened > 1 && opened < 6) throw replyError(421, '421 Too many connections');
        return fakeChannel();
      },
    });

    await Promise.all([pool.lease(async () => settle()), pool.lease(async () => settle())]);

    expect(opened).toBe(2);
    expect(pool.ceiling).toBe(1);
  });

  it('gives a release to the next waiter when an earlier one has aborted', async () => {
    // An aborted waiter left in the queue swallows the release meant for the
    // caller behind it, which then waits for a channel that is already idle.
    const pool = poolOf(1);
    const controller = new AbortController();
    let finish: (() => void) | undefined;

    const held = pool.lease(
      async () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const abandoned = pool.acquire(controller.signal);
    const behind = pool.acquire();
    await settle();

    controller.abort();
    await expect(abandoned).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled',
    );

    finish?.();
    await held;
    const channel = await behind;
    expect(channel.isAlive()).toBe(true);
    pool.release(channel);
  });

  it('removes the waiter that aborted, not whichever is at the head of the queue', async () => {
    const pool = poolOf(1);
    const controller = new AbortController();
    let finish: (() => void) | undefined;

    const held = pool.lease(
      async () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const patient = pool.acquire();
    const abandoned = pool.acquire(controller.signal);
    await settle();

    controller.abort();
    await expect(abandoned).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled',
    );

    finish?.();
    await held;
    const channel = await patient;
    expect(channel.isAlive()).toBe(true);
    pool.release(channel);
  });

  // A wakeup goes to exactly one waiter, so whoever it wakes owes it back to
  // the queue if it cannot use it. `release` shifts the waiter off the queue
  // and resolves it, which detaches its abort listener — so an abort landing
  // after that and before the waiter's continuation runs removes it from
  // nothing. The waiter then throws `Cancelled`, which is right, while the
  // release it consumed must still reach the caller behind it.
  it('hands the wakeup on when the waiter it woke aborts before resuming', async () => {
    const pool = poolOf(1);
    const controller = new AbortController();

    const held = await pool.acquire();
    const aborting = pool.acquire(controller.signal);
    const behind = pool.acquire();
    await settle();

    // Both of these run in one synchronous stretch, which is the whole
    // point: the abort lands inside the window `release` opened.
    pool.release(held);
    controller.abort();

    await expect(aborting).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled',
    );
    expect(await behind).toBe(held);
    pool.release(held);
  }, 2_000);

  // The same lost wakeup without an abort anywhere, at the shipped default
  // ceiling of one. The release discards a channel the server idled out, so it
  // frees a slot rather than handing a channel on; the waiter it wakes then
  // fails to open a replacement. A transient refusal must stay an error its
  // own caller can retry, not wedge everyone queued behind it.
  it('hands the wakeup on when the waiter it woke fails to open a channel', async () => {
    let opened = 0;
    const pool = new FtpPool({
      maxConnections: 1,
      logger: NOOP_LOGGER,
      open: async () => {
        opened += 1;
        if (opened === 2) throw replyError(425, '425 Cannot open data connection');
        return fakeChannel();
      },
    });

    const held = (await pool.acquire()) as FakeChannel;
    const failing = pool.acquire();
    const behind = pool.acquire();
    await settle();

    held.alive = false;
    pool.release(held);

    await expect(failing).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'ConnectionFailed',
    );
    const channel = await behind;
    expect(channel.isAlive()).toBe(true);
    expect(channel).not.toBe(held);
    expect(opened).toBe(3);
    pool.release(channel);
  }, 2_000);

  it('rejects everyone still queued when the pool closes', async () => {
    const pool = poolOf(1);
    let finish: (() => void) | undefined;

    const held = pool.lease(
      async () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const queued = pool.acquire();
    await settle();

    const closed = pool.close();
    await expect(queued).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'ConnectionFailed',
    );

    finish?.();
    await held;
    await closed;
  });
});
