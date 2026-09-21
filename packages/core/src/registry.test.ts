import { describe, expect, it } from 'vitest';
import { MINIMAL_CAPABILITIES } from './capabilities.js';
import { OmniFsError } from './errors.js';
import { ProviderRegistry } from './registry.js';
import type { ProviderDefinition, RemoteFileSystem } from './provider.js';

/**
 * The registry is what keeps a `switch` on provider id out of core: a protocol
 * is a package plus one `register()` call per host. These pin the resolution
 * and lifetime rules the hosts rely on.
 */

function definition(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return {
    id: 'stub',
    displayName: 'Stub',
    schemes: ['stub'],
    settingsSchema: { fields: [] },
    secretSchema: { fields: [] },
    defaultCapabilities: MINIMAL_CAPABILITIES,
    create: () => ({}) as unknown as RemoteFileSystem,
    ...overrides,
  };
}

function codeOf(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    if (OmniFsError.is(error)) return error.code;
    throw error;
  }
  throw new Error('Expected the call to throw, but it returned.');
}

describe('ProviderRegistry', () => {
  describe('resolution', () => {
    it('resolves a registered provider by id', () => {
      const registry = new ProviderRegistry();
      const stub = definition();
      registry.register(stub);

      expect(registry.get('stub')).toBe(stub);
    });

    it('resolves by every scheme the definition declares', () => {
      const registry = new ProviderRegistry();
      const stub = definition({ schemes: ['ftp', 'ftps'] });
      registry.register(stub);

      expect(registry.getByScheme('ftp')).toBe(stub);
      expect(registry.getByScheme('ftps')).toBe(stub);
    });

    it('throws a NotFound naming the missing id', () => {
      const registry = new ProviderRegistry();

      expect(codeOf(() => registry.get('absent'))).toBe('NotFound');
      // The message has to say what to do about it: the usual cause is a host
      // that forgot the `register()` line for a package it depends on.
      expect(() => registry.get('absent')).toThrow(/absent/);
    });

    it('tryGet reports absence without throwing', () => {
      const registry = new ProviderRegistry();

      expect(registry.tryGet('absent')).toBeUndefined();
      expect(registry.getByScheme('absent')).toBeUndefined();
    });

    it('lists everything registered', () => {
      const registry = new ProviderRegistry();
      registry.register(definition({ id: 'one', schemes: ['one'] }));
      registry.register(definition({ id: 'two', schemes: ['two'] }));

      expect(registry.list().map((entry) => entry.id)).toEqual(['one', 'two']);
    });
  });

  describe('lifetime', () => {
    it('refuses a duplicate id', () => {
      const registry = new ProviderRegistry();
      registry.register(definition());

      expect(codeOf(() => registry.register(definition()))).toBe('AlreadyExists');
    });

    it('disposing a registration removes the id and every scheme', () => {
      const registry = new ProviderRegistry();
      const registration = registry.register(definition({ schemes: ['ftp', 'ftps'] }));

      registration[Symbol.dispose]();

      expect(registry.tryGet('stub')).toBeUndefined();
      expect(registry.getByScheme('ftp')).toBeUndefined();
      expect(registry.getByScheme('ftps')).toBeUndefined();
    });

    it('frees the id for re-registration once disposed', () => {
      const registry = new ProviderRegistry();
      const registration = registry.register(definition());
      registration[Symbol.dispose]();

      expect(() => registry.register(definition())).not.toThrow();
    });

    it('lets the last registration win a shared scheme', () => {
      const registry = new ProviderRegistry();
      const first = definition({ id: 'first', schemes: ['shared'] });
      const second = definition({ id: 'second', schemes: ['shared'] });
      registry.register(first);
      registry.register(second);

      // Ids are guarded; schemes are not. Worth knowing before a host registers
      // two providers that both claim one scheme — and worth knowing that
      // disposing the winner drops the scheme entirely rather than restoring
      // the provider it displaced.
      expect(registry.getByScheme('shared')).toBe(second);
    });
  });
});

describe('register freezes what it stores', () => {
  it('refuses an in-place swap of create()', () => {
    // The registry is published on the extension's API, so `get()` hands a
    // co-resident extension the live object. `create` receives `getSecret`,
    // so replacing it in place would hand over every credential.
    const registry = new ProviderRegistry();
    registry.register(definition({ id: 'swappable', schemes: ['swappable'] }));
    const stored = registry.get('swappable');

    expect(Object.isFrozen(stored)).toBe(true);
    expect(() => {
      (stored as { create: unknown }).create = () => {
        throw new Error('hijacked');
      };
    }).toThrow(TypeError);
  });

  it('freezes the schemes array too, because disposal iterates it', () => {
    const registry = new ProviderRegistry();
    registry.register(definition({ id: 'pinned', schemes: ['pinned'] }));
    const stored = registry.get('pinned');

    expect(Object.isFrozen(stored.schemes)).toBe(true);
    expect(() => {
      (stored.schemes as string[]).push('smuggled');
    }).toThrow(TypeError);
  });

  it('still lets a caller spread it into a new definition', () => {
    // How the extension tests put a fake in front of a real provider: the
    // spread produces a fresh object, so freezing the source costs nothing.
    const registry = new ProviderRegistry();
    registry.register(definition({ id: 'real', schemes: ['real'], displayName: 'real' }));
    const real = registry.get('real');

    const registration = registry.register({ ...real, id: 'real-test', schemes: ['real-test'] });
    expect(registry.get('real-test').displayName).toBe('real');

    registration[Symbol.dispose]();
    expect(registry.tryGet('real-test')).toBeUndefined();
    // Disposing the copy must not have taken the original's scheme with it.
    expect(registry.getByScheme('real')?.id).toBe('real');
  });
});
