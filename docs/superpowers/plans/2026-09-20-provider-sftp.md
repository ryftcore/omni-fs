# SFTP Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@omni-fs/provider-sftp` a real provider that passes the shared conformance suite against the live openssh container, with host key verification, and add it to `pnpm test:conformance`.

**Architecture:** Two layers inside the package. `sftp-session.ts` owns the transport — the `ssh2` connection, the promisified `SFTPWrapper`, the `AbortSignal` race and OpenSSH extension detection — and exposes the narrow `SftpApi` interface. `sftp-file-system.ts` implements `RemoteFileSystem` over `SftpApi` and contains no callbacks, so the hermetic tests substitute a fake `SftpApi` rather than a network library. Everything that touches the local disk lives in `local-files.ts`, so a future `LocalFiles` port has one file to replace.

**Tech Stack:** `ssh2@^1.17.0` (dependency, replacing `ssh2-sftp-client`), `@types/ssh2@^1.15.6` (dev), `node:crypto` for known_hosts hashing and fingerprints, vitest, the compose stack in `compose.yaml` (`docker/sftp`, OpenSSH 9.7 on Alpine 3.20, `127.0.0.1:2222`).

**Spec:** `docs/superpowers/specs/2026-09-20-provider-sftp-design.md`. It carries the six rulings this plan implements and the reasoning behind each; read it before Task 1. The binding contracts are `packages/core/src/provider.ts`, `packages/core/src/capabilities.ts` and `packages/testing/src/conformance.ts`, and `packages/provider-webdav` is the reference implementation to follow in shape.

## Global Constraints

- Nothing in `packages/` may import `vscode` or `electron`. Nothing in `packages/core` may import a protocol SDK. Enforced by `eslint.config.mjs` and a CI grep. `ssh2` is fine in this package; it is banned in core.
- Providers throw `OmniFsError` and nothing else; translate native errors in this package's own `errors.ts`.
- Providers never cache. Caching is `ManagedFileSystem`'s job, above this interface.
- Declare capabilities honestly. Do not implement an optional method while declaring its capability false, or the reverse — with the one documented exception this plan introduces in Task 7, where `canCopyServerSide` is answered per connection.
- Accept an `AbortSignal` on every method that touches the network.
- TypeScript is held at 6.0.x; `@types/node` at 22. Strictness includes `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`, `module: Node16` — so relative imports carry a `.js` extension and optional properties are written `| undefined`.
- `.npmrc` sets `hoist=false`: a package may only import what its own `package.json` declares.
- Commits are a single title line, `:emoji: <type> <description>`, no body. Never add `Co-Authored-By` or any session attribution. CI enforces both the pattern and the empty body.
- Never run `pnpm format`. Run `pnpm exec prettier --write <files you touched>` instead.
- After changing a `packages/*` source file, run `pnpm build` before any typecheck of a dependent — packages resolve each other through `dist/`, not source.
- `pnpm test` must stay hermetic: no test outside `*.live.test.ts` may need Docker or a network.

---

## File Structure

| File                                                           | Responsibility                                                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/provider-sftp/package.json` (modify)                 | `ssh2` in, `ssh2-sftp-client` out, `test:conformance` added                                                            |
| `packages/provider-sftp/vitest.config.ts` (create)             | default run excludes `*.live.test.ts` and `dist/**`                                                                    |
| `packages/provider-sftp/vitest.conformance.config.ts` (create) | includes only `*.live.test.ts`, 30s timeouts                                                                           |
| `src/settings.ts` (create)                                     | schemas, `SftpSettings`, `readSettings()` — the one `readSettings` that keeps a leading slash                          |
| `src/errors.ts` (create)                                       | `toOmniFsError()`, `isFailure()`                                                                                       |
| `src/local-files.ts` (create)                                  | the only file that touches the local disk: `expandHome()`, `readLocalFile()`                                           |
| `src/known-hosts.ts` (create)                                  | `parseKnownHosts()`, `verifyHostKey()`, `fingerprint()`, `readKnownHosts()`                                            |
| `src/auth.ts` (create)                                         | `buildAuth()` — password, private key, agent                                                                           |
| `src/sftp-session.ts` (create)                                 | `SftpApi`, `SftpConnection`, `SftpSession`, the abort race, extension detection                                        |
| `src/sftp-helpers.ts` (create)                                 | pure helpers: `toFileType()`, `toFileStat()`, `resolveBase()`, `joinRemote()`, `buildRange()`, `translateReadStream()` |
| `src/sftp-file-system.ts` (create)                             | `SFTP_CAPABILITIES`, `SftpFileSystem implements RemoteFileSystem`                                                      |
| `src/index.ts` (rewrite)                                       | `sftpProvider: ProviderDefinition` plus re-exports, ~20 lines                                                          |
| `src/*.test.ts` (create)                                       | one test file per module above                                                                                         |
| `src/sftp.live.test.ts` (create)                               | `runConformanceSuite()` plus the cases only a real server can show                                                     |
| `packages/core/src/capabilities.ts` (modify)                   | sharpen the `canDeleteRecursive` comment                                                                               |
| `docker/README.md`, `README.md` (modify)                       | SFTP moves from scaffolded to implemented                                                                              |

Live tests are named `*.live.test.ts` so `pnpm test` stays hermetic while `pnpm test:conformance` runs exactly those, matching `provider-webdav`.

---

### Task 1: Dependency swap, test wiring and the settings module

**Files:**

- Modify: `packages/provider-sftp/package.json`
- Create: `packages/provider-sftp/vitest.config.ts`
- Create: `packages/provider-sftp/vitest.conformance.config.ts`
- Create: `packages/provider-sftp/src/settings.ts`
- Create: `packages/provider-sftp/src/settings.test.ts`
- Modify: `packages/provider-sftp/src/index.ts` (import the schemas instead of declaring them)

**Interfaces:**

- Consumes: nothing.
- Produces: `SFTP_SETTINGS_SCHEMA`, `SFTP_SECRET_SCHEMA`, `SftpAuthMethod` (`'password' | 'privateKey' | 'agent'`), `SftpSettings`, and `readSettings(raw: Readonly<Record<string, unknown>>): SftpSettings`. Every later task reads `SftpSettings`.

- [ ] **Step 1: Swap the dependency and split the test runs**

In `packages/provider-sftp/package.json`, replace the `test` script and the dependency block:

```json
  "scripts": {
    "build": "tsc -b",
    "dev": "tsc -b --watch",
    "typecheck": "tsc -b --noEmit false --emitDeclarationOnly",
    "lint": "eslint src",
    "test": "vitest run --passWithNoTests",
    "test:conformance": "vitest run --config vitest.conformance.config.ts",
    "clean": "rm -rf dist *.tsbuildinfo"
  },
  "dependencies": {
    "@omni-fs/core": "workspace:*",
    "ssh2": "^1.17.0"
  },
  "devDependencies": {
    "@omni-fs/testing": "workspace:*",
    "@types/node": "^22.8.0",
    "@types/ssh2": "^1.15.6",
    "typescript": "^6.0.3",
    "vitest": "^5.0.0"
  }
```

- [ ] **Step 2: Add both vitest configs**

Create `packages/provider-sftp/vitest.config.ts` — the same file `provider-webdav` has, for the same reason:

```ts
import { configDefaults, defineConfig } from 'vitest/config';

// Live tests need the compose stack, so the default run excludes them and
// `pnpm test` stays hermetic. `dist/**` is named as well because vitest's
// defaults do not cover it and the packages emit there.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '**/dist/**', '**/*.live.test.ts'] },
});
```

Create `packages/provider-sftp/vitest.conformance.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.live.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
});
```

- [ ] **Step 3: Install and commit the toolchain change**

Run: `pnpm install`
Expected: `ssh2-sftp-client` disappears from `packages/provider-sftp`, `ssh2` and `@types/ssh2` appear. `pnpm-workspace.yaml` already carries `ssh2: true` in `allowBuilds` and `cpu-features: false`, so the install stays non-interactive and needs no edit there.

```bash
git add packages/provider-sftp/package.json packages/provider-sftp/vitest.config.ts packages/provider-sftp/vitest.conformance.config.ts pnpm-lock.yaml
git commit -m ":wrench: build point provider-sftp at ssh2 and split its hermetic and live test runs"
```

- [ ] **Step 4: Write the failing settings test**

Create `packages/provider-sftp/src/settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { OmniFsError } from '@omni-fs/core';
import { SFTP_SETTINGS_SCHEMA, readSettings } from './settings.js';

const base = { host: 'sftp.example.com', username: 'alice' };

describe('SFTP_SETTINGS_SCHEMA', () => {
  it('offers a known_hosts override as a file field', () => {
    const field = SFTP_SETTINGS_SCHEMA.fields.find((f) => f.key === 'knownHostsPath');
    expect(field?.kind).toBe('file');
  });

  it('shows an absolute root prefix in the placeholder, because that is the common form here', () => {
    const field = SFTP_SETTINGS_SCHEMA.fields.find((f) => f.key === 'rootPrefix');
    expect(field).toMatchObject({ kind: 'text', label: 'Root prefix', placeholder: '/var/www' });
  });
});

describe('readSettings', () => {
  it('defaults the port to 22 and the auth method to password', () => {
    const settings = readSettings(base);
    expect(settings.port).toBe(22);
    expect(settings.authMethod).toBe('password');
  });

  it('keeps a leading slash on rootPrefix, unlike every other provider', () => {
    expect(readSettings({ ...base, rootPrefix: '/var/www' }).rootPrefix).toBe('/var/www');
  });

  it('keeps a relative rootPrefix relative', () => {
    expect(readSettings({ ...base, rootPrefix: 'projects' }).rootPrefix).toBe('projects');
  });

  it('strips trailing slashes and collapses a repeated leading slash', () => {
    expect(readSettings({ ...base, rootPrefix: '//var/www/' }).rootPrefix).toBe('/var/www');
  });

  it('treats a blank rootPrefix as the login directory', () => {
    expect(readSettings({ ...base, rootPrefix: '   ' }).rootPrefix).toBe('');
  });

  it('rejects a connection with no host', () => {
    expect(() => readSettings({ username: 'alice' })).toThrowError(OmniFsError);
    try {
      readSettings({ username: 'alice' });
    } catch (error) {
      expect(OmniFsError.is(error) && error.code).toBe('ProtocolError');
    }
  });

  it('rejects a connection with no username', () => {
    try {
      readSettings({ host: 'sftp.example.com' });
      expect.unreachable('readSettings should have thrown');
    } catch (error) {
      expect(OmniFsError.is(error) && error.code).toBe('ProtocolError');
    }
  });

  it('rejects an unknown authentication method', () => {
    try {
      readSettings({ ...base, authMethod: 'kerberos' });
      expect.unreachable('readSettings should have thrown');
    } catch (error) {
      expect(OmniFsError.is(error) && error.code).toBe('ProtocolError');
    }
  });

  it('rejects a port outside the legal range', () => {
    try {
      readSettings({ ...base, port: 70000 });
      expect.unreachable('readSettings should have thrown');
    } catch (error) {
      expect(OmniFsError.is(error) && error.code).toBe('ProtocolError');
    }
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `pnpm --filter @omni-fs/provider-sftp exec vitest run src/settings.test.ts`
Expected: FAIL — `Cannot find module './settings.js'`.

- [ ] **Step 6: Write the settings module**

Create `packages/provider-sftp/src/settings.ts`:

```ts
import { OmniFsError } from '@omni-fs/core';
import type { SettingsSchema } from '@omni-fs/core';

export const SFTP_SETTINGS_SCHEMA: SettingsSchema = {
  fields: [
    { kind: 'text', key: 'host', label: 'Host', required: true, placeholder: 'sftp.example.com' },
    { kind: 'number', key: 'port', label: 'Port', default: 22, min: 1, max: 65535 },
    { kind: 'text', key: 'username', label: 'Username', required: true },
    {
      kind: 'select',
      key: 'authMethod',
      label: 'Authentication',
      required: true,
      default: 'password',
      options: [
        { value: 'password', label: 'Password' },
        { value: 'privateKey', label: 'Private key' },
        { value: 'agent', label: 'SSH agent' },
      ],
    },
    {
      kind: 'file',
      key: 'privateKeyPath',
      label: 'Private key file',
      help: 'Used when authentication is set to Private key. e.g. ~/.ssh/id_ed25519',
    },
    {
      kind: 'file',
      key: 'knownHostsPath',
      label: 'known_hosts file',
      help: 'Optional. Defaults to ~/.ssh/known_hosts. A host listed there with a different key is refused.',
    },
    {
      kind: 'text',
      key: 'rootPrefix',
      label: 'Root prefix',
      placeholder: '/var/www',
      help: 'Optional. Scopes the connection to a subfolder of the login directory. Begin with / for an absolute server path, e.g. /var/www.',
    },
  ],
};

export const SFTP_SECRET_SCHEMA: SettingsSchema = {
  fields: [
    { kind: 'password', key: 'password', label: 'Password', help: 'For password authentication.' },
    {
      kind: 'password',
      key: 'passphrase',
      label: 'Key passphrase',
      help: 'For an encrypted private key.',
    },
  ],
};

export type SftpAuthMethod = 'password' | 'privateKey' | 'agent';

export interface SftpSettings {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly authMethod: SftpAuthMethod;
  readonly privateKeyPath: string | undefined;
  readonly knownHostsPath: string | undefined;
  /**
   * Where the connection starts. `''` is the login directory, `projects` sits
   * below it, and `/var/www` is an absolute server path.
   *
   * This is the one `readSettings` in the repo that keeps a leading slash.
   * `provider-s3` and `provider-webdav` strip theirs, rightly: the absolute
   * part of the location already lives in their Bucket or Server URL field, so
   * `rootPrefix` has no absolute form left to express. Here the server's
   * filesystem root is a real, reachable place that no other setting names, so
   * the slash is load-bearing. Never has a trailing slash.
   */
  readonly rootPrefix: string;
}

const AUTH_METHODS: readonly SftpAuthMethod[] = ['password', 'privateKey', 'agent'];

export function readSettings(raw: Readonly<Record<string, unknown>>): SftpSettings {
  const host = readString(raw, 'host');
  if (host === undefined) throw invalid('SFTP connection is missing a host.');

  const username = readString(raw, 'username');
  if (username === undefined) throw invalid('SFTP connection is missing a username.');

  const authMethod = readString(raw, 'authMethod') ?? 'password';
  if (!AUTH_METHODS.includes(authMethod as SftpAuthMethod)) {
    throw invalid(`Unknown SFTP authentication method: ${authMethod}`);
  }

  const port = raw['port'] === undefined ? 22 : Number(raw['port']);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw invalid(`SFTP port is not a valid port number: ${String(raw['port'])}`);
  }

  return {
    host,
    port,
    username,
    authMethod: authMethod as SftpAuthMethod,
    privateKeyPath: readString(raw, 'privateKeyPath'),
    knownHostsPath: readString(raw, 'knownHostsPath'),
    rootPrefix: normaliseRootPrefix(readString(raw, 'rootPrefix')),
  };
}

/**
 * Trailing slashes go, because `RemotePath` never has one and joining would
 * double it. A repeated leading slash collapses to one: `//var` and `/var` name
 * the same directory, and keeping both spellings would make two connections
 * that differ only in a typo look different in logs.
 */
function normaliseRootPrefix(value: string | undefined): string {
  if (value === undefined) return '';
  const trimmed = value.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? `/${trimmed.replace(/^\/+/, '')}` : trimmed;
}

function invalid(message: string): OmniFsError {
  return new OmniFsError({ code: 'ProtocolError', message, providerId: 'sftp' });
}

function readString(raw: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
```

- [ ] **Step 7: Point the skeleton at the new module**

In `packages/provider-sftp/src/index.ts`, delete the `SFTP_SETTINGS_SCHEMA` and `SFTP_SECRET_SCHEMA` declarations and the now-unused `SettingsSchema` type import, and add at the top:

```ts
import { SFTP_SECRET_SCHEMA, SFTP_SETTINGS_SCHEMA } from './settings.js';
```

and at the bottom, beside the existing exports:

```ts
export { SFTP_SECRET_SCHEMA, SFTP_SETTINGS_SCHEMA } from './settings.js';
```

Leave the skeleton `SftpFileSystem` and `SFTP_CAPABILITIES` alone; Task 7 replaces them.

- [ ] **Step 8: Run the tests and the whole suite**

Run: `pnpm build && pnpm --filter @omni-fs/provider-sftp exec vitest run src/settings.test.ts`
Expected: PASS, 11 tests.

Run: `pnpm test && pnpm lint`
Expected: PASS. `apps/vscode` imports `sftpProvider` only, so moving the schemas changes nothing for it.

- [ ] **Step 9: Drop the no-tests escape hatch and commit**

Now that the package has tests, `--passWithNoTests` has nothing left to excuse. In
`packages/provider-sftp/package.json`:

```json
    "test": "vitest run",
```

It was there for one commit so that step 3's commit did not leave a package whose own `pnpm test`
fails with "No test files found".

```bash
pnpm exec prettier --write packages/provider-sftp/src
git add packages/provider-sftp/src packages/provider-sftp/package.json
git commit -m ":sparkles: feat add sftp settings parsing with a root prefix that keeps its leading slash"
```

---

### Task 2: Error translation

**Files:**

- Create: `packages/provider-sftp/src/errors.ts`
- Create: `packages/provider-sftp/src/errors.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `toOmniFsError(cause: unknown, path?: string): OmniFsError` and `isFailure(cause: unknown): boolean`. Every method from Task 7 onward translates through the first; Tasks 9 and 10 narrow status 4 with the second.

`ssh2` reports SFTP failures as an `Error` whose `code` is the numeric status from `lib/protocol/SFTP.js:32` (`2` no such file, `3` permission denied, `4` failure, `5` bad message, `6` no connection, `7` connection lost, `8` operation unsupported), with the server's own message where it sent one. Connection-level failures arrive with the usual string `code`s, and authentication failure arrives as a message only. Mirror `packages/provider-webdav/src/errors.ts` in shape: one translation point, and the ambiguous status deliberately left unclassified.

- [ ] **Step 1: Write the failing test**

Create `packages/provider-sftp/src/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { OmniFsError } from '@omni-fs/core';
import { isFailure, toOmniFsError } from './errors.js';

function statusError(code: number, message = 'Failure'): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

function systemError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

describe('toOmniFsError', () => {
  it('passes an OmniFsError straight through', () => {
    const original = OmniFsError.notFound('/a.txt');
    expect(toOmniFsError(original)).toBe(original);
  });

  it.each([
    [2, 'NotFound'],
    [3, 'PermissionDenied'],
    [5, 'ProtocolError'],
    [6, 'ConnectionFailed'],
    [7, 'ConnectionFailed'],
    [8, 'Unsupported'],
  ])('maps SFTP status %i to %s', (status, code) => {
    expect(toOmniFsError(statusError(status), '/a.txt').code).toBe(code);
  });

  it('leaves status 4 unclassified, because only the call site knows what it meant', () => {
    expect(toOmniFsError(statusError(4), '/dir').code).toBe('Unknown');
  });

  it('marks a lost connection retryable', () => {
    expect(toOmniFsError(statusError(7)).retryable).toBe(true);
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EPIPE'])(
    'maps %s to a retryable ConnectionFailed',
    (code) => {
      const error = toOmniFsError(systemError(code));
      expect(error.code).toBe('ConnectionFailed');
      expect(error.retryable).toBe(true);
    },
  );

  it('maps a failed handshake to Timeout', () => {
    expect(toOmniFsError(new Error('Timed out while waiting for handshake')).code).toBe('Timeout');
  });

  it('maps rejected credentials to AuthenticationFailed', () => {
    expect(toOmniFsError(new Error('All configured authentication methods failed')).code).toBe(
      'AuthenticationFailed',
    );
  });

  it('maps an aborted operation to Cancelled', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(toOmniFsError(abort, '/a.txt').code).toBe('Cancelled');
  });

  it('keeps the path and the provider id on what it builds', () => {
    const error = toOmniFsError(statusError(3), '/secret.txt');
    expect(error.path).toBe('/secret.txt');
    expect(error.providerId).toBe('sftp');
  });

  it('calls anything it cannot place Unknown rather than guessing', () => {
    expect(toOmniFsError(new Error('something else entirely')).code).toBe('Unknown');
  });
});

describe('isFailure', () => {
  it('is true only for SFTP status 4', () => {
    expect(isFailure(statusError(4))).toBe(true);
    expect(isFailure(statusError(2))).toBe(false);
    expect(isFailure(new Error('no code at all'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @omni-fs/provider-sftp exec vitest run src/errors.test.ts`
Expected: FAIL — `Cannot find module './errors.js'`.

- [ ] **Step 3: Write the translation**

Create `packages/provider-sftp/src/errors.ts`:

```ts
import { OmniFsError } from '@omni-fs/core';

/**
 * SFTP protocol status codes, as `ssh2` reports them on `err.code`
 * (`lib/protocol/SFTP.js:32`).
 */
const STATUS = {
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
} as const;

const NETWORK_CODES: readonly string[] = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
];

/**
 * Translates `ssh2` failures into the shared vocabulary. This happens here and
 * nowhere else — above this line no code knows that SFTP has status codes.
 *
 * Status 4 (`FAILURE`) is deliberately absent from the switch. OpenSSH answers
 * it for "directory not empty", for "destination exists" and for a generic
 * refusal, so only the call site can say which: `rmdir` narrows it to
 * `NotEmpty`, a `wx` open and a non-overwriting `rename` to `AlreadyExists`,
 * through `isFailure`. It falls through to `Unknown`, which is unspecific but
 * true, rather than to a code that would be confidently wrong two times in
 * three. This is the same shape `provider-webdav` uses for 412 and 405.
 */
export function toOmniFsError(cause: unknown, path?: string): OmniFsError {
  if (OmniFsError.is(cause)) return cause;

  const message = cause instanceof Error ? cause.message : String(cause);
  const base = { path, providerId: 'sftp', cause } as const;

  if (errorName(cause) === 'AbortError') return OmniFsError.cancelled(path ?? 'SFTP request');

  switch (statusCode(cause)) {
    case STATUS.NO_SUCH_FILE:
      return OmniFsError.notFound(path ?? 'resource', cause);
    case STATUS.PERMISSION_DENIED:
      return new OmniFsError({ ...base, code: 'PermissionDenied', message });
    case STATUS.BAD_MESSAGE:
      return new OmniFsError({ ...base, code: 'ProtocolError', message, retryable: false });
    case STATUS.NO_CONNECTION:
    case STATUS.CONNECTION_LOST:
      return new OmniFsError({ ...base, code: 'ConnectionFailed', message, retryable: true });
    case STATUS.OP_UNSUPPORTED:
      return new OmniFsError({ ...base, code: 'Unsupported', message });
  }

  const system = systemCode(cause);
  if (system !== undefined && NETWORK_CODES.includes(system)) {
    return new OmniFsError({ ...base, code: 'ConnectionFailed', message, retryable: true });
  }

  // The handshake and authentication failures `ssh2` reports as a message only.
  if (/timed out while waiting for handshake/i.test(message)) {
    return new OmniFsError({ ...base, code: 'Timeout', message, retryable: true });
  }
  if (/authentication methods failed|no matching (host key|key exchange)/i.test(message)) {
    return new OmniFsError({ ...base, code: 'AuthenticationFailed', message });
  }

  return new OmniFsError({ ...base, code: 'Unknown', message });
}

/**
 * Whether the server answered SFTP status 4, `FAILURE`.
 *
 * The same shape as `provider-webdav`'s `isPreconditionFailed`, for the same
 * reason: one status, two meanings, and only the caller knows which method it
 * sent. `rmdir` reads it as `NotEmpty`; an exclusive open and a plain rename
 * read it as `AlreadyExists`.
 */
export function isFailure(cause: unknown): boolean {
  return statusCode(cause) === STATUS.FAILURE;
}

function errorName(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null) return '';
  const name = (cause as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

function statusCode(cause: unknown): number | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

function systemCode(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @omni-fs/provider-sftp exec vitest run src/errors.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/provider-sftp/src
git add packages/provider-sftp/src
git commit -m ":sparkles: feat translate sftp status codes into the shared OmniFsError vocabulary"
```

---

### Task 3: Local file access and known_hosts verification

**Files:**

- Create: `packages/provider-sftp/src/local-files.ts`
- Create: `packages/provider-sftp/src/local-files.test.ts`
- Create: `packages/provider-sftp/src/known-hosts.ts`
- Create: `packages/provider-sftp/src/known-hosts.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `expandHome(path: string): string` and `readLocalFile(path: string): Promise<Buffer>` from `local-files.ts`; `parseKnownHosts(text: string): readonly KnownHostEntry[]`, `verifyHostKey(entries: readonly KnownHostEntry[], host: string, port: number, key: Buffer): HostKeyVerdict`, `fingerprint(key: Buffer): string` and `readKnownHosts(path: string | undefined): Promise<readonly KnownHostEntry[]>` from `known-hosts.ts`. `HostKeyVerdict` is `'match' | 'mismatch' | 'unknown'`. Task 4 uses `readLocalFile`; Task 5 uses all four known-hosts functions.

Two modules in one task because they land together: the verifier is useless without the reader, and the reader is three lines. `local-files.ts` is the only file in the package that touches the local disk, which is what makes a future `LocalFiles` port a one-file change.

- [ ] **Step 1: Write the failing local-files test**

Create `packages/provider-sftp/src/local-files.test.ts`:

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHome, readLocalFile } from './local-files.js';

describe('expandHome', () => {
  it('expands a bare tilde', () => {
    expect(expandHome('~')).toBe(homedir());
  });

  it('expands a tilde prefix', () => {
    expect(expandHome('~/.ssh/id_ed25519')).toBe(join(homedir(), '.ssh/id_ed25519'));
  });

  it('leaves an absolute path alone', () => {
    expect(expandHome('/etc/ssh/key')).toBe('/etc/ssh/key');
  });

  it('leaves a tilde inside the path alone', () => {
    expect(expandHome('/keys/~backup/id')).toBe('/keys/~backup/id');
  });
});

describe('readLocalFile', () => {
  it('reads a file from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omni-fs-sftp-'));
    const path = join(dir, 'key');
    await writeFile(path, 'PRIVATE KEY');

    expect((await readLocalFile(path)).toString('utf8')).toBe('PRIVATE KEY');
  });

  it('rejects when the file is not there', async () => {
    await expect(readLocalFile(join(tmpdir(), 'omni-fs-sftp-definitely-absent'))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @omni-fs/provider-sftp exec vitest run src/local-files.test.ts`
Expected: FAIL — `Cannot find module './local-files.js'`.

- [ ] **Step 3: Write local-files.ts**

Create `packages/provider-sftp/src/local-files.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The only module in this package that touches the local disk.
 *
 * SFTP is the one protocol here whose credentials live on the client machine: a
 * private key at a path the user picked, and `known_hosts`. The boundary rule
 * bans `vscode` and `electron` from `packages/`, not Node, and the design
 * already assumed a path — the settings field is `kind: 'file'` and
 * `packages/ui` grew `pickFile()` for it. Concentrating the access here means
 * that if a `LocalFiles` port ever arrives with the download/upload work, it
 * replaces one file instead of being threaded through the provider.
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  return /^~[\\/]/.test(path) ? join(homedir(), path.slice(2)) : path;
}

export async function readLocalFile(path: string): Promise<Buffer> {
  return readFile(expandHome(path));
}
```

- [ ] **Step 4: Run it and write the failing known-hosts test**

Run: `pnpm --filter @omni-fs/provider-sftp exec vitest run src/local-files.test.ts`
Expected: PASS, 6 tests.

Create `packages/provider-sftp/src/known-hosts.test.ts`:

```ts
import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fingerprint, parseKnownHosts, verifyHostKey } from './known-hosts.js';

/** An SSH wire-format public key blob: length-prefixed type, then the body. */
function keyBlob(type: string, body: string): Buffer {
  const typeBuf = Buffer.from(type, 'utf8');
  const bodyBuf = Buffer.from(body, 'utf8');
  const out = Buffer.alloc(4 + typeBuf.length + 4 + bodyBuf.length);
  out.writeUInt32BE(typeBuf.length, 0);
  typeBuf.copy(out, 4);
  out.writeUInt32BE(bodyBuf.length, 4 + typeBuf.length);
  bodyBuf.copy(out, 8 + typeBuf.length);
  return out;
}

const ours = keyBlob('ssh-ed25519', 'the-real-server');
const theirs = keyBlob('ssh-ed25519', 'the-impostor');
const rsa = keyBlob('ssh-rsa', 'a-different-key-type');

function line(hosts: string, key: Buffer, type = 'ssh-ed25519'): string {
  return `${hosts} ${type} ${key.toString('base64')}`;
}

describe('verifyHostKey', () => {
  it('matches a host listed with this exact key', () => {
    const entries = parseKnownHosts(line('sftp.example.com', ours));
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('match');
  });

  it('refuses a host listed with a different key of the same type', () => {
    const entries = parseKnownHosts(line('sftp.example.com', theirs));
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('mismatch');
  });

  it('treats a host listed only under another key type as unseen, not as an attack', () => {
    const entries = parseKnownHosts(line('sftp.example.com', rsa, 'ssh-rsa'));
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('unknown');
  });

  it('knows nothing about a host that is not listed', () => {
    const entries = parseKnownHosts(line('other.example.com', ours));
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('unknown');
  });

  it('matches a non-default port written as [host]:port', () => {
    const entries = parseKnownHosts(line('[localhost]:2222', ours));
    expect(verifyHostKey(entries, 'localhost', 2222, ours)).toBe('match');
    expect(verifyHostKey(entries, 'localhost', 22, ours)).toBe('unknown');
  });

  it('matches a wildcard pattern', () => {
    const entries = parseKnownHosts(line('*.example.com', ours));
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('match');
  });

  it('honours a negated pattern', () => {
    const entries = parseKnownHosts(line('!secret.example.com,*.example.com', ours));
    expect(verifyHostKey(entries, 'secret.example.com', 22, ours)).toBe('unknown');
    expect(verifyHostKey(entries, 'public.example.com', 22, ours)).toBe('match');
  });

  it('matches a hashed entry', () => {
    const salt = randomBytes(20);
    const hash = createHmac('sha1', salt).update('sftp.example.com').digest('base64');
    const entries = parseKnownHosts(
      `|1|${salt.toString('base64')}|${hash} ssh-ed25519 ${ours.toString('base64')}`,
    );
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('match');
    expect(verifyHostKey(entries, 'elsewhere.example.com', 22, ours)).toBe('unknown');
  });

  it('refuses a revoked key even when it is the one on offer', () => {
    const entries = parseKnownHosts(`@revoked ${line('sftp.example.com', ours)}`);
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('mismatch');
  });

  it('ignores a certificate authority line, since certificates are out of scope', () => {
    const entries = parseKnownHosts(`@cert-authority ${line('*.example.com', theirs)}`);
    expect(entries).toHaveLength(0);
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('unknown');
  });

  it('skips comments, blank lines and anything too short to be an entry', () => {
    const text = ['# a comment', '', '   ', 'broken-line', line('sftp.example.com', ours)].join(
      '\n',
    );
    const entries = parseKnownHosts(text);
    expect(entries).toHaveLength(1);
    expect(verifyHostKey(entries, 'sftp.example.com', 22, ours)).toBe('match');
  });
});

describe('fingerprint', () => {
  it('formats the key the way OpenSSH prints it, with no padding', () => {
    const printed = fingerprint(ours);
    expect(printed.startsWith('SHA256:')).toBe(true);
    expect(printed).not.toContain('=');
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `pnpm --filter @omni-fs/provider-sftp exec vitest run src/known-hosts.test.ts`
Expected: FAIL — `Cannot find module './known-hosts.js'`.

- [ ] **Step 6: Write known-hosts.ts**

Create `packages/provider-sftp/src/known-hosts.ts`:

```ts
import { createHash, createHmac } from 'node:crypto';
import { readLocalFile } from './local-files.js';

export type HostKeyVerdict = 'match' | 'mismatch' | 'unknown';

export interface KnownHostEntry {
  /** Patterns as written, including `[host]:port` forms, wildcards and `!` negations. */
  readonly patterns: readonly string[];
  /** Set instead of `patterns` for `|1|salt|hash` lines, which hide the hostname. */
  readonly hashed: { readonly salt: string; readonly hash: string } | undefined;
  /** Base64 of the key blob, exactly as the file spells it. */
  readonly keyBase64: string;
  /** `@revoked`: the key is known and must never be accepted. */
  readonly revoked: boolean;
}

/**
 * Parses `known_hosts`, skipping anything it does not understand rather than
 * failing. A line we cannot read is one host we do not know about, which
 * degrades to trust-on-first-use; refusing to parse the file would instead
 * refuse every connection, which is a worse answer to a stray line.
 *
 * `@cert-authority` lines are dropped: certificate authentication is a non-goal,
 * and keeping them would make a CA line look like a host key and produce a
 * spurious mismatch.
 */
export function parseKnownHosts(text: string): readonly KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const fields = line.split(/\s+/);
    let revoked = false;
    let certAuthority = false;
    let unrecognisedMarker = false;
    while (fields[0]?.startsWith('@') === true) {
      const marker = fields.shift()?.toLowerCase();
      if (marker === '@revoked') revoked = true;
      else if (marker === '@cert-authority') certAuthority = true;
      else unrecognisedMarker = true;
    }
    // A marker we do not understand makes the whole line unusable, which is
    // what OpenSSH does with it. Stripping it and trusting the rest is how a
    // misspelled revocation — `@Revoked` — becomes a trusted key.
    if (certAuthority || unrecognisedMarker) continue;

    const [hosts, , keyBase64] = fields;
    if (hosts === undefined || keyBase64 === undefined || keyBase64 === '') continue;

    if (hosts.startsWith('|1|')) {
      const [, , salt, hash] = hosts.split('|');
      if (salt === undefined || hash === undefined) continue;
      entries.push({ patterns: [], hashed: { salt, hash }, keyBase64, revoked });
    } else {
      entries.push({ patterns: hosts.split(','), hashed: undefined, keyBase64, revoked });
    }
  }

  return entries;
}

/**
 * What `known_hosts` says about the key this server just offered.
 *
 * `mismatch` is reserved for the case that actually means an attack: the host is
 * listed with a *different* key **of the same type*, or the key is `@revoked`. A
 * host listed only under another key type is `unknown`, because a server
 * legitimately holds one key per algorithm and offering its ed25519 key when the
 * file records its RSA one is not evidence of anything.
 */
export function verifyHostKey(
  entries: readonly KnownHostEntry[],
  host: string,
  port: number,
  key: Buffer,
): HostKeyVerdict {
  const offered = key.toString('base64');
  const offeredType = keyType(key);
  const matching = entries.filter((entry) => matchesHost(entry, host, port));

  // Revocation wins whatever order the file lists things in. `ssh-keygen -R`
  // removes the old line, but appending `@revoked` by hand and leaving the
  // stale line above it is just as common — and OpenSSH refuses the key either
  // way. Deciding this inside the match loop would let line order matter.
  if (matching.some((entry) => entry.revoked && entry.keyBase64 === offered)) {
    return 'mismatch';
  }

  for (const entry of matching) {
    if (entry.keyBase64 === offered) return 'match';
  }
  for (const entry of matching) {
    if (keyType(Buffer.from(entry.keyBase64, 'base64')) === offeredType) return 'mismatch';
  }
  return 'unknown';
}

/** The key as OpenSSH prints it: `SHA256:` plus unpadded base64. */
export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Reads and parses `known_hosts`, defaulting to `~/.ssh/known_hosts`. A file
 * that is absent or unreadable is no entries, which means every host is unseen.
 */
export async function readKnownHosts(path: string | undefined): Promise<readonly KnownHostEntry[]> {
  // The `try` covers the read and nothing else: a throw from `parseKnownHosts`
  // swallowed here would read as "no known hosts" and silently downgrade
  // verification to trust-on-first-use.
  let text: string;
  try {
    text = (await readLocalFile(path ?? '~/.ssh/known_hosts')).toString('utf8');
  } catch {
    return [];
  }
  return parseKnownHosts(text);
}

/**
 * OpenSSH writes a non-default port as `[host]:port` and a default one bare, so
 * both spellings are offered for port 22 and only the bracketed one otherwise.
 */
function matchesHost(entry: KnownHostEntry, host: string, port: number): boolean {
  const candidates = port === 22 ? [host, `[${host}]:22`] : [`[${host}]:${port}`];

  if (entry.hashed !== undefined) {
    const { salt, hash } = entry.hashed;
    const key = Buffer.from(salt, 'base64');
    return candidates.some(
      (candidate) => createHmac('sha1', key).update(candidate).digest('base64') === hash,
    );
  }

  let matched = false;
  for (const pattern of entry.patterns) {
    const negated = pattern.startsWith('!');
    const glob = negated ? pattern.slice(1) : pattern;
    if (!candidates.some((candidate) => globMatches(glob, candidate))) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

function globMatches(pattern: string, value: string): boolean {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${expression}$`, 'i').test(value);
}

/** The algorithm name from the front of an SSH wire-format key blob. */
function keyType(key: Buffer): string {
  if (key.length < 4) return '';
  const length = key.readUInt32BE(0);
  return length > 0 && length <= key.length - 4 ? key.toString('utf8', 4, 4 + length) : '';
}
```

- [ ] **Step 7: Run both test files**

Run: `pnpm --filter @omni-fs/provider-sftp exec vitest run src/known-hosts.test.ts src/local-files.test.ts`
Expected: PASS, 24 tests (18 known-hosts, 6 local-files).

The known-hosts file must also pin what the two security fixes above buy: a plain line followed by a
`@revoked` line for the same key (and the reverse order) is `mismatch`, `@Revoked` with a capital R
is `mismatch`, an unrecognised marker such as `@bogus` drops its line entirely so the verdict is
`unknown`, and `readKnownHosts` answers a real temp file with its entry and a missing path with `[]`.

- [ ] **Step 8: Commit**

```bash
pnpm exec prettier --write packages/provider-sftp/src
git add packages/provider-sftp/src
git commit -m ":sparkles: feat add known_hosts parsing that refuses a host whose key changed"
```

---

### Task 4: Authentication assembly

**Files:**

- Create: `packages/provider-sftp/src/auth.ts`
- Create: `packages/provider-sftp/src/auth.test.ts`

**Interfaces:**

- Consumes: `SftpSettings` (Task 1), `readLocalFile` (Task 3).
- Produces: `SftpAuth` (`{ password?: string; privateKey?: Buffer; passphrase?: string; agent?: string }`), `AuthSources` (`{ readFile, env, platform }`) and `buildAuth(settings: SftpSettings, secret: Readonly<Record<string, unknown>>, sources?: AuthSources): Promise<SftpAuth>`. Task 5 spreads the result into the `ssh2` connect config.

Injecting `AuthSources` is what makes this testable without a home directory or an agent: the tests pass a fake `readFile` and a fake `env`, and production uses the default.

- [ ] **Step 1: Write the failing test**

Create `packages/provider-sftp/src/auth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { OmniFsError } from '@omni-fs/core';
import { buildAuth, type AuthSources } from './auth.js';
import { readSettings, type SftpSettings } from './settings.js';

function settings(over: Readonly<Record<string, unknown>> = {}): SftpSettings {
  return readSettings({ host: 'sftp.example.com', username: 'alice', ...over });
}

function sources(over: Partial<AuthSources> = {}): AuthSources {
  return {
    readFile: async () => Buffer.from('PRIVATE KEY'),
    env: {},
    platform: 'linux',
    ...over,
  };
}

async function codeOf(body: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await body();
    return undefined;
  } catch (error) {
    return OmniFsError.is(error) ? error.code : 'not-an-OmniFsError';
  }
}

describe('buildAuth', () => {
  it('uses the stored password for password authentication', async () => {
    const auth = await buildAuth(settings(), { password: 'hunter2' }, sources());
    expect(auth).toEqual({ password: 'hunter2' });
  });

  it('refuses password authentication with no password stored', async () => {
    expect(await codeOf(() => buildAuth(settings(), {}, sources()))).toBe('AuthenticationFailed');
  });

  it('reads the private key from the path in the settings', async () => {
    const read: string[] = [];
    const auth = await buildAuth(
      settings({ authMethod: 'privateKey', privateKeyPath: '~/.ssh/id_ed25519' }),
      {},
      sources({
        readFile: async (path) => {
          read.push(path);
          return Buffer.from('PRIVATE KEY');
        },
      }),
    );

    expect(read).toEqual(['~/.ssh/id_ed25519']);
    expect(auth.privateKey?.toString('utf8')).toBe('PRIVATE KEY');
    expect('passphrase' in auth).toBe(false);
  });

  it('passes the passphrase through when the key is encrypted', async () => {
    const auth = await buildAuth(
      settings({ authMethod: 'privateKey', privateKeyPath: '/keys/id' }),
      { passphrase: 'open sesame' },
      sources(),
    );
    expect(auth.passphrase).toBe('open sesame');
  });

  it('refuses private key authentication with no key path', async () => {
    expect(
      await codeOf(() => buildAuth(settings({ authMethod: 'privateKey' }), {}, sources())),
    ).toBe('AuthenticationFailed');
  });

  it('reports an unreadable key file as AuthenticationFailed, not as Unknown', async () => {
    const code = await codeOf(() =>
      buildAuth(
        settings({ authMethod: 'privateKey', privateKeyPath: '/keys/absent' }),
        {},
        sources({
          readFile: async () => {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          },
        }),
      ),
    );
    expect(code).toBe('AuthenticationFailed');
  });

  it('takes the agent socket from the environment', async () => {
    const auth = await buildAuth(
      settings({ authMethod: 'agent' }),
      {},
      sources({ env: { SSH_AUTH_SOCK: '/tmp/agent.sock' } }),
    );
    expect(auth).toEqual({ agent: '/tmp/agent.sock' });
  });

  it('falls back to pageant on Windows', async () => {
    const auth = await buildAuth(
      settings({ authMethod: 'agent' }),
      {},
      sources({ platform: 'win32' }),
    );
    expect(auth).toEqual({ agent: 'pageant' });
  });

  it('refuses agent authentication when no agent is reachable', async () => {
    expect(await codeOf(() => buildAuth(settings({ authMethod: 'agent' }), {}, sources()))).toBe(
      'AuthenticationFailed',
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @omni-fs/provider-sftp exec vitest run src/auth.test.ts`
Expected: FAIL — `Cannot find module './auth.js'`.

- [ ] **Step 3: Write auth.ts**

Create `packages/provider-sftp/src/auth.ts`:

```ts
import { OmniFsError } from '@omni-fs/core';
import { readLocalFile } from './local-files.js';
import type { SftpSettings } from './settings.js';

/** The credential half of an `ssh2` connect config. */
export interface SftpAuth {
  readonly password?: string | undefined;
  readonly privateKey?: Buffer | undefined;
  readonly passphrase?: string | undefined;
  readonly agent?: string | undefined;
}

export interface AuthSources {
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
}

const DEFAULT_SOURCES: AuthSources = {
  readFile: readLocalFile,
  env: process.env,
  platform: process.platform,
};

/**
 * Turns settings plus stored secrets into the credentials `ssh2` wants.
 *
 * Every failure here is `AuthenticationFailed` rather than `Unknown`, because
 * every one of them is answered the same way by a host: re-prompt for the
 * credential, which is exactly what that code exists to distinguish
 * (`packages/core/src/errors.ts`). A missing key file is a credential problem
 * even though it presents as an `ENOENT`.
 */
export async function buildAuth(
  settings: SftpSettings,
  secret: Readonly<Record<string, unknown>>,
  sources: AuthSources = DEFAULT_SOURCES,
): Promise<SftpAuth> {
  switch (settings.authMethod) {
    case 'password':
      return { password: requireSecret(secret, 'password') };

    case 'privateKey': {
      const path = settings.privateKeyPath;
      if (path === undefined) {
        throw failed('SFTP private key authentication needs a private key file.');
      }
      let privateKey: Buffer;
      try {
        privateKey = await sources.readFile(path);
      } catch (cause) {
        throw failed(`Could not read the SFTP private key at ${path}`, cause);
      }
      const passphrase = readSecret(secret, 'passphrase');
      return { privateKey, ...(passphrase !== undefined ? { passphrase } : {}) };
    }

    case 'agent': {
      const socket =
        sources.env['SSH_AUTH_SOCK'] ?? (sources.platform === 'win32' ? 'pageant' : undefined);
      if (socket === undefined) {
        throw failed('No SSH agent found: SSH_AUTH_SOCK is not set.');
      }
      return { agent: socket };
    }
  }
}

function requireSecret(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = readSecret(record, key);
  if (value === undefined) throw failed(`Missing credential field: ${key}`);
  return value;
}

function readSecret(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function failed(message: string, cause?: unknown): OmniFsError {
  return new OmniFsError({ code: 'AuthenticationFailed', message, providerId: 'sftp', cause });
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @omni-fs/provider-sftp exec vitest run src/auth.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/provider-sftp/src
git add packages/provider-sftp/src
git commit -m ":sparkles: feat assemble sftp credentials for password, private key and agent auth"
```

---

### Task 5: The session — connection, the abort race, and the request-shaped calls

> **Corrected during execution.** Four defects in this task's code blocks were found by review and
> fixed in `packages/provider-sftp/src/sftp-session.ts`, which is the authority — read it before
> re-applying anything below.
>
> 1. The persistent `client.on('error')`/`client.on('close')` listeners must be registered
>    immediately after `new Client()`, **not** after `await client.sftp(...)`. As written below they
>    left a window — authenticated, channel opening — where a dropped connection emits `error` with
>    no listener, which is fatal to the host process: in VS Code, the whole extension host. The
>    listeners close over a `let session: SftpSession | undefined = undefined` they no-op against
>    until it is assigned; the explicit initialiser is load-bearing, because a `const` at the
>    assignment site would leave them referencing it in the temporal dead zone.
> 2. `open()` must end the client on every failing path, and re-check `signal?.aborted` after the
>    channel opens. As written it abandoned an authenticated connection whenever anything after
>    `connect` failed — a server refusing the `sftp` subsystem leaves the socket alive with no handle
>    able to close it — and it ignored an abort that arrived after the connect race settled, handing a
>    live session to a caller that had already cancelled.
> 3. `close()` must clear `#alive` unconditionally, before its early returns, or `isAlive()` keeps
>    claiming a closed session is usable.
> 4. Cancellations are built by a module-scope `cancelled()` helper carrying `providerId: 'sftp'`,
>    not by `OmniFsError.cancelled`, which drops it — the same reason `errors.ts` stopped using that
>    factory in Task 2.
>
> `SftpAuth`'s optional fields in `auth.ts` also lost their `| undefined` so that `ConnectConfig`'s
> exact-optional fields accept the single `...auth` spread this task's code uses.

**Files:**

- Create: `packages/provider-sftp/src/sftp-session.ts`
- Create: `packages/provider-sftp/src/sftp-session.test.ts`

**Interfaces:**

- Consumes: `SftpSettings` (Task 1), `toOmniFsError` (Task 2), `readKnownHosts`/`verifyHostKey`/`fingerprint` (Task 3), `buildAuth` (Task 4).
- Produces: `SftpAttrs`, `SftpEntry`, `SftpExtensions`, `SftpRequests`, `SftpSessionOptions`, `detectExtensions()`, and `class SftpSession implements SftpRequests` with `static open(options: SftpSessionOptions): Promise<SftpSession>`, `isAlive(): boolean` and `close(): Promise<void>`. Task 6 widens `SftpSession` to the full `SftpApi`; Task 7 consumes it through `OpenSession`.

Verified before planning: `import { Client } from 'ssh2'` resolves at runtime from an ESM package — `ssh2/lib/index.js` assigns an object literal to `module.exports`, which `cjs-module-lexer` reads as named exports. No default-import dance is needed.

The constructor takes the real `SFTPWrapper` rather than a structural subset, and the tests pass a fake through one `as unknown as SFTPWrapper` cast. That keeps every production signature the library's own, and puts the only cast in a test file where a wrong shape fails loudly.

- [ ] **Step 1: Write the failing test**

Create `packages/provider-sftp/src/sftp-session.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { NOOP_LOGGER, OmniFsError } from '@omni-fs/core';
import type { SFTPWrapper } from 'ssh2';
import { SftpSession, detectExtensions, type SftpExtensions } from './sftp-session.js';

const NO_EXTENSIONS: SftpExtensions = { posixRename: false, fsync: false, copyData: false };

/** The callback shape `ssh2` uses: an optional error first, then the value. */
type Reply<T = void> = (error?: Error | null, value?: T) => void;

const attrs = { mode: 0o100644, size: 12, mtime: 1_700_000_000, uid: 1000, gid: 1000 };

function channel(over: Record<string, unknown>): SFTPWrapper {
  return over as unknown as SFTPWrapper;
}

function session(over: Record<string, unknown>, extensions = NO_EXTENSIONS): SftpSession {
  return new SftpSession(channel(over), extensions, NOOP_LOGGER);
}

describe('SftpSession requests', () => {
  it('maps stat attributes into the shape the provider uses', async () => {
    const fs = session({ stat: (_p: string, cb: Reply<typeof attrs>) => cb(undefined, attrs) });
    expect(await fs.stat('/data/a.txt')).toEqual(attrs);
  });

  it('maps a directory listing to filenames and attributes', async () => {
    const fs = session({
      readdir: (_p: string, cb: Reply<{ filename: string; attrs: typeof attrs }[]>) =>
        cb(undefined, [{ filename: 'a.txt', attrs }]),
    });
    expect(await fs.readdir('/data')).toEqual([{ filename: 'a.txt', attrs }]);
  });

  it('rejects an already-aborted call without touching the wire', async () => {
    const stat = vi.fn();
    const fs = session({ stat });
    const controller = new AbortController();
    controller.abort();

    await expect(fs.stat('/data/a.txt', controller.signal)).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled',
    );
    expect(stat).not.toHaveBeenCalled();
  });

  it('rejects with Cancelled when the signal fires mid-request, and ignores the late reply', async () => {
    let reply: (() => void) | undefined;
    const fs = session({
      stat: (_p: string, cb: (error: undefined, value: typeof attrs) => void) => {
        reply = () => cb(undefined, attrs);
      },
    });

    const controller = new AbortController();
    const pending = fs.stat('/data/a.txt', controller.signal);
    controller.abort();

    await expect(pending).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled',
    );

    // The request was abandoned, not cancelled: the server still answers, and
    // that answer must settle nothing.
    expect(() => reply?.()).not.toThrow();
  });

  it('passes a failure through untranslated, because translation is the file system layer job', async () => {
    const failure = Object.assign(new Error('No such file'), { code: 2 });
    const fs = session({ stat: (_p: string, cb: Reply) => cb(failure) });
    await expect(fs.stat('/data/gone.txt')).rejects.toBe(failure);
  });

  it('renames through the POSIX extension when the server offers it', async () => {
    const posix = vi.fn((_f: string, _t: string, cb: Reply) => cb(undefined));
    const plain = vi.fn((_f: string, _t: string, cb: Reply) => cb(undefined));
    const fs = session({ ext_openssh_rename: posix, rename: plain });

    await fs.posixRename('/a', '/b');
    await fs.rename('/a', '/b');

    expect(posix).toHaveBeenCalledTimes(1);
    expect(plain).toHaveBeenCalledTimes(1);
  });

  it('resolves the login directory through realpath', async () => {
    const fs = session({
      realpath: (_p: string, cb: Reply<string>) => cb(undefined, '/home/omnifs'),
    });
    expect(await fs.realpath('.')).toBe('/home/omnifs');
  });
});

describe('detectExtensions', () => {
  it('reads what the server announced at version exchange', () => {
    const sftp = channel({
      _extensions: {
        'posix-rename@openssh.com': '1',
        'fsync@openssh.com': '1',
        'copy-data': '1',
      },
    });
    expect(detectExtensions(sftp)).toEqual({ posixRename: true, fsync: true, copyData: true });
  });

  it('treats an unannounced extension as absent', () => {
    expect(detectExtensions(channel({ _extensions: { 'statvfs@openssh.com': '2' } }))).toEqual(
      NO_EXTENSIONS,
    );
  });

  it('degrades to no extensions when the field is not there at all', () => {
    expect(detectExtensions(channel({}))).toEqual(NO_EXTENSIONS);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @omni-fs/provider-sftp exec vitest run src/sftp-session.test.ts`
Expected: FAIL — `Cannot find module './sftp-session.js'`.

- [ ] **Step 3: Write the session**

Create `packages/provider-sftp/src/sftp-session.ts`:

```ts
import { Client } from 'ssh2';
import type { ConnectConfig, FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';
import { OmniFsError } from '@omni-fs/core';
import type { Logger } from '@omni-fs/core';
import { buildAuth } from './auth.js';
import { toOmniFsError } from './errors.js';
import { fingerprint, readKnownHosts, verifyHostKey } from './known-hosts.js';
import type { SftpSettings } from './settings.js';

/** What this provider needs from `SSH_FXP_ATTRS`. `mtime` is seconds, as SFTP counts it. */
export interface SftpAttrs {
  readonly mode: number;
  readonly size: number;
  readonly mtime: number;
  readonly uid: number;
  readonly gid: number;
}

export interface SftpEntry {
  readonly filename: string;
  readonly attrs: SftpAttrs;
}

/** OpenSSH extensions this provider can use, as announced by the connected server. */
export interface SftpExtensions {
  readonly posixRename: boolean;
  readonly fsync: boolean;
  readonly copyData: boolean;
}

/** The request-shaped half of the transport. Task 6 adds the streaming half. */
export interface SftpRequests {
  readonly extensions: SftpExtensions;
  stat(path: string, signal?: AbortSignal): Promise<SftpAttrs>;
  lstat(path: string, signal?: AbortSignal): Promise<SftpAttrs>;
  readdir(path: string, signal?: AbortSignal): Promise<readonly SftpEntry[]>;
  mkdir(path: string, signal?: AbortSignal): Promise<void>;
  rmdir(path: string, signal?: AbortSignal): Promise<void>;
  unlink(path: string, signal?: AbortSignal): Promise<void>;
  rename(from: string, to: string, signal?: AbortSignal): Promise<void>;
  posixRename(from: string, to: string, signal?: AbortSignal): Promise<void>;
  realpath(path: string, signal?: AbortSignal): Promise<string>;
}

export interface SftpSessionOptions {
  readonly settings: SftpSettings;
  /** Already resolved by the caller, so the session never sees `ProviderContext`. */
  readonly secret: Readonly<Record<string, unknown>>;
  readonly logger: Logger;
  readonly signal?: AbortSignal | undefined;
}

/**
 * One SSH connection and one SFTP channel.
 *
 * Everything callback-shaped about `ssh2` stops here: above this class the
 * provider is plain `async` code over `SftpApi`, which is what lets the
 * hermetic tests replace one small interface instead of a network library.
 *
 * `AbortSignal` is honoured as a race. SFTP has no cancel on the wire, so an
 * aborted request is *abandoned*: this class stops waiting and reports
 * `Cancelled`, and the server's eventual answer settles nothing. A mutation
 * already in flight may still land. That is inherent, not an oversight — the
 * alternative is tearing down the connection, which would cancel every other
 * operation sharing it.
 */
export class SftpSession implements SftpRequests {
  readonly extensions: SftpExtensions;

  readonly #sftp: SFTPWrapper;
  readonly #logger: Logger;
  readonly #client: Client | undefined;
  #alive = true;

  /** `client` is absent in tests, which construct a session over a fake channel. */
  constructor(sftp: SFTPWrapper, extensions: SftpExtensions, logger: Logger, client?: Client) {
    this.#sftp = sftp;
    this.extensions = extensions;
    this.#logger = logger;
    this.#client = client;
  }

  static async open(options: SftpSessionOptions): Promise<SftpSession> {
    const { settings, secret, logger, signal } = options;

    try {
      const knownHosts = await readKnownHosts(settings.knownHostsPath);
      const auth = await buildAuth(settings, secret);
      const client = new Client();
      let refusal: OmniFsError | undefined;

      const config: ConnectConfig = {
        host: settings.host,
        port: settings.port,
        username: settings.username,
        ...auth,
        hostVerifier: (key: Buffer): boolean => {
          const verdict = verifyHostKey(knownHosts, settings.host, settings.port, key);
          if (verdict === 'mismatch') {
            refusal = new OmniFsError({
              code: 'AuthenticationFailed',
              message: `Host key for ${settings.host} does not match known_hosts. Offered ${fingerprint(key)}. Refusing to connect.`,
              providerId: 'sftp',
            });
            return false;
          }
          if (verdict === 'unknown') {
            logger.log('info', 'Accepting an SFTP host key that known_hosts has never seen', {
              host: settings.host,
              port: settings.port,
              fingerprint: fingerprint(key),
            });
          }
          return true;
        },
      };

      await new Promise<void>((resolve, reject) => {
        const settle = (error?: unknown): void => {
          client.removeListener('ready', onReady);
          client.removeListener('error', onError);
          signal?.removeEventListener('abort', onAbort);
          if (error === undefined) resolve();
          else reject(error);
        };
        const onReady = (): void => settle();
        const onError = (error: Error): void => settle(refusal ?? error);
        const onAbort = (): void => {
          client.end();
          settle(OmniFsError.cancelled(`SFTP connect to ${settings.host}`));
        };

        client.once('ready', onReady);
        client.once('error', onError);
        signal?.addEventListener('abort', onAbort, { once: true });
        client.connect(config);
      });

      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((error, channel) => (error ? reject(error) : resolve(channel)));
      });

      const session = new SftpSession(sftp, detectExtensions(sftp), logger, client);

      // A connection that drops later emits `error` on the client. Without a
      // listener Node treats that as unhandled and takes the host process down,
      // so this is load-bearing rather than defensive: it is also how `isAlive`
      // learns to stop claiming the session is usable.
      client.on('error', (error: Error) => session.#markDead(error));
      client.on('close', () => session.#markDead());

      logger.log('info', 'SFTP session opened', {
        host: settings.host,
        port: settings.port,
        extensions: session.extensions,
      });

      return session;
    } catch (error) {
      throw toOmniFsError(error, settings.host);
    }
  }

  isAlive(): boolean {
    return this.#alive;
  }

  async close(): Promise<void> {
    const client = this.#client;
    if (client === undefined) return;
    if (!this.#alive) {
      client.end();
      return;
    }
    this.#alive = false;
    await new Promise<void>((resolve) => {
      client.once('close', () => resolve());
      client.end();
    });
  }

  async stat(path: string, signal?: AbortSignal): Promise<SftpAttrs> {
    return toAttrs(await this.#request<Stats>(signal, (cb) => this.#sftp.stat(path, cb)));
  }

  async lstat(path: string, signal?: AbortSignal): Promise<SftpAttrs> {
    return toAttrs(await this.#request<Stats>(signal, (cb) => this.#sftp.lstat(path, cb)));
  }

  async readdir(path: string, signal?: AbortSignal): Promise<readonly SftpEntry[]> {
    const list = await this.#request<FileEntryWithStats[]>(signal, (cb) =>
      this.#sftp.readdir(path, cb),
    );
    return list.map((entry) => ({ filename: entry.filename, attrs: toAttrs(entry.attrs) }));
  }

  async mkdir(path: string, signal?: AbortSignal): Promise<void> {
    await this.#request<void>(signal, (cb) => this.#sftp.mkdir(path, cb));
  }

  async rmdir(path: string, signal?: AbortSignal): Promise<void> {
    await this.#request<void>(signal, (cb) => this.#sftp.rmdir(path, cb));
  }

  async unlink(path: string, signal?: AbortSignal): Promise<void> {
    await this.#request<void>(signal, (cb) => this.#sftp.unlink(path, cb));
  }

  async rename(from: string, to: string, signal?: AbortSignal): Promise<void> {
    await this.#request<void>(signal, (cb) => this.#sftp.rename(from, to, cb));
  }

  /** `posix-rename@openssh.com`: replaces the destination instead of failing on it. */
  async posixRename(from: string, to: string, signal?: AbortSignal): Promise<void> {
    await this.#request<void>(signal, (cb) => this.#sftp.ext_openssh_rename(from, to, cb));
  }

  async realpath(path: string, signal?: AbortSignal): Promise<string> {
    return this.#request<string>(signal, (cb) => this.#sftp.realpath(path, cb));
  }

  #markDead(error?: Error): void {
    this.#alive = false;
    if (error !== undefined) {
      this.#logger.log('warn', 'SFTP connection failed', { message: error.message });
    }
  }

  /**
   * One request, one abort race. `settled` is what makes the abandoned reply
   * harmless: the server's callback arrives after the rejection and finds the
   * promise already settled, so it does nothing rather than throwing into a
   * dead handler.
   */
  async #request<T>(
    signal: AbortSignal | undefined,
    body: (callback: (error: unknown, value?: T) => void) => void,
  ): Promise<T> {
    if (signal?.aborted === true) throw OmniFsError.cancelled('SFTP request');

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        reject(OmniFsError.cancelled('SFTP request'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      body((error, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        if (error !== undefined && error !== null) reject(error);
        else resolve(value as T);
      });
    });
  }
}

/**
 * Which OpenSSH extensions the connected server announced.
 *
 * `ssh2` records them at version exchange on a private field, so this is one
 * narrow, named cast rather than a guess. Its failure mode is benign: an
 * unexpected shape reads as no extensions, which costs a server-side copy and a
 * durable flush and changes nothing about correctness. `ext_copy_data` and
 * `ext_openssh_fsync` also throw synchronously when the extension is missing,
 * which is the backstop if this ever reads wrong.
 */
export function detectExtensions(sftp: SFTPWrapper): SftpExtensions {
  const announced = (sftp as unknown as { _extensions?: Readonly<Record<string, string>> })
    ._extensions;
  const has = (name: string): boolean => announced?.[name] === '1';
  return {
    posixRename: has('posix-rename@openssh.com'),
    fsync: has('fsync@openssh.com'),
    copyData: has('copy-data'),
  };
}

function toAttrs(stats: Stats): SftpAttrs {
  return {
    mode: stats.mode,
    size: stats.size,
    mtime: stats.mtime,
    uid: stats.uid,
    gid: stats.gid,
  };
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm build && pnpm --filter @omni-fs/provider-sftp exec vitest run src/sftp-session.test.ts`
Expected: PASS, 12 tests — the ten below plus the two `isAlive`/`close` cases correction 3 above calls for.

Checked against `@types/ssh2@1.15.6` while planning, so these should compile as written: `Callback = (err?: Error | null) => void`, `readdir` yields `FileEntryWithStats[]` whose `attrs` is a `Stats`, `Attributes` declares `mode`/`uid`/`gid`/`size`/`atime`/`mtime` as required numbers, `ext_openssh_rename`/`ext_openssh_fsync`/`ext_copy_data` are all declared, and `SyncHostVerifier` is `(key: Buffer) => boolean`.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/provider-sftp/src
git add packages/provider-sftp/src
git commit -m ":sparkles: feat add an sftp session that races every request against its abort signal"
```

---

### Task 6: The session's streaming half — writeAll, copyData and both streams

**Files:**

- Modify: `packages/provider-sftp/src/sftp-session.ts`
- Modify: `packages/provider-sftp/src/sftp-session.test.ts`

**Interfaces:**

- Consumes: everything Task 5 produced.
- Produces: `SftpWriteFlags` (`'w' | 'wx'`), `SftpReadRange` (`{ start?, end?, signal? }`, `end` inclusive), `SftpApi extends SftpRequests` with `writeAll`, `copyData`, `openReadStream` and `openWriteStream`, `SftpConnection extends SftpApi` adding `isAlive()` and `close()`, and `OpenSession = (options: SftpSessionOptions) => Promise<SftpConnection>`. `SftpSession` now declares `implements SftpConnection`, and `SftpSession.open` satisfies `OpenSession`. Task 7 builds the file system on `SftpConnection` and `OpenSession`.

`openWriteStream` is the reason this task exists separately: its `close()` must mean the bytes are on the server. It opens the handle itself and passes it to `createWriteStream` with `autoClose: false` (both are `WriteStreamOptions`, verified), so the sequence is finish, then `fsync@openssh.com` where offered, then close the handle — and only then does `close()` resolve. A write stream whose `close()` resolved for a transfer the server rejected is the defect this repo has already fixed twice, in `openUploadStream` (S3) and `openWriteStream` (WebDAV).

- [ ] **Step 1: Write the failing tests**

Append to `packages/provider-sftp/src/sftp-session.test.ts` — and add `PassThrough` and `Readable` to the imports at the top of the file (`import { PassThrough, Readable } from 'node:stream';`):

```ts
describe('SftpSession writes', () => {
  interface WriteLog {
    opened: { path: string; flags: string }[];
    written: Buffer[];
    fsynced: number;
    closed: number;
  }

  function writeChannel(over: Record<string, unknown> = {}): {
    channel: Record<string, unknown>;
    log: WriteLog;
  } {
    const log: WriteLog = { opened: [], written: [], fsynced: 0, closed: 0 };
    const channel = {
      open: (path: string, flags: string, cb: Reply<Buffer>) => {
        log.opened.push({ path, flags });
        cb(undefined, Buffer.from('handle'));
      },
      write: (_h: Buffer, buffer: Buffer, _o: number, _l: number, _p: number, cb: Reply) => {
        log.written.push(Buffer.from(buffer));
        cb(undefined);
      },
      ext_openssh_fsync: (_h: Buffer, cb: Reply) => {
        log.fsynced += 1;
        cb(undefined);
      },
      close: (_h: Buffer, cb: Reply) => {
        log.closed += 1;
        cb(undefined);
      },
      ...over,
    };
    return { channel, log };
  }

  it('writes a whole buffer through one open, flush and close', async () => {
    const { channel, log } = writeChannel();
    const fs = session(channel, { posixRename: false, fsync: true, copyData: false });

    await fs.writeAll('/data/a.txt', new TextEncoder().encode('hello'), 'w');

    expect(log.opened).toEqual([{ path: '/data/a.txt', flags: 'w' }]);
    expect(Buffer.concat(log.written).toString('utf8')).toBe('hello');
    expect(log.fsynced).toBe(1);
    expect(log.closed).toBe(1);
  });

  it('opens exclusively when asked to, so the server refuses an existing file', async () => {
    const { channel, log } = writeChannel();
    await session(channel).writeAll('/data/a.txt', new Uint8Array(), 'wx');
    expect(log.opened[0]?.flags).toBe('wx');
  });

  it('skips the flush on a server without fsync@openssh.com', async () => {
    const { channel, log } = writeChannel();
    await session(channel).writeAll('/data/a.txt', new TextEncoder().encode('hi'), 'w');
    expect(log.fsynced).toBe(0);
    expect(log.closed).toBe(1);
  });

  it('closes the handle even when the write fails, and reports the write failure', async () => {
    const failure = Object.assign(new Error('Failure'), { code: 4 });
    const { channel, log } = writeChannel({
      write: (_h: Buffer, _b: Buffer, _o: number, _l: number, _p: number, cb: Reply) => cb(failure),
    });

    await expect(
      session(channel).writeAll('/data/a.txt', new TextEncoder().encode('hi'), 'w'),
    ).rejects.toBe(failure);
    expect(log.closed).toBe(1);
  });

  it('refuses a server-side copy the server never announced', async () => {
    const { channel } = writeChannel();
    await expect(session(channel).copyData('/a', '/b', 'w')).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Unsupported',
    );
  });

  it('copies with copy-data, reading to EOF and closing both handles', async () => {
    let call: { srcOffset: number; len: number; dstOffset: number } | undefined;
    const { channel, log } = writeChannel({
      ext_copy_data: (
        _src: Buffer,
        srcOffset: number,
        len: number,
        _dst: Buffer,
        dstOffset: number,
        cb: Reply,
      ) => {
        call = { srcOffset, len, dstOffset };
        cb(undefined);
      },
    });
    const fs = session(channel, { posixRename: false, fsync: false, copyData: true });

    await fs.copyData('/data/from.txt', '/data/to.txt', 'w');

    expect(log.opened).toEqual([
      { path: '/data/from.txt', flags: 'r' },
      { path: '/data/to.txt', flags: 'w' },
    ]);
    // length 0 means "read the source until EOF"
    expect(call).toEqual({ srcOffset: 0, len: 0, dstOffset: 0 });
    expect(log.closed).toBe(2);
  });

  it('holds the write stream open until the bytes are flushed and the handle is closed', async () => {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));
    const { channel, log } = writeChannel({ createWriteStream: () => sink });
    const fs = session(channel, { posixRename: false, fsync: true, copyData: false });

    const stream = await fs.openWriteStream('/data/streamed.txt', 'w');
    const writer = stream.getWriter();
    await writer.write(new TextEncoder().encode('first-'));
    await writer.write(new TextEncoder().encode('second'));
    await writer.close();

    expect(Buffer.concat(chunks).toString('utf8')).toBe('first-second');
    expect(log.fsynced).toBe(1);
    expect(log.closed).toBe(1);
  });

  it('fails close() when the server rejects the flush, rather than claiming the write landed', async () => {
    const sink = new PassThrough();
    sink.resume();
    const { channel } = writeChannel({
      createWriteStream: () => sink,
      ext_openssh_fsync: (_h: Buffer, cb: Reply) => cb(new Error('Quota exceeded')),
    });
    const fs = session(channel, { posixRename: false, fsync: true, copyData: false });

    const stream = await fs.openWriteStream('/data/streamed.txt', 'w');
    const writer = stream.getWriter();
    await writer.write(new TextEncoder().encode('bytes'));

    await expect(writer.close()).rejects.toThrow('Quota exceeded');
  });

  it('passes an inclusive byte range to the read stream', async () => {
    let options: { start?: number; end?: number } | undefined;
    const { channel } = writeChannel({
      createReadStream: (_path: string, opts: { start?: number; end?: number }) => {
        options = opts;
        return Readable.from([Buffer.from('234')]);
      },
    });

    const stream = await session(channel).openReadStream('/data/ranged.txt', { start: 2, end: 4 });
    const reader = stream.getReader();
    const first = await reader.read();

    expect(options).toEqual({ start: 2, end: 4 });
    expect(Buffer.from(first.value as Uint8Array).toString('utf8')).toBe('234');
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @omni-fs/provider-sftp exec vitest run src/sftp-session.test.ts`
Expected: FAIL — `fs.writeAll is not a function`.

- [ ] **Step 3: Widen the interfaces**

In `packages/provider-sftp/src/sftp-session.ts`, add `Readable` and `Writable` to the Node imports at the top:

```ts
import { Readable, type Writable } from 'node:stream';
```

and add these declarations after `SftpRequests`:

```ts
/** `w` truncates or creates; `wx` fails when the path already exists, on the server. */
export type SftpWriteFlags = 'w' | 'wx';

export interface SftpReadRange {
  readonly start?: number | undefined;
  /** Inclusive, as `ssh2` wants it. */
  readonly end?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface SftpApi extends SftpRequests {
  writeAll(
    path: string,
    data: Uint8Array,
    flags: SftpWriteFlags,
    signal?: AbortSignal,
  ): Promise<void>;
  /** `copy-data`. Throws `Unsupported` when the server did not announce it. */
  copyData(from: string, to: string, flags: SftpWriteFlags, signal?: AbortSignal): Promise<void>;
  openReadStream(path: string, range?: SftpReadRange): Promise<ReadableStream<Uint8Array>>;
  openWriteStream(
    path: string,
    flags: SftpWriteFlags,
    signal?: AbortSignal,
  ): Promise<WritableStream<Uint8Array>>;
}

export interface SftpConnection extends SftpApi {
  isAlive(): boolean;
  close(): Promise<void>;
}

/** How the file system opens a session. Replaced by a fake in the hermetic tests. */
export type OpenSession = (options: SftpSessionOptions) => Promise<SftpConnection>;
```

Change the class declaration from `implements SftpRequests` to:

```ts
export class SftpSession implements SftpConnection {
```

- [ ] **Step 4: Implement the four methods**

Add to `SftpSession`, after `realpath`:

```ts
  /**
   * Open, write, flush, close.
   *
   * `ssh2` chunks a buffer larger than the negotiated maximum itself and calls
   * back once at the end (`lib/protocol/SFTP.js:446`), so the whole payload goes
   * in one call. The first failure wins: a write error is reported even when the
   * close that follows also fails, because the write is the one the caller asked
   * about.
   */
  async writeAll(
    path: string,
    data: Uint8Array,
    flags: SftpWriteFlags,
    signal?: AbortSignal,
  ): Promise<void> {
    const handle = await this.#open(path, flags, signal);
    let failure: unknown;

    try {
      if (data.byteLength > 0) {
        const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        await this.#request<void>(signal, (cb) =>
          this.#sftp.write(handle, buffer, 0, buffer.byteLength, 0, cb),
        );
      }
      await this.#flush(handle, signal);
    } catch (error) {
      failure = error;
    }

    try {
      await this.#closeHandle(handle);
    } catch (error) {
      failure ??= error;
    }

    if (failure !== undefined) throw failure;
  }

  /**
   * `copy-data`: the server reads from one handle and writes to another, so the
   * bytes never cross the client. `len: 0` means "until EOF" (`ssh2`'s
   * `SFTP.md`).
   */
  async copyData(
    from: string,
    to: string,
    flags: SftpWriteFlags,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.extensions.copyData) {
      throw OmniFsError.unsupported('server-side copy', 'sftp');
    }

    const source = await this.#open(from, 'r', signal);
    try {
      const target = await this.#open(to, flags, signal);
      try {
        await this.#request<void>(signal, (cb) =>
          this.#sftp.ext_copy_data(source, 0, 0, target, 0, cb),
        );
        await this.#flush(target, signal);
      } finally {
        await this.#closeHandle(target);
      }
    } finally {
      await this.#closeHandle(source);
    }
  }

  /**
   * A Node read stream translated to a web one. Errors arrive late — the library
   * returns the stream before the request is answered — so a missing file
   * surfaces as an error event, which the file system layer translates.
   * Aborting destroys the stream with an `AbortError`, which is real
   * cancellation rather than the abandonment a request-shaped call has to settle
   * for.
   */
  async openReadStream(path: string, range?: SftpReadRange): Promise<ReadableStream<Uint8Array>> {
    if (range?.signal?.aborted === true) throw OmniFsError.cancelled(path);

    const stream = this.#sftp.createReadStream(path, {
      ...(range?.start !== undefined ? { start: range.start } : {}),
      ...(range?.end !== undefined ? { end: range.end } : {}),
    });

    range?.signal?.addEventListener(
      'abort',
      () => stream.destroy(Object.assign(new Error(`Aborted: ${path}`), { name: 'AbortError' })),
      { once: true },
    );

    return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  }

  /**
   * A streamed write whose `close()` means the bytes are on the server.
   *
   * The handle is opened here rather than by `createWriteStream`, and passed in
   * with `autoClose: false`, so this class controls the end of the transfer:
   * finish the stream, `fsync` where the server offers it, then close the
   * handle. Each step's failure rejects `close()`.
   *
   * `onProgress` is not reported and cannot be: the caller is the one feeding
   * the stream, so it already knows how many bytes it has handed over.
   */
  async openWriteStream(
    path: string,
    flags: SftpWriteFlags,
    signal?: AbortSignal,
  ): Promise<WritableStream<Uint8Array>> {
    const handle = await this.#open(path, flags, signal);
    const stream: Writable = this.#sftp.createWriteStream(path, { handle, autoClose: false });

    return new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await new Promise<void>((resolve, reject) => {
          stream.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength), (error) =>
            error === undefined || error === null ? resolve() : reject(error),
          );
        });
      },
      close: async () => {
        await new Promise<void>((resolve, reject) => {
          stream.once('error', reject);
          stream.end(() => resolve());
        });
        await this.#flush(handle, signal);
        await this.#closeHandle(handle);
      },
      abort: async () => {
        stream.destroy();
        await this.#closeHandle(handle).catch(() => undefined);
      },
    });
  }

  async #open(path: string, flags: SftpWriteFlags | 'r', signal?: AbortSignal): Promise<Buffer> {
    return this.#request<Buffer>(signal, (cb) => this.#sftp.open(path, flags, cb));
  }

  /** `fsync@openssh.com` where the server has it, and nothing where it does not. */
  async #flush(handle: Buffer, signal?: AbortSignal): Promise<void> {
    if (!this.extensions.fsync) return;
    await this.#request<void>(signal, (cb) => this.#sftp.ext_openssh_fsync(handle, cb));
  }

  /**
   * Closes a handle without a signal, deliberately: a close skipped because the
   * caller aborted would leak the handle for the life of the connection, and the
   * server has already done the work.
   */
  async #closeHandle(handle: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#sftp.close(handle, (error) =>
        error === undefined || error === null ? resolve() : reject(error),
      );
    });
  }
```

- [ ] **Step 5: Run the tests**

Run: `pnpm build && pnpm --filter @omni-fs/provider-sftp exec vitest run src/sftp-session.test.ts`
Expected: PASS, 21 tests (Task 5's 12 plus the 9 here).

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write packages/provider-sftp/src
git add packages/provider-sftp/src
git commit -m ":sparkles: feat make a closed sftp write stream mean the bytes are on the server"
```

---

### Task 7: The file system — capabilities, connect, stat and list

**Files:**

- Create: `packages/provider-sftp/src/sftp-helpers.ts`
- Create: `packages/provider-sftp/src/sftp-helpers.test.ts`
- Create: `packages/provider-sftp/src/sftp-file-system.ts`
- Create: `packages/provider-sftp/src/sftp-file-system.test.ts`
- Rewrite: `packages/provider-sftp/src/index.ts`

**Interfaces:**

- Consumes: `SftpSettings`/`readSettings` (Task 1), `toOmniFsError` (Task 2), `SftpAttrs`/`SftpConnection`/`OpenSession`/`SftpSession` (Tasks 5–6).
- Produces: from `sftp-helpers.ts` — `toFileType(mode: number): FileType`, `toFileStat(attrs: SftpAttrs): FileStat`, `resolveBase(rootPrefix: string, loginDirectory: string): string`, `joinRemote(base: string, path: RemotePath): string`. From `sftp-file-system.ts` — `SFTP_CAPABILITIES` and `class SftpFileSystem implements RemoteFileSystem` whose constructor is `(context: ProviderContext, openSession?: OpenSession)`. Tasks 8–10 add methods to the same class. `index.ts` exports `sftpProvider`.

Two capability corrections land here, both justified in the spec: `canDeleteRecursive` becomes `true` (Task 10 implements the walk) and `preservesMTime` becomes `false` (no `WriteOption` carries a client mtime, so there is nothing to preserve — the same answer S3 and WebDAV give). `canCopyServerSide` stays `false` in the static set and is answered per connection by the getter.

- [ ] **Step 1: Write the failing helper test**

Create `packages/provider-sftp/src/sftp-helpers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RemotePath } from '@omni-fs/core';
import { joinRemote, resolveBase, toFileStat, toFileType } from './sftp-helpers.js';

describe('toFileType', () => {
  it.each([
    [0o100644, 'file'],
    [0o040755, 'directory'],
    [0o120777, 'symlink'],
    [0o010644, 'unknown'],
  ])('reads mode %s as %s', (mode, type) => {
    expect(toFileType(mode)).toBe(type);
  });
});

describe('toFileStat', () => {
  it('converts SFTP seconds into the epoch millis core expects', () => {
    const stat = toFileStat({
      mode: 0o100644,
      size: 12,
      mtime: 1_700_000_000,
      uid: 1000,
      gid: 1000,
    });
    expect(stat).toMatchObject({ type: 'file', size: 12, mtime: 1_700_000_000_000 });
    expect(stat.mode).toBe(0o100644);
    expect(stat.raw).toEqual({ uid: 1000, gid: 1000 });
  });

  it('never reports a version token, because SFTP has none', () => {
    expect(toFileStat({ mode: 0o100644, size: 1, mtime: 1, uid: 0, gid: 0 }).etag).toBeUndefined();
  });
});

describe('resolveBase', () => {
  it('uses the login directory when no prefix is set', () => {
    expect(resolveBase('', '/home/omnifs')).toBe('/home/omnifs');
  });

  it('puts a relative prefix below the login directory', () => {
    expect(resolveBase('projects', '/home/omnifs')).toBe('/home/omnifs/projects');
  });

  it('takes an absolute prefix as the server path it is', () => {
    expect(resolveBase('/var/www', '/home/omnifs')).toBe('/var/www');
  });

  it('collapses repeated slashes and drops a trailing one', () => {
    expect(resolveBase('projects', '/home/omnifs/')).toBe('/home/omnifs/projects');
  });

  it('keeps the filesystem root usable as a base', () => {
    expect(resolveBase('/', '/home/omnifs')).toBe('/');
  });
});

describe('joinRemote', () => {
  it('joins a connection path onto the base', () => {
    expect(joinRemote('/home/omnifs', RemotePath.parse('/docs/a.txt'))).toBe(
      '/home/omnifs/docs/a.txt',
    );
  });

  it('maps the connection root onto the base itself', () => {
    expect(joinRemote('/home/omnifs', RemotePath.ROOT)).toBe('/home/omnifs');
  });

  it('does not double the slash when the base is the filesystem root', () => {
    expect(joinRemote('/', RemotePath.parse('/a.txt'))).toBe('/a.txt');
    expect(joinRemote('/', RemotePath.ROOT)).toBe('/');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @omni-fs/provider-sftp exec vitest run src/sftp-helpers.test.ts`
Expected: FAIL — `Cannot find module './sftp-helpers.js'`.

- [ ] **Step 3: Write the helpers**

Create `packages/provider-sftp/src/sftp-helpers.ts`:

```ts
import type { FileStat, FileType, RemotePath } from '@omni-fs/core';
import type { SftpAttrs } from './sftp-session.js';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

/**
 * POSIX mode bits to the shared vocabulary.
 *
 * The bits are read rather than `Stats.isDirectory()` and friends, because this
 * runs against a plain attributes object in the hermetic tests as well as
 * against the library's class.
 */
export function toFileType(mode: number): FileType {
  switch (mode & S_IFMT) {
    case S_IFDIR:
      return 'directory';
    case S_IFREG:
      return 'file';
    case S_IFLNK:
      return 'symlink';
    default:
      return 'unknown';
  }
}

/**
 * `mtime` is seconds in SFTP and millis in `FileStat`. `etag` is left unset:
 * SFTP has no version token, which is what `hasVersionTokens: false` declares.
 * `size` is passed through even for a directory, as `provider-webdav` does.
 */
export function toFileStat(attrs: SftpAttrs): FileStat {
  return {
    type: toFileType(attrs.mode),
    size: attrs.size,
    mtime: attrs.mtime * 1000,
    mode: attrs.mode,
    raw: { uid: attrs.uid, gid: attrs.gid },
  };
}

/**
 * Where this connection starts on the server.
 *
 * An empty prefix is the login directory, an absolute one is itself, and a
 * relative one sits below the login directory. The login directory comes from
 * `realpath('.')` at connect, which is the only way to learn it.
 */
export function resolveBase(rootPrefix: string, loginDirectory: string): string {
  if (rootPrefix.startsWith('/')) return normalise(rootPrefix);
  if (rootPrefix === '') return normalise(loginDirectory);
  return normalise(`${loginDirectory}/${rootPrefix}`);
}

/** `RemotePath` is already absolute and normalised, so this is concatenation. */
export function joinRemote(base: string, path: RemotePath): string {
  if (path.isRoot) return base;
  return base === '/' ? path.value : `${base}${path.value}`;
}

function normalise(value: string): string {
  const collapsed = `/${value}`.replace(/\/+/g, '/').replace(/\/+$/, '');
  return collapsed === '' ? '/' : collapsed;
}
```

- [ ] **Step 4: Run it, then write the failing file system test**

Run: `pnpm build && pnpm --filter @omni-fs/provider-sftp exec vitest run src/sftp-helpers.test.ts`
Expected: PASS, 14 tests.

Create `packages/provider-sftp/src/sftp-file-system.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { NOOP_LOGGER, OmniFsError, RemotePath } from '@omni-fs/core';
import type { ConnectionConfig, DirEntry, ProviderContext } from '@omni-fs/core';
import { SftpFileSystem } from './sftp-file-system.js';
import type {
  SftpAttrs,
  SftpConnection,
  SftpExtensions,
  SftpSessionOptions,
} from './sftp-session.js';

export const NO_EXTENSIONS: SftpExtensions = {
  posixRename: false,
  fsync: false,
  copyData: false,
};

export function file(size = 4, mtime = 1_700_000_000): SftpAttrs {
  return { mode: 0o100644, size, mtime, uid: 1000, gid: 1000 };
}

export function directory(): SftpAttrs {
  return { mode: 0o040755, size: 4096, mtime: 1_700_000_000, uid: 1000, gid: 1000 };
}

export function link(): SftpAttrs {
  return { mode: 0o120777, size: 7, mtime: 1_700_000_000, uid: 1000, gid: 1000 };
}

export function notFound(): Error & { code: number } {
  return Object.assign(new Error('No such file'), { code: 2 });
}

/** A session whose behaviour each test supplies; anything unset throws. */
export function fakeSession(
  over: Partial<SftpConnection>,
  extensions: SftpExtensions = NO_EXTENSIONS,
): SftpConnection {
  const missing = (name: string) => async (): Promise<never> => {
    throw new Error(`fake session: ${name} was not expected to be called`);
  };

  return {
    extensions,
    isAlive: () => true,
    close: async () => undefined,
    realpath: async () => '/home/omnifs',
    stat: missing('stat'),
    lstat: missing('lstat'),
    readdir: missing('readdir'),
    mkdir: missing('mkdir'),
    rmdir: missing('rmdir'),
    unlink: missing('unlink'),
    rename: missing('rename'),
    posixRename: missing('posixRename'),
    writeAll: missing('writeAll'),
    copyData: missing('copyData'),
    openReadStream: missing('openReadStream'),
    openWriteStream: missing('openWriteStream'),
    ...over,
  } as SftpConnection;
}

export function context(settings: Readonly<Record<string, unknown>> = {}): ProviderContext {
  const config: ConnectionConfig = {
    id: 'test-connection',
    providerId: 'sftp',
    label: 'Test',
    settings: { host: 'sftp.example.com', username: 'omnifs', ...settings },
  };
  return { config, getSecret: async () => ({ password: 'secret' }), logger: NOOP_LOGGER };
}

/** A connected file system over the given session. */
export async function connected(
  session: SftpConnection,
  settings: Readonly<Record<string, unknown>> = {},
): Promise<{ fs: SftpFileSystem; opened: SftpSessionOptions[] }> {
  const opened: SftpSessionOptions[] = [];
  const fs = new SftpFileSystem(context(settings), async (options) => {
    opened.push(options);
    return session;
  });
  await fs.connect();
  return { fs, opened };
}

export async function collect(entries: AsyncIterable<DirEntry>): Promise<DirEntry[]> {
  const out: DirEntry[] = [];
  for await (const entry of entries) out.push(entry);
  return out;
}

describe('SftpFileSystem connect', () => {
  it('is not alive before it connects', () => {
    const fs = new SftpFileSystem(context(), async () => fakeSession({}));
    expect(fs.isAlive()).toBe(false);
  });

  it('passes the resolved secret to the session', async () => {
    const { opened } = await connected(fakeSession({}));
    expect(opened).toHaveLength(1);
    expect(opened[0]?.secret).toEqual({ password: 'secret' });
  });

  it('roots an empty prefix at the login directory', async () => {
    const seen: string[] = [];
    const session = fakeSession({
      realpath: async () => '/home/omnifs',
      stat: async (path: string) => {
        seen.push(path);
        return file();
      },
    });
    const { fs } = await connected(session);

    await fs.stat(RemotePath.parse('/docs/a.txt'));
    expect(seen).toEqual(['/home/omnifs/docs/a.txt']);
  });

  it('takes an absolute root prefix as the server path', async () => {
    const seen: string[] = [];
    const session = fakeSession({
      stat: async (path: string) => {
        seen.push(path);
        return file();
      },
    });
    const { fs } = await connected(session, { rootPrefix: '/var/www' });

    await fs.stat(RemotePath.parse('/a.txt'));
    expect(seen).toEqual(['/var/www/a.txt']);
  });

  it('puts a relative root prefix below the login directory', async () => {
    const seen: string[] = [];
    const session = fakeSession({
      stat: async (path: string) => {
        seen.push(path);
        return file();
      },
    });
    const { fs } = await connected(session, { rootPrefix: 'projects' });

    await fs.stat(RemotePath.parse('/a.txt'));
    expect(seen).toEqual(['/home/omnifs/projects/a.txt']);
  });

  it('does not reconnect while the session is alive', async () => {
    const { fs, opened } = await connected(fakeSession({}));
    await fs.connect();
    expect(opened).toHaveLength(1);
  });
});

describe('SftpFileSystem capabilities', () => {
  it('declares recursive delete and no mtime preservation', () => {
    const fs = new SftpFileSystem(context(), async () => fakeSession({}));
    expect(fs.capabilities.canDeleteRecursive).toBe(true);
    expect(fs.capabilities.preservesMTime).toBe(false);
    expect(fs.capabilities.hasVersionTokens).toBe(false);
  });

  it('promises no server-side copy before a server has been asked', () => {
    const fs = new SftpFileSystem(context(), async () => fakeSession({}));
    expect(fs.capabilities.canCopyServerSide).toBe(false);
  });

  it('reports server-side copy once a server announces copy-data', async () => {
    const { fs } = await connected(fakeSession({}, { ...NO_EXTENSIONS, copyData: true }));
    expect(fs.capabilities.canCopyServerSide).toBe(true);
  });

  it('keeps promising nothing on a server without the extension', async () => {
    const { fs } = await connected(fakeSession({}));
    expect(fs.capabilities.canCopyServerSide).toBe(false);
  });
});

describe('SftpFileSystem stat', () => {
  it('maps type, size and modification time', async () => {
    const { fs } = await connected(fakeSession({ stat: async () => file(12) }));
    const stat = await fs.stat(RemotePath.parse('/a.txt'));
    expect(stat).toMatchObject({ type: 'file', size: 12, mtime: 1_700_000_000_000 });
  });

  it('translates a missing path into NotFound', async () => {
    const { fs } = await connected(
      fakeSession({
        stat: async () => {
          throw notFound();
        },
        lstat: async () => {
          throw notFound();
        },
      }),
    );

    await expect(fs.stat(RemotePath.parse('/gone.txt'))).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
    );
  });

  it('reports a dangling symlink as a symlink rather than as absent', async () => {
    const { fs } = await connected(
      fakeSession({
        stat: async () => {
          throw notFound();
        },
        lstat: async () => link(),
      }),
    );

    expect((await fs.stat(RemotePath.parse('/broken'))).type).toBe('symlink');
  });
});

describe('SftpFileSystem list', () => {
  it('yields children with absolute, resolvable paths', async () => {
    const { fs } = await connected(
      fakeSession({
        readdir: async () => [{ filename: 'a.txt', attrs: file() }],
      }),
    );

    const entries = await collect(fs.list(RemotePath.parse('/docs')));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('a.txt');
    expect(entries[0]?.path.value).toBe('/docs/a.txt');
  });

  it('drops the dot entries OpenSSH includes in a listing', async () => {
    const { fs } = await connected(
      fakeSession({
        readdir: async () => [
          { filename: '.', attrs: directory() },
          { filename: '..', attrs: directory() },
          { filename: 'deep', attrs: directory() },
        ],
      }),
    );

    const entries = await collect(fs.list(RemotePath.parse('/shallow')));
    expect(entries.map((entry) => entry.name)).toEqual(['deep']);
  });

  it('resolves a symlink to the type of its target', async () => {
    const { fs } = await connected(
      fakeSession({
        readdir: async () => [{ filename: 'current', attrs: link() }],
        stat: async () => directory(),
      }),
    );

    const entries = await collect(fs.list(RemotePath.parse('/releases')));
    expect(entries[0]).toMatchObject({ name: 'current', type: 'directory' });
  });

  it('leaves a link whose target is gone as a symlink', async () => {
    const { fs } = await connected(
      fakeSession({
        readdir: async () => [{ filename: 'broken', attrs: link() }],
        stat: async () => {
          throw notFound();
        },
      }),
    );

    const entries = await collect(fs.list(RemotePath.parse('/releases')));
    expect(entries[0]).toMatchObject({ name: 'broken', type: 'symlink' });
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `pnpm --filter @omni-fs/provider-sftp exec vitest run src/sftp-file-system.test.ts`
Expected: FAIL — `Cannot find module './sftp-file-system.js'`.

- [ ] **Step 6: Write the file system**

Create `packages/provider-sftp/src/sftp-file-system.ts`:

```ts
import { OmniFsError } from '@omni-fs/core';
import type {
  DirEntry,
  FileStat,
  Logger,
  ProviderCapabilities,
  ProviderContext,
  RemoteFileSystem,
  RemotePath,
} from '@omni-fs/core';
import { toOmniFsError } from './errors.js';
import { readSettings, type SftpSettings } from './settings.js';
import { joinRemote, resolveBase, toFileStat, toFileType } from './sftp-helpers.js';
import { SftpSession, type OpenSession, type SftpConnection } from './sftp-session.js';

/**
 * SFTP over SSH.
 *
 * The closest of the four providers to a real POSIX filesystem: real
 * directories, real rename, real permission bits, and the fewest emulations
 * above it — which makes it the useful control case when a bug might be in
 * `ManagedFileSystem` rather than in a protocol.
 *
 * Two things here are unlike the other providers. Symlinks exist, so `list`
 * resolves them and `stat` falls back to `lstat` for one that dangles. And
 * `canCopyServerSide` is answered per connection, because `copy-data` is an
 * OpenSSH extension the server announces at version exchange — see the
 * `capabilities` getter.
 */
export class SftpFileSystem implements RemoteFileSystem {
  readonly #context: ProviderContext;
  readonly #settings: SftpSettings;
  readonly #logger: Logger;
  readonly #openSession: OpenSession;
  #session: SftpConnection | undefined;
  #base = '/';

  /**
   * `openSession` is the seam the hermetic tests replace. Production never
   * passes it, so `ProviderDefinition.create` stays a one-liner.
   */
  constructor(context: ProviderContext, openSession: OpenSession = SftpSession.open) {
    this.#context = context;
    this.#settings = readSettings(context.config.settings);
    this.#logger = context.logger;
    this.#openSession = openSession;
  }

  /**
   * Static until connected, then truthful about this server.
   *
   * `copy-data` is announced per connection, so the honest answer for
   * `canCopyServerSide` does not exist before the handshake. `copy()` is defined
   * either way and throws `Unsupported` when the extension is absent;
   * `ManagedFileSystem.copy` checks the method *and* this flag before using it
   * (`packages/core/src/fs/managed-file-system.ts:204`), so on a server without
   * the extension core streams the copy exactly as it does today.
   */
  get capabilities(): ProviderCapabilities {
    const session = this.#session;
    if (session === undefined) return SFTP_CAPABILITIES;
    return { ...SFTP_CAPABILITIES, canCopyServerSide: session.extensions.copyData };
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.#session?.isAlive() === true) return;

    const secret = await this.#context.getSecret(signal);
    const session = await this.#openSession({
      settings: this.#settings,
      secret,
      logger: this.#logger,
      ...(signal !== undefined ? { signal } : {}),
    });

    try {
      this.#base = resolveBase(this.#settings.rootPrefix, await session.realpath('.', signal));
    } catch (error) {
      await session.close();
      throw toOmniFsError(error, this.#settings.rootPrefix);
    }

    this.#session = session;
    this.#logger.log('info', 'SFTP connected', {
      host: this.#settings.host,
      base: this.#base,
    });
  }

  isAlive(): boolean {
    return this.#session?.isAlive() ?? false;
  }

  async stat(path: RemotePath, signal?: AbortSignal): Promise<FileStat> {
    const session = this.#requireSession();
    const remote = this.#remote(path);

    try {
      return toFileStat(await session.stat(remote, signal));
    } catch (error) {
      const translated = toOmniFsError(error, path.value);
      if (translated.code !== 'NotFound') throw translated;

      // `SSH_FXP_STAT` follows links, so a link whose target is gone reads as
      // absent — while `list` has just drawn it as a symlink. One `lstat` keeps
      // the two agreeing, and a path that genuinely is not there fails both.
      try {
        return toFileStat(await session.lstat(remote, signal));
      } catch {
        throw translated;
      }
    }
  }

  /**
   * `readdir` reports a symlink as a symlink, because its attributes are
   * `lstat`-shaped. Each link therefore gets one follow-up `stat`, so a link to
   * a directory opens as a directory and a link to a file opens in the editor —
   * which is how the same file already behaves over S3 and WebDAV. The
   * follow-ups run `maxConcurrency` at a time and are only paid on directories
   * that contain links. A link whose target is gone, or that we may not follow,
   * stays a symlink.
   */
  async *list(path: RemotePath, signal?: AbortSignal): AsyncIterable<DirEntry> {
    const session = this.#requireSession();
    const entries = (
      await this.#run(() => session.readdir(this.#remote(path), signal), path)
    ).filter((entry) => entry.filename !== '.' && entry.filename !== '..');

    const links = entries.filter((entry) => toFileType(entry.attrs.mode) === 'symlink');
    const resolved = new Map<string, FileStat>();

    for (let i = 0; i < links.length; i += SFTP_CAPABILITIES.maxConcurrency) {
      const batch = links.slice(i, i + SFTP_CAPABILITIES.maxConcurrency);
      await Promise.all(
        batch.map(async (entry) => {
          const target = path.join(entry.filename);
          try {
            resolved.set(
              entry.filename,
              toFileStat(await session.stat(this.#remote(target), signal)),
            );
          } catch (error) {
            const translated = toOmniFsError(error, target.value);
            if (translated.code !== 'NotFound' && translated.code !== 'PermissionDenied') {
              throw translated;
            }
          }
        }),
      );
    }

    for (const entry of entries) {
      const child = path.join(entry.filename);
      const stat = resolved.get(entry.filename) ?? toFileStat(entry.attrs);
      yield { ...stat, name: entry.filename, path: child };
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    await session?.close();
  }

  #remote(path: RemotePath): string {
    return joinRemote(this.#base, path);
  }

  #requireSession(): SftpConnection {
    const session = this.#session;
    if (session === undefined) {
      throw new OmniFsError({
        code: 'ConnectionFailed',
        message: 'SFTP session is not connected. Call connect() first.',
        providerId: 'sftp',
      });
    }
    return session;
  }

  async #run<T>(body: () => Promise<T>, path: RemotePath): Promise<T> {
    try {
      return await body();
    } catch (error) {
      throw toOmniFsError(error, path.value);
    }
  }
}

export const SFTP_CAPABILITIES: ProviderCapabilities = {
  canWrite: true,
  canRename: true,
  // False in the static set only. `SSH_FXP_RENAME` always exists, but a
  // server-side copy needs the `copy-data` extension, which is announced per
  // connection — the `capabilities` getter above answers it truthfully once the
  // handshake has happened.
  canCopyServerSide: false,
  canCreateDirectory: true,
  // The protocol has no recursive remove, so `delete` walks the tree itself.
  // `provider-s3` already settles what this flag means: it declares true and
  // enumerates-then-deletes from the client (`s3-file-system.ts:301`). Its only
  // reader asks whether the provider handles recursion
  // (`managed-file-system.ts:146`), so declaring true keeps one walk in the
  // system instead of two.
  canDeleteRecursive: true,
  canAppend: true,
  canReadRange: true,
  canStreamWrite: true,
  canWatch: false,
  hasRealDirectories: true,
  // Nothing in `WriteOptions` carries a client-supplied mtime, so there is no
  // mtime to preserve. `setstat`/`futimes` could keep one the day the contract
  // grows one; until then this matches what S3 and WebDAV declare, and the
  // skeleton's `true` was a claim about the protocol rather than about us.
  preservesMTime: false,
  // SFTP has no etag. A token synthesised from mtime and size would make
  // `ifMatch` look atomic when it would really be a racy re-stat, so the two
  // `ifMatch` conformance cases skip instead.
  hasVersionTokens: false,
  // One SSH connection multiplexes channels comfortably.
  maxConcurrency: 4,
  listIsPaginated: false,
};
```

- [ ] **Step 7: Rewrite index.ts**

Replace the whole of `packages/provider-sftp/src/index.ts` with:

```ts
import type { ProviderDefinition } from '@omni-fs/core';
import { SFTP_CAPABILITIES, SftpFileSystem } from './sftp-file-system.js';
import { SFTP_SECRET_SCHEMA, SFTP_SETTINGS_SCHEMA } from './settings.js';

/**
 * The whole public surface of this package: one definition object. A host adds
 * SFTP support with `registry.register(sftpProvider)` and learns nothing about
 * SSH or the `ssh2` client in the process.
 */
export const sftpProvider: ProviderDefinition = {
  id: 'sftp',
  displayName: 'SFTP (SSH)',
  schemes: ['sftp'],
  settingsSchema: SFTP_SETTINGS_SCHEMA,
  secretSchema: SFTP_SECRET_SCHEMA,
  defaultCapabilities: SFTP_CAPABILITIES,
  create: (context) => new SftpFileSystem(context),
};

export { SFTP_CAPABILITIES, SftpFileSystem } from './sftp-file-system.js';
export { SFTP_SECRET_SCHEMA, SFTP_SETTINGS_SCHEMA, readSettings } from './settings.js';
export type { SftpAuthMethod, SftpSettings } from './settings.js';
```

- [ ] **Step 8: Run everything**

Run: `pnpm build && pnpm --filter @omni-fs/provider-sftp test`
Expected: PASS — the settings, errors, local-files, known-hosts, auth, session, helpers and file system suites.

Run: `pnpm test && pnpm lint && pnpm --filter omni-fs-vscode exec tsc -p tsconfig.json --noEmit`
Expected: PASS. The extension only ever imports `sftpProvider`, and its shape has not changed.

- [ ] **Step 9: Commit**

```bash
pnpm exec prettier --write packages/provider-sftp/src
git add packages/provider-sftp/src
git commit -m ":sparkles: feat implement sftp connect, stat and list with symlink resolution"
```

---

### Task 8: Reading

**Files:**

- Modify: `packages/provider-sftp/src/sftp-helpers.ts`
- Modify: `packages/provider-sftp/src/sftp-helpers.test.ts`
- Modify: `packages/provider-sftp/src/sftp-file-system.ts`
- Modify: `packages/provider-sftp/src/sftp-file-system.test.ts`

**Interfaces:**

- Consumes: `openReadStream` (Task 6), the helpers and the class from Task 7.
- Produces: `buildRange(options: ReadOptions | undefined): { start: number; end?: number } | 'empty' | undefined` and `translateReadStream(source: ReadableStream<Uint8Array>, path: string): ReadableStream<Uint8Array>` in `sftp-helpers.ts`; `readFile` and `createReadStream` on `SftpFileSystem`.

Both helpers are deliberately the same shape as `provider-webdav`'s, including the `'empty'` case: an inclusive range cannot express "no bytes", so `{ offset: 5, length: 0 }` has to be answered rather than sent.

- [ ] **Step 1: Write the failing helper tests**

Append to `packages/provider-sftp/src/sftp-helpers.test.ts` — and add `buildRange` to the import from `./sftp-helpers.js`:

```ts
describe('buildRange', () => {
  it('is nothing when the caller asked for the whole file', () => {
    expect(buildRange(undefined)).toBeUndefined();
    expect(buildRange({})).toBeUndefined();
  });

  it('turns offset and length into an inclusive end', () => {
    expect(buildRange({ offset: 2, length: 3 })).toEqual({ start: 2, end: 4 });
  });

  it('leaves the end open when only an offset is given', () => {
    expect(buildRange({ offset: 10 })).toEqual({ start: 10 });
  });

  it('reports a zero-length read as empty rather than as an inverted range', () => {
    expect(buildRange({ offset: 5, length: 0 })).toBe('empty');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @omni-fs/provider-sftp exec vitest run src/sftp-helpers.test.ts`
Expected: FAIL — `buildRange is not a function`.

- [ ] **Step 3: Add both helpers**

Append to `packages/provider-sftp/src/sftp-helpers.ts`, and extend its imports to `import { toOmniFsError } from './errors.js';` plus `ReadOptions` in the type import from `@omni-fs/core`:

```ts
/**
 * `ReadOptions` to an `ssh2` byte range, whose `end` is inclusive.
 *
 * `'empty'` means the caller asked for no bytes at all: `{ offset: 5, length: 0 }`
 * would otherwise become `start: 5, end: 4`, which reads as an inverted range.
 * The same shape, and the same reason, as `provider-webdav`'s `buildRange`.
 */
export function buildRange(
  options: ReadOptions | undefined,
): { start: number; end?: number } | 'empty' | undefined {
  if (options?.offset === undefined) return undefined;
  const start = options.offset;
  if (options.length === undefined) return { start };
  return options.length <= 0 ? 'empty' : { start, end: start + options.length - 1 };
}

/**
 * Gives a read stream's late failures the same translation the request-shaped
 * calls get. `createReadStream` returns before the request is answered, so a
 * missing file or a dropped connection arrives as an error on the stream rather
 * than as a rejection from the call that made it.
 */
export function translateReadStream(
  source: ReadableStream<Uint8Array>,
  path: string,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        throw toOmniFsError(error, path);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
```

- [ ] **Step 4: Run the helper tests, then write the failing read tests**

Run: `pnpm --filter @omni-fs/provider-sftp exec vitest run src/sftp-helpers.test.ts`
Expected: PASS, 18 tests.

Append to `packages/provider-sftp/src/sftp-file-system.test.ts` — and add `collectStream, streamFrom` to the `@omni-fs/core` import and `Readable` to a `node:stream` import:

```ts
describe('SftpFileSystem reads', () => {
  function readable(body: string): ReadableStream<Uint8Array> {
    return Readable.toWeb(Readable.from([Buffer.from(body)])) as ReadableStream<Uint8Array>;
  }

  it('reads a whole file', async () => {
    const { fs } = await connected(fakeSession({ openReadStream: async () => readable('hello') }));
    expect(new TextDecoder().decode(await fs.readFile(RemotePath.parse('/a.txt')))).toBe('hello');
  });

  it('asks for an inclusive byte range', async () => {
    let range: unknown;
    const { fs } = await connected(
      fakeSession({
        openReadStream: async (_path: string, options: unknown) => {
          range = options;
          return readable('234');
        },
      }),
    );

    await fs.readFile(RemotePath.parse('/ranged.txt'), { offset: 2, length: 3 });
    expect(range).toMatchObject({ start: 2, end: 4 });
  });

  it('answers a zero-length read without opening a stream, after checking the file is there', async () => {
    let opened = 0;
    const { fs } = await connected(
      fakeSession({
        stat: async () => file(10),
        openReadStream: async () => {
          opened += 1;
          return readable('');
        },
      }),
    );

    const bytes = await fs.readFile(RemotePath.parse('/a.txt'), { offset: 5, length: 0 });
    expect(bytes.byteLength).toBe(0);
    expect(opened).toBe(0);
  });

  it('still reports a missing file on a zero-length read', async () => {
    const { fs } = await connected(
      fakeSession({
        stat: async () => {
          throw notFound();
        },
        lstat: async () => {
          throw notFound();
        },
      }),
    );

    await expect(
      fs.readFile(RemotePath.parse('/gone.txt'), { offset: 0, length: 0 }),
    ).rejects.toSatisfy((error: unknown) => OmniFsError.is(error) && error.code === 'NotFound');
  });

  it('translates a failure the stream reports after it was handed over', async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull() {
        throw Object.assign(new Error('No such file'), { code: 2 });
      },
    });
    const { fs } = await connected(fakeSession({ openReadStream: async () => failing }));

    await expect(fs.readFile(RemotePath.parse('/gone.txt'))).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
    );
  });
});
```

- [ ] **Step 5: Run them and watch them fail**

Run: `pnpm --filter @omni-fs/provider-sftp exec vitest run src/sftp-file-system.test.ts`
Expected: FAIL — `fs.readFile is not a function`.

- [ ] **Step 6: Implement the reads**

Add to `SftpFileSystem`, after `list`, and extend the imports with `collectStream`, `streamFrom` from `@omni-fs/core`, the types `ReadOptions`, and `buildRange`, `translateReadStream` from `./sftp-helpers.js`:

```ts
  /**
   * `onProgress` is not reported, as in `provider-webdav`: the bytes arrive
   * through a stream this method immediately collects, and a caller who wants
   * progress can read the stream itself.
   */
  async readFile(path: RemotePath, options?: ReadOptions): Promise<Uint8Array> {
    try {
      return await collectStream(await this.createReadStream(path, options));
    } catch (error) {
      throw toOmniFsError(error, path.value);
    }
  }

  async createReadStream(
    path: RemotePath,
    options?: ReadOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    const session = this.#requireSession();
    const range = buildRange(options);

    // A read of zero bytes has no range spelling, so it is answered here rather
    // than sent as something the server would read as a different request. The
    // `stat` is not a formality: without it a zero-length read of a missing path,
    // or one through an already-aborted signal, would succeed emptily, where
    // `MemoryFileSystem` — the contract's reference — raises `NotFound` and
    // `Cancelled` first.
    if (range === 'empty') {
      await this.stat(path, options?.signal);
      return streamFrom(new Uint8Array(0));
    }

    const stream = await this.#run(
      () =>
        session.openReadStream(this.#remote(path), {
          ...(range ?? {}),
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        }),
      path,
    );

    return translateReadStream(stream, path.value);
  }
```

- [ ] **Step 7: Run the tests**

Run: `pnpm build && pnpm --filter @omni-fs/provider-sftp test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
pnpm exec prettier --write packages/provider-sftp/src
git add packages/provider-sftp/src
git commit -m ":sparkles: feat implement sftp file reads including byte ranges"
```

---

### Task 9: Writing, and the directories a write needs

**Files:**

- Modify: `packages/provider-sftp/src/sftp-file-system.ts`
- Modify: `packages/provider-sftp/src/sftp-file-system.test.ts`

**Interfaces:**

- Consumes: `writeAll`, `openWriteStream`, `mkdir` (Tasks 5–6), `isFailure` (Task 2).
- Produces: `writeFile`, `createWriteStream` and `createDirectory` on `SftpFileSystem`.

`createDirectory` lands here rather than with the other mutations because `createParents` needs it: a write into a directory that does not exist yet has to build the chain and retry.

- [ ] **Step 1: Write the failing tests**

Append to `packages/provider-sftp/src/sftp-file-system.test.ts`:

```ts
describe('SftpFileSystem writes', () => {
  function failure(): Error & { code: number } {
    return Object.assign(new Error('Failure'), { code: 4 });
  }

  it('writes a file, truncating by default', async () => {
    const writes: { path: string; flags: string; body: string }[] = [];
    const { fs } = await connected(
      fakeSession({
        writeAll: async (path: string, data: Uint8Array, flags: string) => {
          writes.push({ path, flags, body: new TextDecoder().decode(data) });
        },
      }),
    );

    await fs.writeFile(RemotePath.parse('/a.txt'), new TextEncoder().encode('hello'));
    expect(writes).toEqual([{ path: '/home/omnifs/a.txt', flags: 'w', body: 'hello' }]);
  });

  it('opens exclusively when overwrite is false, so the server does the excluding', async () => {
    const flags: string[] = [];
    const { fs } = await connected(
      fakeSession({
        writeAll: async (_p: string, _d: Uint8Array, mode: string) => void flags.push(mode),
      }),
    );

    await fs.writeFile(RemotePath.parse('/a.txt'), new Uint8Array(), { overwrite: false });
    expect(flags).toEqual(['wx']);
  });

  it('reports an exclusive write that lost the race as AlreadyExists', async () => {
    const { fs } = await connected(
      fakeSession({
        writeAll: async () => {
          throw failure();
        },
      }),
    );

    await expect(
      fs.writeFile(RemotePath.parse('/a.txt'), new Uint8Array(), { overwrite: false }),
    ).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'AlreadyExists',
    );
  });

  it('creates the missing parent chain and writes again', async () => {
    const made: string[] = [];
    let attempts = 0;
    const { fs } = await connected(
      fakeSession({
        mkdir: async (path: string) => void made.push(path),
        writeAll: async () => {
          attempts += 1;
          if (attempts === 1) throw notFound();
        },
      }),
    );

    await fs.writeFile(RemotePath.parse('/deep/nested/a.txt'), new TextEncoder().encode('x'));
    expect(made).toEqual(['/home/omnifs/deep', '/home/omnifs/deep/nested']);
    expect(attempts).toBe(2);
  });

  it('does not build parents when the caller said not to', async () => {
    const { fs } = await connected(
      fakeSession({
        writeAll: async () => {
          throw notFound();
        },
      }),
    );

    await expect(
      fs.writeFile(RemotePath.parse('/deep/a.txt'), new Uint8Array(), { createParents: false }),
    ).rejects.toSatisfy((error: unknown) => OmniFsError.is(error) && error.code === 'NotFound');
  });

  it('reports progress for a whole-buffer write', async () => {
    const seen: number[] = [];
    const { fs } = await connected(fakeSession({ writeAll: async () => undefined }));

    await fs.writeFile(RemotePath.parse('/a.txt'), new TextEncoder().encode('12345'), {
      onProgress: (transferred) => seen.push(transferred),
    });
    expect(seen).toEqual([5]);
  });

  it('hands back a write stream opened with the right flags', async () => {
    const flags: string[] = [];
    const sink = new WritableStream<Uint8Array>();
    const { fs } = await connected(
      fakeSession({
        openWriteStream: async (_path: string, mode: string) => {
          flags.push(mode);
          return sink;
        },
      }),
    );

    expect(await fs.createWriteStream(RemotePath.parse('/a.txt'))).toBe(sink);
    await fs.createWriteStream(RemotePath.parse('/b.txt'), { overwrite: false });
    expect(flags).toEqual(['w', 'wx']);
  });

  it('builds the parents of a streamed write before the first byte', async () => {
    const made: string[] = [];
    let attempts = 0;
    const { fs } = await connected(
      fakeSession({
        mkdir: async (path: string) => void made.push(path),
        openWriteStream: async () => {
          attempts += 1;
          if (attempts === 1) throw notFound();
          return new WritableStream<Uint8Array>();
        },
      }),
    );

    await fs.createWriteStream(RemotePath.parse('/deep/a.txt'));
    expect(made).toEqual(['/home/omnifs/deep']);
    expect(attempts).toBe(2);
  });
});

describe('SftpFileSystem createDirectory', () => {
  function failure(): Error & { code: number } {
    return Object.assign(new Error('Failure'), { code: 4 });
  }

  it('creates the whole chain, shallowest first', async () => {
    const made: string[] = [];
    const { fs } = await connected(fakeSession({ mkdir: async (p: string) => void made.push(p) }));

    await fs.createDirectory(RemotePath.parse('/a/b/c'));
    expect(made).toEqual(['/home/omnifs/a', '/home/omnifs/a/b', '/home/omnifs/a/b/c']);
  });

  it('treats an existing directory as nothing to do', async () => {
    const { fs } = await connected(
      fakeSession({
        mkdir: async () => {
          throw failure();
        },
        stat: async () => directory(),
      }),
    );

    await expect(fs.createDirectory(RemotePath.parse('/existing'))).resolves.toBeUndefined();
  });

  it('refuses when a file already occupies the path', async () => {
    const { fs } = await connected(
      fakeSession({
        mkdir: async () => {
          throw failure();
        },
        stat: async () => file(),
      }),
    );

    await expect(fs.createDirectory(RemotePath.parse('/a.txt'))).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'AlreadyExists',
    );
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @omni-fs/provider-sftp exec vitest run src/sftp-file-system.test.ts`
Expected: FAIL — `fs.writeFile is not a function`.

- [ ] **Step 3: Implement the writes**

Add to `SftpFileSystem`, after `createReadStream`, extending the imports with `isFailure` from `./errors.js`, the types `WriteOptions` from `@omni-fs/core`, and `SftpWriteFlags` from `./sftp-session.js`:

```ts
  /**
   * `overwrite: false` is `wx`, so the exclusion is the server's. Unlike
   * `provider-webdav`, which has to check first and race, nothing here can slip
   * between the check and the write — there is no check.
   */
  async writeFile(path: RemotePath, data: Uint8Array, options?: WriteOptions): Promise<void> {
    const session = this.#requireSession();
    const flags = writeFlags(options);

    await this.#withParents(path, flags, options, (remote) =>
      session.writeAll(remote, data, flags, options?.signal),
    );

    options?.onProgress?.(data.byteLength, data.byteLength);
  }

  /**
   * A streamed write, for a file too large to hold in memory.
   *
   * `createParents` works here where it cannot on WebDAV's streamed PUT: the
   * handle is opened before the first byte, so a missing parent is known while
   * there is still something to retry. `onProgress` is not reported — the caller
   * is the one feeding the stream, so it already knows how much it has written.
   */
  async createWriteStream(
    path: RemotePath,
    options?: WriteOptions,
  ): Promise<WritableStream<Uint8Array>> {
    const session = this.#requireSession();
    const flags = writeFlags(options);

    return this.#withParents(path, flags, options, (remote) =>
      session.openWriteStream(remote, flags, options?.signal),
    );
  }

  /**
   * `SSH_FXP_MKDIR` one level at a time, shallowest first, because a server
   * answers "no such file" for a missing parent and there is no recursive form.
   *
   * An existing directory is not an error: that matches `MemoryFileSystem`, the
   * contract's reference, where creating one twice is a no-op. Status 4 is the
   * only answer a server gives for "something is already here", and it does not
   * say what, so one `stat` decides between the no-op and `AlreadyExists`.
   */
  async createDirectory(path: RemotePath, signal?: AbortSignal): Promise<void> {
    const session = this.#requireSession();

    const chain: RemotePath[] = [];
    for (let current = path; !current.isRoot; current = current.parent) chain.unshift(current);

    for (const directory of chain) {
      try {
        await session.mkdir(this.#remote(directory), signal);
      } catch (error) {
        if (!isFailure(error)) throw toOmniFsError(error, directory.value);
        if ((await this.stat(directory, signal)).type !== 'directory') {
          throw OmniFsError.alreadyExists(directory.value, error);
        }
      }
    }
  }

  /**
   * Runs a write, and on a missing parent builds the chain and runs it once more.
   *
   * One retry, not a loop: the second failure is the server telling us something
   * other than the parent was wrong, and retrying past that would turn a real
   * error into a hang.
   */
  async #withParents<T>(
    path: RemotePath,
    flags: SftpWriteFlags,
    options: WriteOptions | undefined,
    body: (remote: string) => Promise<T>,
  ): Promise<T> {
    const remote = this.#remote(path);

    try {
      return await body(remote);
    } catch (error) {
      const failure = this.#writeError(error, path, flags);
      if (failure.code !== 'NotFound' || options?.createParents === false) throw failure;

      await this.createDirectory(path.parent, options?.signal);
      try {
        return await body(remote);
      } catch (retry) {
        throw this.#writeError(retry, path, flags);
      }
    }
  }

  /**
   * Names a failed write. An exclusive open answers status 4 when the path is
   * already taken, and only this call site knows the open was exclusive — the
   * same narrowing `provider-webdav` does for 405 on `MKCOL`.
   */
  #writeError(error: unknown, path: RemotePath, flags: SftpWriteFlags): OmniFsError {
    return flags === 'wx' && isFailure(error)
      ? OmniFsError.alreadyExists(path.value, error)
      : toOmniFsError(error, path.value);
  }
```

And at the bottom of the file, beside the other module-scope helpers:

```ts
function writeFlags(options: WriteOptions | undefined): SftpWriteFlags {
  return options?.overwrite === false ? 'wx' : 'w';
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm build && pnpm --filter @omni-fs/provider-sftp test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/provider-sftp/src
git add packages/provider-sftp/src
git commit -m ":sparkles: feat implement sftp writes with an exclusive-open overwrite guard"
```

---

### Task 10: Delete, rename and copy — and what `canDeleteRecursive` means

**Files:**

- Modify: `packages/provider-sftp/src/sftp-file-system.ts`
- Modify: `packages/provider-sftp/src/sftp-file-system.test.ts`
- Modify: `packages/core/src/capabilities.ts` (the `canDeleteRecursive` doc comment)

**Interfaces:**

- Consumes: `unlink`, `rmdir`, `rename`, `posixRename`, `copyData`, `readdir`, `lstat` (Tasks 5–6).
- Produces: `delete`, `rename` and `copy` on `SftpFileSystem`. With these the class implements every `RemoteFileSystem` method its capabilities claim, so Task 11 can run the conformance suite.

- [ ] **Step 1: Write the failing tests**

Append to `packages/provider-sftp/src/sftp-file-system.test.ts`:

```ts
describe('SftpFileSystem delete', () => {
  function failure(): Error & { code: number } {
    return Object.assign(new Error('Failure'), { code: 4 });
  }

  it('unlinks a file', async () => {
    const unlinked: string[] = [];
    const { fs } = await connected(
      fakeSession({
        lstat: async () => file(),
        unlink: async (path: string) => void unlinked.push(path),
      }),
    );

    await fs.delete(RemotePath.parse('/a.txt'));
    expect(unlinked).toEqual(['/home/omnifs/a.txt']);
  });

  it('unlinks a symlink instead of following it, even when it points at a directory', async () => {
    const unlinked: string[] = [];
    const { fs } = await connected(
      fakeSession({
        lstat: async () => link(),
        stat: async () => directory(),
        unlink: async (path: string) => void unlinked.push(path),
      }),
    );

    await fs.delete(RemotePath.parse('/current'));
    expect(unlinked).toEqual(['/home/omnifs/current']);
  });

  it('removes an empty directory', async () => {
    const removed: string[] = [];
    const { fs } = await connected(
      fakeSession({
        lstat: async () => directory(),
        rmdir: async (path: string) => void removed.push(path),
      }),
    );

    await fs.delete(RemotePath.parse('/empty'));
    expect(removed).toEqual(['/home/omnifs/empty']);
  });

  it('refuses to remove a directory that still has children', async () => {
    const { fs } = await connected(
      fakeSession({
        lstat: async () => directory(),
        rmdir: async () => {
          throw failure();
        },
      }),
    );

    await expect(fs.delete(RemotePath.parse('/full'))).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'NotEmpty',
    );
  });

  it('walks a tree depth-first when asked to be recursive', async () => {
    const order: string[] = [];
    const tree: Record<string, { filename: string; attrs: SftpAttrs }[]> = {
      '/home/omnifs/tree': [
        { filename: 'one.txt', attrs: file() },
        { filename: 'nested', attrs: directory() },
      ],
      '/home/omnifs/tree/nested': [{ filename: 'two.txt', attrs: file() }],
    };

    const { fs } = await connected(
      fakeSession({
        lstat: async () => directory(),
        readdir: async (path: string) => tree[path] ?? [],
        unlink: async (path: string) => void order.push(`unlink ${path}`),
        rmdir: async (path: string) => void order.push(`rmdir ${path}`),
      }),
    );

    await fs.delete(RemotePath.parse('/tree'), { recursive: true });
    expect(order).toEqual([
      'unlink /home/omnifs/tree/one.txt',
      'unlink /home/omnifs/tree/nested/two.txt',
      'rmdir /home/omnifs/tree/nested',
      'rmdir /home/omnifs/tree',
    ]);
  });

  it('unlinks a symlink inside a tree rather than deleting what it points at', async () => {
    const order: string[] = [];
    const { fs } = await connected(
      fakeSession({
        lstat: async () => directory(),
        readdir: async (path: string) =>
          path === '/home/omnifs/tree' ? [{ filename: 'current', attrs: link() }] : [],
        stat: async () => directory(),
        unlink: async (path: string) => void order.push(`unlink ${path}`),
        rmdir: async (path: string) => void order.push(`rmdir ${path}`),
      }),
    );

    await fs.delete(RemotePath.parse('/tree'), { recursive: true });
    expect(order).toEqual(['unlink /home/omnifs/tree/current', 'rmdir /home/omnifs/tree']);
  });
});

describe('SftpFileSystem rename', () => {
  function failure(): Error & { code: number } {
    return Object.assign(new Error('Failure'), { code: 4 });
  }

  it('replaces the destination through the POSIX extension when the server has it', async () => {
    const calls: string[] = [];
    const { fs } = await connected(
      fakeSession(
        { posixRename: async (from: string, to: string) => void calls.push(`${from} -> ${to}`) },
        { posixRename: true, fsync: false, copyData: false },
      ),
    );

    await fs.rename(RemotePath.parse('/before.txt'), RemotePath.parse('/after.txt'));
    expect(calls).toEqual(['/home/omnifs/before.txt -> /home/omnifs/after.txt']);
  });

  it('removes the destination first on a server without the extension, and says so is not atomic', async () => {
    const order: string[] = [];
    let renames = 0;
    const { fs } = await connected(
      fakeSession({
        rename: async (from: string, to: string) => {
          renames += 1;
          if (renames === 1) throw failure();
          order.push(`rename ${from} -> ${to}`);
        },
        unlink: async (path: string) => void order.push(`unlink ${path}`),
      }),
    );

    await fs.rename(RemotePath.parse('/before.txt'), RemotePath.parse('/after.txt'));
    expect(order).toEqual([
      'unlink /home/omnifs/after.txt',
      'rename /home/omnifs/before.txt -> /home/omnifs/after.txt',
    ]);
  });

  it('reports an occupied destination as AlreadyExists when overwrite is false', async () => {
    const { fs } = await connected(
      fakeSession({
        rename: async () => {
          throw failure();
        },
      }),
    );

    await expect(
      fs.rename(RemotePath.parse('/a.txt'), RemotePath.parse('/b.txt'), { overwrite: false }),
    ).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'AlreadyExists',
    );
  });

  it('never replaces a destination when overwrite is false, even with the extension', async () => {
    let posix = 0;
    const { fs } = await connected(
      fakeSession(
        {
          posixRename: async () => void (posix += 1),
          rename: async () => undefined,
        },
        { posixRename: true, fsync: false, copyData: false },
      ),
    );

    await fs.rename(RemotePath.parse('/a.txt'), RemotePath.parse('/b.txt'), { overwrite: false });
    expect(posix).toBe(0);
  });
});

describe('SftpFileSystem copy', () => {
  function failure(): Error & { code: number } {
    return Object.assign(new Error('Failure'), { code: 4 });
  }

  it('copies on the server when copy-data is there', async () => {
    const calls: string[] = [];
    const { fs } = await connected(
      fakeSession(
        {
          copyData: async (from: string, to: string, flags: string) =>
            void calls.push(`${from} -> ${to} (${flags})`),
        },
        { posixRename: false, fsync: false, copyData: true },
      ),
    );

    await fs.copy(RemotePath.parse('/source.txt'), RemotePath.parse('/copy.txt'));
    expect(calls).toEqual(['/home/omnifs/source.txt -> /home/omnifs/copy.txt (w)']);
  });

  it('reports an occupied destination as AlreadyExists', async () => {
    const { fs } = await connected(
      fakeSession(
        {
          copyData: async () => {
            throw failure();
          },
        },
        { posixRename: false, fsync: false, copyData: true },
      ),
    );

    await expect(
      fs.copy(RemotePath.parse('/a.txt'), RemotePath.parse('/b.txt'), { overwrite: false }),
    ).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'AlreadyExists',
    );
  });

  it('passes the session Unsupported through on a server without the extension', async () => {
    const { fs } = await connected(
      fakeSession({
        copyData: async () => {
          throw OmniFsError.unsupported('server-side copy', 'sftp');
        },
      }),
    );

    await expect(fs.copy(RemotePath.parse('/a.txt'), RemotePath.parse('/b.txt'))).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Unsupported',
    );
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @omni-fs/provider-sftp exec vitest run src/sftp-file-system.test.ts`
Expected: FAIL — `fs.delete is not a function`.

- [ ] **Step 3: Implement the three mutations**

Add to `SftpFileSystem`, after `createDirectory`, extending the type imports with `DeleteOptions` and `OverwriteOptions` from `@omni-fs/core`:

```ts
  /**
   * `unlink` for anything that is not a directory, `rmdir` for an empty one, and
   * a walk when the caller asked for recursion.
   *
   * The type comes from `lstat`, not `stat`: a symlink — even one pointing at a
   * directory — is unlinked, which is what `rm` does and the only answer that
   * cannot destroy something outside the tree.
   *
   * A non-recursive delete of a non-empty directory is status 4 from `rmdir`,
   * narrowed here to `NotEmpty`. Without that narrowing a caller who asked to
   * remove an empty directory could not tell "not empty" from any other refusal.
   */
  async delete(path: RemotePath, options?: DeleteOptions): Promise<void> {
    const session = this.#requireSession();
    const signal = options?.signal;
    const attrs = await this.#run(() => session.lstat(this.#remote(path), signal), path);

    if (toFileType(attrs.mode) !== 'directory') {
      await this.#run(() => session.unlink(this.#remote(path), signal), path);
      return;
    }

    if (options?.recursive === true) {
      await this.#deleteTree(session, path, signal);
      return;
    }

    try {
      await session.rmdir(this.#remote(path), signal);
    } catch (error) {
      if (!isFailure(error)) throw toOmniFsError(error, path.value);
      throw new OmniFsError({
        code: 'NotEmpty',
        message: `Directory is not empty: ${path.value}`,
        path: path.value,
        providerId: 'sftp',
        cause: error,
      });
    }
  }

  /**
   * Depth-first, children before their parent, because `SSH_FXP_RMDIR` only
   * removes an empty directory.
   *
   * `readdir` deliberately, not `list`: `list` resolves symlinks, and a recursive
   * delete that followed one would delete the link's *target* — a file outside
   * the tree the caller asked to remove.
   */
  async #deleteTree(
    session: SftpConnection,
    path: RemotePath,
    signal?: AbortSignal,
  ): Promise<void> {
    const entries = (
      await this.#run(() => session.readdir(this.#remote(path), signal), path)
    ).filter((entry) => entry.filename !== '.' && entry.filename !== '..');

    for (const entry of entries) {
      const child = path.join(entry.filename);
      if (toFileType(entry.attrs.mode) === 'directory') {
        await this.#deleteTree(session, child, signal);
      } else {
        await this.#run(() => session.unlink(this.#remote(child), signal), child);
      }
    }

    await this.#run(() => session.rmdir(this.#remote(path), signal), path);
  }

  /**
   * A real server-side rename: no read-back, no re-upload.
   *
   * With `overwrite: false`, plain `SSH_FXP_RENAME` is exactly right — it fails
   * when the destination exists, and status 4 then means `AlreadyExists`.
   * Overwriting needs `posix-rename@openssh.com`, which replaces atomically. On a
   * server without it the destination has to be unlinked first, which is a race
   * — a reader in between sees nothing at `to` — so it is logged as the
   * non-atomic fallback it is rather than presented as a rename.
   */
  async rename(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void> {
    const session = this.#requireSession();
    const signal = options?.signal;

    if (options?.overwrite === false) {
      try {
        await session.rename(this.#remote(from), this.#remote(to), signal);
      } catch (error) {
        if (!isFailure(error)) throw toOmniFsError(error, from.value);
        throw OmniFsError.alreadyExists(to.value, error);
      }
      return;
    }

    if (session.extensions.posixRename) {
      await this.#run(
        () => session.posixRename(this.#remote(from), this.#remote(to), signal),
        from,
      );
      return;
    }

    try {
      await session.rename(this.#remote(from), this.#remote(to), signal);
    } catch (error) {
      if (!isFailure(error)) throw toOmniFsError(error, from.value);
      this.#logger.log(
        'warn',
        'Replacing a rename destination without posix-rename, which is not atomic',
        { from: from.value, to: to.value },
      );
      await this.#run(() => session.unlink(this.#remote(to), signal), to);
      await this.#run(() => session.rename(this.#remote(from), this.#remote(to), signal), from);
    }
  }

  /**
   * `copy-data`, the server-side copy the `canCopyServerSide` getter promises
   * when the server announced the extension. The session raises `Unsupported`
   * when it did not, and `ManagedFileSystem` streams the copy instead because it
   * checks the same flag before calling this.
   */
  async copy(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void> {
    const session = this.#requireSession();
    const flags: SftpWriteFlags = options?.overwrite === false ? 'wx' : 'w';

    try {
      await session.copyData(this.#remote(from), this.#remote(to), flags, options?.signal);
    } catch (error) {
      if (flags === 'wx' && isFailure(error)) throw OmniFsError.alreadyExists(to.value, error);
      throw toOmniFsError(error, from.value);
    }
  }
```

- [ ] **Step 4: Say what the capability has always meant**

In `packages/core/src/capabilities.ts`, replace:

```ts
  /** Recursive delete in one call, rather than walk-and-delete by the client. */
  readonly canDeleteRecursive: boolean;
```

with:

```ts
  /**
   * Whether the provider handles `recursive: true` on `delete` itself, rather
   * than leaving `ManagedFileSystem` to walk the tree and delete leaf by leaf.
   *
   * It is not a promise of one server call, and never was: `provider-s3`
   * enumerates the prefix and deletes in batches, and `provider-sftp` walks with
   * `readdir` and `unlink`, because neither protocol has a recursive remove. What
   * true promises is that asking this provider to delete a tree works — which is
   * the only thing its one reader asks (`fs/managed-file-system.ts`).
   */
  readonly canDeleteRecursive: boolean;
```

- [ ] **Step 5: Run everything**

Run: `pnpm build && pnpm --filter @omni-fs/provider-sftp test`
Expected: PASS.

Run: `pnpm test && pnpm lint && pnpm typecheck`
Expected: PASS. The comment change in core is a comment, so nothing else moves.

- [ ] **Step 6: Commit**

```bash
pnpm exec prettier --write packages/provider-sftp/src packages/core/src/capabilities.ts
git add packages/provider-sftp/src packages/core/src/capabilities.ts
git commit -m ":sparkles: feat implement sftp delete, mkdir, rename and server-side copy"
```

---

### Task 11: Turn on the shared conformance suite against the live server

**Files:**

- Create: `packages/provider-sftp/src/sftp.live.test.ts`
- Modify: `docker/README.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: everything above.
- Produces: nothing importable. `pnpm test:conformance` now covers SFTP as well as WebDAV, which is what says this provider is finished.

Requires the stack: `docker compose up -d`. The seeded tree lives in the `sftp-data` volume mounted at `/data` and owned by uid 1000, which is why the live connection uses `rootPrefix: '/data'` — and that choice also exercises the absolute-prefix rule, the one thing this provider's `readSettings` does differently from every other.

- [ ] **Step 1: Write the live test**

Create `packages/provider-sftp/src/sftp.live.test.ts`:

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOOP_LOGGER, OmniFsError, RemotePath } from '@omni-fs/core';
import type { ConnectionConfig, RemoteFileSystem } from '@omni-fs/core';
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

function connect(settings: Readonly<Record<string, unknown>> = {}): SftpFileSystem {
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
    logger: NOOP_LOGGER,
  });
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
 * Removes an absolute server path, through the transport rather than through
 * `fs.delete`: a cleanup that ran through a method under test could not fail
 * safely, and one failure leaves a `conformance-*` directory behind for every
 * run after it.
 */
async function remove(absolute: string): Promise<void> {
  const transport = await session();
  try {
    await removeTree(transport, absolute);
  } finally {
    await transport.close();
  }
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
    if (root !== undefined) await remove(`${ROOT_PREFIX}${root.value}`);
    await fs[Symbol.asyncDispose]();
  },
});

describe('SFTP root prefix, against the live server', () => {
  it('starts at the login directory when no prefix is set', async () => {
    const fs = connect({ rootPrefix: '' });
    try {
      await fs.connect();
      // The login directory is the account's home, which exists and is a
      // directory — that it resolves at all is what `realpath('.')` is for.
      expect((await fs.stat(RemotePath.ROOT)).type).toBe('directory');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('puts a relative prefix below the login directory', async () => {
    const name = `relative-${String(Date.now())}`;
    const transport = await session();
    const home = await transport.realpath('.');
    await transport.mkdir(`${home}/${name}`);
    await transport.close();

    const fs = connect({ rootPrefix: name });
    try {
      await fs.connect();
      await fs.writeFile(RemotePath.parse('/inside.txt'), encode('below home'));

      const check = await session();
      try {
        expect((await check.stat(`${home}/${name}/inside.txt`)).size).toBe('below home'.length);
      } finally {
        await check.close();
      }
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
    const fs = connect();
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
    const fs = connect({ knownHostsPath: join(dir, 'known_hosts') });
    try {
      await fs.connect();
      expect(fs.isAlive()).toBe(true);
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
```

- [ ] **Step 2: Start the stack and run the suite**

Run: `docker compose up -d && docker compose ps`
Expected: `minio`, `sftp`, `ftp`, `webdav` up; `file-seed` and `minio-init` exited 0.

Run: `pnpm build && pnpm --filter @omni-fs/provider-sftp test:conformance`
Expected: PASS — the conformance suite's cases plus the seven live cases above. The two `ifMatch` cases report as skipped, because `hasVersionTokens` is false.

If the copy-data case fails with `Unsupported`, check the server's OpenSSH version (`docker compose exec sftp sshd -V`): the extension needs 9.0 or newer, and `docker/sftp` pins Alpine 3.20, which ships 9.7.

- [ ] **Step 3: Run the whole conformance target and the hermetic suite**

Run: `pnpm test:conformance`
Expected: PASS for both `provider-webdav` and `provider-sftp`.

Run: `pnpm test`
Expected: PASS, and unchanged in duration — the live file is excluded by `vitest.config.ts`, so this must not need Docker. Verify that claim once with `docker compose down` and `pnpm test`, then bring the stack back up.

- [ ] **Step 4: Update docker/README.md**

In the "What you can actually test today" section, replace the paragraph naming SFTP as unimplemented so it reads:

```markdown
`provider-s3`, `provider-webdav` and `provider-sftp` are implemented. FTP still
throws `Unsupported` from `connect()`, so **Test Connection will fail for it**
with "… is not implemented yet". That is the correct result, and it is still
worth running: it exercises the probe path, the error mapping and the form's
error display. Browsing files works on S3, WebDAV and SFTP.

The FTP server is here so that provider can be written against something real.
```

In the "Conformance suite" section, replace the sentence about which packages define the script:

```markdown
`packages/provider-webdav` and `packages/provider-sftp` define the script today,
so WebDAV and SFTP are what runs. A provider is finished exactly when this
passes for it.
```

In the SFTP table, add the root prefix row so the manual test matches the live tests:

```markdown
| Field          | Value               |
| -------------- | ------------------- |
| Host           | `localhost`         |
| Port           | `2222`              |
| Username       | `omnifs`            |
| Authentication | Password            |
| Password       | `omnifs-dev-secret` |
| Root prefix    | `/data`             |
```

and after that table, add:

```markdown
Files live under `/data`, so the root prefix is absolute — the one provider where
that form is the common one. Leave it empty and the connection starts in the
account's home directory instead, which is empty on this image.

Host keys: the provider reads `~/.ssh/known_hosts` and refuses a host listed
there with a different key. `localhost:2222` is normally absent, so the first
connection is accepted and its fingerprint logged. If you have an old entry for
that port from another project, delete it or point `known_hosts file` at
somewhere else.
```

- [ ] **Step 5: Update README.md**

In the "Supported storage" table, change the SFTP row:

```markdown
| **SFTP (SSH)** | ✅ Implemented | Password, private key, SSH agent |
```

In the roadmap, tick the SFTP line:

```markdown
- [x] SFTP provider
```

- [ ] **Step 6: Check the formatting CI enforces**

Run: `pnpm exec prettier --write packages/provider-sftp/src docker/README.md README.md`
Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/provider-sftp/src docker/README.md README.md
git commit -m ":white_check_mark: test run the shared conformance suite against the live sftp server"
```

---

## Done when

- `pnpm test` passes with no Docker running.
- `docker compose up -d && pnpm test:conformance` passes for both WebDAV and SFTP.
- `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check` pass.
- `packages/provider-sftp/src/index.ts` is a `ProviderDefinition` and re-exports, with no `notImplemented`.
- Every capability `SFTP_CAPABILITIES` declares has a method behind it, and `canCopyServerSide` is the only one answered per connection.
