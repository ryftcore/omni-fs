# WebDAV Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@omni-fs/provider-webdav` a real provider that passes the shared conformance suite against a live server, and turn on `test:conformance` as a local command.

**Architecture:** Follow `packages/provider-s3` exactly: a thin `ProviderDefinition` in `index.ts`, a declarative schema plus `readSettings()` in `settings.ts`, one `toOmniFsError()` in `errors.ts`, and the `RemoteFileSystem` implementation in its own file. The provider translates every native failure at its own boundary, never caches, and accepts an `AbortSignal` on anything touching the network. WebDAV is the first provider with `hasRealDirectories: true`, so it is the first real exercise of the non-object-store half of the conformance suite.

**Tech Stack:** `webdav@^5.7.1` (already declared in `packages/provider-webdav/package.json`), vitest, the compose stack at `compose.yaml` (`dgraziotin/nginx-webdav-nononsense` on `http://localhost:8081`).

**Spec:** No separate spec document. The binding contract is `packages/core/src/provider.ts` (`RemoteFileSystem`, `ProviderDefinition`), `packages/core/src/capabilities.ts`, and `packages/testing/src/conformance.ts`. `packages/provider-s3` is the reference implementation and `docs/architecture.md` the surrounding rationale. Read all four before Task 1.

## Global Constraints

- Nothing in `packages/` may import `vscode` or `electron`. Nothing in `packages/core` may import a protocol SDK. Enforced by `eslint.config.mjs` and a CI grep.
- Providers throw `OmniFsError` and nothing else; translate native errors in the provider's own `errors.ts`.
- Providers never cache. Caching is `ManagedFileSystem`'s job, above this interface.
- Declare capabilities honestly. Do not implement an optional method while declaring its capability false, or the reverse.
- Accept an `AbortSignal` on every method that touches the network.
- TypeScript is held at 6.0.x; `@types/node` at 22. Strictness includes `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`, `module: Node16` — so relative imports carry a `.js` extension.
- `.npmrc` sets `hoist=false`: a package may only import what its own `package.json` declares.
- Commits are a single title line, `:emoji: <type> <description>`, no body. Never add `Co-Authored-By` or any session attribution. CI enforces both the pattern and the empty body.
- Never run `pnpm format`. Run `pnpm exec prettier --write <files you touched>` instead.
- After changing a `packages/*` source file, run `pnpm build` before any typecheck of a dependent — packages resolve each other through `dist/`, not source.

## Ruling on the root-path field, which supersedes the original instruction

The task was given to me as "drop `rootPath` from the FTP/SFTP/WebDAV settings schemas and have the providers honour the connection-level `ConnectionConfig.rootPath` instead". Reading the code, that instruction rests on a false premise and this plan does **not** follow it.

`ConnectionConfig.rootPath` is documented as "Path within the remote to treat as the connection root", but **nothing in core applies it**. Its only two readers are `ConnectionManager.probe` (`packages/core/src/connection/manager.ts:137`, which stats it to verify the start location) and `mountAsWorkspaceFolder` (`apps/vscode/src/commands/index.ts:153`, which opens the workspace folder at that URI). Neither scopes the filesystem. S3 does its own scoping with a separate `rootPrefix` **setting**, which the provider applies to every key.

So making WebDAV scope by `config.rootPath` would double-apply it: `mountAsWorkspaceFolder` already opens at `/Documents`, and a provider prefixing `/Documents` again would resolve `/Documents/Documents`. Fixing that properly means changing what `rootPath` means across core, the probe, the mount command and S3 — a cross-cutting change that should not ride along with the first provider implementation.

**Task 1 therefore renames rather than deletes.** The provider-level field becomes `rootPrefix` labelled "Root prefix", matching S3 exactly. That removes the duplicate "Root path" label — the actual goal — keeps the ability to scope a connection to a subfolder, and leaves all four providers speaking one vocabulary. Consolidating `rootPath` and `rootPrefix` into a single concept is worth doing, but as its own plan.

---

## File Structure

| File                                                             | Responsibility                                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/provider-webdav/src/settings.ts` (create)              | `WEBDAV_SETTINGS_SCHEMA`, `WEBDAV_SECRET_SCHEMA`, `WebdavSettings`, `readSettings()`            |
| `packages/provider-webdav/src/errors.ts` (create)                | `toOmniFsError(cause, path?)` — HTTP status to `OmniFsError`                                    |
| `packages/provider-webdav/src/webdav-file-system.ts` (create)    | `WebdavFileSystem implements RemoteFileSystem`                                                  |
| `packages/provider-webdav/src/index.ts` (rewrite)                | `webdavProvider: ProviderDefinition` plus re-exports, ~37 lines like `provider-s3/src/index.ts` |
| `packages/provider-webdav/src/settings.test.ts` (create)         | Pure unit tests for the schema and `readSettings`                                               |
| `packages/provider-webdav/src/errors.test.ts` (create)           | Pure unit tests for status mapping                                                              |
| `packages/provider-webdav/src/webdav.live.test.ts` (create)      | The conformance harness against the compose server                                              |
| `packages/provider-webdav/vitest.config.ts` (create)             | Default run excludes `*.live.test.ts`                                                           |
| `packages/provider-webdav/vitest.conformance.config.ts` (create) | Conformance run includes only `*.live.test.ts`                                                  |
| `packages/provider-ftp/src/index.ts` (modify)                    | Rename its `rootPath` field                                                                     |
| `packages/provider-sftp/src/index.ts` (modify)                   | Rename its `rootPath` field                                                                     |
| `docker/README.md` (modify)                                      | Document the conformance command                                                                |

Live tests are named `*.live.test.ts` so `pnpm test` stays hermetic and green without Docker, while `pnpm test:conformance` runs exactly those.

---

### Task 1: Rename the duplicate root field in all three skeleton schemas

**Files:**

- Modify: `packages/provider-webdav/src/index.ts` (the `rootPath` entry of `WEBDAV_SETTINGS_SCHEMA`)
- Modify: `packages/provider-ftp/src/index.ts` (the `rootPath` entry of `FTP_SETTINGS_SCHEMA`)
- Modify: `packages/provider-sftp/src/index.ts` (the `rootPath` entry of `SFTP_SETTINGS_SCHEMA`)
- Create: `packages/provider-webdav/src/settings.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: the settings key `rootPrefix` (string, optional), which Task 3's `readSettings()` reads and Task 5's `WebdavFileSystem` applies.

- [ ] **Step 1: Write the failing test**

Create `packages/provider-webdav/src/settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { WEBDAV_SETTINGS_SCHEMA } from './index.js';

describe('WEBDAV_SETTINGS_SCHEMA', () => {
  it('has no field labelled "Root path", which would collide with the connection-level one', () => {
    const labels = WEBDAV_SETTINGS_SCHEMA.fields.map((field) => field.label);
    expect(labels).not.toContain('Root path');
  });

  it('scopes the connection with a rootPrefix field, spelled as S3 spells it', () => {
    const field = WEBDAV_SETTINGS_SCHEMA.fields.find((candidate) => candidate.key === 'rootPrefix');
    expect(field).toBeDefined();
    expect(field?.label).toBe('Root prefix');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @omni-fs/provider-webdav exec vitest run src/settings.test.ts`
Expected: FAIL — the schema still has `key: 'rootPath'` labelled `Root path`.

- [ ] **Step 3: Rename the field in all three providers**

In `packages/provider-webdav/src/index.ts`, replace the `rootPath` entry of `WEBDAV_SETTINGS_SCHEMA` with:

```ts
    {
      kind: 'text',
      key: 'rootPrefix',
      label: 'Root prefix',
      placeholder: 'Documents',
      help: 'Optional. Scopes the connection to a subfolder of the server URL.',
    },
```

In `packages/provider-ftp/src/index.ts`, replace the `rootPath` entry of `FTP_SETTINGS_SCHEMA` with:

```ts
    {
      kind: 'text',
      key: 'rootPrefix',
      label: 'Root prefix',
      placeholder: 'public_html',
      help: 'Optional. Scopes the connection to a subfolder of the login directory.',
    },
```

In `packages/provider-sftp/src/index.ts`, replace the `rootPath` entry of `SFTP_SETTINGS_SCHEMA` with:

```ts
    {
      kind: 'text',
      key: 'rootPrefix',
      label: 'Root prefix',
      placeholder: 'var/www',
      help: 'Optional. Scopes the connection to a subfolder of the login directory.',
    },
```

- [ ] **Step 4: Run the test and the whole suite**

Run: `pnpm build && pnpm --filter @omni-fs/provider-webdav exec vitest run src/settings.test.ts`
Expected: PASS, 2 tests.

Run: `pnpm test`
Expected: PASS. No existing test references `rootPath` as a settings key, so nothing else should move.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/provider-webdav/src packages/provider-ftp/src packages/provider-sftp/src
git add packages/provider-webdav/src packages/provider-ftp/src packages/provider-sftp/src
git commit -m ":pencil2: fix rename the providers' root scoping field to rootPrefix so it stops colliding with the connection root path"
```

---

### Task 2: Error translation

**Files:**

- Create: `packages/provider-webdav/src/errors.ts`
- Create: `packages/provider-webdav/src/errors.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `toOmniFsError(cause: unknown, path?: string): OmniFsError`, used by every method in Task 5 onward.

The `webdav` package throws errors carrying a numeric `status` and a `response`. `AbortError` arrives as a `DOMException` with `name === 'AbortError'`. Mirror `packages/provider-s3/src/errors.ts` in shape.

- [ ] **Step 1: Write the failing test**

Create `packages/provider-webdav/src/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { OmniFsError } from '@omni-fs/core';
import { toOmniFsError } from './errors.js';

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`Request failed with status code ${status}`), { status });
}

describe('toOmniFsError', () => {
  it('passes an OmniFsError straight through', () => {
    const original = OmniFsError.notFound('/a.txt');
    expect(toOmniFsError(original)).toBe(original);
  });

  it.each([
    [404, 'NotFound'],
    [401, 'AuthenticationFailed'],
    [403, 'PermissionDenied'],
    [405, 'AlreadyExists'],
    [409, 'Conflict'],
    [412, 'Conflict'],
    [423, 'PermissionDenied'],
    [507, 'QuotaExceeded'],
  ])('maps HTTP %i to %s', (status, code) => {
    expect(toOmniFsError(httpError(status), '/a.txt').code).toBe(code);
  });

  it('marks 429 and 5xx retryable', () => {
    expect(toOmniFsError(httpError(429)).retryable).toBe(true);
    expect(toOmniFsError(httpError(503)).retryable).toBe(true);
  });

  it('maps an aborted request to Cancelled', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(toOmniFsError(abort, '/a.txt').code).toBe('Cancelled');
  });

  it('maps a refused socket to ConnectionFailed and marks it retryable', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const translated = toOmniFsError(refused);
    expect(translated.code).toBe('ConnectionFailed');
    expect(translated.retryable).toBe(true);
  });

  it('falls back to Unknown rather than leaking a bare Error', () => {
    expect(toOmniFsError(new Error('something odd')).code).toBe('Unknown');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @omni-fs/provider-webdav exec vitest run src/errors.test.ts`
Expected: FAIL — `./errors.js` does not exist.

Before Step 3, confirm `QuotaExceeded` is a real member of `OmniFsErrorCode`:

Run: `grep -n "OmniFsErrorCode" -A 25 packages/core/src/errors.ts | head -30`

If it is absent, use `ProtocolError` for 507 and change the test row to match. Do not add a new code to core for this.

- [ ] **Step 3: Write the implementation**

Create `packages/provider-webdav/src/errors.ts`:

```ts
import { OmniFsError } from '@omni-fs/core';

/**
 * Translates `webdav` failures into the shared vocabulary. This happens here and
 * nowhere else — above this line no code knows that WebDAV speaks HTTP.
 */
export function toOmniFsError(cause: unknown, path?: string): OmniFsError {
  if (OmniFsError.is(cause)) return cause;

  const message = cause instanceof Error ? cause.message : String(cause);
  const base = { path, providerId: 'webdav', cause } as const;

  if (errorName(cause) === 'AbortError') return OmniFsError.cancelled(path ?? 'WebDAV request');

  switch (httpStatus(cause)) {
    case 401:
      return new OmniFsError({ ...base, code: 'AuthenticationFailed', message });
    case 403:
    case 423: // Locked — someone else holds a WebDAV lock on this resource.
      return new OmniFsError({ ...base, code: 'PermissionDenied', message });
    case 404:
      return OmniFsError.notFound(path ?? 'resource', cause);
    // MKCOL answers 405 when the collection is already there.
    case 405:
      return new OmniFsError({ ...base, code: 'AlreadyExists', message });
    case 409:
    case 412:
      return new OmniFsError({ ...base, code: 'Conflict', message });
    case 507:
      return new OmniFsError({ ...base, code: 'QuotaExceeded', message });
    case 408:
      return new OmniFsError({ ...base, code: 'Timeout', message, retryable: true });
    case 429:
      return new OmniFsError({ ...base, code: 'ProtocolError', message, retryable: true });
  }

  const status = httpStatus(cause);
  if (status !== undefined && status >= 500) {
    return new OmniFsError({ ...base, code: 'ProtocolError', message, retryable: true });
  }
  if (isNetworkError(cause)) {
    return new OmniFsError({ ...base, code: 'ConnectionFailed', message, retryable: true });
  }

  return new OmniFsError({ ...base, code: 'Unknown', message });
}

function errorName(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null) return '';
  const name = (cause as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

function httpStatus(cause: unknown): number | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const record = cause as { status?: unknown; response?: { status?: unknown } };
  if (typeof record.status === 'number') return record.status;
  return typeof record.response?.status === 'number' ? record.response.status : undefined;
}

function isNetworkError(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const code = (cause as { code?: unknown }).code;
  return (
    typeof code === 'string' &&
    ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ETIMEDOUT'].includes(code)
  );
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @omni-fs/provider-webdav exec vitest run src/errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/provider-webdav/src
git add packages/provider-webdav/src
git commit -m ":sparkles: feat translate webdav http failures into the shared OmniFsError vocabulary"
```

---

### Task 3: Settings module

**Files:**

- Create: `packages/provider-webdav/src/settings.ts`
- Modify: `packages/provider-webdav/src/settings.test.ts` (extend it)
- Modify: `packages/provider-webdav/src/index.ts` (re-export the schemas from `settings.ts`)

**Interfaces:**

- Consumes: the `rootPrefix` key from Task 1.
- Produces:
  - `WEBDAV_SETTINGS_SCHEMA: SettingsSchema`, `WEBDAV_SECRET_SCHEMA: SettingsSchema`
  - `interface WebdavSettings { baseUrl: string; authType: 'password' | 'token' | 'none'; username: string | undefined; rootPrefix: string }`
  - `readSettings(raw: Readonly<Record<string, unknown>>): WebdavSettings`

`rootPrefix` is normalised to no leading or trailing slash, exactly as `provider-s3/src/settings.ts` does with its own.

- [ ] **Step 1: Write the failing test**

Append to `packages/provider-webdav/src/settings.test.ts`:

```ts
import { OmniFsError } from '@omni-fs/core';
import { readSettings } from './settings.js';

describe('readSettings', () => {
  it('reads a complete configuration', () => {
    const settings = readSettings({
      baseUrl: 'http://localhost:8081',
      authType: 'password',
      username: 'omnifs',
      rootPrefix: 'docs',
    });
    expect(settings.baseUrl).toBe('http://localhost:8081');
    expect(settings.authType).toBe('password');
    expect(settings.username).toBe('omnifs');
    expect(settings.rootPrefix).toBe('docs');
  });

  it('strips surrounding slashes from the root prefix', () => {
    expect(readSettings({ baseUrl: 'http://h', rootPrefix: '/docs/' }).rootPrefix).toBe('docs');
  });

  it('defaults an absent root prefix to empty', () => {
    expect(readSettings({ baseUrl: 'http://h' }).rootPrefix).toBe('');
  });

  it('drops a trailing slash from the base url so paths do not double up', () => {
    expect(readSettings({ baseUrl: 'http://h/dav/' }).baseUrl).toBe('http://h/dav');
  });

  it('defaults authType to password', () => {
    expect(readSettings({ baseUrl: 'http://h' }).authType).toBe('password');
  });

  it('rejects an unknown authType rather than guessing', () => {
    expect(() => readSettings({ baseUrl: 'http://h', authType: 'kerberos' })).toThrow(OmniFsError);
  });

  it('throws a ProtocolError when the server url is missing', () => {
    try {
      readSettings({});
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(OmniFsError.is(error) && error.code).toBe('ProtocolError');
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @omni-fs/provider-webdav exec vitest run src/settings.test.ts`
Expected: FAIL — `./settings.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `packages/provider-webdav/src/settings.ts`. Move `WEBDAV_SETTINGS_SCHEMA` and `WEBDAV_SECRET_SCHEMA` here verbatim from `index.ts` (including the Task 1 `rootPrefix` field), then add:

```ts
export type WebdavAuthType = 'password' | 'token' | 'none';

export interface WebdavSettings {
  readonly baseUrl: string;
  readonly authType: WebdavAuthType;
  readonly username: string | undefined;
  /** Path segment treated as the connection root. No leading or trailing slash. */
  readonly rootPrefix: string;
}

const AUTH_TYPES: readonly WebdavAuthType[] = ['password', 'token', 'none'];

export function readSettings(raw: Readonly<Record<string, unknown>>): WebdavSettings {
  const baseUrl = readString(raw, 'baseUrl');
  if (baseUrl === undefined) {
    throw new OmniFsError({
      code: 'ProtocolError',
      message: 'WebDAV connection is missing a server URL.',
      providerId: 'webdav',
    });
  }

  const authType = readString(raw, 'authType') ?? 'password';
  if (!AUTH_TYPES.includes(authType as WebdavAuthType)) {
    throw new OmniFsError({
      code: 'ProtocolError',
      message: `Unknown WebDAV authentication type: ${authType}`,
      providerId: 'webdav',
    });
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    authType: authType as WebdavAuthType,
    username: readString(raw, 'username'),
    rootPrefix: (readString(raw, 'rootPrefix') ?? '').replace(/^\/+|\/+$/g, ''),
  };
}

function readString(raw: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
```

Add the imports it needs at the top:

```ts
import { OmniFsError } from '@omni-fs/core';
import type { SettingsSchema } from '@omni-fs/core';
```

Then in `index.ts`, delete the two schema constants and re-export them instead:

```ts
export { WEBDAV_SECRET_SCHEMA, WEBDAV_SETTINGS_SCHEMA } from './settings.js';
```

- [ ] **Step 4: Run the tests**

Run: `pnpm build && pnpm --filter @omni-fs/provider-webdav exec vitest run`
Expected: PASS, all settings and errors tests.

`settings.test.ts` imports `WEBDAV_SETTINGS_SCHEMA` from `./index.js`, which now re-exports it — if that import fails, change it to `./settings.js`.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/provider-webdav/src
git add packages/provider-webdav/src
git commit -m ":sparkles: feat add webdav settings parsing with a normalised root prefix"
```

---

### Task 4: Verify the declared capabilities against the live server

**Files:**

- Modify: `packages/provider-webdav/src/index.ts` (`WEBDAV_CAPABILITIES`, only if the probe disproves something)

**Interfaces:**

- Consumes: nothing.
- Produces: a `WEBDAV_CAPABILITIES` object that Task 5's `WebdavFileSystem` assigns to `capabilities`.

The skeleton already declares capabilities, but they were written from the protocol spec, not measured. The repo's rule is that a provider is penalised only for lying, so measure before implementing — a wrong `canReadRange` or `hasVersionTokens` here produces conformance failures in Task 9 that look like implementation bugs.

- [ ] **Step 1: Start the stack**

```bash
docker compose up -d
docker compose ps
```

Expected: `webdav` is `Up` on `127.0.0.1:8081`.

- [ ] **Step 2: Probe each doubtful capability**

```bash
A=omnifs:omnifs-dev-secret
curl -s -u $A -T <(printf '0123456789') http://localhost:8081/probe.txt -o /dev/null -w 'PUT %{http_code}\n'

# canReadRange — a 206 with body "234" means ranged GET works
curl -s -u $A -r 2-4 http://localhost:8081/probe.txt -w ' <- range %{http_code}\n'

# hasVersionTokens — an ETag header on GET, and getetag in PROPFIND
curl -s -u $A -I http://localhost:8081/probe.txt | grep -i '^etag' || echo 'NO ETAG HEADER'
curl -s -u $A -X PROPFIND -H 'Depth: 0' http://localhost:8081/probe.txt | grep -o 'getetag' || echo 'NO getetag PROP'

# canCopyServerSide
curl -s -u $A -X COPY -H 'Destination: http://localhost:8081/probe-copy.txt' \
  http://localhost:8081/probe.txt -o /dev/null -w 'COPY %{http_code}\n'

# canRename
curl -s -u $A -X MOVE -H 'Destination: http://localhost:8081/probe-moved.txt' \
  http://localhost:8081/probe-copy.txt -o /dev/null -w 'MOVE %{http_code}\n'

# canCreateDirectory
curl -s -u $A -X MKCOL http://localhost:8081/probe-dir/ -o /dev/null -w 'MKCOL %{http_code}\n'

# canDeleteRecursive — DELETE on a non-empty collection
curl -s -u $A -T <(echo x) http://localhost:8081/probe-dir/child.txt -o /dev/null -w 'PUT child %{http_code}\n'
curl -s -u $A -X DELETE http://localhost:8081/probe-dir/ -o /dev/null -w 'DELETE dir %{http_code}\n'

# clean up
curl -s -u $A -X DELETE http://localhost:8081/probe.txt -o /dev/null
curl -s -u $A -X DELETE http://localhost:8081/probe-moved.txt -o /dev/null
```

- [ ] **Step 3: Record the results and correct the declaration**

Expected: `PUT 201`, `range 206`, an `ETag` header, `COPY 201`, `MOVE 201`, `MKCOL 201`, `DELETE dir 204`.

Write the observed values into the ledger. For each capability the probe **disproves**, flip it to `false` in `WEBDAV_CAPABILITIES` in `packages/provider-webdav/src/index.ts` and note why in a comment. The two most likely to fail against this nginx image are:

- `hasVersionTokens` — if PROPFIND returns no `getetag`, `list()` cannot carry etags even though `stat()` can. Keep `true` only if the header is present on GET **and** `getetag` appears in PROPFIND; otherwise set it `false`, which makes the conformance suite skip the `ifMatch` path rather than fail it.
- `canDeleteRecursive` — if `DELETE` on a non-empty collection is refused, set it `false` and let `ManagedFileSystem` walk-and-delete.

Leave `canAppend: false`, `canWatch: false`, `preservesMTime: false`, `hasRealDirectories: true`, `listIsPaginated: false`, `maxConcurrency: 6` as declared; none of those is in doubt.

- [ ] **Step 4: Verify the file still compiles**

Run: `pnpm build && pnpm typecheck && pnpm lint`
Expected: all pass.

- [ ] **Step 5: Commit (only if Step 3 changed anything)**

```bash
pnpm exec prettier --write packages/provider-webdav/src
git add packages/provider-webdav/src
git commit -m ":pencil2: fix declare webdav capabilities from what the server actually answers"
```

If the probe confirmed every declaration, skip the commit and say so in the report.

---

### Task 5: Connect, stat and list

**Files:**

- Create: `packages/provider-webdav/src/webdav-file-system.ts`
- Create: `packages/provider-webdav/vitest.config.ts`
- Create: `packages/provider-webdav/vitest.conformance.config.ts`
- Create: `packages/provider-webdav/src/webdav.live.test.ts`
- Modify: `packages/provider-webdav/package.json` (add the `test:conformance` script)
- Modify: `packages/provider-webdav/src/index.ts` (`create` returns the real class)

**Interfaces:**

- Consumes: `toOmniFsError` (Task 2), `readSettings`/`WebdavSettings` (Task 3), `WEBDAV_CAPABILITIES` (Task 4).
- Produces: `class WebdavFileSystem implements RemoteFileSystem`, constructed as `new WebdavFileSystem(context: ProviderContext)`. Tasks 6-8 add methods to this same class.

- [ ] **Step 1: Add the two vitest configs and the script**

Create `packages/provider-webdav/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

// Live tests need the compose stack, so the default run excludes them and
// `pnpm test` stays hermetic.
export default defineConfig({
  test: { exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'] },
});
```

Create `packages/provider-webdav/vitest.conformance.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.live.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
});
```

In `packages/provider-webdav/package.json`, add to `scripts`:

```json
    "test:conformance": "vitest run --config vitest.conformance.config.ts",
```

- [ ] **Step 2: Write the failing live test**

Create `packages/provider-webdav/src/webdav.live.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { NOOP_LOGGER, OmniFsError, RemotePath } from '@omni-fs/core';
import type { ConnectionConfig } from '@omni-fs/core';
import { WebdavFileSystem } from './webdav-file-system.js';

const BASE_URL = process.env['OMNI_FS_WEBDAV_URL'] ?? 'http://localhost:8081';
const USERNAME = process.env['OMNI_FS_WEBDAV_USER'] ?? 'omnifs';
const PASSWORD = process.env['OMNI_FS_WEBDAV_PASSWORD'] ?? 'omnifs-dev-secret';

export function connect(): WebdavFileSystem {
  const config: ConnectionConfig = {
    id: 'live',
    providerId: 'webdav',
    label: 'live',
    settings: { baseUrl: BASE_URL, authType: 'password', username: USERNAME },
  };
  return new WebdavFileSystem({
    config,
    getSecret: async () => ({ password: PASSWORD }),
    logger: NOOP_LOGGER,
  });
}

describe('WebdavFileSystem against a live server', () => {
  it('connects and stats the root as a directory', async () => {
    const fs = connect();
    await fs.connect();
    try {
      expect(fs.isAlive()).toBe(true);
      expect((await fs.stat(RemotePath.ROOT)).type).toBe('directory');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('lists the seeded tree, distinguishing files from directories', async () => {
    const fs = connect();
    await fs.connect();
    try {
      const entries = [];
      for await (const entry of fs.list(RemotePath.ROOT)) entries.push(entry);
      const byName = new Map(entries.map((entry) => [entry.name, entry]));
      expect(byName.get('readme.txt')?.type).toBe('file');
      expect(byName.get('docs')?.type).toBe('directory');
      // Entry paths must be absolute and resolvable, not bare names.
      expect(byName.get('readme.txt')?.path.value).toBe('/readme.txt');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('reports a missing path as NotFound', async () => {
    const fs = connect();
    await fs.connect();
    try {
      await expect(fs.stat(RemotePath.parse('/definitely-not-here.txt'))).rejects.toSatisfy(
        (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
      );
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
docker compose up -d
pnpm --filter @omni-fs/provider-webdav test:conformance
```

Expected: FAIL — `./webdav-file-system.js` does not exist.

- [ ] **Step 4: Write the implementation**

Create `packages/provider-webdav/src/webdav-file-system.ts`:

```ts
import { AuthType, createClient, type FileStat as DavStat, type WebDAVClient } from 'webdav';
import { OmniFsError } from '@omni-fs/core';
import type {
  DirEntry,
  FileStat,
  Logger,
  ProviderCapabilities,
  ProviderContext,
  RemotePath,
} from '@omni-fs/core';
import { toOmniFsError } from './errors.js';
import { readSettings, type WebdavSettings } from './settings.js';

/**
 * WebDAV, including Nextcloud and ownCloud.
 *
 * The one protocol of the four with both a native server-side copy (`COPY`) and
 * real directories (`MKCOL`), so almost nothing is emulated above it. Unlike S3
 * a directory is a real resource, which makes this the first provider to
 * exercise the `hasRealDirectories: true` half of the conformance suite.
 */
export class WebdavFileSystem implements RemoteFileSystem {
  readonly capabilities: ProviderCapabilities = WEBDAV_CAPABILITIES;

  // NOTE: WEBDAV_CAPABILITIES is declared at the bottom of THIS file (see the
  // end of Step 4) and re-exported from index.ts. It must not live in index.ts:
  // that file imports this one, so reading it from there would be a cycle.

  readonly #context: ProviderContext;
  readonly #settings: WebdavSettings;
  readonly #logger: Logger;
  #client: WebDAVClient | undefined;

  constructor(context: ProviderContext) {
    this.#context = context;
    this.#settings = readSettings(context.config.settings);
    this.#logger = context.logger;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.#client !== undefined) return;

    const { baseUrl, authType, username } = this.#settings;
    if (authType === 'none') {
      this.#client = createClient(baseUrl);
    } else {
      const secret = await this.#context.getSecret(signal);
      this.#client =
        authType === 'token'
          ? createClient(baseUrl, {
              authType: AuthType.Token,
              token: { access_token: requireString(secret, 'token'), token_type: 'Bearer' },
            })
          : createClient(baseUrl, {
              username: username ?? '',
              password: requireString(secret, 'password'),
            });
    }

    this.#logger.log('info', 'WebDAV client created', { baseUrl, authType });
  }

  isAlive(): boolean {
    return this.#client !== undefined;
  }

  async stat(path: RemotePath, signal?: AbortSignal): Promise<FileStat> {
    const stat = await this.#run(
      (client) => client.stat(this.#remote(path), { signal }) as Promise<DavStat>,
      path.value,
    );
    return toFileStat(stat);
  }

  async *list(path: RemotePath, signal?: AbortSignal): AsyncIterable<DirEntry> {
    const contents = await this.#run(
      (client) => client.getDirectoryContents(this.#remote(path), { signal }) as Promise<DavStat[]>,
      path.value,
    );

    for (const entry of contents) {
      // Some servers include the collection itself in its own listing.
      if (entry.basename === '' || entry.basename === path.basename) continue;
      yield { ...toFileStat(entry), name: entry.basename, path: path.join(entry.basename) };
    }
  }

  /** Applies the connection's root prefix, so a connection can be scoped to a subfolder. */
  #remote(path: RemotePath): string {
    const root = this.#settings.rootPrefix;
    return root === '' ? path.value : `/${root}${path.value === '/' ? '' : path.value}`;
  }

  #requireClient(): WebDAVClient {
    if (this.#client === undefined) {
      throw new OmniFsError({
        code: 'ConnectionFailed',
        message: 'WebDAV client is not connected. Call connect() first.',
        providerId: 'webdav',
      });
    }
    return this.#client;
  }

  async #run<T>(body: (client: WebDAVClient) => Promise<T>, path?: string): Promise<T> {
    try {
      return await body(this.#requireClient());
    } catch (error) {
      throw toOmniFsError(error, path);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#client = undefined;
  }
}

function toFileStat(stat: DavStat): FileStat {
  return {
    type: stat.type === 'directory' ? 'directory' : 'file',
    size: stat.size,
    mtime: stat.lastmod === undefined ? undefined : Date.parse(stat.lastmod),
    etag: stat.etag ?? undefined,
    raw: { mime: stat.mime },
  };
}

function requireString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new OmniFsError({
      code: 'AuthenticationFailed',
      message: `Missing credential field: ${key}`,
      providerId: 'webdav',
    });
  }
  return value;
}
```

Import `RemoteFileSystem` as a type alongside the others.

Then in `index.ts`, delete the placeholder class and the `notImplemented` helper, and point `create` at the real one:

```ts
import { WebdavFileSystem } from './webdav-file-system.js';
// ...
  create: (context) => new WebdavFileSystem(context),
```

Move the whole `WEBDAV_CAPABILITIES` constant out of `index.ts` and paste it at the bottom of `webdav-file-system.ts`, with the value Task 4 verified. Then re-export it from `index.ts` so its public name does not change:

```ts
export { WEBDAV_CAPABILITIES, WebdavFileSystem } from './webdav-file-system.js';
```

Dependencies then run one way only — `index.ts` → `webdav-file-system.ts` → `settings.ts`/`errors.ts` — with no cycle, which matters under `module: Node16`.

- [ ] **Step 5: Run the live tests**

Run: `pnpm build && pnpm --filter @omni-fs/provider-webdav test:conformance`
Expected: PASS, 3 tests.

Run: `pnpm test`
Expected: PASS, and the live tests are **not** among them.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write packages/provider-webdav
git add packages/provider-webdav
git commit -m ":sparkles: feat implement webdav connect, stat and list"
```

---

### Task 6: Reading

**Files:**

- Modify: `packages/provider-webdav/src/webdav-file-system.ts`
- Modify: `packages/provider-webdav/src/webdav.live.test.ts`

**Interfaces:**

- Consumes: `WebdavFileSystem` from Task 5.
- Produces: `readFile(path, options?)` and `createReadStream(path, options?)` on the same class.

`client.createReadStream` returns a **Node** `Readable`; the contract wants a web `ReadableStream`. Convert with `Readable.toWeb` from `node:stream`.

- [ ] **Step 1: Write the failing test**

Append to `webdav.live.test.ts`, inside the existing `describe`:

```ts
it('reads a whole file', async () => {
  const fs = connect();
  await fs.connect();
  try {
    const bytes = await fs.readFile(RemotePath.parse('/readme.txt'));
    expect(new TextDecoder().decode(bytes)).toContain('omni-fs test file');
  } finally {
    await fs[Symbol.asyncDispose]();
  }
});

it('reads a byte range', async () => {
  const fs = connect();
  await fs.connect();
  try {
    // The seeded readme.txt is exactly "omni-fs test file\n".
    const slice = await fs.readFile(RemotePath.parse('/readme.txt'), { offset: 0, length: 7 });
    expect(new TextDecoder().decode(slice)).toBe('omni-fs');
  } finally {
    await fs[Symbol.asyncDispose]();
  }
});
```

Both tests read the seeded tree, so this task needs nothing from Tasks 7 or 8 and ends green on its own.

- [ ] **Step 2: Run and watch the whole-file test fail**

Run: `pnpm --filter @omni-fs/provider-webdav test:conformance`
Expected: FAIL — `fs.readFile is not a function`.

- [ ] **Step 3: Implement reading**

Add to `WebdavFileSystem`, and add `import { Readable } from 'node:stream';` plus `collectStream` to the `@omni-fs/core` import:

```ts
  async readFile(path: RemotePath, options?: ReadOptions): Promise<Uint8Array> {
    return collectStream(await this.createReadStream(path, options));
  }

  async createReadStream(
    path: RemotePath,
    options?: ReadOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    const range = buildRange(options);
    const stream = this.#requireClient().createReadStream(this.#remote(path), {
      ...(range !== undefined ? { range } : {}),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });

    // The library hands back a Node stream; the contract asks for a web one.
    return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  }
```

and the helper:

```ts
function buildRange(options: ReadOptions | undefined): { start: number; end?: number } | undefined {
  if (options?.offset === undefined) return undefined;
  const start = options.offset;
  return options.length === undefined ? { start } : { start, end: start + options.length - 1 };
}
```

Add `ReadOptions` to the type-only import from `@omni-fs/core`.

- [ ] **Step 4: Run the tests**

Run: `pnpm build && pnpm --filter @omni-fs/provider-webdav test:conformance`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/provider-webdav
git add packages/provider-webdav
git commit -m ":sparkles: feat implement webdav file reads including byte ranges"
```

---

### Task 7: Writing

**Files:**

- Modify: `packages/provider-webdav/src/webdav-file-system.ts`
- Modify: `packages/provider-webdav/src/webdav.live.test.ts`

**Interfaces:**

- Consumes: `WebdavFileSystem` from Tasks 5-6.
- Produces: `writeFile(path, data, options?)` and `createWriteStream(path, options?)`.

- [ ] **Step 1: Write the failing test**

Append inside the `describe`:

```ts
it('round-trips a write and refuses to overwrite when told not to', async () => {
  const fs = connect();
  await fs.connect();
  const path = RemotePath.parse('/write-probe.txt');
  try {
    await fs.writeFile(path, new TextEncoder().encode('first'));
    expect(new TextDecoder().decode(await fs.readFile(path))).toBe('first');

    await expect(
      fs.writeFile(path, new TextEncoder().encode('second'), { overwrite: false }),
    ).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'AlreadyExists',
    );
    expect(new TextDecoder().decode(await fs.readFile(path))).toBe('first');
  } finally {
    await fs.delete(path).catch(() => undefined);
    await fs[Symbol.asyncDispose]();
  }
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @omni-fs/provider-webdav test:conformance`
Expected: FAIL — `fs.writeFile is not a function`.

- [ ] **Step 3: Implement writing**

```ts
  async writeFile(path: RemotePath, data: Uint8Array, options?: WriteOptions): Promise<void> {
    if (options?.overwrite === false && (await this.#exists(path, options.signal))) {
      throw OmniFsError.alreadyExists(path.value);
    }

    await this.#run(
      (client) =>
        client.putFileContents(this.#remote(path), Buffer.from(data), {
          overwrite: options?.overwrite !== false,
          contentLength: data.byteLength,
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        }),
      path.value,
    );

    options?.onProgress?.(data.byteLength, data.byteLength);
  }

  async createWriteStream(
    path: RemotePath,
    options?: WriteOptions,
  ): Promise<WritableStream<Uint8Array>> {
    const stream = this.#requireClient().createWriteStream(this.#remote(path), {
      overwrite: options?.overwrite !== false,
    });
    return Writable.toWeb(stream) as WritableStream<Uint8Array>;
  }

  async #exists(path: RemotePath, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.stat(path, signal);
      return true;
    } catch (error) {
      if (OmniFsError.is(error) && error.code === 'NotFound') return false;
      throw error;
    }
  }
```

Widen Task 6's `node:stream` import to `import { Readable, Writable } from 'node:stream';` and add `WriteOptions` to the type-only core import.

`putFileContents` takes a Node `Buffer`; `Buffer.from(data)` does not copy for a `Uint8Array` view.

- [ ] **Step 4: Run the tests**

Run: `pnpm build && pnpm --filter @omni-fs/provider-webdav test:conformance`
Expected: PASS, including the range test parked in Task 6.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/provider-webdav
git add packages/provider-webdav
git commit -m ":sparkles: feat implement webdav writes with an overwrite guard"
```

---

### Task 8: Delete, create directory, rename and copy

**Files:**

- Modify: `packages/provider-webdav/src/webdav-file-system.ts`
- Modify: `packages/provider-webdav/src/webdav.live.test.ts`

**Interfaces:**

- Consumes: `WebdavFileSystem` from Tasks 5-7.
- Produces: `delete`, `createDirectory`, `rename`, `copy`. Each is only present because Task 4 confirmed the matching capability.

- [ ] **Step 1: Write the failing test**

```ts
it('creates a directory, copies, renames and deletes recursively', async () => {
  const fs = connect();
  await fs.connect();
  const dir = RemotePath.parse('/tree-probe');
  try {
    await fs.createDirectory?.(dir);
    expect((await fs.stat(dir)).type).toBe('directory');

    const source = dir.join('source.txt');
    await fs.writeFile(source, new TextEncoder().encode('payload'));

    await fs.copy?.(source, dir.join('copy.txt'));
    expect(new TextDecoder().decode(await fs.readFile(dir.join('copy.txt')))).toBe('payload');
    expect((await fs.stat(source)).type).toBe('file');

    await fs.rename?.(source, dir.join('moved.txt'));
    expect(new TextDecoder().decode(await fs.readFile(dir.join('moved.txt')))).toBe('payload');
    await expect(fs.stat(source)).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
    );

    await fs.delete(dir, { recursive: true });
    await expect(fs.stat(dir)).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
    );
  } finally {
    await fs.delete(dir, { recursive: true }).catch(() => undefined);
    await fs[Symbol.asyncDispose]();
  }
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @omni-fs/provider-webdav test:conformance`
Expected: FAIL — `fs.createDirectory is not a function`.

- [ ] **Step 3: Implement the four methods**

```ts
  async delete(path: RemotePath, options?: DeleteOptions): Promise<void> {
    // WebDAV DELETE on a collection is recursive by definition, so the
    // non-recursive case is enforced here rather than by the server.
    if (options?.recursive !== true && (await this.stat(path, options?.signal)).type === 'directory') {
      const children = this.list(path, options?.signal);
      for await (const _child of children) {
        throw new OmniFsError({
          code: 'Conflict',
          message: `Directory is not empty: ${path.value}`,
          path: path.value,
          providerId: 'webdav',
        });
      }
    }

    await this.#run((client) => client.deleteFile(this.#remote(path)), path.value);
  }

  async createDirectory(path: RemotePath, signal?: AbortSignal): Promise<void> {
    await this.#run(
      (client) => client.createDirectory(this.#remote(path), { recursive: true, signal }),
      path.value,
    );
  }

  async rename(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void> {
    await this.#run(
      (client) =>
        client.moveFile(this.#remote(from), this.#remote(to), {
          overwrite: options?.overwrite !== false,
        }),
      from.value,
    );
  }

  async copy(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void> {
    await this.#run(
      (client) =>
        client.copyFile(this.#remote(from), this.#remote(to), {
          overwrite: options?.overwrite !== false,
        }),
      from.value,
    );
  }
```

Add `DeleteOptions` and `OverwriteOptions` to the type-only core import.

If Task 4 found `canDeleteRecursive: false`, delete the recursive branch and let core walk the tree; if it found `canCopyServerSide: false`, remove `copy` entirely rather than emulating it.

- [ ] **Step 4: Run the tests**

Run: `pnpm build && pnpm --filter @omni-fs/provider-webdav test:conformance && pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/provider-webdav
git add packages/provider-webdav
git commit -m ":sparkles: feat implement webdav delete, mkcol, move and copy"
```

---

### Task 9: Turn on the shared conformance suite

**Files:**

- Modify: `packages/provider-webdav/src/webdav.live.test.ts` (add `runConformanceSuite`)
- Modify: `docker/README.md`
- Modify: `CLAUDE.md`

**Interfaces:**

- Consumes: the finished `WebdavFileSystem`.
- Produces: a green `pnpm test:conformance` at the repo root.

This is the task that decides whether the provider is finished. Everything before it was the provider's own tests; this is the shared contract every provider must pass.

- [ ] **Step 1: Wire the harness**

Append to `webdav.live.test.ts`:

```ts
import { runConformanceSuite } from '@omni-fs/testing';

runConformanceSuite({
  name: 'WebDAV (nginx)',
  setup: async () => {
    const fs = connect();
    await fs.connect();
    // A per-run directory, so a crashed run never poisons the next one.
    const root = RemotePath.parse(`/conformance-${String(Date.now())}`);
    await fs.createDirectory?.(root);
    return { fs, root };
  },
  teardown: async (fs) => {
    await fs[Symbol.asyncDispose]();
  },
});
```

Confirm `runConformanceSuite` is exported from `@omni-fs/testing`:

Run: `cat packages/testing/src/index.ts`

The suite's `teardown` receives only the filesystem, not the root, so the per-run directories accumulate. Delete them in `setup` before creating the new one, or add a final cleanup test — decide, and record the choice in the ledger.

- [ ] **Step 2: Run the suite and watch it fail**

Run: `pnpm build && pnpm --filter @omni-fs/provider-webdav test:conformance`
Expected: FAIL on at least one case. The likely candidates are the two paths never exercised by the S3 reference: `does not list grandchildren as direct children` and `refuses to overwrite when overwrite is false`.

- [ ] **Step 3: Fix what the suite catches**

Fix the provider, never the suite. A case that genuinely does not apply must be excluded by a capability flag in `WEBDAV_CAPABILITIES`, not by editing `packages/testing/src/conformance.ts` — changing the suite changes the contract for all four providers.

If a case fails because the capability declaration is wrong, correct the declaration and note it in the ledger against the Task 4 measurement.

- [ ] **Step 4: Verify everything**

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm format:check
pnpm test:conformance
```

Expected: all pass. `pnpm test:conformance` at the root runs through turbo and reaches the new script.

- [ ] **Step 5: Document it**

Add to `docker/README.md`, under the "What you can actually test today" section:

````markdown
## Conformance suite

With the stack up, the shared behavioural contract runs against the live servers:

```bash
docker compose up -d
pnpm test:conformance
```
````

Providers that are still skeletons contribute no cases. A provider is finished
exactly when this passes for it.

````

In `CLAUDE.md`, replace the sentence "`turbo.json` defines a `test:conformance` task that no package implements yet." with:

```markdown
`pnpm test:conformance` runs the shared suite against the live servers in
`compose.yaml`; `packages/provider-webdav` implements it today.
````

and update the "Current state" paragraph so WebDAV is no longer listed as a skeleton.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write packages/provider-webdav docker/README.md CLAUDE.md
git add packages/provider-webdav docker/README.md CLAUDE.md
git commit -m ":white_check_mark: test run the shared conformance suite against the live webdav server"
```

---

## What this plan deliberately leaves out

- **FTP and SFTP.** Each gets its own plan once this one lands. The compose stack already has servers for both, and the FTP server has no TLS, so an FTPS-capable image is a prerequisite for that plan.
- **Consolidating `rootPath` and `rootPrefix`.** See the ruling above.
- **`canWatch`.** WebDAV has no change notification; core polls.
- **Download/upload commands.** Still stubs in `apps/vscode`; the queue, retry and progress already exist in core and are provider-independent.
