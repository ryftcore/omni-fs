import { OmniFsError } from './errors.js';
import type { ProviderDefinition } from './provider.js';
import type { ProviderId } from './model/connection.js';

/**
 * The extension point. Providers are registered at host startup; core resolves
 * them by id and never imports one.
 *
 * Consequence: `apps/desktop` gains a protocol by calling `register()`, exactly
 * as `apps/vscode` does. Neither host contains protocol-specific code, and the
 * fifth protocol costs one package plus one line per host.
 */
export class ProviderRegistry {
  readonly #byId = new Map<ProviderId, ProviderDefinition>();
  readonly #byScheme = new Map<string, ProviderDefinition>();

  register(definition: ProviderDefinition): Disposable {
    if (this.#byId.has(definition.id)) {
      throw new OmniFsError({
        code: 'AlreadyExists',
        message: `Provider already registered: ${definition.id}`,
        providerId: definition.id,
      });
    }

    this.#byId.set(definition.id, definition);
    for (const scheme of definition.schemes) this.#byScheme.set(scheme, definition);

    return {
      [Symbol.dispose]: () => {
        this.#byId.delete(definition.id);
        for (const scheme of definition.schemes) this.#byScheme.delete(scheme);
      },
    };
  }

  get(id: ProviderId): ProviderDefinition {
    const definition = this.#byId.get(id);
    if (definition === undefined) {
      throw new OmniFsError({
        code: 'NotFound',
        message: `No provider registered for "${id}". Is its package registered at startup?`,
        providerId: id,
      });
    }
    return definition;
  }

  tryGet(id: ProviderId): ProviderDefinition | undefined {
    return this.#byId.get(id);
  }

  getByScheme(scheme: string): ProviderDefinition | undefined {
    return this.#byScheme.get(scheme);
  }

  list(): readonly ProviderDefinition[] {
    return [...this.#byId.values()];
  }
}
