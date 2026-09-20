# VS Code Extension Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the real extension inside a real VS Code Extension Development Host, so that the host layer — URI translation, the error table, the port adapters, the manifest, and the minified bundle itself — is covered by tests, and fix the two shipped bugs that writing those tests exposes.

**Architecture:** A second test framework, kept entirely separate from Vitest. Mocha runs inside an Electron extension host launched by `@vscode/test-cli`; its sources live under `apps/vscode/src/test/` and compile with esbuild to `out-test/`, never to `out/`, which stays free to hold the production bundle. Two labels: `hermetic` drives `vscode.workspace.fs` over an in-memory provider and needs no network, `live` drives the **minified** bundle against the `compose.yaml` servers. Neither joins `pnpm test`.

**Tech Stack:** `@vscode/test-cli` + `@vscode/test-electron` (Electron host + runner), Mocha with the `tdd` interface (`suite`/`test`/`suiteSetup`/`suiteTeardown`), `node:assert/strict` for assertions, esbuild for the test bundles, `@omni-fs/testing`'s `MemoryFileSystem` as the in-memory disk, the existing `compose.yaml` stack (MinIO, OpenSSH, nginx-webdav) for the live label.

**Spec:** `docs/superpowers/specs/2026-09-20-vscode-extension-tests-design.md`. It carries the eight decisions this plan implements and the reasoning behind each; read it before Task 1. The binding contracts are `packages/core/src/provider.ts`, `packages/core/src/fs/managed-file-system.ts` and `apps/vscode/src/fs/omni-file-system-provider.ts`.

## Global Constraints

- Nothing in `packages/` may import `vscode` or `electron`. Nothing in `packages/core` may import a protocol SDK. Enforced by `eslint.config.mjs` and two CI greps. This plan touches `packages/core` twice (Tasks 1 and 2) and adds no imports to either file.
- `apps/vscode` is the only place `vscode` may be imported — including from `apps/vscode/src/test/**`, which is inside the app.
- Commits are a single title line, `:emoji: <type> <description>`, no body. Never add `Co-Authored-By`, `Generated with Claude Code`, or any session attribution. CI checks the title against `^:[a-z0-9_+-]+: (feat|fix|docs|refactor|test|build|chore|perf|style|ci) .+` and fails any commit whose body is non-empty.
- **Never run `pnpm format`.** Run `pnpm exec prettier --write <the files you touched>` instead.
- TypeScript is held at 6.0.x; `@types/node` at 22; `@types/vscode` at `^1.90.0`. Strictness includes `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` — so optional properties are written `| undefined`, a type-only import must say `import type`, and an indexed read is `T | undefined` until you narrow it.
- `.npmrc` sets `hoist=false`: a package may only import what its own `package.json` declares. Every new dependency in this plan is declared in `apps/vscode/package.json`.
- `apps/vscode` resolves `@omni-fs/*` through each package's `dist/`, not its source. After changing anything under `packages/`, run `pnpm build` before the extension's typecheck or test run means anything.
- `pnpm test` must stay hermetic, headless and fast. Nothing this plan adds may join it: the extension suite is `pnpm test:extension`, and the live label is `pnpm test:extension:live`.
- The `compose.yaml` credentials (`omnifs` / `omnifs-dev-secret`) are committed on purpose and must never be used anywhere real. Nothing in this plan binds to a public interface.
- The extension id is `ryftcore.omni-fs-vscode` — `publisher` plus `name` from `apps/vscode/package.json`, not the `displayName`.

---

## File Structure

| File                                                       | Responsibility                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/core/src/errors.ts` (modify)                     | `OmniFsError.is` becomes a realm-global brand check                                              |
| `packages/core/src/errors.test.ts` (modify)                | the cross-bundle case                                                                            |
| `packages/core/src/registry.ts` (modify)                   | `register()` freezes the definition it stores                                                    |
| `packages/core/src/registry.test.ts` (modify)              | the freeze, and that the spread-and-re-register pattern still works                              |
| `apps/vscode/package.json` (modify)                        | four devDependencies, three scripts, typecheck gains a third program                             |
| `apps/vscode/esbuild.mjs` (modify)                         | a `--tests` target emitting to `out-test/`, never minified, always sourcemapped                  |
| `apps/vscode/tsconfig.json` (modify)                       | excludes `src/test/**` so Mocha globals stay out of the extension's own program                  |
| `apps/vscode/tsconfig.test.json` (create)                  | the test program: `types: ["node", "vscode", "mocha"]`                                           |
| `apps/vscode/.vscode-test.mjs` (create)                    | the two labelled configurations                                                                  |
| `apps/vscode/src/extension.ts` (modify)                    | returns `OmniFsApi`; passes `configStore` to the filesystem provider                             |
| `apps/vscode/src/fs/omni-file-system-provider.ts` (modify) | reads the connection's `readOnly`; fires `Changed` rather than `Created` on an overwrite         |
| `apps/vscode/src/test/helpers.ts` (create)                 | activate, register a pinned in-memory provider, save and clean up its connection                 |
| `apps/vscode/src/test/fixtures/workspace/.gitkeep`         | a real, empty folder for the host to open                                                        |
| `apps/vscode/src/test/fixtures/known_hosts`                | empty, pinned, so the live SFTP suite ignores the developer's own                                |
| `apps/vscode/src/test/hermetic/activation.test.ts`         | manifest against code: commands, providers, configuration keys                                   |
| `apps/vscode/src/test/hermetic/file-system.test.ts`        | `vscode.workspace.fs` over `omnifs://`, including read-only refusal                              |
| `apps/vscode/src/test/hermetic/provider-direct.test.ts`    | the branches `workspace.fs` cannot reach: `create`/`overwrite` flags, change events              |
| `apps/vscode/src/test/hermetic/errors.test.ts`             | the `OmniFsError` to `FileSystemError` table                                                     |
| `apps/vscode/src/test/hermetic/ports.test.ts`              | `VsCodeConfigStore` against the real API; `VsCodeSecretStore` and `VsCodeLogger` against doubles |
| `apps/vscode/src/test/live/bundled-sdk.test.ts`            | the minified bundle's SFTP, WebDAV and S3 move bytes                                             |
| `turbo.json` (modify)                                      | `build:tests`, `test:extension`, `test:extension:live`                                           |
| `package.json` (modify)                                    | root passthroughs for the two test scripts                                                       |
| `.gitignore` (modify)                                      | `out-test/` — the existing `out/` entry does not match it                                        |
| `.vscode/launch.json` (create or modify)                   | a debug target for the hermetic label                                                            |
| `.github/workflows/ci.yml` (modify)                        | `extension tests` on three OSes; `extension tests (live)` on ubuntu                              |
| `CLAUDE.md`, `README.md`, `docker/README.md` (modify)      | the test story these files currently describe is now out of date                                 |

Task order is: the two core fixes first, because everything downstream depends on them; then the harness; then the suites, with each production bug fixed in the task whose test exposes it; then CI and docs.

---

### Task 1: `OmniFsError.is` stops being an identity check

**Files:**

- Modify: `packages/core/src/errors.ts`
- Test: `packages/core/src/errors.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `OmniFsError.is(value: unknown): value is OmniFsError` now returns `true` for any error carrying the realm-global brand `Symbol.for('omni-fs.error')`, whoever built it. Every later task depends on this: the hermetic tests throw `OmniFsError` from a `MemoryFileSystem` bundled into `out-test/`, and the extension's `toVsCodeError` in `out/` has to recognise it.

**Why this is a product fix and not test scaffolding.** `instanceof` compares class identity, and esbuild gives every bundle its own class object. Today that bites the tests; after Task 3 publishes the registry it bites production, because a third-party extension registering a provider bundles its own copy of `@omni-fs/core` and its errors are foreign. An unrecognised `OmniFsError` reaches `toVsCodeError`, falls through the `if (!OmniFsError.is(error))` guard untranslated, and the editor reports a generic failure for every remote error — no create-on-save, no read-only editor. `ManagedFileSystem.#exists` has the same problem in the other direction: it rethrows a `NotFound` it does not recognise, which breaks create-parents on write.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/errors.test.ts`. Add `vi` to the existing `vitest` import if it is not already there.

```ts
describe('OmniFsError.is across module copies', () => {
  it('recognises an error built by a second instance of this module', async () => {
    // esbuild gives the extension bundle and the test bundle each their own
    // class object, so `instanceof` answers "no" for an error that is an
    // OmniFsError in every way that matters. `vi.resetModules()` reproduces
    // that here without a bundler: the dynamic import below re-evaluates
    // errors.ts and hands back a different class.
    vi.resetModules();
    const second = await import('./errors.js');
    const foreign = new second.OmniFsError({ code: 'NotFound', message: 'gone' });

    expect(second.OmniFsError).not.toBe(OmniFsError);
    expect(foreign instanceof OmniFsError).toBe(false);
    expect(OmniFsError.is(foreign)).toBe(true);
  });

  it('recognises a structurally identical error carrying the brand', () => {
    // The contract stated without relying on module-registry mechanics: the
    // brand is the whole test. Anything carrying it is one of ours.
    const branded = Object.defineProperty(new Error('gone'), Symbol.for('omni-fs.error'), {
      value: true,
    });

    expect(OmniFsError.is(branded)).toBe(true);
  });

  it('still refuses anything without the brand', () => {
    expect(OmniFsError.is(new Error('ordinary'))).toBe(false);
    expect(OmniFsError.is({ code: 'NotFound', message: 'shaped like one' })).toBe(false);
    expect(OmniFsError.is(null)).toBe(false);
    expect(OmniFsError.is(undefined)).toBe(false);
    expect(OmniFsError.is('NotFound')).toBe(false);
  });

  it('keeps the brand off anything that serialises the error', () => {
    // Non-enumerable: a spread-based copy of the error must not carry the
    // brand, or every logged error grows a mystery symbol key. (The brand is
    // separately absent after any postMessage hop, since structuredClone
    // drops symbol-keyed properties regardless of enumerability — that is not
    // what this assertion is about.)
    //
    // `Object.getOwnPropertySymbols`, not `Object.keys`: Object.keys returns
    // only String-keyed properties and never surfaces a symbol, so asserting
    // on it here would pass even with the brand marked enumerable.
    const error = new OmniFsError({ code: 'NotFound', message: 'gone' });
    expect(Object.getOwnPropertySymbols({ ...error })).not.toContain(Symbol.for('omni-fs.error'));
    expect(Object.getOwnPropertyDescriptor(error, Symbol.for('omni-fs.error'))?.enumerable).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Run the tests and watch two of them fail**

```bash
pnpm --filter @omni-fs/core exec vitest run src/errors.test.ts
```

Expected: the two "recognises …" cases FAIL (`is()` returns `false`), plus the brand-descriptor case FAILS (no such property). "still refuses anything without the brand" passes already.

- [ ] **Step 3: Brand the error**

In `packages/core/src/errors.ts`, add the symbol above the class:

```ts
/**
 * Realm-global, so two copies of this module agree about their own errors.
 *
 * `instanceof` cannot: it compares class identity, and every esbuild bundle
 * gets its own class object. The extension bundle, a test bundle, and a
 * third-party extension that registers a provider each carry a copy of this
 * module — and an OmniFsError one of them throws must still be recognised by
 * the others, or `toVsCodeError` passes it through untranslated and every
 * remote failure reaches the editor as a generic error.
 *
 * `Symbol.for` looks the symbol up in the process-wide registry, so all
 * copies resolve the same key.
 */
const OMNI_FS_ERROR = Symbol.for('omni-fs.error');
```

In the constructor, after `this.retryable = ...`:

```ts
// Non-enumerable: spreads, Object.keys and JSON.stringify must not see it.
Object.defineProperty(this, OMNI_FS_ERROR, { value: true });
```

Replace `is`:

```ts
  static is(value: unknown): value is OmniFsError {
    return typeof value === 'object' && value !== null && OMNI_FS_ERROR in value;
  }
```

- [ ] **Step 4: Run the tests and the rest of core**

```bash
pnpm --filter @omni-fs/core exec vitest run src/errors.test.ts
pnpm --filter @omni-fs/core test
```

Expected: PASS, both.

- [ ] **Step 5: Prove the whole workspace still agrees**

`ManagedFileSystem`, `OmniFsError.wrap`, the S3/SFTP/WebDAV providers and the shared conformance suite all branch on `OmniFsError.is`. Rebuild so dependents see the change, then run everything.

```bash
pnpm build
pnpm test
```

Expected: PASS. 604 tests before this task; three or four more now.

- [ ] **Step 6: Format and commit**

```bash
pnpm exec prettier --write packages/core/src/errors.ts packages/core/src/errors.test.ts
git add packages/core/src/errors.ts packages/core/src/errors.test.ts
git commit -m ":bug: fix recognise an OmniFsError thrown by another bundle"
```

---

### Task 2: A registered provider definition is frozen

**Files:**

- Modify: `packages/core/src/registry.ts`
- Test: `packages/core/src/registry.test.ts`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces: `ProviderRegistry.register(definition)` freezes `definition` and `definition.schemes` in place before storing them, and still returns the same `Disposable`. Tasks 4 and 9 depend on the spread-and-re-register pattern — `{ ...real, id, schemes, create }` — continuing to work against a frozen source object.

**Why.** Task 3 publishes the registry on `OmniFsApi`, so `registry.get('sftp')` hands a co-resident extension the live definition object. Replacing `create` in place would let it observe every SFTP credential, because `ProviderDefinition.create` receives `getSecret` and `readonly` is compile-time only. Freezing closes the in-place swap. Be honest about what it does not close: VS Code does not isolate extensions from one another, so this is hygiene, not a boundary — the spec says so and the code comment should too. Freezing `schemes` matters separately: the returned `Disposable` iterates it, so a mutated array after registration would make disposal delete the wrong scheme entries.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/registry.test.ts`. Reuse whatever definition factory that file already has; if it has none, add this one at the top of the new `describe`:

```ts
describe('register freezes what it stores', () => {
  function definition(id: string): ProviderDefinition {
    return {
      id,
      displayName: id,
      schemes: [id],
      settingsSchema: { fields: [] },
      secretSchema: { fields: [] },
      defaultCapabilities: MINIMAL_CAPABILITIES,
      create: () => {
        throw new Error('not needed for this test');
      },
    };
  }

  it('refuses an in-place swap of create()', () => {
    // The registry is published on the extension's API, so `get()` hands a
    // co-resident extension the live object. `create` receives `getSecret`,
    // so replacing it in place would hand over every credential.
    const registry = new ProviderRegistry();
    registry.register(definition('swappable'));
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
    registry.register(definition('pinned'));
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
    registry.register(definition('real'));
    const real = registry.get('real');

    const registration = registry.register({ ...real, id: 'real-test', schemes: ['real-test'] });
    expect(registry.get('real-test').displayName).toBe('real');

    registration[Symbol.dispose]();
    expect(registry.tryGet('real-test')).toBeUndefined();
    // Disposing the copy must not have taken the original's scheme with it.
    expect(registry.getByScheme('real')?.id).toBe('real');
  });
});
```

Add `MINIMAL_CAPABILITIES` and `type ProviderDefinition` to the file's imports from `./index.js` or their own modules, matching however the rest of that file imports.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @omni-fs/core exec vitest run src/registry.test.ts
```

Expected: the first two FAIL (`Object.isFrozen` is `false`, the assignment succeeds silently). The third passes already.

- [ ] **Step 3: Freeze on register**

In `packages/core/src/registry.ts`, replace the body of `register` between the duplicate-id guard and the `return`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @omni-fs/core exec vitest run src/registry.test.ts
pnpm --filter @omni-fs/core test
```

Expected: PASS.

- [ ] **Step 5: Prove nothing else mutated a definition after registering it**

```bash
pnpm build
pnpm test
pnpm typecheck
```

Expected: PASS. A failure here is a real find — something was writing to a registered definition — and it should be fixed at the writer, not by removing the freeze.

- [ ] **Step 6: Format and commit**

```bash
pnpm exec prettier --write packages/core/src/registry.ts packages/core/src/registry.test.ts
git add packages/core/src/registry.ts packages/core/src/registry.test.ts
git commit -m ":lock: fix freeze a registered provider definition in place"
```

---

### Task 3: The extension test harness, and the manifest it has to match

**Files:**

- Modify: `apps/vscode/package.json`
- Modify: `apps/vscode/esbuild.mjs`
- Modify: `apps/vscode/tsconfig.json`
- Modify: `apps/vscode/src/extension.ts`
- Create: `apps/vscode/tsconfig.test.json`
- Create: `apps/vscode/.vscode-test.mjs`
- Create: `apps/vscode/src/test/fixtures/workspace/.gitkeep`
- Create: `apps/vscode/src/test/hermetic/activation.test.ts`
- Modify: `turbo.json`, `package.json` (root), `.gitignore`
- Create: `.vscode/launch.json`

**Interfaces:**

- Consumes: `ProviderRegistry` from Task 2 (frozen definitions).
- Produces:
  - `export interface OmniFsApi { readonly registry: ProviderRegistry }` from `apps/vscode/src/extension.ts`, and `activate` now returns `OmniFsApi` rather than `void`. Tasks 4, 5 and 9 import this **type only**.
  - `pnpm test:extension` — builds `out/` and `out-test/`, launches an Electron host, runs `out-test/hermetic/**/*.test.js`.
  - `pnpm test:extension:live` — the same for `out-test/live/**/*.test.js`.
  - The extension id, used by every later test file: `ryftcore.omni-fs-vscode`.

**What this task delivers.** A working runner plus the one suite that needs nothing else: the manifest checked against the code. That suite is worth having on its own — `package.json` contributes twelve commands and nothing compares that list to what `registerCommands` registers, so a contributed-but-unregistered id shows up as "command not found" when a user clicks a menu entry.

- [ ] **Step 1: Add the dependencies**

```bash
pnpm --filter omni-fs-vscode add -D @vscode/test-cli @vscode/test-electron @types/mocha
pnpm --filter omni-fs-vscode add -D @omni-fs/testing@workspace:*
```

`@omni-fs/testing` is a devDependency, not a dependency: it is bundled only into `out-test/`, never into the `.vsix`. `.npmrc` sets `hoist=false`, so all four must be declared here or the imports will not resolve.

Verify the four landed and that the lockfile changed:

```bash
node -e "const d=require('./apps/vscode/package.json').devDependencies; console.log(JSON.stringify(d,null,2))"
git diff --stat pnpm-lock.yaml
```

Expected: `@vscode/test-cli`, `@vscode/test-electron`, `@types/mocha` and `"@omni-fs/testing": "workspace:*"` are present.

- [ ] **Step 2: Teach esbuild to build the test bundles**

Replace `apps/vscode/esbuild.mjs` entirely:

```js
import { readdirSync } from 'node:fs';
import { build, context } from 'esbuild';

/**
 * Bundles the extension into a single CommonJS file.
 *
 * Two reasons this is not optional. The VS Code extension host loads CommonJS,
 * while `packages/*` are ESM — bundling is the bridge. And a `.vsix` that ships
 * `node_modules` for four protocol SDKs is an order of magnitude larger and
 * slower to activate than one bundled file.
 *
 * `vscode` is external because the host provides it at runtime.
 */
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const withTests = process.argv.includes('--tests');

const shared = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/**
 * The extension host: CommonJS, Node, `vscode` provided at runtime.
 *
 * `cpu-features` is external because it is never built: `pnpm-workspace.yaml`
 * denies its install script, so the `.node` binary it requires does not exist
 * and esbuild cannot follow the import. `ssh2` asks for it inside a `try` and
 * falls back to its pure-JS crypto, so an unresolved require at runtime is the
 * outcome that was already chosen — bundling must not turn it into a build
 * failure.
 *
 * `*.node` is external for the mirror-image reason. `ssh2`'s install script
 * *is* allowed, so on a machine with a C++ toolchain — every CI runner —
 * `sshcrypto.node` exists, and esbuild has no loader for a native binary. The
 * require sits in the same `try` as `cpu-features`, and a bundled `.vsix`
 * cannot ship one runner's architecture anyway, so leaving it unresolved is
 * again the outcome already chosen. Without this the build passes on a machine
 * that never built the binding and fails on one that did.
 */
const nodeExternals = ['vscode', 'cpu-features', '*.node'];

/** @type {import('esbuild').BuildOptions} */
const extension = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: nodeExternals,
};

/**
 * The webview: a browser context with no Node and no `vscode` module. The CSS
 * imported by the entry point is emitted alongside as out/webview.css.
 */
/** @type {import('esbuild').BuildOptions} */
const webview = {
  ...shared,
  entryPoints: ['src/webview/index.tsx'],
  outfile: 'out/webview.js',
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
};

/**
 * The extension-host tests, one bundle per test file.
 *
 * They go to `out-test/`, never `out/`, for two reasons. turbo declares
 * `out/**` as the `build` task's output, so restoring a cached `build` can
 * delete whatever another task wrote there. And `out/` has to stay free to
 * hold the *production* bundle: the live label's entire claim is about the
 * artifact that ships, so there must exist a configuration in which minified
 * code and tests are both present. Separate directories give that —
 * `--production` controls minification, `--tests` controls the test build, and
 * they compose. Nothing under `out-test/` is inside the packaged extension, so
 * `.vscodeignore` needs no entry for it.
 *
 * Never minified and always sourcemapped, whatever `--production` says: a
 * failing assertion inside an Electron host is read off its stack trace or not
 * at all.
 *
 * `outbase` keeps `hermetic/` and `live/` as real directories under
 * `out-test/`, which is what the two `files` globs in `.vscode-test.mjs`
 * select on.
 */
function testEntryPoints() {
  return readdirSync('src/test', { recursive: true })
    .map((entry) => String(entry).replaceAll('\\', '/'))
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `src/test/${name}`);
}

/** @type {import('esbuild').BuildOptions} */
const tests = {
  ...shared,
  entryPoints: testEntryPoints(),
  outdir: 'out-test',
  outbase: 'src/test',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: nodeExternals,
  sourcemap: true,
  minify: false,
};

const targets = withTests ? [extension, webview, tests] : [extension, webview];

if (watch) {
  const contexts = await Promise.all(targets.map((target) => context(target)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(targets.map((target) => build(target)));
}
```

- [ ] **Step 3: Give the test sources their own TypeScript program**

Create `apps/vscode/tsconfig.test.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    // Same shape as the extension's own program (tsconfig.json): esbuild does
    // the bundling, tsc only type checks. The one difference is "mocha".
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true,
    "composite": false,
    "incremental": false,
    "declaration": false,
    "declarationMap": false,
    // "mocha" must NOT go in the extension's own program. It makes suite,
    // test, setup and teardown ambient in every file, which is exactly what
    // tsconfig.json rejects for "dom": a stray global should be a compile
    // error there, not a silent pass.
    "types": ["node", "vscode", "mocha"]
  },
  "include": ["src/test/**/*.ts"]
}
```

In `apps/vscode/tsconfig.json`, add `"src/test/**"` to `exclude` and extend its comment:

```json
  "exclude": [
    "src/webview/index.tsx",
    "src/webview/backend.ts",
    "src/webview/css.d.ts",
    "src/test/**"
  ]
```

Above `"include"`, append to the existing comment block:

```
  // src/test/** is excluded for the same reason the webview is: it needs
  // ambient Mocha globals that must not leak into the extension's own
  // program. It has its own: tsconfig.test.json.
```

- [ ] **Step 4: Configure the runner**

Create `apps/vscode/.vscode-test.mjs`. `@vscode/test-cli` discovers this file automatically and defaults `extensionDevelopmentPath` to its own directory.

```js
import { defineConfig } from '@vscode/test-cli';

/**
 * Two labels, run separately.
 *
 * `hermetic` needs no network and no Docker, so it runs on all three desktop
 * platforms in the normal PR path. `live` needs `compose.yaml` up and the
 * production bundle in `out/`, so it is Linux-only and runs in its own job.
 *
 * Neither joins `pnpm test`, which stays the fast hermetic loop. A 150 MB
 * editor download and an Electron launch do not belong in it — the same reason
 * `test:conformance` is kept out.
 */
const shared = {
  version: 'stable',
  // A committed, empty folder rather than a generated one, so the host always
  // opens something known. Some VS Code APIs behave differently with no folder
  // open at all.
  workspaceFolder: 'src/test/fixtures/workspace',
  // --disable-extensions turns off the *user's* installed extensions; the one
  // under development still loads. --disable-gpu is for headless CI, where
  // Electron's GPU process is a common source of flake.
  launchArgs: ['--disable-extensions', '--disable-gpu'],
};

export default defineConfig([
  {
    ...shared,
    label: 'hermetic',
    files: 'out-test/hermetic/**/*.test.js',
    // 20s rather than Mocha's 2s default: Electron on macOS and Windows
    // runners times out under load far more often than on Linux.
    mocha: { ui: 'tdd', timeout: 20_000 },
  },
  {
    ...shared,
    label: 'live',
    files: 'out-test/live/**/*.test.js',
    // Longer again: suiteSetup here waits for the compose stack's one-shot
    // seed container to finish chowning the SFTP volume.
    mocha: { ui: 'tdd', timeout: 60_000 },
  },
]);
```

Create the workspace fixture:

```bash
mkdir -p apps/vscode/src/test/fixtures/workspace
touch apps/vscode/src/test/fixtures/workspace/.gitkeep
```

- [ ] **Step 5: Publish `OmniFsApi` from `activate`**

In `apps/vscode/src/extension.ts`, add the interface above `activate`:

```ts
/**
 * What `activate` resolves to.
 *
 * A genuine public extension API, not only a test hook: `ProviderRegistry` is
 * already the documented extension point — "a new protocol is a new package
 * plus one `register()` call per host" — so publishing it means a third-party
 * extension can add a protocol with the same line this function uses below.
 * Unstable before 1.0.
 *
 * It deliberately does not carry the `SecretStore`, but be clear about how
 * small that is: `registry.get('sftp')` hands back the live definition, whose
 * `create` receives `getSecret`. `register()` freezes what it stores, which
 * closes the in-place swap; VS Code does not isolate extensions from one
 * another, so nothing here can close co-residency. Withholding the secret
 * store is hygiene, not a boundary.
 */
export interface OmniFsApi {
  readonly registry: ProviderRegistry;
}
```

Change the signature and add the return:

```ts
export function activate(context: vscode.ExtensionContext): OmniFsApi {
```

…and, immediately after the closing `logger.log('info', 'Omni-FS activated', { … });`:

```ts
  return { registry };
}
```

`ProviderRegistry` is already imported as a value; no import change is needed.

- [ ] **Step 6: Wire the scripts**

In `apps/vscode/package.json`, replace `dev` and `typecheck` and add three scripts:

```json
    "dev": "node esbuild.mjs --watch --tests",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.webview.json --noEmit && tsc -p tsconfig.test.json --noEmit",
    "build:tests": "node esbuild.mjs --tests",
    "test:extension": "vscode-test --label hermetic",
    "test:extension:live": "vscode-test --label live",
```

The `dev` change means the F5 loop rebuilds tests too, so a test edit is picked up without a separate command.

In `turbo.json`, add three tasks next to `test:conformance`:

```json
    "build:tests": {
      "dependsOn": ["^build"],
      "outputs": ["out-test/**"]
    },
    "test:extension": {
      "dependsOn": ["build", "build:tests"],
      "cache": false,
      "outputs": []
    },
    "test:extension:live": {
      "dependsOn": ["build", "build:tests"],
      "cache": false,
      "outputs": []
    },
```

`cache: false` matches `test:conformance`: launching an editor is not a cacheable pure function of the inputs.

In the root `package.json` scripts, after `"test:conformance"`:

```json
    "test:extension": "turbo run test:extension",
    "test:extension:live": "turbo run test:extension:live",
```

In `.gitignore`, add `out-test/` immediately after the `out/` line — the existing entry does not match it:

```
out/
out-test/
```

- [ ] **Step 7: Add a debug target**

Create `.vscode/launch.json` (or add this configuration if the file exists):

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Extension tests (hermetic)",
      "type": "extensionHost",
      "request": "launch",
      "args": [
        "--extensionDevelopmentPath=${workspaceFolder}/apps/vscode",
        "--extensionTestsPath=${workspaceFolder}/apps/vscode/out-test/hermetic",
        "${workspaceFolder}/apps/vscode/src/test/fixtures/workspace"
      ],
      "outFiles": ["${workspaceFolder}/apps/vscode/out-test/**/*.js"],
      "preLaunchTask": "npm: build:tests - omni-fs-vscode"
    }
  ]
}
```

Breakpoints inside the extension host pay for themselves the first time a test fails only in CI.

- [ ] **Step 8: Write the activation suite**

Create `apps/vscode/src/test/hermetic/activation.test.ts`:

```ts
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { OmniFsApi } from '../../extension.js';

/**
 * The manifest against the code.
 *
 * Assertions are derived from `package.json` only where the manifest is the
 * authority. Two places qualify: the contributed command list, because VS Code
 * enumerates what was actually registered; and the provider dependency list,
 * because a package added without its `register()` line is the failure this
 * architecture invites. Configuration runs the other way and is asserted from
 * the code side — see below.
 *
 * Note what is NOT here: tree views. No public API enumerates them, and the
 * auto-generated `<viewId>.focus` command is derived from the manifest itself,
 * so asserting on it would be tautological. That gap is real and recorded in
 * the spec's Risks rather than papered over.
 */

const EXTENSION_ID = 'ryftcore.omni-fs-vscode';

/**
 * Every `omniFs.*` key the code actually reads: five in `extension.ts` and
 * `connections` again in `VsCodeConfigStore`. Written out here rather than
 * derived from the manifest on purpose — asserting that a manifest key reads
 * back its own manifest default tests VS Code's configuration registry, not
 * this extension. The bug worth catching is code reading a key nobody
 * contributed, and only the code knows which keys those are.
 */
const KEYS_THE_CODE_READS = [
  'connections',
  'cache.ttlSeconds',
  'connection.idleTimeoutSeconds',
  'transfers.maxConcurrent',
  'logLevel',
] as const;

suite('activation', () => {
  let extension: vscode.Extension<OmniFsApi>;
  let api: OmniFsApi;

  suiteSetup(async () => {
    const found = vscode.extensions.getExtension<OmniFsApi>(EXTENSION_ID);
    assert.ok(found, `Extension ${EXTENSION_ID} was not loaded by the host`);
    extension = found;
    // `activationEvents` is `onFileSystem:omnifs`, so nothing has activated it
    // yet. This is the call that runs the composition root.
    api = await extension.activate();
  });

  test('returns its registry so a host or another extension can reach it', () => {
    assert.ok(api.registry, 'activate() must resolve to an OmniFsApi carrying the registry');
  });

  test('registers every command the manifest contributes', async () => {
    const contributed = (
      extension.packageJSON.contributes.commands as readonly { command: string }[]
    ).map((entry) => entry.command);
    assert.ok(contributed.length > 0, 'manifest contributes no commands — read the wrong field?');

    // `true` excludes VS Code's internal commands, and the list is of
    // *registered* ids — so a command contributed to a menu but never
    // registered shows up here, which is exactly the "command not found"
    // a user hits when they click that menu entry.
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = contributed.filter((id) => !registered.has(id));

    assert.deepEqual(missing, [], `contributed but never registered: ${missing.join(', ')}`);
  });

  test('registers a provider for every @omni-fs/provider-* dependency', () => {
    const dependencies = Object.keys(
      extension.packageJSON.dependencies as Readonly<Record<string, string>>,
    );
    const expected = dependencies
      .filter((name) => name.startsWith('@omni-fs/provider-'))
      .map((name) => name.slice('@omni-fs/provider-'.length));
    assert.ok(expected.length > 0, 'no provider packages in dependencies — read the wrong field?');

    // Derived rather than hardcoded because the failure this catches is a
    // fifth package added and the register() line forgotten. A list of four
    // would pass that day and be wrong.
    const registered = new Set(api.registry.list().map((definition) => definition.id));
    const missing = expected.filter((id) => !registered.has(id));

    assert.deepEqual(
      missing,
      [],
      `package depended on but never registered: ${missing.join(', ')}`,
    );
  });

  test('every configuration key the code reads has a contributed default', () => {
    const configuration = vscode.workspace.getConfiguration('omniFs');
    for (const key of KEYS_THE_CODE_READS) {
      const inspected = configuration.inspect(key);
      assert.ok(inspected, `omniFs.${key} is read by the code but is not a known setting`);
      // `inspect` rather than `get`: a user or workspace value would otherwise
      // mask a missing contribution and the test would pass on a dev machine
      // and fail nowhere.
      assert.notEqual(
        inspected.defaultValue,
        undefined,
        `omniFs.${key} is read by the code but contributes no default`,
      );
    }
  });
});
```

- [ ] **Step 9: Run it**

```bash
pnpm build
pnpm --filter omni-fs-vscode build:tests
pnpm --filter omni-fs-vscode test:extension
```

The first run downloads roughly 150 MB of VS Code into `apps/vscode/.vscode-test/` (already git-ignored). Expected: an Electron window opens, four tests pass, the process exits 0.

On Linux without a display, prefix with `xvfb-run -a`.

- [ ] **Step 10: Prove the suite can fail**

A suite that passes on its first run has proved nothing yet. Break the thing it watches and confirm it goes red.

In `apps/vscode/src/commands/index.ts`, temporarily comment out the registration of `omniFs.refresh`, then:

```bash
pnpm --filter omni-fs-vscode build:tests && pnpm --filter omni-fs-vscode build
pnpm --filter omni-fs-vscode test:extension
```

Expected: FAIL — `contributed but never registered: omniFs.refresh`.

Restore the line, rebuild, and confirm green again.

- [ ] **Step 11: Check the whole workspace still builds, types and lints**

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Expected: PASS. `typecheck` now runs three programs for `apps/vscode`; `lint` covers `src/test/**` under the existing `eslint src`.

- [ ] **Step 12: Format and commit**

```bash
pnpm exec prettier --write apps/vscode/package.json apps/vscode/esbuild.mjs \
  apps/vscode/tsconfig.json apps/vscode/tsconfig.test.json apps/vscode/.vscode-test.mjs \
  apps/vscode/src/extension.ts apps/vscode/src/test/hermetic/activation.test.ts \
  turbo.json package.json .vscode/launch.json
git add apps/vscode package.json turbo.json .gitignore .vscode/launch.json pnpm-lock.yaml
git commit -m ":white_check_mark: test run the extension in a real host and check its manifest"
```

---

### Task 4: The hermetic helper, and the `workspace.fs` round trip

**Files:**

- Create: `apps/vscode/src/test/helpers.ts`
- Create: `apps/vscode/src/test/hermetic/file-system.test.ts`

**Interfaces:**

- Consumes: `OmniFsApi` from Task 3; `OmniFsError.is` from Task 1 (the errors this suite provokes are thrown by a `MemoryFileSystem` in the test bundle and recognised by `toVsCodeError` in the extension bundle — this suite is that fix's end-to-end proof); `ProviderRegistry.register` from Task 2.
- Produces, from `apps/vscode/src/test/helpers.ts`:
  - `EXTENSION_ID: string`
  - `activateExtension(): Promise<OmniFsApi>`
  - `resetConnections(): Promise<void>`
  - `interface TestConnection { readonly connectionId: string; readonly disk: MemoryFileSystem; uri(path: string): vscode.Uri; dispose(): Promise<void> }`
  - `connectMemory(options: { api: OmniFsApi; id: string; seed?: Readonly<Record<string, string>>; readOnly?: boolean }): Promise<TestConnection>`
  - `saveConnection(config: ConnectionConfig): Promise<void>` and `removeConnection(id: string): Promise<void>`
  - `bytes(text: string): Uint8Array` and `text(data: Uint8Array): string`

  Tasks 5 and 8 use all of these.

**Four isolation hazards and how the helper answers each.**

1. **Settings.** Every file that saves a connection writes the same global `omniFs.connections` array, and `ports.test.ts` reads it. So: write in `suiteSetup`, remove in `suiteTeardown`, **and reset in `suiteSetup` as well** — the runner's user-data directory survives between local runs, so one crashed run otherwise leaves entries behind and the next run fails for no visible reason.
2. **The registry.** The extension activates once per host run, so the registry is shared across files. Each file registers under an id and a **scheme** unique to itself and disposes it in `suiteTeardown`. Distinct schemes matter as much as distinct ids: the registry maps schemes to definitions, so reusing `'sftp'` would overwrite the real entry and disposal would then delete it outright. `connectMemory` uses one string for provider id, scheme and connection id, which makes collisions impossible by construction.
3. **Registering is necessary and not sufficient.** The URI authority is a _connection id_, not a provider id. `#resolve` calls `manager.acquire(uri.authority)`, which calls `configStore.get(id)` and fails with `Unknown connection` before the registry is ever consulted. So every file opening an `omnifs://` URI must also save a `ConnectionConfig` whose `providerId` is its registered provider, and the activated extension's only `ConfigStore` is `VsCodeConfigStore` — which means writing `omniFs.connections` at `ConfigurationTarget.Global`.
4. **The entry cache.** `EntryCache` is built once at activation with a 15 second TTL and shared by every `ManagedFileSystem`. Seeding the in-memory disk directly _after_ a `stat` or `readDirectory` on the same path reads a stale answer. Rule: seed before first access — which `connectMemory` does, before the connection can be acquired — and make mid-test mutations through `vscode.workspace.fs`, which invalidates on write.

- [ ] **Step 1: Write the helper**

Create `apps/vscode/src/test/helpers.ts`:

```ts
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { MemoryFileSystem, memoryProvider } from '@omni-fs/testing';
import type { ConnectionConfig } from '@omni-fs/core';
import type { OmniFsApi } from '../extension.js';

/**
 * Shared setup for the hermetic suites.
 *
 * Note that `OmniFsApi` is imported as a *type*. `verbatimModuleSyntax` erases
 * it, so nothing here pulls `extension.ts` into the test bundle — which would
 * bundle a second copy of the whole extension and prove nothing about the one
 * the host loaded.
 *
 * `MemoryFileSystem` is a value import, so the test bundle does carry its own
 * copy of `@omni-fs/core`. That is the point: an `OmniFsError` thrown here is
 * a different class object from the extension bundle's, and these suites are
 * what proves the brand check in `OmniFsError.is` holds.
 */

export const EXTENSION_ID = 'ryftcore.omni-fs-vscode';

const SECTION = 'omniFs';
const CONNECTIONS = 'connections';

export async function activateExtension(): Promise<OmniFsApi> {
  const extension = vscode.extensions.getExtension<OmniFsApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} was not loaded by the host`);
  return extension.activate();
}

export interface TestConnection {
  readonly connectionId: string;
  /** The exact disk behind the connection, for seeding and for assertions. */
  readonly disk: MemoryFileSystem;
  /** Builds `omnifs://<connectionId><path>`. */
  uri(path: string): vscode.Uri;
  /** Unregisters the provider and removes the saved connection. */
  dispose(): Promise<void>;
}

/**
 * Registers a provider backed by one pinned in-memory disk, saves a connection
 * pointing at it, and hands back both.
 *
 * `memoryProvider.create` returns a *new* `MemoryFileSystem` per call, which
 * would leave the test with no handle on the bytes it is asserting about — so
 * the definition is spread and `create` is replaced with one that returns the
 * instance this function owns.
 *
 * `ConnectionManager` calls `getSecret` lazily and `MemoryFileSystem` never
 * calls it, so these connections need no keychain entry at all.
 *
 * Pass an `id` unique to the calling file: it becomes the provider id, the URI
 * scheme and the connection id at once, so two files cannot collide.
 */
export async function connectMemory(options: {
  api: OmniFsApi;
  id: string;
  seed?: Readonly<Record<string, string>> | undefined;
  readOnly?: boolean | undefined;
}): Promise<TestConnection> {
  const disk = new MemoryFileSystem();
  // Before the connection can be acquired, so the shared 15s EntryCache has
  // nothing stale to serve.
  if (options.seed !== undefined) disk.seed(options.seed);

  const registration = options.api.registry.register({
    ...memoryProvider,
    id: options.id,
    schemes: [options.id],
    create: () => disk,
  });

  const config: ConnectionConfig = {
    id: options.id,
    providerId: options.id,
    label: options.id,
    settings: {},
    ...(options.readOnly === true ? { readOnly: true } : {}),
  };
  await saveConnection(config);

  return {
    connectionId: options.id,
    disk,
    uri: (path: string) => vscode.Uri.from({ scheme: 'omnifs', authority: options.id, path }),
    dispose: async () => {
      registration[Symbol.dispose]();
      await removeConnection(options.id);
    },
  };
}

async function listConnections(): Promise<ConnectionConfig[]> {
  return [...vscode.workspace.getConfiguration(SECTION).get<ConnectionConfig[]>(CONNECTIONS, [])];
}

export async function saveConnection(config: ConnectionConfig): Promise<void> {
  const next = (await listConnections()).filter((candidate) => candidate.id !== config.id);
  next.push(config);
  await write(next);
}

export async function removeConnection(id: string): Promise<void> {
  const next = (await listConnections()).filter((candidate) => candidate.id !== id);
  await write(next);
}

/**
 * Clears the global setting outright.
 *
 * Called from every suite's `suiteSetup`, not only its teardown: the runner's
 * user-data directory survives between local runs, so a crashed run leaves
 * entries behind and the next run fails for no visible reason.
 */
export async function resetConnections(): Promise<void> {
  await write([]);
}

async function write(configs: readonly ConnectionConfig[]): Promise<void> {
  await vscode.workspace
    .getConfiguration(SECTION)
    // `undefined` removes the key entirely rather than storing an empty array,
    // which is what "as the user found it" means here.
    .update(
      CONNECTIONS,
      configs.length === 0 ? undefined : configs,
      vscode.ConfigurationTarget.Global,
    );
}

export function bytes(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

export function text(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

/** True when `error` is a `vscode.FileSystemError` with this code. */
export function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof vscode.FileSystemError && error.code === code;
}
```

- [ ] **Step 2: De-duplicate the extension id**

`activation.test.ts` declared its own `EXTENSION_ID` in Task 3, because `helpers.ts` did not exist yet. Now it does. In `apps/vscode/src/test/hermetic/activation.test.ts`, delete the local `const EXTENSION_ID = 'ryftcore.omni-fs-vscode';` and import it instead:

```ts
import { EXTENSION_ID } from '../helpers.js';
```

One spelling of the id, in one place.

- [ ] **Step 3: Check that `vitest` did not come along for the ride**

`helpers.ts` imports `@omni-fs/testing`, whose single entry point re-exports `runConformanceSuite` from `conformance.ts` — and that module imports `vitest`, which does not exist inside an extension host. Nothing here calls it, so esbuild should tree-shake it away. Verify rather than assume:

```bash
pnpm --filter omni-fs-vscode build:tests
grep -c "vitest" apps/vscode/out-test/hermetic/file-system.test.js || echo "clean: vitest is not in the bundle"
```

Expected: `clean: vitest is not in the bundle`.

If `vitest` **is** present, the package has no side-effect declaration and esbuild kept the import to be safe. The fix is structural and true — nothing in `@omni-fs/testing` has a module-level side effect — so add to `packages/testing/package.json`, next to `"type": "module"`:

```json
  "sideEffects": false,
```

Then `pnpm build && pnpm --filter omni-fs-vscode build:tests` and check again. Do not mark `vitest` external instead: that turns a build-time problem into a `Cannot find module 'vitest'` at runtime inside the host, which is strictly worse.

- [ ] **Step 4: Write the `workspace.fs` suite**

Create `apps/vscode/src/test/hermetic/file-system.test.ts`. Every assertion is about **what the host layer adds** — the tuple shape, the `FileType`, the `FileSystemError` code — not about the bytes, which is `runConformanceSuite`'s job and is already covered against four real servers.

```ts
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  activateExtension,
  bytes,
  connectMemory,
  isFileSystemError,
  resetConnections,
  text,
  type TestConnection,
} from '../helpers.js';

/**
 * The activated composition, driven the way a keystroke drives it: manifest,
 * registration, connection lookup, URI parsing, `ManagedFileSystem`, provider.
 *
 * This is also the end-to-end proof of the brand check. The errors asserted
 * below are thrown by a `MemoryFileSystem` living in *this* bundle and are
 * recognised by `toVsCodeError` in the *extension's* bundle. Before that fix
 * they arrived untranslated and every case expecting `FileNotFound` saw
 * `Unavailable` instead.
 */

const ID = 'omnifs-test-file-system';

suite('workspace.fs over omnifs://', () => {
  let connection: TestConnection;

  suiteSetup(async () => {
    await resetConnections();
    const api = await activateExtension();
    connection = await connectMemory({
      api,
      id: ID,
      seed: {
        '/readme.txt': 'hello omni-fs',
        '/docs/guide.md': '# Guide',
        '/docs/nested/deep.txt': 'three levels down',
      },
    });
  });

  suiteTeardown(async () => {
    await connection.dispose();
  });

  const statCases: readonly [string, vscode.FileType][] = [
    ['/readme.txt', vscode.FileType.File],
    ['/docs/guide.md', vscode.FileType.File],
    ['/docs', vscode.FileType.Directory],
    ['/docs/nested', vscode.FileType.Directory],
  ];

  for (const [path, type] of statCases) {
    test(`stat reports ${vscode.FileType[type]} for ${path}`, async () => {
      const stat = await vscode.workspace.fs.stat(connection.uri(path));
      assert.equal(stat.type, type);
    });
  }

  test('stat rejects a missing path as FileNotFound', async () => {
    // The code VS Code reads as "create this on save". Getting it wrong is the
    // difference between a new remote file saving and the editor reporting a
    // generic failure.
    await assert.rejects(
      () => vscode.workspace.fs.stat(connection.uri('/not-here.txt')),
      (error: unknown) => isFileSystemError(error, 'FileNotFound'),
    );
  });

  test('readDirectory returns [name, FileType] tuples with names, not paths', async () => {
    const entries = await vscode.workspace.fs.readDirectory(connection.uri('/docs'));
    const byName = new Map(entries);

    assert.equal(byName.get('guide.md'), vscode.FileType.File);
    assert.equal(byName.get('nested'), vscode.FileType.Directory);
    // core's DirEntry carries an absolute path; the host layer's job is to send
    // VS Code the bare name. A path here shows up as nested folders in the
    // Explorer that do not exist.
    assert.ok(
      !entries.some(([name]) => name.includes('/')),
      `readDirectory returned a path, not a name: ${JSON.stringify(entries)}`,
    );
  });

  test('readFile returns the seeded bytes', async () => {
    const data = await vscode.workspace.fs.readFile(connection.uri('/readme.txt'));
    assert.equal(text(data), 'hello omni-fs');
  });

  const writeCases: readonly [string, string, string][] = [
    ['creates a new file', '/written/new.txt', 'first'],
    ['replaces an existing file', '/readme.txt', 'replaced'],
  ];

  for (const [name, path, content] of writeCases) {
    test(`writeFile ${name}`, async () => {
      await vscode.workspace.fs.writeFile(connection.uri(path), bytes(content));
      assert.equal(text(await vscode.workspace.fs.readFile(connection.uri(path))), content);
    });
  }

  test('createDirectory creates a directory stat then reports', async () => {
    const uri = connection.uri('/fresh-directory');
    await vscode.workspace.fs.createDirectory(uri);
    assert.equal((await vscode.workspace.fs.stat(uri)).type, vscode.FileType.Directory);
  });

  test('rename moves a file and the old path is gone', async () => {
    const from = connection.uri('/rename-me.txt');
    const to = connection.uri('/renamed.txt');
    await vscode.workspace.fs.writeFile(from, bytes('moved'));

    await vscode.workspace.fs.rename(from, to);

    assert.equal(text(await vscode.workspace.fs.readFile(to)), 'moved');
    await assert.rejects(
      () => vscode.workspace.fs.stat(from),
      (error: unknown) => isFileSystemError(error, 'FileNotFound'),
    );
  });

  test('copy duplicates a file within one connection', async () => {
    const from = connection.uri('/copy-me.txt');
    const to = connection.uri('/copied.txt');
    await vscode.workspace.fs.writeFile(from, bytes('payload'));

    await vscode.workspace.fs.copy(from, to);

    assert.equal(text(await vscode.workspace.fs.readFile(to)), 'payload');
    assert.equal(text(await vscode.workspace.fs.readFile(from)), 'payload');
  });

  test('delete with recursive removes a populated directory', async () => {
    const dir = connection.uri('/doomed');
    await vscode.workspace.fs.writeFile(connection.uri('/doomed/one.txt'), bytes('1'));
    await vscode.workspace.fs.writeFile(connection.uri('/doomed/deeper/two.txt'), bytes('2'));

    await vscode.workspace.fs.delete(dir, { recursive: true });

    await assert.rejects(
      () => vscode.workspace.fs.stat(connection.uri('/doomed/one.txt')),
      (error: unknown) => isFileSystemError(error, 'FileNotFound'),
    );
  });

  test('an authority naming no saved connection fails as FileNotFound', async () => {
    // `#resolve` calls `manager.acquire(authority)`, which asks the ConfigStore
    // before the registry is ever consulted. Registering a provider is not
    // enough to make a URI resolvable — there has to be a saved connection.
    const stray = vscode.Uri.from({
      scheme: 'omnifs',
      authority: 'no-such-connection',
      path: '/a',
    });
    await assert.rejects(
      () => vscode.workspace.fs.stat(stray),
      (error: unknown) => isFileSystemError(error, 'FileNotFound'),
    );
  });
});
```

- [ ] **Step 5: Run it**

```bash
pnpm build
pnpm --filter omni-fs-vscode build:tests
pnpm --filter omni-fs-vscode test:extension
```

Expected: PASS, activation's four plus this file's fifteen.

If the missing-path cases fail with `Unavailable` rather than `FileNotFound`, Task 1's brand check did not land or `pnpm build` was not re-run after it — the extension resolves `@omni-fs/core` through `dist/`, not source.

- [ ] **Step 6: Prove the brand check is load-bearing**

These cases pass whether or not Task 1 happened, unless you check. Temporarily revert `OmniFsError.is` in `packages/core/src/errors.ts` to `return value instanceof OmniFsError;`, then:

```bash
pnpm build && pnpm --filter omni-fs-vscode build:tests
pnpm --filter omni-fs-vscode test:extension
```

Expected: FAIL — every `FileNotFound` assertion now sees `Unavailable`, because the `OmniFsError` thrown by the test bundle's `MemoryFileSystem` is not an `instanceof` the extension bundle's class.

Restore the brand check, rebuild, and confirm green.

- [ ] **Step 7: Format and commit**

```bash
pnpm exec prettier --write apps/vscode/src/test/helpers.ts \
  apps/vscode/src/test/hermetic/file-system.test.ts \
  apps/vscode/src/test/hermetic/activation.test.ts
git add apps/vscode/src/test
git commit -m ":white_check_mark: test round-trip workspace.fs over an omnifs uri"
```

---

### Task 5: A read-only connection refuses writes from the editor

**Files:**

- Modify: `apps/vscode/src/fs/omni-file-system-provider.ts`
- Modify: `apps/vscode/src/extension.ts`
- Modify: `apps/vscode/src/test/hermetic/file-system.test.ts`

**Interfaces:**

- Consumes: `connectMemory({ readOnly: true })` from Task 4.
- Produces: `OmniFileSystemProvider`'s constructor options gain `configStore: ConfigStore`. Task 6 and Task 7 construct this class directly and must pass it.

**The bug.** `ConnectionConfig.readOnly` is editable in the Connection Manager and drawn as a lock in the connections tree. `ManagedFileSystem` implements it properly: it clears `canWrite`, `canRename`, `canCreateDirectory` and `canDeleteRecursive`, and `#assertWritable` throws `PermissionDenied` before anything reaches the network. But `OmniFileSystemProvider.#resolve` constructs `ManagedFileSystem` without the flag and never reads the config at all — it has only the `connectionId`. **So a connection marked read-only is writable from the editor today.** Every layer is individually correct and the wiring between them is wrong.

- [ ] **Step 1: Write the failing tests**

Append a second suite to `apps/vscode/src/test/hermetic/file-system.test.ts`:

```ts
const READ_ONLY_ID = 'omnifs-test-read-only';

suite('a connection saved with readOnly: true', () => {
  let connection: TestConnection;

  suiteSetup(async () => {
    const api = await activateExtension();
    connection = await connectMemory({
      api,
      id: READ_ONLY_ID,
      readOnly: true,
      seed: { '/readme.txt': 'untouched' },
    });
  });

  suiteTeardown(async () => {
    await connection.dispose();
  });

  test('still reads', async () => {
    // Read-only has to mean read-only, not broken.
    assert.equal(
      text(await vscode.workspace.fs.readFile(connection.uri('/readme.txt'))),
      'untouched',
    );
    assert.equal(
      (await vscode.workspace.fs.stat(connection.uri('/readme.txt'))).type,
      vscode.FileType.File,
    );
  });

  const refusals: readonly [string, () => Thenable<unknown>][] = [
    [
      'writeFile',
      () => vscode.workspace.fs.writeFile(connection.uri('/readme.txt'), bytes('nope')),
    ],
    ['delete', () => vscode.workspace.fs.delete(connection.uri('/readme.txt'))],
    [
      'rename',
      () => vscode.workspace.fs.rename(connection.uri('/readme.txt'), connection.uri('/moved.txt')),
    ],
    ['createDirectory', () => vscode.workspace.fs.createDirectory(connection.uri('/new-folder'))],
  ];

  for (const [name, call] of refusals) {
    test(`refuses ${name} as NoPermissions`, async () => {
      // NoPermissions is the code that makes VS Code show a read-only editor
      // rather than a failed save, which is the whole point of the flag.
      await assert.rejects(call, (error: unknown) => isFileSystemError(error, 'NoPermissions'));
    });
  }

  test('leaves the file exactly as it was', async () => {
    assert.equal(
      text(await vscode.workspace.fs.readFile(connection.uri('/readme.txt'))),
      'untouched',
    );
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm --filter omni-fs-vscode build:tests
pnpm --filter omni-fs-vscode test:extension
```

Expected: the four `refuses …` cases FAIL — every call succeeds — and `leaves the file exactly as it was` FAILS because `readme.txt` now says `nope`. That is the bug, reproduced.

- [ ] **Step 3: Give the provider the config store**

In `apps/vscode/src/fs/omni-file-system-provider.ts`, add `ConfigStore` to the type imports:

```ts
import type {
  ConfigStore,
  ConnectionManager,
  DirEntry,
  EntryCache,
  Logger,
  RemoteFileSystem,
} from '@omni-fs/core';
```

Add the field and constructor parameter:

```ts
  readonly #manager: ConnectionManager;
  readonly #configStore: ConfigStore;
  readonly #cache: EntryCache;
```

```ts
  constructor(options: {
    manager: ConnectionManager;
    configStore: ConfigStore;
    cache: EntryCache;
    logger: Logger;
  }) {
    this.#manager = options.manager;
    this.#configStore = options.configStore;
    this.#cache = options.cache;
    this.#logger = options.logger;
  }
```

- [ ] **Step 4: Read the flag where the wrapper is built**

Replace the memoisation block inside `#resolve`:

```ts
// One ManagedFileSystem per live provider instance, so the cache and the
// emulation state survive across calls but are dropped when the underlying
// connection is replaced.
let managed = this.#wrapped.get(raw);
if (managed === undefined) {
  // The connection's own read-only flag. `#resolve` has only the id, so
  // this is the one place the config can be reached — and without it the
  // lock shown in the tree does nothing: ManagedFileSystem implements
  // read-only properly and was simply never told.
  //
  // Read when the wrapper is built, which is memoised per live provider
  // instance, so a change to the flag takes effect on the next connect.
  // That is how every other connection setting already behaves.
  const config = await this.#configStore.get(connectionId);
  managed = new ManagedFileSystem({
    connectionId,
    inner: raw,
    cache: this.#cache,
    logger: this.#logger.child(connectionId),
    readOnly: config?.readOnly ?? false,
  });
  this.#wrapped.set(raw, managed);
}
```

- [ ] **Step 5: Pass it from the composition root**

In `apps/vscode/src/extension.ts`, the `configStore` is already constructed above. Change the one line:

```ts
const fileSystemProvider = new OmniFileSystemProvider({ manager, configStore, cache, logger });
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm --filter omni-fs-vscode build && pnpm --filter omni-fs-vscode build:tests
pnpm --filter omni-fs-vscode test:extension
```

Expected: PASS, all of it. The writable suite from Task 4 must still be green — it saves no `readOnly`, so `config?.readOnly ?? false` gives `false`.

- [ ] **Step 7: Typecheck and lint**

```bash
pnpm typecheck
pnpm lint
```

Expected: PASS. If `typecheck` complains about `readOnly: config?.readOnly ?? false`, note that `ManagedFileSystemOptions.readOnly` is `boolean` and not `boolean | undefined` — the `?? false` is what satisfies `exactOptionalPropertyTypes`, so keep it.

- [ ] **Step 8: Format and commit**

```bash
pnpm exec prettier --write apps/vscode/src/fs/omni-file-system-provider.ts \
  apps/vscode/src/extension.ts apps/vscode/src/test/hermetic/file-system.test.ts
git add apps/vscode/src
git commit -m ":bug: fix honour a connection's read-only flag in the editor"
```

---

### Task 6: The branches `workspace.fs` cannot reach

**Files:**

- Create: `apps/vscode/src/test/hermetic/provider-direct.test.ts`
- Modify: `apps/vscode/src/fs/omni-file-system-provider.ts`

**Interfaces:**

- Consumes: `OmniFileSystemProvider`'s constructor, now `{ manager, configStore, cache, logger }` from Task 5.
- Produces: nothing later tasks import. `writeFile` changes behaviour: it now fires `Changed` for an overwrite and `Created` only for a genuinely new file.

**Why a second way in.** `vscode.workspace.fs` is a narrowed API. It always sends `create: true, overwrite: true`, so `writeFile`'s `create: false` branch — the one piece of genuine logic in the class, written because "core has no equivalent flag" — is unreachable through it, and so is `overwrite: false`. Change events fire on a private emitter that `workspace.fs` does not surface either. So this file constructs `OmniFileSystemProvider` directly, over core's `ConnectionManager` with `InMemoryConfigStore`/`InMemorySecretStore` and a `MemoryFileSystem`. Everything in it comes from one bundle, so it needs no activation, no registered scheme and no global settings — and it tests the class rather than the composition, which is why it complements the Task 4 suite instead of replacing it.

**The change-event bug.** `writeFile` fires `options.create ? Created : Changed`, and VS Code sends `create: true` on every ordinary save — so an overwrite currently reports `Created`. The spec is explicit that this is a bug to fix in the provider, not an assertion to relax: an editor or extension listening for `Created` sees files appear that were already there.

- [ ] **Step 1: Write the failing tests**

Create `apps/vscode/src/test/hermetic/provider-direct.test.ts`:

```ts
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  ConnectionManager,
  EntryCache,
  InMemoryConfigStore,
  InMemorySecretStore,
  NOOP_LOGGER,
  ProviderRegistry,
} from '@omni-fs/core';
import type { FileStat, RemotePath } from '@omni-fs/core';
import { MemoryFileSystem, memoryProvider } from '@omni-fs/testing';
import { OmniFileSystemProvider } from '../../fs/omni-file-system-provider.js';
import { bytes, isFileSystemError, text } from '../helpers.js';

/**
 * `OmniFileSystemProvider` constructed directly, because `workspace.fs` cannot
 * reach parts of it.
 *
 * `workspace.fs` always sends `create: true, overwrite: true`, so two of this
 * class's three real decisions are unreachable through it, and the change
 * emitter is private to the provider — VS Code surfaces it to watchers, not to
 * callers. Nothing here is activated, registered or saved to settings: one
 * bundle, one object graph, no shared state with any other file.
 */

const ID = 'direct';

/** A MemoryFileSystem whose `stat` can be made to answer anything. */
class StubFileSystem extends MemoryFileSystem {
  #override: ((path: RemotePath) => FileStat | undefined) | undefined;

  /** Next `stat` for a path this returns a value for answers with it. */
  overrideStat(answer: (path: RemotePath) => FileStat | undefined): void {
    this.#override = answer;
  }

  override async stat(path: RemotePath, signal?: AbortSignal): Promise<FileStat> {
    return this.#override?.(path) ?? (await super.stat(path, signal));
  }
}

interface Harness {
  readonly provider: OmniFileSystemProvider;
  readonly disk: StubFileSystem;
  uri(path: string): vscode.Uri;
  /** Every change event fired since construction, flattened and in order. */
  readonly events: vscode.FileChangeEvent[];
  dispose(): void;
}

async function harness(seed: Readonly<Record<string, string>> = {}): Promise<Harness> {
  const disk = new StubFileSystem();
  disk.seed(seed);

  const registry = new ProviderRegistry();
  registry.register({ ...memoryProvider, id: ID, schemes: [ID], create: () => disk });

  const configStore = new InMemoryConfigStore();
  await configStore.save({ id: ID, providerId: ID, label: ID, settings: {} });

  const manager = new ConnectionManager({
    registry,
    configStore,
    secretStore: new InMemorySecretStore(),
    logger: NOOP_LOGGER,
  });

  const provider = new OmniFileSystemProvider({
    manager,
    configStore,
    // Fresh per test: the shared 15s cache would otherwise serve a stat from a
    // previous case and hide the very branch under test.
    cache: new EntryCache(),
    logger: NOOP_LOGGER,
  });

  const events: vscode.FileChangeEvent[] = [];
  const subscription = provider.onDidChangeFile((batch) => events.push(...batch));

  return {
    provider,
    disk,
    uri: (path: string) => vscode.Uri.from({ scheme: 'omnifs', authority: ID, path }),
    events,
    dispose: () => {
      subscription.dispose();
      provider.dispose();
    },
  };
}

suite('OmniFileSystemProvider, constructed directly', () => {
  // Nullable, and started through `start()` so that `teardown` has something
  // to dispose even when a test fails before its harness is built — and so
  // each test reads a non-optional local rather than a possibly-undefined
  // suite variable.
  let current: Harness | undefined;

  async function start(seed: Readonly<Record<string, string>> = {}): Promise<Harness> {
    current = await harness(seed);
    return current;
  }

  teardown(() => {
    current?.dispose();
    current = undefined;
  });

  suite('flags workspace.fs never sends', () => {
    test('writeFile with create: false on a missing file fails as FileNotFound', async () => {
      const fixture = await start();
      await assert.rejects(
        () =>
          fixture.provider.writeFile(fixture.uri('/absent.txt'), bytes('x'), {
            create: false,
            overwrite: true,
          }),
        (error: unknown) => isFileSystemError(error, 'FileNotFound'),
      );
    });

    test('writeFile with create: false on an existing file succeeds', async () => {
      const fixture = await start({ '/present.txt': 'before' });
      await fixture.provider.writeFile(fixture.uri('/present.txt'), bytes('after'), {
        create: false,
        overwrite: true,
      });
      assert.equal(text(await fixture.provider.readFile(fixture.uri('/present.txt'))), 'after');
    });

    test('writeFile with overwrite: false on an existing file fails as FileExists', async () => {
      const fixture = await start({ '/present.txt': 'before' });
      await assert.rejects(
        () =>
          fixture.provider.writeFile(fixture.uri('/present.txt'), bytes('after'), {
            create: true,
            overwrite: false,
          }),
        (error: unknown) => isFileSystemError(error, 'FileExists'),
      );
      assert.equal(text(await fixture.provider.readFile(fixture.uri('/present.txt'))), 'before');
    });
  });

  suite('change events', () => {
    test('a new file reports Created', async () => {
      const fixture = await start();
      const uri = fixture.uri('/new.txt');
      await fixture.provider.writeFile(uri, bytes('x'), { create: true, overwrite: true });

      assert.deepEqual(
        fixture.events.map((event) => event.type),
        [vscode.FileChangeType.Created],
      );
      assert.equal(fixture.events[0]?.uri.toString(), uri.toString());
    });

    test('an overwrite reports Changed, not Created', async () => {
      // `options.create` is true on every ordinary save, so it cannot tell a
      // new file from an overwrite. A watcher that believes it sees files
      // appear that were already there.
      const fixture = await start({ '/present.txt': 'before' });
      await fixture.provider.writeFile(fixture.uri('/present.txt'), bytes('after'), {
        create: true,
        overwrite: true,
      });

      assert.deepEqual(
        fixture.events.map((event) => event.type),
        [vscode.FileChangeType.Changed],
      );
    });

    test('a delete reports Deleted', async () => {
      const fixture = await start({ '/doomed.txt': 'x' });
      await fixture.provider.delete(fixture.uri('/doomed.txt'), { recursive: false });

      assert.deepEqual(
        fixture.events.map((event) => event.type),
        [vscode.FileChangeType.Deleted],
      );
    });

    test('a rename reports Deleted at the old path then Created at the new', async () => {
      const fixture = await start({ '/before.txt': 'x' });
      await fixture.provider.rename(fixture.uri('/before.txt'), fixture.uri('/after.txt'), {
        overwrite: false,
      });

      assert.deepEqual(
        fixture.events.map((event) => [event.type, event.uri.path]),
        [
          [vscode.FileChangeType.Deleted, '/before.txt'],
          [vscode.FileChangeType.Created, '/after.txt'],
        ],
      );
    });

    test('a created directory reports Created', async () => {
      const fixture = await start();
      await fixture.provider.createDirectory(fixture.uri('/folder'));

      assert.deepEqual(
        fixture.events.map((event) => event.type),
        [vscode.FileChangeType.Created],
      );
    });
  });

  suite('stat fields only a provider can set', () => {
    test('a read-only entry reports FilePermission.Readonly', async () => {
      // FileStat.readOnly is what makes VS Code open the file in a read-only
      // editor rather than letting the user type and fail at save time.
      const fixture = await start({ '/locked.txt': 'x' });
      fixture.disk.overrideStat((path) =>
        path.value === '/locked.txt' ? { type: 'file', size: 1, readOnly: true } : undefined,
      );

      const stat = await fixture.provider.stat(fixture.uri('/locked.txt'));
      assert.equal(stat.permissions, vscode.FilePermission.Readonly);
    });

    test('an ordinary entry sets no permissions at all', async () => {
      // Not `permissions: 0`: VS Code treats the absent property as "no
      // special permissions", and sending 0 is a different statement.
      const fixture = await start({ '/plain.txt': 'x' });
      const stat = await fixture.provider.stat(fixture.uri('/plain.txt'));
      assert.equal(stat.permissions, undefined);
    });

    test('a symlink maps to FileType.SymbolicLink', async () => {
      const fixture = await start({ '/link': 'x' });
      fixture.disk.overrideStat((path) =>
        path.value === '/link' ? { type: 'symlink', size: 0 } : undefined,
      );

      const stat = await fixture.provider.stat(fixture.uri('/link'));
      assert.equal(stat.type, vscode.FileType.SymbolicLink);
    });
  });
});
```

- [ ] **Step 2: Run and confirm exactly one case fails**

```bash
pnpm --filter omni-fs-vscode build:tests
pnpm --filter omni-fs-vscode test:extension
```

Expected: `an overwrite reports Changed, not Created` FAILS with `Created` where `Changed` was expected. Everything else passes. If more than that fails, stop and read the failure before changing the provider — the rest of this file is pinning behaviour that already works.

- [ ] **Step 3: Ask the filesystem instead of trusting the flag**

In `apps/vscode/src/fs/omni-file-system-provider.ts`, replace the whole body of `writeFile`:

```ts
  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    const { fs, path } = await this.#resolve(uri);

    // Did it exist *before* this write? Asked here because afterwards the
    // answer is always yes, and `options.create` cannot answer it: VS Code
    // sends `create: true` on every ordinary save, so trusting it reports a
    // file created that was only modified.
    //
    // This is not an extra round trip in practice. ManagedFileSystem serves
    // stat from EntryCache, and VS Code stats a file before saving it anyway
    // for its own conflict detection — and it replaces the stat the
    // `create: false` branch used to make, rather than adding to it.
    const existed = await fs.stat(path).then(
      () => true,
      (error: unknown) => {
        if (OmniFsError.is(error) && error.code === 'NotFound') return false;
        throw toVsCodeError(error, uri);
      },
    );

    // VS Code asks us to fail when the file is missing and `create` is false.
    // Core has no equivalent flag, so the check belongs here.
    if (!options.create && !existed) throw vscode.FileSystemError.FileNotFound(uri);

    await translate(() => fs.writeFile(path, content, { overwrite: options.overwrite }), uri);
    this.#fire(existed ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri);
  }
```

`OmniFsError` is already imported as a value in this file; `toVsCodeError` and `translate` are module-level functions below the class.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter omni-fs-vscode build && pnpm --filter omni-fs-vscode build:tests
pnpm --filter omni-fs-vscode test:extension
```

Expected: PASS — this file, plus Tasks 3, 4 and 5's files unchanged.

- [ ] **Step 5: Prove the create: false branch still refuses for the right reason**

The rewrite moved that check from a translated `stat` to an explicit throw. Confirm it is not now swallowing a real failure: temporarily change `if (OmniFsError.is(error) && error.code === 'NotFound') return false;` to `return false;` and re-run.

Expected: `writeFile with create: false on a missing file fails as FileNotFound` still passes, but you have just made every stat failure — a timeout, a permission denial — look like "file absent". Restore the guard. The point of the exercise is that the guard is deliberate, not incidental.

- [ ] **Step 6: Format and commit**

```bash
pnpm exec prettier --write apps/vscode/src/fs/omni-file-system-provider.ts \
  apps/vscode/src/test/hermetic/provider-direct.test.ts
git add apps/vscode/src
git commit -m ":bug: fix report a file overwrite as Changed rather than Created"
```

---

### Task 7: The error table

**Files:**

- Create: `apps/vscode/src/test/hermetic/errors.test.ts`

**Interfaces:**

- Consumes: `OmniFileSystemProvider`'s `{ manager, configStore, cache, logger }` constructor from Task 5; `OmniFsError.is` from Task 1.
- Produces: nothing later tasks import.

**Why this table and not the providers'.** `toVsCodeError` is where a remote failure becomes an editor behaviour: `FileNotFound` drives create-on-save, `NoPermissions` shows a read-only editor, anything else is a generic `Unavailable`. Break a row and every provider still passes conformance while the editor misbehaves. Nothing else in the repo asserts it.

**Why injection happens on `stat`.** `ManagedFileSystem` emulates missing operations — rename becomes copy-plus-delete, recursive delete becomes a walk — so an error thrown from inside one of those can be caught and replaced before it ever reaches the host, and the test would be asserting about the emulation rather than the table. `stat` only consults the cache, which never stores a throw, before delegating. It is the one method that carries a provider's error through untouched.

- [ ] **Step 1: Write the tests**

Create `apps/vscode/src/test/hermetic/errors.test.ts`:

```ts
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  ConnectionManager,
  EntryCache,
  InMemoryConfigStore,
  InMemorySecretStore,
  NOOP_LOGGER,
  OmniFsError,
  ProviderRegistry,
} from '@omni-fs/core';
import type {
  DeleteOptions,
  FileStat,
  OmniFsErrorCode,
  OverwriteOptions,
  RemotePath,
  WriteOptions,
} from '@omni-fs/core';
import { MemoryFileSystem, memoryProvider } from '@omni-fs/testing';
import { OmniFileSystemProvider } from '../../fs/omni-file-system-provider.js';
import { bytes, isFileSystemError, text } from '../helpers.js';

/**
 * `toVsCodeError`, the one place a remote failure becomes an editor behaviour.
 *
 * Injection happens on `stat` on purpose. ManagedFileSystem emulates the
 * operations a protocol lacks — rename as copy-plus-delete, recursive delete
 * as a walk — so an error thrown from inside one of those can be caught and
 * replaced before it reaches the host, and the assertion would be about the
 * emulation instead of the table. `stat` consults only the cache, which never
 * stores a throw, before delegating.
 */

/** A MemoryFileSystem whose `stat` throws whatever it is handed. */
class ThrowingFileSystem extends MemoryFileSystem {
  failure: unknown;

  override async stat(path: RemotePath, signal?: AbortSignal): Promise<FileStat> {
    if (this.failure !== undefined) throw this.failure;
    return super.stat(path, signal);
  }
}

/** A MemoryFileSystem that remembers which mutating calls actually reached it. */
class RecordingFileSystem extends MemoryFileSystem {
  readonly calls: string[] = [];

  override async writeFile(
    path: RemotePath,
    data: Uint8Array,
    options?: WriteOptions,
  ): Promise<void> {
    this.calls.push('writeFile');
    return super.writeFile(path, data, options);
  }

  override async delete(path: RemotePath, options?: DeleteOptions): Promise<void> {
    this.calls.push('delete');
    return super.delete(path, options);
  }

  override async rename(
    from: RemotePath,
    to: RemotePath,
    options?: OverwriteOptions,
  ): Promise<void> {
    this.calls.push('rename');
    return super.rename(from, to, options);
  }

  override async copy(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void> {
    this.calls.push('copy');
    return super.copy(from, to, options);
  }
}

/** Builds a provider over one or more named in-memory filesystems. */
async function buildProvider(
  disks: Readonly<Record<string, MemoryFileSystem>>,
): Promise<OmniFileSystemProvider> {
  const registry = new ProviderRegistry();
  const configStore = new InMemoryConfigStore();

  for (const [id, disk] of Object.entries(disks)) {
    registry.register({ ...memoryProvider, id, schemes: [id], create: () => disk });
    await configStore.save({ id, providerId: id, label: id, settings: {} });
  }

  return new OmniFileSystemProvider({
    manager: new ConnectionManager({
      registry,
      configStore,
      secretStore: new InMemorySecretStore(),
      logger: NOOP_LOGGER,
    }),
    configStore,
    cache: new EntryCache(),
    logger: NOOP_LOGGER,
  });
}

function uriFor(connectionId: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: 'omnifs', authority: connectionId, path });
}

suite('toVsCodeError', () => {
  const TABLE: readonly [OmniFsErrorCode, string][] = [
    ['NotFound', 'FileNotFound'],
    ['AlreadyExists', 'FileExists'],
    ['NotADirectory', 'FileNotADirectory'],
    ['IsADirectory', 'FileIsADirectory'],
    ['PermissionDenied', 'NoPermissions'],
    ['AuthenticationFailed', 'NoPermissions'],
    ['Unsupported', 'NoPermissions'],
    // Everything not named above is Unavailable. These four are the ones a
    // user actually meets, so each is pinned rather than trusting the default.
    ['Timeout', 'Unavailable'],
    ['ConnectionFailed', 'Unavailable'],
    ['Conflict', 'Unavailable'],
    ['Unknown', 'Unavailable'],
  ];

  for (const [code, expected] of TABLE) {
    test(`maps ${code} to ${expected}`, async () => {
      const disk = new ThrowingFileSystem();
      disk.failure = new OmniFsError({ code, message: `${code} happened` });
      const provider = await buildProvider({ table: disk });

      await assert.rejects(
        () => provider.stat(uriFor('table', '/anything.txt')),
        (error: unknown) => isFileSystemError(error, expected),
      );
      provider.dispose();
    });
  }

  test('passes a plain Error through unwrapped', async () => {
    // A provider that throws something other than an OmniFsError has broken
    // its contract. Wrapping it in a FileSystemError would bury the stack the
    // author needs; the honest thing is to let it surface as itself.
    const disk = new ThrowingFileSystem();
    const original = new Error('the provider threw a bare Error');
    disk.failure = original;
    const provider = await buildProvider({ bare: disk });

    await assert.rejects(
      () => provider.stat(uriFor('bare', '/anything.txt')),
      (error: unknown) => error === original,
    );
    provider.dispose();
  });

  test('surfaces a failed connect as NoPermissions', async () => {
    // The second call site of toVsCodeError, inside `#resolve`'s catch on
    // `manager.acquire`. Stat injection never reaches it, because this failure
    // happens before there is a filesystem to stat.
    const registry = new ProviderRegistry();
    registry.register({
      ...memoryProvider,
      id: 'refuses',
      schemes: ['refuses'],
      create: () => {
        const disk = new MemoryFileSystem();
        return Object.assign(disk, {
          connect: async () => {
            throw new OmniFsError({ code: 'AuthenticationFailed', message: 'wrong password' });
          },
        });
      },
    });
    const configStore = new InMemoryConfigStore();
    await configStore.save({
      id: 'refuses',
      providerId: 'refuses',
      label: 'refuses',
      settings: {},
    });

    const provider = new OmniFileSystemProvider({
      manager: new ConnectionManager({
        registry,
        configStore,
        secretStore: new InMemorySecretStore(),
        logger: NOOP_LOGGER,
      }),
      configStore,
      cache: new EntryCache(),
      logger: NOOP_LOGGER,
    });

    await assert.rejects(
      () => provider.stat(uriFor('refuses', '/anything.txt')),
      (error: unknown) => isFileSystemError(error, 'NoPermissions'),
    );
    provider.dispose();
  });

  suite('across two connections', () => {
    test('rename refuses as NoPermissions and moves nothing', async () => {
      // Cross-connection moves are a copy-then-delete across two providers.
      // Worth doing, but it belongs in the transfer queue with progress and
      // cancellation — so until that lands the refusal must be clean, not a
      // half-completed move.
      const source = new RecordingFileSystem();
      source.seed({ '/file.txt': 'stays here' });
      const target = new RecordingFileSystem();
      const provider = await buildProvider({ left: source, right: target });

      await assert.rejects(
        () =>
          provider.rename(uriFor('left', '/file.txt'), uriFor('right', '/file.txt'), {
            overwrite: true,
          }),
        (error: unknown) => isFileSystemError(error, 'NoPermissions'),
      );

      assert.deepEqual(source.calls, [], 'the source filesystem was mutated');
      assert.deepEqual(target.calls, [], 'the target filesystem was mutated');
      provider.dispose();
    });

    test('copy refuses as NoPermissions and copies nothing', async () => {
      const source = new RecordingFileSystem();
      source.seed({ '/file.txt': 'stays here' });
      const target = new RecordingFileSystem();
      const provider = await buildProvider({ left: source, right: target });

      await assert.rejects(
        () =>
          provider.copy(uriFor('left', '/file.txt'), uriFor('right', '/file.txt'), {
            overwrite: true,
          }),
        (error: unknown) => isFileSystemError(error, 'NoPermissions'),
      );

      assert.deepEqual(source.calls, []);
      assert.deepEqual(target.calls, []);
      provider.dispose();
    });
  });

  test('a malformed uri with no authority fails as FileNotFound', async () => {
    const provider = await buildProvider({ table: new MemoryFileSystem() });
    const malformed = vscode.Uri.parse('omnifs:///no-authority.txt');

    await assert.rejects(
      () => provider.stat(malformed),
      (error: unknown) => isFileSystemError(error, 'FileNotFound'),
    );
    provider.dispose();
  });

  test('a mutating call is translated too, not only stat', async () => {
    // `translate()` wraps every call site. This proves the wrapper is in place
    // on a write path rather than only on the one the table above uses — and
    // it comes from the provider's own refusal, not from injection.
    const disk = new MemoryFileSystem();
    disk.seed({ '/present.txt': 'before' });
    const provider = await buildProvider({ writes: disk });

    await assert.rejects(
      () =>
        provider.writeFile(uriFor('writes', '/present.txt'), bytes('after'), {
          create: true,
          overwrite: false,
        }),
      (error: unknown) => isFileSystemError(error, 'FileExists'),
    );
    assert.equal(text(await provider.readFile(uriFor('writes', '/present.txt'))), 'before');
    provider.dispose();
  });
});
```

- [ ] **Step 2: Run it**

```bash
pnpm --filter omni-fs-vscode build:tests
pnpm --filter omni-fs-vscode test:extension
```

Expected: PASS, all of it.

- [ ] **Step 3: Prove the table is actually being read**

Temporarily change the `case 'IsADirectory':` arm of `toVsCodeError` to return `vscode.FileSystemError.Unavailable(...)`, rebuild and re-run.

```bash
pnpm --filter omni-fs-vscode build && pnpm --filter omni-fs-vscode build:tests
pnpm --filter omni-fs-vscode test:extension
```

Expected: FAIL — `maps IsADirectory to FileIsADirectory`. Restore the arm and confirm green.

- [ ] **Step 4: Format and commit**

```bash
pnpm exec prettier --write apps/vscode/src/test/hermetic/errors.test.ts
git add apps/vscode/src/test/hermetic/errors.test.ts
git commit -m ":white_check_mark: test cover the error table the editor behaves on"
```

---

### Task 8: The port adapters

**Files:**

- Create: `apps/vscode/src/test/hermetic/ports.test.ts`

**Interfaces:**

- Consumes: `resetConnections` and `removeConnection` from Task 4's helper.
- Produces: nothing later tasks import.

**What each port can and cannot be tested against.** `VsCodeConfigStore` runs against the **real** configuration API, because that is exactly what it wraps — a double would test the double. `VsCodeSecretStore` cannot: it is constructed over `ExtensionContext.secrets`, a Mocha test has no `ExtensionContext`, and publishing the secret store on `OmniFsApi` to reach it is what Decision 3 refuses. So its cases run against a small in-test `vscode.SecretStorage`, which proves the key namespacing, the JSON round trip and the corrupt-entry fallback — but not the keychain. Same for `VsCodeLogger` against a `LogOutputChannel` double. That gap is real and is recorded in the spec's Risks.

- [ ] **Step 1: Write the tests**

Create `apps/vscode/src/test/hermetic/ports.test.ts`:

```ts
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ConnectionConfig, LogLevel } from '@omni-fs/core';
import { VsCodeConfigStore, VsCodeLogger, VsCodeSecretStore } from '../../host/vscode-ports.js';
import { removeConnection, resetConnections } from '../helpers.js';

/**
 * The host adapter layer — the whole of it. When the desktop app is built it
 * gets an `electron-ports.ts` of comparable size and nothing else changes, so
 * these three classes are the seam the second host has to match.
 */

const PREFIX = 'ports-test';

function config(id: string, overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: `${PREFIX}-${id}`,
    providerId: 'memory',
    label: `label for ${id}`,
    settings: { host: 'example.test' },
    ...overrides,
  };
}

suite('VsCodeConfigStore, against the real configuration API', () => {
  let store: VsCodeConfigStore;

  suiteSetup(async () => {
    // Also at setup, not only teardown: the runner's user-data directory
    // survives between local runs, so a crashed run leaves entries behind.
    await resetConnections();
    store = new VsCodeConfigStore();
  });

  teardown(async () => {
    await resetConnections();
  });

  test('save then list round-trips a ConnectionConfig', async () => {
    const saved = config('round-trip', { rootPath: '/srv', readOnly: true });
    await store.save(saved);

    const listed = (await store.list()).filter((entry) => entry.id.startsWith(PREFIX));
    assert.deepEqual(listed, [saved]);
    assert.deepEqual(await store.get(saved.id), saved);
  });

  test('save replaces an existing entry rather than appending a duplicate', async () => {
    await store.save(config('edited', { label: 'before' }));
    await store.save(config('edited', { label: 'after' }));

    const listed = (await store.list()).filter((entry) => entry.id.startsWith(PREFIX));
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.label, 'after');
  });

  test('list drops entries that are not shaped like a ConnectionConfig', async () => {
    // `omniFs.connections` is hand-editable JSON that a team commits, so it
    // can and will arrive malformed. One bad entry must not take the rest of
    // a user's connections down with it.
    await vscode.workspace
      .getConfiguration('omniFs')
      .update(
        'connections',
        [
          config('valid'),
          { id: `${PREFIX}-no-provider`, label: 'x', settings: {} },
          { nonsense: true },
          'a bare string',
          null,
        ],
        vscode.ConfigurationTarget.Global,
      );

    const listed = (await store.list()).filter((entry) => entry.id.startsWith(PREFIX));
    assert.deepEqual(
      listed.map((entry) => entry.id),
      [`${PREFIX}-valid`],
    );
  });

  test('delete removes one connection and leaves the others', async () => {
    await store.save(config('keep-a'));
    await store.save(config('remove'));
    await store.save(config('keep-b'));

    await store.delete(`${PREFIX}-remove`);

    const listed = (await store.list()).filter((entry) => entry.id.startsWith(PREFIX));
    assert.deepEqual(listed.map((entry) => entry.id).sort(), [
      `${PREFIX}-keep-a`,
      `${PREFIX}-keep-b`,
    ]);
  });

  test('onDidChange fires for omniFs.connections', async () => {
    let fired = 0;
    const subscription = store.onDidChange(() => {
      fired += 1;
    });

    await store.save(config('watched'));
    // The configuration event is delivered asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 100));

    subscription[Symbol.dispose]();
    assert.ok(fired > 0, 'onDidChange never fired for a connections write');
  });

  test('onDidChange does not fire for an unrelated omniFs key', async () => {
    // `affectsConfiguration('omniFs')` would be true here. The store asks
    // about `omniFs.connections` specifically, and this is what says so — a
    // listener that reloads every connection on a log-level change is a real
    // cost against a metered bucket.
    let fired = 0;
    const subscription = store.onDidChange(() => {
      fired += 1;
    });

    const configuration = vscode.workspace.getConfiguration('omniFs');
    await configuration.update('logLevel', 'debug', vscode.ConfigurationTarget.Global);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await configuration.update('logLevel', undefined, vscode.ConfigurationTarget.Global);

    subscription[Symbol.dispose]();
    assert.equal(fired, 0, 'onDidChange fired for omniFs.logLevel');
  });

  test('deleting the last connection leaves nothing of ours behind', async () => {
    await store.save(config('last'));
    await removeConnection(`${PREFIX}-last`);

    const listed = (await store.list()).filter((entry) => entry.id.startsWith(PREFIX));
    assert.deepEqual(listed, []);
  });
});

/**
 * Enough of `vscode.SecretStorage` for the store to run against.
 *
 * The real binding — Keychain, DPAPI, libsecret — is reached through
 * `ExtensionContext.secrets`, which a Mocha test does not have. Publishing the
 * secret store on `OmniFsApi` to get at it is exactly what the API decision
 * refuses, so this proves the store's own logic and not the keychain.
 */
function fakeSecretStorage(): vscode.SecretStorage & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>();
  const emitter = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
  return {
    entries,
    get: async (key: string) => entries.get(key),
    store: async (key: string, value: string) => {
      entries.set(key, value);
      emitter.fire({ key });
    },
    delete: async (key: string) => {
      entries.delete(key);
      emitter.fire({ key });
    },
    onDidChange: emitter.event,
  };
}

suite('VsCodeSecretStore', () => {
  test('namespaces keys so a connection id cannot collide with another extension', async () => {
    const storage = fakeSecretStorage();
    const store = new VsCodeSecretStore(storage);

    await store.set('my-bucket', { accessKeyId: 'AKIA', secretAccessKey: 'shh' });

    assert.deepEqual([...storage.entries.keys()], ['omniFs.secret.my-bucket']);
  });

  test('round-trips a secret through JSON', async () => {
    const store = new VsCodeSecretStore(fakeSecretStorage());
    const secret = { password: 'hunter2', passphrase: '' };

    await store.set('conn', secret);

    assert.deepEqual(await store.get('conn'), secret);
  });

  test('reports a missing secret as undefined', async () => {
    const store = new VsCodeSecretStore(fakeSecretStorage());
    assert.equal(await store.get('never-saved'), undefined);
  });

  test('treats a corrupt entry as no entry', async () => {
    // A half-written keychain entry must re-prompt, not throw on every
    // connect attempt for the rest of the installation's life.
    const storage = fakeSecretStorage();
    storage.entries.set('omniFs.secret.broken', '{not json');
    const store = new VsCodeSecretStore(storage);

    assert.equal(await store.get('broken'), undefined);
  });

  test('delete removes the namespaced key', async () => {
    const storage = fakeSecretStorage();
    const store = new VsCodeSecretStore(storage);
    await store.set('conn', { password: 'x' });

    await store.delete('conn');

    assert.equal(storage.entries.size, 0);
  });
});

/** Records the five level methods `VsCodeLogger` actually calls. */
function fakeLogChannel(): {
  readonly channel: vscode.LogOutputChannel;
  readonly lines: [LogLevel, string][];
} {
  const lines: [LogLevel, string][] = [];
  const channel = {
    trace: (line: string) => lines.push(['trace', line]),
    debug: (line: string) => lines.push(['debug', line]),
    info: (line: string) => lines.push(['info', line]),
    warn: (line: string) => lines.push(['warn', line]),
    error: (line: string) => lines.push(['error', line]),
    // `LogOutputChannel` has a dozen more members (append, show, logLevel,
    // onDidChangeLogLevel …) that this adapter never touches. Casting is
    // honest here: implementing them would assert nothing.
  } as unknown as vscode.LogOutputChannel;
  return { channel, lines };
}

suite('VsCodeLogger', () => {
  test('drops everything below the minimum level', async () => {
    const { channel, lines } = fakeLogChannel();
    const logger = new VsCodeLogger(channel, 'warn');

    logger.log('trace', 'no');
    logger.log('debug', 'no');
    logger.log('info', 'no');
    logger.log('warn', 'yes');
    logger.log('error', 'yes');

    assert.deepEqual(
      lines.map(([level]) => level),
      ['warn', 'error'],
    );
  });

  test('appends structured data as JSON', async () => {
    const { channel, lines } = fakeLogChannel();
    new VsCodeLogger(channel, 'info').log('info', 'connected', { providerId: 's3' });

    assert.equal(lines[0]?.[1], 'connected {"providerId":"s3"}');
  });

  test('child nests scopes as parent/child', async () => {
    // `#resolve` calls `logger.child(connectionId)`, and ManagedFileSystem
    // passes it on again. A flat scope makes two connections' logs identical.
    const { channel, lines } = fakeLogChannel();
    const logger = new VsCodeLogger(channel, 'info');

    logger.child('conn-1').child('transfer').log('info', 'started');

    assert.equal(lines[0]?.[1], '[conn-1/transfer] started');
  });

  test('a child inherits the minimum level', async () => {
    const { channel, lines } = fakeLogChannel();
    new VsCodeLogger(channel, 'error').child('conn-1').log('info', 'dropped');

    assert.deepEqual(lines, []);
  });
});
```

- [ ] **Step 2: Run it**

```bash
pnpm --filter omni-fs-vscode build:tests
pnpm --filter omni-fs-vscode test:extension
```

Expected: PASS.

If `onDidChange fires for omniFs.connections` is flaky, raise the 100 ms wait rather than removing the assertion — VS Code delivers configuration events on a later tick and the latency varies by platform.

- [ ] **Step 3: Confirm this suite does not disturb the others**

`ports.test.ts` writes the same global `omniFs.connections` that Tasks 4 and 5 use. Mocha runs suites sequentially, so the reset in `suiteSetup` and the reset in `teardown` bracket it — but prove it rather than assume it by running the whole label twice in a row:

```bash
pnpm --filter omni-fs-vscode test:extension
pnpm --filter omni-fs-vscode test:extension
```

Expected: identical results both times. A second run that fails means state leaked into the runner's user-data directory, which is exactly the failure `resetConnections()` in `suiteSetup` exists to absorb.

- [ ] **Step 4: Format and commit**

```bash
pnpm exec prettier --write apps/vscode/src/test/hermetic/ports.test.ts
git add apps/vscode/src/test/hermetic/ports.test.ts
git commit -m ":white_check_mark: test cover the three vs code port adapters"
```

---

### Task 9: The live label — the bundled SDKs still move bytes

**Files:**

- Create: `apps/vscode/src/test/fixtures/known_hosts`
- Create: `apps/vscode/src/test/live/bundled-sdk.test.ts`

**Interfaces:**

- Consumes: `OmniFsApi` from Task 3; `saveConnection`/`removeConnection`/`bytes`/`text` from Task 4's helper; frozen definitions from Task 2 (the spread below produces a new object, so the freeze is invisible here).
- Produces: nothing later tasks import. `pnpm test:extension:live` becomes meaningful.

**What only this can prove.** esbuild flattens four protocol SDKs into one minified CommonJS file, and that transformation is not free: `cpu-features` cannot be bundled at all and is already externalised, `ssh2` requires it inside a `try` and silently falls back to pure-JS crypto, `@aws-sdk` resolves parts of itself lazily, and minification mangles names a dependency may read back off `constructor.name`. CI's `package` job proves the `.vsix` builds and stays under 2 MB. Nothing proves `ssh2` still opens a connection after being bundled.

**Why the real definition is taken out of the registry rather than imported.** `real.create` is the bundled `SftpFileSystem` closing over the bundled `ssh2` — which is the entire point. Importing `@omni-fs/provider-sftp` into this test file would bundle a second, freshly-built copy into `out-test/` and prove nothing about the one that ships. Only `getSecret` is wrapped, which is how credentials reach the provider without widening `OmniFsApi`.

**It never skips.** A live label that passes silently with nothing running is the exact failure mode it exists to prevent. `suiteSetup` retries for up to 60 seconds and then fails with a message naming the unreachable server.

**One accepted leak.** `OmniFsApi` exposes no `ConnectionManager` and the idle timeout is 300 seconds, so each live socket stays open until the extension host exits. That is acceptable for a smoke test and is written down here so nobody spends an afternoon hunting it.

- [ ] **Step 1: Create the pinned known_hosts**

```bash
touch apps/vscode/src/test/fixtures/known_hosts
```

It must be **empty and committed**. The SFTP provider reads `~/.ssh/known_hosts` by default, and a developer with a stale `[localhost]:2222` entry from a previous container would be refused for a host-key mismatch — correct behaviour, wrong context. An empty file means trust-on-first-use against the throwaway container.

Confirm git will keep an empty file (it will — git tracks empty files, unlike empty directories):

```bash
git add apps/vscode/src/test/fixtures/known_hosts && git status --short apps/vscode/src/test/fixtures/
```

- [ ] **Step 2: Write the live suite**

Create `apps/vscode/src/test/live/bundled-sdk.test.ts`:

```ts
import { join } from 'node:path';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ConnectionSecret } from '@omni-fs/core';
import {
  EXTENSION_ID,
  activateExtension,
  bytes,
  removeConnection,
  saveConnection,
  text,
} from '../helpers.js';

/**
 * A smoke test of the *shipped* bundle against real servers.
 *
 * Deliberately shallow. Depth belongs in each provider's own
 * `test:conformance`, which runs the shared contract against these same
 * containers. The only question here is whether esbuild broke an SDK: `ssh2`
 * falling back to pure-JS crypto when `cpu-features` is unresolved,
 * `@aws-sdk`'s lazy internal resolution, a minifier mangling a name something
 * reads back off `constructor.name`.
 *
 * Requires `docker compose up -d` and `out/` holding the production build —
 * `pnpm package:vsix` leaves exactly that behind.
 */

/** A payload with a non-ASCII character, so a charset bug shows up as a diff. */
const PAYLOAD = 'omni-fs bundled-sdk probe — café\n';

/** Unique per run, so a crashed run cannot collide with the next one. */
const RUN = `omnifs-ext-live-${String(Date.now())}-${String(process.pid)}`;

interface LiveTarget {
  /** The provider id registered by the extension, e.g. `'sftp'`. */
  readonly providerId: string;
  /** Everything but the credentials. */
  readonly settings: Readonly<Record<string, unknown>>;
  readonly secret: ConnectionSecret;
}

function extensionPath(...segments: string[]): string {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} was not loaded by the host`);
  return join(extension.extensionPath, ...segments);
}

/**
 * Environment variable names follow the existing `*.live.test.ts` files
 * exactly, so one `.env` or one shell export drives both the vitest
 * conformance runs and this one.
 */
function targets(): Readonly<Record<string, LiveTarget>> {
  return {
    sftp: {
      providerId: 'sftp',
      settings: {
        host: process.env['OMNI_FS_SFTP_HOST'] ?? 'localhost',
        port: Number(process.env['OMNI_FS_SFTP_PORT'] ?? '2222'),
        username: process.env['OMNI_FS_SFTP_USER'] ?? 'omnifs',
        authMethod: 'password',
        rootPrefix: process.env['OMNI_FS_SFTP_ROOT'] ?? '/data',
        // Pinned and empty, not the developer's own: a stale
        // `[localhost]:2222` entry from a previous container would be refused
        // for a host-key mismatch. Correct behaviour, wrong context.
        knownHostsPath: extensionPath('src', 'test', 'fixtures', 'known_hosts'),
      },
      secret: { password: process.env['OMNI_FS_SFTP_PASSWORD'] ?? 'omnifs-dev-secret' },
    },
    webdav: {
      providerId: 'webdav',
      settings: {
        baseUrl: process.env['OMNI_FS_WEBDAV_URL'] ?? 'http://localhost:8081',
        authType: 'password',
        username: process.env['OMNI_FS_WEBDAV_USER'] ?? 'omnifs',
      },
      secret: { password: process.env['OMNI_FS_WEBDAV_PASSWORD'] ?? 'omnifs-dev-secret' },
    },
    s3: {
      providerId: 's3',
      settings: {
        bucket: process.env['OMNI_FS_S3_BUCKET'] ?? 'omni-fs-test',
        region: process.env['OMNI_FS_S3_REGION'] ?? 'us-east-1',
        endpoint: process.env['OMNI_FS_S3_ENDPOINT'] ?? 'http://localhost:9000',
        // MinIO does not serve virtual-hosted-style requests on localhost.
        forcePathStyle: true,
      },
      secret: {
        accessKeyId: process.env['OMNI_FS_S3_ACCESS_KEY'] ?? 'omnifs',
        secretAccessKey: process.env['OMNI_FS_S3_SECRET_KEY'] ?? 'omnifs-dev-secret',
      },
    },
  };
}

for (const [name, target] of Object.entries(targets())) {
  suite(`bundled ${name}`, () => {
    const connectionId = `${RUN}-${name}`;
    let registration: Disposable;
    let scratch: vscode.Uri;
    let file: vscode.Uri;

    suiteSetup(async () => {
      const api = await activateExtension();

      // The bundle's own definition, wrapped only to supply credentials.
      // `real.create` is the SftpFileSystem closing over the bundled ssh2 —
      // importing the provider package here would build a second copy and
      // prove nothing about the one that ships.
      const real = api.registry.get(target.providerId);
      registration = api.registry.register({
        ...real,
        id: connectionId,
        schemes: [connectionId],
        create: (context) => real.create({ ...context, getSecret: async () => target.secret }),
      });

      await saveConnection({
        id: connectionId,
        providerId: connectionId,
        label: connectionId,
        settings: target.settings,
      });

      // Each provider's `rootPrefix`/`baseUrl`/`bucket` already points at the
      // seeded tree, so paths here are relative to that root.
      scratch = vscode.Uri.from({ scheme: 'omnifs', authority: connectionId, path: `/${RUN}` });
      file = scratch.with({ path: `${scratch.path}/hello.txt` });

      // Readiness is proved by actually writing, not by connecting.
      // compose.yaml seeds the tree from a one-shot `file-seed` container
      // that starts *after* the servers and ends with `chown -R 1000:1000`,
      // so there is a window in which SFTP accepts a login and a write fails
      // with PermissionDenied. Retry that, not the connect.
      //
      // Never skip: a live label that passes with nothing running is the
      // failure this suite exists to prevent.
      await waitUntilWritable(name, async () => {
        await vscode.workspace.fs.createDirectory(scratch);
        await vscode.workspace.fs.writeFile(file, bytes(PAYLOAD));
      });
    });

    suiteTeardown(async () => {
      // Best-effort: the delete test below is the one that asserts. This is
      // the safety net for a run that failed before reaching it.
      await vscode.workspace.fs
        .delete(scratch, { recursive: true })
        .then(undefined, () => undefined);
      registration[Symbol.dispose]();
      await removeConnection(connectionId);
    });

    test('reads back byte-identically', async () => {
      assert.equal(text(await vscode.workspace.fs.readFile(file)), PAYLOAD);
    });

    test('lists the file as a File', async () => {
      const entries = await vscode.workspace.fs.readDirectory(scratch);
      assert.deepEqual(new Map(entries).get('hello.txt'), vscode.FileType.File);
    });

    test('stats the file with the right size', async () => {
      const stat = await vscode.workspace.fs.stat(file);
      assert.equal(stat.type, vscode.FileType.File);
      assert.equal(stat.size, bytes(PAYLOAD).byteLength);
    });

    test('deletes the scratch path recursively, leaving the seeded tree as found', async () => {
      await vscode.workspace.fs.delete(scratch, { recursive: true });

      await assert.rejects(
        () => vscode.workspace.fs.stat(file),
        (error: unknown) => error instanceof vscode.FileSystemError,
      );

      // The seeded tree every one of these servers shares.
      const seeded = vscode.Uri.from({
        scheme: 'omnifs',
        authority: connectionId,
        path: '/readme.txt',
      });
      assert.equal((await vscode.workspace.fs.stat(seeded)).type, vscode.FileType.File);
    });
  });
}

/**
 * Retries `attempt` until it succeeds or 60 seconds pass, then fails with the
 * last error and the name of the server that never became writable.
 */
async function waitUntilWritable(name: string, attempt: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last: unknown;

  while (Date.now() < deadline) {
    try {
      await attempt();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  assert.fail(
    `${name} never became writable within 60s. Is \`docker compose up -d\` running? Last error: ${String(last)}`,
  );
}
```

- [ ] **Step 3: Start the stack and build the production bundle**

```bash
docker compose up -d
docker compose ps
pnpm package:vsix
pnpm --filter omni-fs-vscode build:tests
```

`pnpm package:vsix` is what leaves `out/` holding the **minified** build, which is the artifact this label exists to test. Building with plain `pnpm build` would test an unminified bundle and quietly weaken the whole suite.

Wait for `minio-init` and `file-seed` to report complete:

```bash
docker compose logs minio-init file-seed --tail 5
```

- [ ] **Step 4: Run the live label**

```bash
pnpm --filter omni-fs-vscode test:extension:live
```

On Linux without a display, prefix with `xvfb-run -a`.

Expected: PASS — twelve tests, four per provider.

- [ ] **Step 5: Prove it fails when it should**

Two checks, both cheap and both worth doing once:

```bash
docker compose stop sftp
pnpm --filter omni-fs-vscode test:extension:live
```

Expected: FAIL after 60 seconds with `sftp never became writable within 60s`. Not a skip, not a pass.

```bash
docker compose start sftp
```

Then confirm it is really the minified bundle under test:

```bash
grep -c 'SftpFileSystem' apps/vscode/out/extension.js || echo "minified, as expected"
```

Expected: the readable class name is gone from a minified bundle. If it is still there, `out/` holds a development build and Step 3 was not followed.

- [ ] **Step 6: Confirm the hermetic label is untouched**

```bash
pnpm --filter omni-fs-vscode test:extension
```

Expected: PASS. The hermetic label must never need Docker — check it while the stack is stopped, too:

```bash
docker compose down
pnpm --filter omni-fs-vscode test:extension
docker compose up -d
```

- [ ] **Step 7: Format and commit**

```bash
pnpm exec prettier --write apps/vscode/src/test/live/bundled-sdk.test.ts
git add apps/vscode/src/test/live apps/vscode/src/test/fixtures/known_hosts
git commit -m ":white_check_mark: test prove the shipped bundle still speaks every protocol"
```

---

### Task 10: CI, and the documentation this makes wrong

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `docker/README.md`

**Interfaces:**

- Consumes: `pnpm test:extension` and `pnpm test:extension:live` from Task 3.
- Produces: two CI jobs.

- [ ] **Step 1: Add the hermetic job**

In `.github/workflows/ci.yml`, after the `verify` job and before `boundary`, add:

```yaml
extension-tests:
  name: extension tests (${{ matrix.os }})
  runs-on: ${{ matrix.os }}
  strategy:
    fail-fast: false
    matrix:
      # The same three-OS matrix as `verify`, for the reason that matrix
      # already states: the extension ships on all three desktop platforms.
      os: [ubuntu-latest, macos-latest, windows-latest]

  steps:
    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      with:
        persist-credentials: false

    - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0

    - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
      with:
        node-version: 22
        cache: pnpm

    - run: pnpm install --frozen-lockfile

    # The download key must change when VS Code does, or actions/cache never
    # saves: it skips the upload on an exact key hit, so a key pinned only to
    # the lockfile would re-download 150 MB on every run after a release and
    # store none of it. A weekly stamp bounds that to one run in seven days.
    - id: stamp
      run: echo "week=$(date -u +%Y-%V)" >> "$GITHUB_OUTPUT"
      shell: bash

    # Only the editor download. The rest of .vscode-test is the runner's
    # user-data and extensions directories, which must not persist between
    # runs — stale omniFs.connections state would leak across jobs.
    - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
      with:
        path: apps/vscode/.vscode-test/vscode-*
        key: vscode-test-${{ runner.os }}-${{ steps.stamp.outputs.week }}
        restore-keys: vscode-test-${{ runner.os }}-

    # Electron needs a display. Linux runners are headless, so xvfb provides
    # a virtual one; macOS and Windows runners have a real window server.
    - if: runner.os == 'Linux'
      run: xvfb-run -a pnpm test:extension

    - if: runner.os != 'Linux'
      run: pnpm test:extension
```

- [ ] **Step 2: Add the live job**

After it:

```yaml
extension-tests-live:
  name: extension tests (live)
  runs-on: ubuntu-latest

  steps:
    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      with:
        persist-credentials: false

    - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0

    - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
      with:
        node-version: 22
        cache: pnpm

    - run: pnpm install --frozen-lockfile

    - id: stamp
      run: echo "week=$(date -u +%Y-%V)" >> "$GITHUB_OUTPUT"
      shell: bash

    - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
      with:
        path: apps/vscode/.vscode-test/vscode-*
        key: vscode-test-${{ runner.os }}-${{ steps.stamp.outputs.week }}
        restore-keys: vscode-test-${{ runner.os }}-

    # package:vsix leaves out/ holding the minified production build, which
    # is the artifact the live label exists to test. A plain `pnpm build`
    # here would quietly test an unminified bundle instead.
    - run: pnpm package:vsix

    # Readiness is the suite's job, not a compose flag: it retries the first
    # write for 60s, so starting the tests a second after `up` is fine.
    - run: docker compose up -d

    - run: xvfb-run -a pnpm test:extension:live
```

`continue-on-error` is deliberately not used anywhere here: it hides real failures. Whether either job blocks a merge is a branch-protection setting rather than a file in this repo — the recommendation is that `extension tests` is required and `extension tests (live)` is not, so a container flake cannot block an unrelated change, while a failure stays visibly red either way.

- [ ] **Step 3: Validate the workflow parses**

```bash
node -e "const t=require('node:fs').readFileSync('.github/workflows/ci.yml','utf8'); console.log('jobs:', [...t.matchAll(/^  ([a-z0-9-]+):$/gm)].map(m=>m[1]).join(', '))"
pnpm exec prettier --check .github/workflows/ci.yml
```

Expected: the job list now includes `extension-tests` and `extension-tests-live`, and prettier is clean. If prettier reports a diff, run `pnpm exec prettier --write .github/workflows/ci.yml`.

- [ ] **Step 4: Correct the documentation**

Three files currently describe a test story that is now wrong.

In `CLAUDE.md`, under `## Commands`, add to the command block:

```bash
pnpm test:extension        # the extension inside a real VS Code host
pnpm test:extension:live   # + the compose stack, against the minified bundle
```

Replace the sentence "`provider-ftp` is the only package without tests." with:

```
`provider-ftp` is the only package without tests. `apps/vscode` is tested
separately: `pnpm test:extension` boots the real extension inside an Electron
extension host and drives `vscode.workspace.fs` over an in-memory provider, and
`pnpm test:extension:live` runs the *minified* production bundle against the
`compose.yaml` servers — the only thing that proves esbuild did not break a
protocol SDK. Neither joins `pnpm test`, which stays hermetic and fast.
```

Under `## Tests`, after the paragraph about the live conformance target, add:

```
Two test frameworks live here and never meet: Vitest for everything hermetic,
Mocha inside the extension host for `apps/vscode/src/test/**`. Different turbo
task, different directory, different compile output (`out-test/`, never
`out/`), different runner. The extension's sources compile with esbuild rather
than `tsc` because they import `@omni-fs/testing`, which is ESM-only.
```

In `README.md`, under `## Roadmap`, add one entry after the `VS Code FileSystemProvider` line:

```markdown
- [x] VS Code extension tested in a real extension host, hermetic and live
```

In `docker/README.md`, the `## Conformance suite` section has a claim that went stale when S3 gained its live run:

> `packages/provider-webdav` and `packages/provider-sftp` define the script today, so WebDAV and SFTP are what runs.

Replace that sentence with:

```markdown
`packages/provider-s3`, `packages/provider-webdav` and `packages/provider-sftp`
all define the script, so all three run. A provider is finished exactly when
this passes for it.
```

…and delete the now-duplicated "A provider is finished exactly when this passes for it." line that followed it.

Then add a new section immediately after `## Conformance suite`:

````markdown
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
and after. It never skips: with nothing running it retries for 60 seconds and
then fails, naming the server.
````

- [ ] **Step 5: Run everything, uncached**

```bash
pnpm build
pnpm exec turbo run typecheck --force
pnpm exec turbo run test --force
pnpm lint
pnpm format:check
pnpm --filter omni-fs-vscode test:extension
pnpm package:vsix && docker compose up -d && pnpm --filter omni-fs-vscode test:extension:live
pnpm exec turbo run test:conformance --force
```

Expected: PASS throughout. The conformance run at the end is not optional — Tasks 1 and 2 changed `packages/core`, and the live conformance suite is the only thing that exercises those changes against real servers.

Also re-run both CI boundary greps by hand, since Task 3 added a new directory under `apps/`:

```bash
! grep -rEn "from ['\"](vscode|electron)['\"]" packages/ --include=*.ts --include=*.tsx
! grep -rEn "from ['\"](@aws-sdk/|basic-ftp|ssh2|webdav)" packages/core/src --include=*.ts
```

Expected: both print nothing and exit 0. `apps/vscode/src/test/**` imports `vscode` freely — it is inside the app, which is the one place allowed to.

- [ ] **Step 6: Format and commit**

Two commits, so the workflow change and the prose change bisect separately.

```bash
pnpm exec prettier --write .github/workflows/ci.yml CLAUDE.md README.md docker/README.md

git add .github/workflows/ci.yml
git commit -m ":construction_worker: ci run the extension tests on three platforms and live"

git add CLAUDE.md README.md docker/README.md
git commit -m ":memo: docs describe the extension test suite and its two labels"
```

---

## Done when

- `pnpm test:extension` is green on Linux, macOS and Windows, and needs no network, no Docker and no display beyond what CI provides.
- `pnpm test:extension:live` is green against `compose.yaml` with `out/` holding the minified production bundle, and **fails**, rather than skipping, when a server is down.
- `pnpm test` is unchanged in character: hermetic, fast, and with a larger count only from the handful of core cases Tasks 1 and 2 added.
- A connection saved with `readOnly: true` refuses `writeFile`, `delete`, `rename` and `createDirectory` from the editor with `NoPermissions`, and still reads.
- An overwrite reports `Changed`; only a genuinely new file reports `Created`.
- `OmniFsError.is` recognises an error built by another copy of `@omni-fs/core`, and a registered `ProviderDefinition` cannot have its `create` swapped in place.
- Every id in `contributes.commands` is registered, every `@omni-fs/provider-*` dependency resolves to a registered provider, and every configuration key the code reads has a contributed default.
- `pnpm typecheck` runs three programs for `apps/vscode`, and `"mocha"` appears in none of the other two.
- `pnpm lint`, `pnpm format:check` and both CI boundary greps are clean.
- `docs/superpowers/specs/2026-09-20-vscode-extension-tests-design.md` has no goal without a test, and every non-goal in it is still absent from the code.
