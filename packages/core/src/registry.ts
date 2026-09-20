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

  /**
   * Takes ownership of `definition`: it is frozen in place, along with its
   * `schemes` array, and stays frozen after the returned Disposable runs.
   *
   * So a caller adapting an already-registered definition — swapping `create`
   * to inject a fixed instance or fixed credentials, as the test helpers and
   * the live suite both do — must spread it into a fresh object
   * (`{ ...existing, id, create }`) rather than edit it. Assigning to a
   * property of a registered definition fails silently outside strict mode
   * and throws inside it. This matters beyond this repo now that the host
   * publishes the registry to co-resident extensions.
   */
  register(definition: ProviderDefinition): Disposable {
    if (this.#byId.has(definition.id)) {
      throw new OmniFsError({
        code: 'AlreadyExists',
        message: `Provider already registered: ${definition.id}`,
        providerId: definition.id,
      });
    }

    // Frozen because `get()` hands this object to anyone — including, once the
    // host publishes the registry, a co-resident extension. `create` receives
    // `getSecret`, so an in-place swap would be a credential leak, and
    // `readonly` is compile-time only.
    //
    // This is hygiene, not a boundary: VS Code does not isolate extensions
    // from one another. It closes the in-place swap and nothing more.
    //
    // `schemes` is frozen separately because `Object.freeze` is shallow and
    // the Disposable below iterates that array at disposal time.
    Object.freeze(definition.schemes);
    Object.freeze(definition);

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
