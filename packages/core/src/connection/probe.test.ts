import { describe, expect, it } from 'vitest';
import { ConnectionManager } from './manager.js';
import { MINIMAL_CAPABILITIES } from '../capabilities.js';
import { InMemoryConfigStore } from '../ports/config-store.js';
import { InMemorySecretStore } from '../ports/secret-store.js';
import { NOOP_LOGGER } from '../ports/logger.js';
import { OmniFsError } from '../errors.js';
import { ProviderRegistry } from '../registry.js';
import type { ProviderDefinition, RemoteFileSystem } from '../provider.js';

/**
 * A stub rather than `memoryProvider` from @omni-fs/testing: that package
 * depends on core, so importing it here would be a cycle.
 */
function stubProvider(behaviour: {
  connect?: () => Promise<void>;
  stat?: () => Promise<never>;
  onDispose?: () => void;
}): ProviderDefinition {
  return {
    id: 'stub',
    displayName: 'Stub',
    schemes: ['stub'],
    settingsSchema: { fields: [] },
    secretSchema: { fields: [] },
    defaultCapabilities: MINIMAL_CAPABILITIES,
    create: (context) =>
      ({
        capabilities: { ...MINIMAL_CAPABILITIES, maxConcurrency: 7 },
        connect: behaviour.connect ?? (async () => undefined),
        isAlive: () => true,
        stat:
          behaviour.stat ??
          (async () => ({ path: '/', type: 'directory', size: 0, mtime: undefined })),
        list: () => (async function* () {})(),
        readFile: async () => new Uint8Array(),
        createReadStream: async () => new ReadableStream(),
        writeFile: async () => undefined,
        delete: async () => undefined,
        [Symbol.asyncDispose]: async () => {
          behaviour.onDispose?.();
        },
        // Reading the context proves the draft reached the provider.
        __config: context.config,
      }) as unknown as RemoteFileSystem,
  };
}

function managerWith(definition: ProviderDefinition): ConnectionManager {
  const registry = new ProviderRegistry();
  registry.register(definition);
  return new ConnectionManager({
    registry,
    configStore: new InMemoryConfigStore(),
    secretStore: new InMemorySecretStore(),
    logger: NOOP_LOGGER,
  });
}

const target = { providerId: 'stub', label: 'draft', settings: { host: 'h' } };

describe('ConnectionManager.probe', () => {
  it('reports success with the provider capabilities', async () => {
    const manager = managerWith(stubProvider({}));
    const result = await manager.probe(target, { password: 'p' });

    expect(result.ok).toBe(true);
    expect(result.capabilities?.maxConcurrency).toBe(7);
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports failure as an OmniFsError instead of throwing', async () => {
    const manager = managerWith(
      stubProvider({
        connect: async () => {
          throw new OmniFsError({ code: 'AuthenticationFailed', message: 'bad key' });
        },
      }),
    );
    const result = await manager.probe(target, {});

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('AuthenticationFailed');
    expect(result.error?.message).toBe('bad key');
  });

  it('wraps an unclassified throw', async () => {
    const manager = managerWith(
      stubProvider({
        connect: async () => {
          throw new Error('socket hang up');
        },
      }),
    );
    const result = await manager.probe(target, {});

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('Unknown');
    expect(result.error?.providerId).toBe('stub');
  });

  it('resolves with a failure instead of rejecting when the provider is not registered', async () => {
    const manager = new ConnectionManager({
      registry: new ProviderRegistry(),
      configStore: new InMemoryConfigStore(),
      secretStore: new InMemorySecretStore(),
      logger: NOOP_LOGGER,
    });

    const result = await manager.probe(target, {});

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NotFound');
  });

  it('disposes the throwaway filesystem on success and on failure', async () => {
    let disposals = 0;
    const ok = managerWith(stubProvider({ onDispose: () => (disposals += 1) }));
    await ok.probe(target, {});
    expect(disposals).toBe(1);

    const failing = managerWith(
      stubProvider({
        connect: async () => {
          throw new Error('nope');
        },
        onDispose: () => (disposals += 1),
      }),
    );
    await failing.probe(target, {});
    expect(disposals).toBe(2);
  });

  it('leaves connection state untouched', async () => {
    const manager = managerWith(stubProvider({}));
    await manager.probe({ ...target, label: 'draft' }, {});

    // A probe must not register state under any id, or a failing draft would
    // paint an existing connection red.
    expect(manager.getState('stub').status).toBe('disconnected');
    expect(manager.getState('draft').status).toBe('disconnected');
  });
});
