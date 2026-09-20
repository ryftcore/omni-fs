import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager } from './manager.js';
import { MINIMAL_CAPABILITIES } from '../capabilities.js';
import { InMemoryConfigStore } from '../ports/config-store.js';
import { InMemorySecretStore } from '../ports/secret-store.js';
import { NOOP_LOGGER } from '../ports/logger.js';
import { OmniFsError } from '../errors.js';
import { ProviderRegistry } from '../registry.js';
import type { ConnectionState } from '../model/connection.js';
import type { ProviderContext, ProviderDefinition, RemoteFileSystem } from '../provider.js';

/**
 * `ConnectionManager` owns the lifecycle that would otherwise be written once
 * per host and drift: lazy connect, de-duplicated concurrent connects, idle
 * eviction, state broadcasting.
 *
 * A stub provider rather than `MemoryFileSystem`: `@omni-fs/testing` depends on
 * core, so importing it here would be a cycle. The same reason `probe.test.ts`
 * hand-rolls one.
 */

interface StubBehaviour {
  readonly connect?: () => Promise<void>;
  readonly isAlive?: () => boolean;
  /** Throw from `create`, the way a provider that validates settings does. */
  readonly failOnCreate?: () => never;
  /** Ask for the credential during connect, the way a real provider does. */
  readonly needsSecret?: boolean;
}

interface Stub {
  readonly definition: ProviderDefinition;
  readonly created: RemoteFileSystem[];
  readonly disposed: RemoteFileSystem[];
}

function stubProvider(behaviour: StubBehaviour = {}): Stub {
  const created: RemoteFileSystem[] = [];
  const disposed: RemoteFileSystem[] = [];

  const definition: ProviderDefinition = {
    id: 'stub',
    displayName: 'Stub',
    schemes: ['stub'],
    settingsSchema: { fields: [] },
    secretSchema: { fields: [] },
    defaultCapabilities: MINIMAL_CAPABILITIES,
    create: (context: ProviderContext) => {
      behaviour.failOnCreate?.();

      const fs = {
        capabilities: MINIMAL_CAPABILITIES,
        connect: async () => {
          if (behaviour.needsSecret === true) await context.getSecret();
          await behaviour.connect?.();
        },
        isAlive: behaviour.isAlive ?? ((): boolean => true),
        stat: async () => ({ type: 'directory' as const, size: 0 }),
        list: () => (async function* () {})(),
        readFile: async () => new Uint8Array(),
        createReadStream: async () => new ReadableStream<Uint8Array>(),
        writeFile: async () => undefined,
        delete: async () => undefined,
        [Symbol.asyncDispose]: async () => {
          disposed.push(fs);
        },
      } as unknown as RemoteFileSystem;

      created.push(fs);
      return fs;
    },
  };

  return { definition, created, disposed };
}

interface Harness {
  readonly manager: ConnectionManager;
  readonly configStore: InMemoryConfigStore;
  readonly secretStore: InMemorySecretStore;
  readonly stub: Stub;
  readonly states: ConnectionState[];
}

async function setup(
  behaviour: StubBehaviour = {},
  options: { idleTimeoutMs?: number; providerId?: string } = {},
): Promise<Harness> {
  const stub = stubProvider(behaviour);
  const registry = new ProviderRegistry();
  registry.register(stub.definition);

  const configStore = new InMemoryConfigStore();
  await configStore.save({
    id: 'c1',
    providerId: options.providerId ?? 'stub',
    label: 'Stub',
    settings: {},
  });

  const secretStore = new InMemorySecretStore();
  const states: ConnectionState[] = [];

  const manager = new ConnectionManager({
    registry,
    configStore,
    secretStore,
    logger: NOOP_LOGGER,
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
  });
  manager.onDidChangeState((change) => {
    states.push(change.state);
  });

  return { manager, configStore, secretStore, stub, states };
}

async function codeOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (OmniFsError.is(error)) return error.code;
    throw error;
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ConnectionManager', () => {
  describe('acquire', () => {
    it('connects once and reuses the live filesystem', async () => {
      const { manager, stub } = await setup();

      const first = await manager.acquire('c1');
      const second = await manager.acquire('c1');

      expect(second).toBe(first);
      expect(stub.created).toHaveLength(1);
    });

    it('shares one connect attempt between concurrent callers', async () => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const { manager, stub } = await setup({ connect: () => gate });

      const both = Promise.all([manager.acquire('c1'), manager.acquire('c1')]);
      open();
      const [first, second] = await both;

      // Without this, expanding a tree node fires a stat and a list at once and
      // opens two FTP control channels.
      expect(first).toBe(second);
      expect(stub.created).toHaveLength(1);
    });

    it('rejects an unknown connection id', async () => {
      const { manager } = await setup();

      expect(await codeOf(manager.acquire('nope'))).toBe('NotFound');
    });

    it('retries on the next call rather than caching a failed connect', async () => {
      let attempts = 0;
      const { manager } = await setup({
        connect: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new OmniFsError({ code: 'ConnectionFailed', message: 'refused' });
          }
        },
      });

      expect(await codeOf(manager.acquire('c1'))).toBe('ConnectionFailed');
      await expect(manager.acquire('c1')).resolves.toBeDefined();
      expect(attempts).toBe(2);
    });

    it('connects without a stored secret when the provider never asks', async () => {
      const { manager } = await setup();

      await expect(manager.acquire('c1')).resolves.toBeDefined();
    });

    it('fails with AuthenticationFailed when the provider asks and nothing is stored', async () => {
      const { manager } = await setup({ needsSecret: true });

      expect(await codeOf(manager.acquire('c1'))).toBe('AuthenticationFailed');
    });

    it('passes the stored secret to a provider that asks', async () => {
      const { manager, secretStore } = await setup({ needsSecret: true });
      await secretStore.set('c1', { password: 'hunter2' });

      await expect(manager.acquire('c1')).resolves.toBeDefined();
    });
  });

  describe('state', () => {
    it('moves from disconnected through connecting to connected', async () => {
      const { manager, states } = await setup();
      expect(manager.getState('c1')).toEqual({ status: 'disconnected' });

      await manager.acquire('c1');

      expect(states.map((state) => state.status)).toEqual(['connecting', 'connected']);
      expect(manager.getState('c1').status).toBe('connected');
    });

    it('reports error and disposes the filesystem when connect fails', async () => {
      const { manager, stub } = await setup({
        connect: async () => {
          throw new OmniFsError({ code: 'AuthenticationFailed', message: 'bad password' });
        },
      });

      expect(await codeOf(manager.acquire('c1'))).toBe('AuthenticationFailed');

      expect(manager.getState('c1').status).toBe('error');
      // Whatever the failed connect opened has to be released.
      expect(stub.disposed).toHaveLength(1);
    });

    it('does not strand a connection on connecting when the provider is unregistered', async () => {
      const { manager } = await setup({}, { providerId: 'never-registered' });

      expect(await codeOf(manager.acquire('c1'))).toBe('NotFound');

      // A permanent spinner is worse than a visible failure: the user has no
      // way to tell a slow connect from one that can never succeed.
      expect(manager.getState('c1').status).toBe('error');
    });

    it('does not strand a connection on connecting when the provider cannot be built', async () => {
      const { manager } = await setup({
        failOnCreate: () => {
          throw new OmniFsError({ code: 'Unsupported', message: 'settings are not valid' });
        },
      });

      expect(await codeOf(manager.acquire('c1'))).toBe('Unsupported');

      expect(manager.getState('c1').status).toBe('error');
    });
  });

  describe('reconnecting', () => {
    it('replaces a filesystem that is no longer alive', async () => {
      let alive = true;
      const { manager, stub } = await setup({ isAlive: () => alive });
      const first = await manager.acquire('c1');

      alive = false;
      const second = await manager.acquire('c1');

      expect(second).not.toBe(first);
      expect(stub.created).toHaveLength(2);
    });

    it('disposes the dead filesystem it replaced', async () => {
      let alive = true;
      const { manager, stub } = await setup({ isAlive: () => alive });
      const first = await manager.acquire('c1');

      alive = false;
      await manager.acquire('c1');

      // Dropping the reference is not enough: the old instance still holds a
      // socket until something closes it.
      expect(stub.disposed).toContain(first);
    });
  });

  describe('disconnect', () => {
    it('disposes the filesystem and reports disconnected', async () => {
      const { manager, stub } = await setup();
      await manager.acquire('c1');

      await manager.disconnect('c1');

      expect(stub.disposed).toHaveLength(1);
      expect(manager.getState('c1').status).toBe('disconnected');
    });

    it('is safe to call when nothing is connected', async () => {
      const { manager } = await setup();

      await expect(manager.disconnect('c1')).resolves.toBeUndefined();
    });

    it('opens a fresh connection after an invalidate', async () => {
      const { manager, configStore, stub } = await setup();
      const first = await manager.acquire('c1');

      const config = await configStore.get('c1');
      await manager.invalidate(config!);
      const second = await manager.acquire('c1');

      // Editing a config must not leave the old settings live.
      expect(second).not.toBe(first);
      expect(stub.created).toHaveLength(2);
    });
  });

  describe('idle eviction', () => {
    it('drops a connection that has gone unused', async () => {
      vi.useFakeTimers();
      const { manager, stub } = await setup({}, { idleTimeoutMs: 1_000 });
      await manager.acquire('c1');

      await vi.advanceTimersByTimeAsync(1_001);

      expect(stub.disposed).toHaveLength(1);
      expect(manager.getState('c1').status).toBe('disconnected');
    });

    it('extends the deadline each time the connection is used', async () => {
      vi.useFakeTimers();
      const { manager, stub } = await setup({}, { idleTimeoutMs: 1_000 });
      await manager.acquire('c1');

      await vi.advanceTimersByTimeAsync(800);
      await manager.acquire('c1');
      await vi.advanceTimersByTimeAsync(800);

      expect(stub.disposed).toHaveLength(0);
    });

    it('never evicts when the timeout is zero', async () => {
      vi.useFakeTimers();
      const { manager, stub } = await setup({}, { idleTimeoutMs: 0 });
      await manager.acquire('c1');

      await vi.advanceTimersByTimeAsync(600_000);

      expect(stub.disposed).toHaveLength(0);
    });
  });

  it('disposes every live connection when the manager is disposed', async () => {
    const { manager, configStore, stub } = await setup();
    await configStore.save({ id: 'c2', providerId: 'stub', label: 'Second', settings: {} });
    await manager.acquire('c1');
    await manager.acquire('c2');

    await manager[Symbol.asyncDispose]();

    expect(stub.disposed).toHaveLength(2);
  });
});
