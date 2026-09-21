# FTP / FTPS Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@omni-fs/provider-ftp` a real provider that passes the shared conformance suite against a live server in plain FTP, explicit FTPS and implicit FTPS, with a per-connection pool of control channels and a configurable TLS floor, and put the live suite for all four providers into CI.

**Architecture:** Three layers inside the package. `ftp-channel.ts` owns one logged-in `basic-ftp` `Client` — TLS option assembly, login, `FEAT`, the abort race, and the promise API the rest of the package sees (`FtpChannel`). `ftp-pool.ts` decides which channels exist: lease, release, poison, and shrink on `421`. `ftp-file-system.ts` implements `RemoteFileSystem` over leases and contains no `basic-ftp` types at all, so the hermetic tests substitute a fake channel rather than a network library.

**Tech Stack:** `basic-ftp@^6.2.1` (already declared, TypeScript-native, no `@types` package), `node:stream` for the Node↔web stream bridges, vitest, and the compose stack in `compose.yaml` (`docker/ftp`, vsftpd on Alpine, three listeners on `127.0.0.1:2121`, `:2990` and `:2100`).

**Spec:** `docs/superpowers/specs/2026-09-21-provider-ftp-design.md`. It carries the ten rulings this plan implements and the reasoning behind each; read it before Task 1. The binding contracts are `packages/core/src/provider.ts`, `packages/core/src/capabilities.ts` and `packages/testing/src/conformance.ts`. `packages/provider-sftp` is the reference implementation to follow in shape — it is the other stateful, connection-oriented provider, and this package deliberately mirrors its file layout.

## Global Constraints

- Nothing in `packages/` may import `vscode` or `electron`. Nothing in `packages/core` may import a protocol SDK. Enforced by `eslint.config.mjs` and a CI grep job. `basic-ftp` is fine in this package; it is banned in core.
- Providers throw `OmniFsError` and nothing else. Translate native errors in this package's own `errors.ts`.
- Providers never cache. Caching is `ManagedFileSystem`'s job, above this interface.
- Declare capabilities honestly. Do not implement an optional method while declaring its capability false, or the reverse — with the one documented exception this plan introduces in Task 6, where `maxConcurrency` is answered per connection.
- Accept an `AbortSignal` on every method that touches the network.
- TypeScript is held at 6.0.x; `@types/node` at 22. Strictness includes `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules` and `module: Node16` — so relative imports carry a `.js` extension, optional properties are written `| undefined`, and `import type` is required for type-only imports.
- `.npmrc` sets `hoist=false`: a package may only import what its own `package.json` declares.
- Commits are a single title line, `:emoji: <type> <description>`, no body. Never add `Co-Authored-By`, `Generated with Claude Code`, or any session attribution. CI enforces both the title pattern and the empty body.
- Never run `pnpm format`. Run `pnpm exec prettier --write <files you touched>` instead.
- After changing a `packages/*` source file, run `pnpm build` before any typecheck of a dependent — packages resolve each other through `dist/`, not source.
- `pnpm test` must stay hermetic: no test outside `*.live.test.ts` may need Docker or a network.
- The provider id is `'ftp'` everywhere: in `OmniFsError.providerId`, in `ProviderDefinition.id`, and in log messages.

---

## File Structure

| File                                                          | Responsibility                                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/provider-ftp/package.json` (modify)                 | `test` becomes `vitest run`; `test:conformance` added                                                                        |
| `packages/provider-ftp/vitest.config.ts` (create)             | default run excludes `*.live.test.ts` and `dist/**`                                                                          |
| `packages/provider-ftp/vitest.conformance.config.ts` (create) | includes only `*.live.test.ts`, 30s timeouts                                                                                 |
| `src/settings.ts` (create)                                    | `FTP_SETTINGS_SCHEMA`, `FTP_SECRET_SCHEMA`, `FtpSettings`, `readSettings()`                                                  |
| `src/errors.ts` (create)                                      | `toOmniFsError()`, `isReplyCode()`, `isConnectionLimit()`                                                                    |
| `src/ftp-helpers.ts` (create)                                 | pure: `toFileType()`, `toFileStat()`, `toDirEntry()`, `resolveBase()`, `joinRemote()`, `buildRange()`, `parseMlstResponse()` |
| `src/ftp-channel.ts` (create)                                 | `FtpEntry`, `FtpChannel`, `FtpClientLike`, `buildAccessOptions()`, `OpenChannel`, the abort race, poisoning                  |
| `src/ftp-pool.ts` (create)                                    | `FtpPool`: `acquire`/`release`/`lease`, lazy growth, `421` shrink, dispose                                                   |
| `src/ftp-file-system.ts` (create)                             | `FTP_CAPABILITIES`, `FtpFileSystem implements RemoteFileSystem`                                                              |
| `src/index.ts` (rewrite)                                      | `ftpProvider: ProviderDefinition` plus re-exports, ~25 lines                                                                 |
| `src/settings.test.ts` (create)                               | schema and `readSettings`, including the leading-slash rule and the numeric bounds                                           |
| `src/errors.test.ts` (create)                                 | reply-code mapping, TLS branches, call-site narrowing                                                                        |
| `src/ftp-helpers.test.ts` (create)                            | `MLST` facts, listing conversion, base resolution, range arithmetic                                                          |
| `src/ftp-channel.test.ts` (create)                            | `buildAccessOptions` for every mode, and the channel against a fake `FtpClientLike`                                          |
| `src/ftp-pool.test.ts` (create)                               | lease/release, lazy growth, dead-on-acquire replacement, poisoning, `421` shrink                                             |
| `src/ftp-file-system.test.ts` (create)                        | the provider against a fake channel                                                                                          |
| `src/ftp.live.test.ts` (create)                               | `runConformanceSuite()` four times, plus the cases only a real server can show                                               |
| `docker/ftp/Dockerfile` (create)                              | Alpine + vsftpd, three listeners, self-signed cert                                                                           |
| `docker/ftp/entrypoint.sh` (create)                           | starts implicit and legacy in the background, `exec`s explicit                                                               |
| `compose.yaml` (modify)                                       | the `ftp` service becomes `build: ./docker/ftp` with three published ports                                                   |
| `.github/workflows/ci.yml` (modify)                           | the `conformance-live` job                                                                                                   |
| `packages/core/src/capabilities.ts` (modify)                  | the `maxConcurrency` comment stops saying FTP is "typically 1"                                                               |
| `docker/README.md`, `README.md`, `CLAUDE.md` (modify)         | FTP moves from skeleton to implemented                                                                                       |

Live tests are named `*.live.test.ts` so `pnpm test` stays hermetic while `pnpm test:conformance` runs exactly those, matching the other three providers.

**Dependency order.** Tasks 1–3 are pure modules with no dependencies on each other beyond imports. Task 4 needs 1–3. Task 5 needs 4. Tasks 6–9 need 5 and build the filesystem incrementally — each one adds methods and its own tests, and the file compiles and passes at the end of every task. Task 10 makes the package's public surface real. Task 11 builds the server. Task 12 turns on the live suite and CI, and is the only task that needs Docker.

---

### Task 1: Test wiring and the settings module

The package currently has no vitest config and a `test` script that passes with no tests. Both change here, together with the first real module, because a test config with nothing to run is not independently reviewable.

**Files:**

- Modify: `packages/provider-ftp/package.json`
- Create: `packages/provider-ftp/vitest.config.ts`
- Create: `packages/provider-ftp/vitest.conformance.config.ts`
- Create: `packages/provider-ftp/src/settings.ts`
- Test: `packages/provider-ftp/src/settings.test.ts`

**Interfaces:**

- Consumes: `OmniFsError`, `SettingsSchema`, `trimLeadingSlashes`, `trimTrailingSlashes` from `@omni-fs/core`.
- Produces:
  - `FTP_SETTINGS_SCHEMA: SettingsSchema`, `FTP_SECRET_SCHEMA: SettingsSchema`
  - `type FtpSecureMode = 'explicit' | 'implicit' | 'none'`
  - `type FtpTlsMinVersion = 'auto' | 'TLSv1.3' | 'TLSv1.2' | 'TLSv1.1' | 'TLSv1'`
  - `interface FtpSettings { host: string; port: number; username: string; secure: FtpSecureMode; allowSelfSigned: boolean; tlsMinVersion: FtpTlsMinVersion; maxConnections: number; rootPrefix: string }`
  - `readSettings(raw: Readonly<Record<string, unknown>>): FtpSettings`

- [ ] **Step 1: Point the package at vitest**

Edit `packages/provider-ftp/package.json`. Replace the `test` script and add `test:conformance`, so the two scripts read:

```json
    "test": "vitest run",
    "test:conformance": "vitest run --config vitest.conformance.config.ts",
```

Leave `dependencies` and `devDependencies` alone: `basic-ftp@^6.2.1`, `@omni-fs/core`, `@omni-fs/testing` and `vitest` are already declared, and this phase adds no dependency.

- [ ] **Step 2: Add the two vitest configs**

Create `packages/provider-ftp/vitest.config.ts`:

```ts
import { configDefaults, defineConfig } from 'vitest/config';

// Live tests need the compose stack, so the default run excludes them and
// `pnpm test` stays hermetic. `dist/**` is named as well because vitest's
// defaults do not cover it and the packages emit there.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '**/dist/**', '**/*.live.test.ts'] },
});
```

Create `packages/provider-ftp/vitest.conformance.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.live.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
});
```

- [ ] **Step 3: Write the failing settings test**

Create `packages/provider-ftp/src/settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { OmniFsError } from '@omni-fs/core';
import { FTP_SETTINGS_SCHEMA, readSettings } from './settings.js';

const base = { host: 'ftp.example.com', username: 'alice' };

describe('FTP_SETTINGS_SCHEMA', () => {
  it('offers the three encryption modes, defaulting to explicit', () => {
    const field = FTP_SETTINGS_SCHEMA.fields.find((f) => f.key === 'secure');
    expect(field).toMatchObject({ kind: 'select', default: 'explicit' });
    const values =
      field?.kind === 'select' ? field.options.map((option) => option.value) : undefined;
    expect(values).toEqual(['explicit', 'implicit', 'none']);
  });

  it('offers a TLS floor that defaults to auto', () => {
    const field = FTP_SETTINGS_SCHEMA.fields.find((f) => f.key === 'tlsMinVersion');
    expect(field).toMatchObject({ kind: 'select', default: 'auto' });
    const values =
      field?.kind === 'select' ? field.options.map((option) => option.value) : undefined;
    expect(values).toEqual(['auto', 'TLSv1.3', 'TLSv1.2', 'TLSv1.1', 'TLSv1']);
  });

  it('says in the help text that a low TLS floor also relaxes the cipher policy', () => {
    // The coupling is the whole reason the setting works rather than merely
    // existing (spec decision 8). A user who is not told will report the
    // weakened crypto as a bug, or worse, never learn of it.
    const field = FTP_SETTINGS_SCHEMA.fields.find((f) => f.key === 'tlsMinVersion');
    expect(field?.kind === 'select' ? field.help : undefined).toMatch(/cipher/i);
  });

  it('bounds the connection count at 8, which is more than any shared host allows', () => {
    const field = FTP_SETTINGS_SCHEMA.fields.find((f) => f.key === 'maxConnections');
    expect(field).toMatchObject({ kind: 'number', default: 1, min: 1, max: 8 });
  });
});

describe('readSettings', () => {
  it('defaults the port, the mode, the TLS floor and the pool size', () => {
    const settings = readSettings(base);
    expect(settings).toMatchObject({
      port: 21,
      secure: 'explicit',
      tlsMinVersion: 'auto',
      maxConnections: 1,
      allowSelfSigned: false,
      rootPrefix: '',
    });
  });

  it('keeps a leading slash on rootPrefix, as provider-sftp does and the other two do not', () => {
    expect(readSettings({ ...base, rootPrefix: '/srv/ftp/shared' }).rootPrefix).toBe(
      '/srv/ftp/shared',
    );
  });

  it('keeps a relative rootPrefix relative', () => {
    expect(readSettings({ ...base, rootPrefix: 'public_html' }).rootPrefix).toBe('public_html');
  });

  it('strips trailing slashes and collapses a repeated leading slash', () => {
    expect(readSettings({ ...base, rootPrefix: '//srv/ftp/' }).rootPrefix).toBe('/srv/ftp');
  });

  it('keeps a lone slash, which is the server filesystem root and not the login directory', () => {
    expect(readSettings({ ...base, rootPrefix: '/' }).rootPrefix).toBe('/');
  });

  it('rejects a missing host', () => {
    expect(() => readSettings({ username: 'alice' })).toThrowError(OmniFsError);
  });

  it('rejects a missing username', () => {
    expect(() => readSettings({ host: 'ftp.example.com' })).toThrowError(OmniFsError);
  });

  it('rejects an unknown encryption mode', () => {
    expect(() => readSettings({ ...base, secure: 'sometimes' })).toThrowError(/sometimes/);
  });

  it('rejects an unknown TLS floor', () => {
    expect(() => readSettings({ ...base, tlsMinVersion: 'SSLv3' })).toThrowError(/SSLv3/);
  });

  it('rejects a port outside the valid range', () => {
    expect(() => readSettings({ ...base, port: 0 })).toThrowError(/port/i);
    expect(() => readSettings({ ...base, port: 70000 })).toThrowError(/port/i);
  });

  it('rejects a pool size outside 1 to 8', () => {
    expect(() => readSettings({ ...base, maxConnections: 0 })).toThrowError(/connection/i);
    expect(() => readSettings({ ...base, maxConnections: 9 })).toThrowError(/connection/i);
  });

  it('raises ProtocolError, so a typo is caught here and not reported in the server words', () => {
    try {
      readSettings({ username: 'alice' });
      expect.unreachable('readSettings should have thrown');
    } catch (error) {
      expect(OmniFsError.is(error) && error.code).toBe('ProtocolError');
      expect(OmniFsError.is(error) && error.providerId).toBe('ftp');
    }
  });

  it('reads allowSelfSigned as a boolean', () => {
    expect(readSettings({ ...base, allowSelfSigned: true }).allowSelfSigned).toBe(true);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @omni-fs/provider-ftp exec vitest run src/settings.test.ts`
Expected: FAIL — `Failed to resolve import "./settings.js"`.

- [ ] **Step 5: Write the settings module**

Create `packages/provider-ftp/src/settings.ts`:

```ts
import { OmniFsError, trimLeadingSlashes, trimTrailingSlashes } from '@omni-fs/core';
import type { SettingsSchema } from '@omni-fs/core';

export const FTP_SETTINGS_SCHEMA: SettingsSchema = {
  fields: [
    { kind: 'text', key: 'host', label: 'Host', required: true, placeholder: 'ftp.example.com' },
    { kind: 'number', key: 'port', label: 'Port', default: 21, min: 1, max: 65535 },
    { kind: 'text', key: 'username', label: 'Username', required: true, placeholder: 'anonymous' },
    {
      kind: 'select',
      key: 'secure',
      label: 'Encryption',
      required: true,
      default: 'explicit',
      options: [
        { value: 'explicit', label: 'FTPS — explicit TLS (AUTH TLS, recommended)' },
        { value: 'implicit', label: 'FTPS — implicit TLS (port 990)' },
        { value: 'none', label: 'Plain FTP — unencrypted' },
      ],
    },
    {
      kind: 'select',
      key: 'tlsMinVersion',
      label: 'Minimum TLS version',
      default: 'auto',
      options: [
        { value: 'auto', label: 'Automatic (recommended)' },
        { value: 'TLSv1.3', label: 'TLS 1.3' },
        { value: 'TLSv1.2', label: 'TLS 1.2' },
        { value: 'TLSv1.1', label: 'TLS 1.1 — legacy servers only' },
        { value: 'TLSv1', label: 'TLS 1.0 — legacy servers only' },
      ],
      help: 'For reaching an old server, not for hardening a good one. Anything below TLS 1.2 also relaxes the cipher policy, because those servers offer key sizes modern OpenSSL refuses outright. Ignored for plain FTP.',
    },
    {
      kind: 'boolean',
      key: 'allowSelfSigned',
      label: 'Allow self-signed certificates',
      default: false,
      help: 'Disables TLS certificate verification. Only for servers you control.',
    },
    {
      kind: 'number',
      key: 'maxConnections',
      label: 'Maximum connections',
      default: 1,
      min: 1,
      max: 8,
      help: 'FTP carries one command per connection, so browsing waits behind a transfer. Raising this opens more logins; lower it if the server refuses them.',
    },
    {
      kind: 'text',
      key: 'rootPrefix',
      label: 'Root prefix',
      placeholder: 'public_html',
      help: 'Optional. Scopes the connection to a subfolder of the login directory. Begin with / for an absolute server path, e.g. /srv/ftp/shared.',
    },
  ],
};

export const FTP_SECRET_SCHEMA: SettingsSchema = {
  fields: [{ kind: 'password', key: 'password', label: 'Password', required: true }],
};

export type FtpSecureMode = 'explicit' | 'implicit' | 'none';

/** `auto` means Node's own floor, which moves with Node. See spec decision 8. */
export type FtpTlsMinVersion = 'auto' | 'TLSv1.3' | 'TLSv1.2' | 'TLSv1.1' | 'TLSv1';

export interface FtpSettings {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly secure: FtpSecureMode;
  readonly allowSelfSigned: boolean;
  readonly tlsMinVersion: FtpTlsMinVersion;
  /** The pool ceiling, and therefore this connection's `maxConcurrency`. */
  readonly maxConnections: number;
  /**
   * Where the connection starts. `''` is the login directory, `public_html`
   * sits below it, `/srv/ftp/shared` is an absolute server path, and `/` is the
   * server's filesystem root.
   *
   * This and `provider-sftp` are the two `readSettings` in the repo that keep a
   * leading slash. `provider-s3` and `provider-webdav` strip theirs, rightly:
   * the absolute part of their location already lives in the Bucket or Server
   * URL field. Here the server's filesystem root is a real, reachable place
   * that no other setting names, so the slash is load-bearing. Never has a
   * trailing slash.
   */
  readonly rootPrefix: string;
}

const SECURE_MODES: readonly FtpSecureMode[] = ['explicit', 'implicit', 'none'];
const TLS_MIN_VERSIONS: readonly FtpTlsMinVersion[] = [
  'auto',
  'TLSv1.3',
  'TLSv1.2',
  'TLSv1.1',
  'TLSv1',
];

export function readSettings(raw: Readonly<Record<string, unknown>>): FtpSettings {
  const host = readString(raw, 'host');
  if (host === undefined) throw invalid('FTP connection is missing a host.');

  const username = readString(raw, 'username');
  if (username === undefined) throw invalid('FTP connection is missing a username.');

  const secure = readString(raw, 'secure') ?? 'explicit';
  if (!SECURE_MODES.includes(secure as FtpSecureMode)) {
    throw invalid(`Unknown FTP encryption mode: ${secure}`);
  }

  const tlsMinVersion = readString(raw, 'tlsMinVersion') ?? 'auto';
  if (!TLS_MIN_VERSIONS.includes(tlsMinVersion as FtpTlsMinVersion)) {
    throw invalid(`Unknown minimum TLS version: ${tlsMinVersion}`);
  }

  return {
    host,
    username,
    secure: secure as FtpSecureMode,
    tlsMinVersion: tlsMinVersion as FtpTlsMinVersion,
    allowSelfSigned: raw['allowSelfSigned'] === true,
    port: readBoundedInteger(raw, 'port', 21, 1, 65535, 'FTP port'),
    maxConnections: readBoundedInteger(raw, 'maxConnections', 1, 1, 8, 'FTP maximum connections'),
    rootPrefix: normaliseRootPrefix(readString(raw, 'rootPrefix')),
  };
}

/**
 * Trailing slashes go, because `RemotePath` never has one and joining would
 * double it. A repeated leading slash collapses to one: `//srv` and `/srv` name
 * the same directory, and keeping both spellings would make two connections
 * that differ only in a typo look different in logs.
 *
 * A prefix that is nothing but slashes is the exception: it stays `/`, the
 * server's filesystem root. Stripping it to `''` would silently move the
 * connection to the login directory — a different place, which the user already
 * has a way to ask for.
 */
function normaliseRootPrefix(value: string | undefined): string {
  if (value === undefined) return '';
  const trimmed = trimTrailingSlashes(value);
  if (!value.startsWith('/')) return trimmed;
  return trimmed === '' ? '/' : `/${trimLeadingSlashes(trimmed)}`;
}

function readBoundedInteger(
  raw: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  const value = raw[key] === undefined ? fallback : Number(raw[key]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${label} is not between ${min} and ${max}: ${String(raw[key])}`);
  }
  return value;
}

function invalid(message: string): OmniFsError {
  return new OmniFsError({ code: 'ProtocolError', message, providerId: 'ftp' });
}

function readString(raw: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @omni-fs/provider-ftp exec vitest run src/settings.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 7: Lint, format and commit**

```bash
cd /Users/utain/Workspace/omni-fs
pnpm exec prettier --write packages/provider-ftp/package.json packages/provider-ftp/vitest.config.ts packages/provider-ftp/vitest.conformance.config.ts packages/provider-ftp/src/settings.ts packages/provider-ftp/src/settings.test.ts
pnpm lint
git add packages/provider-ftp
git commit -m ":sparkles: feat read and validate the ftp connection settings"
```

---

### Task 2: Error translation

**Files:**

- Create: `packages/provider-ftp/src/errors.ts`
- Test: `packages/provider-ftp/src/errors.test.ts`

**Interfaces:**

- Consumes: `OmniFsError` from `@omni-fs/core`.
- Produces:
  - `toOmniFsError(cause: unknown, path?: string): OmniFsError`
  - `isReplyCode(cause: unknown, ...codes: readonly number[]): boolean`
  - `isConnectionLimit(cause: unknown): boolean`

Everything above this module is written in `OmniFsErrorCode`; nothing above it knows FTP has reply codes. `basic-ftp` throws `FTPError` with the three-digit reply on `.code` as a **number** (`FtpContext.d.ts:26`), while Node's socket and TLS failures put a **string** on the same property — which is why the two are read through separate accessors below.

- [ ] **Step 1: Write the failing test**

Create `packages/provider-ftp/src/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { OmniFsError } from '@omni-fs/core';
import { isConnectionLimit, isReplyCode, toOmniFsError } from './errors.js';

/** Shaped like `basic-ftp`'s FTPError: a numeric reply code on `.code`. */
function reply(code: number, message = 'server said no'): Error {
  return Object.assign(new Error(message), { code });
}

/** Shaped like a Node system or TLS error: a string on `.code`. */
function system(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

describe('toOmniFsError', () => {
  it('passes an OmniFsError through unchanged', () => {
    const original = new OmniFsError({ code: 'NotFound', message: 'gone' });
    expect(toOmniFsError(original)).toBe(original);
  });

  it('stamps the provider id and the path on everything it builds', () => {
    const error = toOmniFsError(reply(550), '/data/missing.txt');
    expect(error.providerId).toBe('ftp');
    expect(error.path).toBe('/data/missing.txt');
  });

  it('reads 550 as NotFound, which is what it means nearly every time', () => {
    expect(toOmniFsError(reply(550)).code).toBe('NotFound');
  });

  it('reads a 550 that says permission denied as PermissionDenied', () => {
    expect(toOmniFsError(reply(550, '550 Permission denied.')).code).toBe('PermissionDenied');
    expect(toOmniFsError(reply(550, 'Access denied')).code).toBe('PermissionDenied');
  });

  it('reads 553 as PermissionDenied', () => {
    expect(toOmniFsError(reply(553)).code).toBe('PermissionDenied');
  });

  it('reads the login refusals as AuthenticationFailed', () => {
    expect(toOmniFsError(reply(530)).code).toBe('AuthenticationFailed');
    expect(toOmniFsError(reply(332)).code).toBe('AuthenticationFailed');
    expect(toOmniFsError(reply(532)).code).toBe('AuthenticationFailed');
  });

  it('reads 421 as a retryable ConnectionFailed', () => {
    const error = toOmniFsError(reply(421, '421 Too many connections'));
    expect(error.code).toBe('ConnectionFailed');
    expect(error.retryable).toBe(true);
  });

  it('reads the data-connection failures as retryable ConnectionFailed', () => {
    for (const code of [425, 426, 450]) {
      const error = toOmniFsError(reply(code));
      expect(error.code, `reply ${code}`).toBe('ConnectionFailed');
      expect(error.retryable, `reply ${code}`).toBe(true);
    }
  });

  it('reads the out-of-space replies as QuotaExceeded', () => {
    expect(toOmniFsError(reply(452)).code).toBe('QuotaExceeded');
    expect(toOmniFsError(reply(552)).code).toBe('QuotaExceeded');
  });

  it('reads a command the server does not know as Unsupported', () => {
    for (const code of [500, 501, 502, 504]) {
      expect(toOmniFsError(reply(code)).code, `reply ${code}`).toBe('Unsupported');
    }
  });

  it('reads socket failures as retryable ConnectionFailed', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH']) {
      const error = toOmniFsError(system(code));
      expect(error.code, code).toBe('ConnectionFailed');
      expect(error.retryable, code).toBe(true);
    }
  });

  it('reads a timeout as a retryable Timeout', () => {
    const error = toOmniFsError(new Error('Timeout (control socket)'));
    expect(error.code).toBe('Timeout');
    expect(error.retryable).toBe(true);
  });

  it('reads an abort as Cancelled', () => {
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(toOmniFsError(aborted).code).toBe('Cancelled');
  });

  it('names the self-signed setting when the certificate is the problem', () => {
    for (const code of [
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ]) {
      const error = toOmniFsError(system(code));
      expect(error.code, code).toBe('ConnectionFailed');
      expect(error.message, code).toMatch(/Allow self-signed certificates/);
    }
  });

  it('does not retry a certificate this client will never accept', () => {
    // Retrying an identical handshake against an identical certificate is pure
    // cost: the answer cannot change until a setting does.
    expect(toOmniFsError(system('DEPTH_ZERO_SELF_SIGNED_CERT')).retryable).toBe(false);
  });

  it('names the TLS floor setting when the protocol version is the problem', () => {
    for (const code of [
      'ERR_SSL_UNSUPPORTED_PROTOCOL',
      'ERR_SSL_WRONG_VERSION_NUMBER',
      'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
    ]) {
      const error = toOmniFsError(system(code));
      expect(error.code, code).toBe('ConnectionFailed');
      expect(error.message, code).toMatch(/Minimum TLS version/);
      expect(error.retryable, code).toBe(false);
    }
  });

  it('reads a security-level refusal as the TLS floor talking, not the certificate', () => {
    // `dh key too small` is OpenSSL's security level, and the security level is
    // exactly what the TLS floor setting moves.
    const error = toOmniFsError(system('EPROTO', 'handshake failure: dh key too small'));
    expect(error.message).toMatch(/Minimum TLS version/);
  });

  it('reads an EPROTO with no protocols available as the TLS floor too', () => {
    const error = toOmniFsError(system('EPROTO', 'no protocols available'));
    expect(error.message).toMatch(/Minimum TLS version/);
  });

  it('falls back to Unknown rather than guessing', () => {
    expect(toOmniFsError(new Error('something else entirely')).code).toBe('Unknown');
  });

  it('survives a thrown non-error', () => {
    expect(toOmniFsError('just a string').code).toBe('Unknown');
  });
});

describe('isReplyCode', () => {
  it('matches the reply code the server sent', () => {
    expect(isReplyCode(reply(550), 550)).toBe(true);
    expect(isReplyCode(reply(550), 521, 550)).toBe(true);
    expect(isReplyCode(reply(553), 550)).toBe(false);
  });

  it('does not confuse a Node error code with a reply code', () => {
    expect(isReplyCode(system('ECONNRESET'), 550)).toBe(false);
  });

  it('sees through an OmniFsError to the reply it was built from', () => {
    // The call sites that narrow a 550 — RMD to NotEmpty, MKD to
    // AlreadyExists — are holding an already-translated error, because the
    // channel translates before anything above it sees the failure.
    const translated = toOmniFsError(reply(550), '/data/full');
    expect(isReplyCode(translated, 550)).toBe(true);
    expect(isReplyCode(translated, 553)).toBe(false);
  });
});

describe('isConnectionLimit', () => {
  it('recognises the 421 that means the server is full', () => {
    expect(isConnectionLimit(reply(421, '421 There are too many connections from your IP'))).toBe(
      true,
    );
    expect(isConnectionLimit(reply(421, '421 Session limit reached'))).toBe(true);
  });

  it('does not treat every 421 as a connection limit', () => {
    // A 421 also means "idle timeout, goodbye", which must reconnect rather
    // than permanently shrink the pool.
    expect(isConnectionLimit(reply(421, '421 Timeout.'))).toBe(false);
  });

  it('is false for anything that is not a 421', () => {
    expect(isConnectionLimit(reply(550))).toBe(false);
    expect(isConnectionLimit(system('ECONNRESET'))).toBe(false);
  });

  it('recognises a connection limit through a translated error', () => {
    // The pool only ever sees translated errors: the channel's open() catches
    // and translates before the pool can look.
    const translated = toOmniFsError(reply(421, '421 Too many connections'));
    expect(isConnectionLimit(translated)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @omni-fs/provider-ftp exec vitest run src/errors.test.ts`
Expected: FAIL — `Failed to resolve import "./errors.js"`.

- [ ] **Step 3: Write the error module**

Create `packages/provider-ftp/src/errors.ts`:

```ts
import { OmniFsError } from '@omni-fs/core';

/**
 * The FTP reply codes this provider classifies. `basic-ftp` puts the
 * three-digit reply on `FTPError.code` as a number (`FtpContext.d.ts:26`).
 */
const AUTH_REPLIES: readonly number[] = [530, 332, 532];
const DATA_CONNECTION_REPLIES: readonly number[] = [425, 426, 450];
const QUOTA_REPLIES: readonly number[] = [452, 552];
const UNSUPPORTED_REPLIES: readonly number[] = [500, 501, 502, 504];

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

const CERTIFICATE_CODES: readonly string[] = [
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
];

const PROTOCOL_VERSION_CODES: readonly string[] = [
  'ERR_SSL_UNSUPPORTED_PROTOCOL',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
  'ERR_SSL_VERSION_TOO_LOW',
];

/**
 * A handshake that failed for a reason the TLS floor setting can fix. OpenSSL 3
 * reports its security level this way, and the security level is precisely what
 * lowering the floor below TLS 1.2 relaxes — so these belong with the version
 * failures rather than with the certificate ones.
 */
const SECURITY_LEVEL_MESSAGE =
  /no protocols available|unsupported protocol|key too small|version too low/i;

const PERMISSION_MESSAGE = /permission denied|access denied|not allowed|forbidden/i;

/**
 * Translates `basic-ftp` and Node failures into the shared vocabulary. This
 * happens here and nowhere else — above this line no code knows that FTP has
 * reply codes.
 *
 * 550 is the ambiguous one, as SFTP status 4 is for `provider-sftp`. Servers
 * answer it for "no such file", for "permission denied", for "directory not
 * empty" and for a plain refusal. Unlike SFTP's status 4 it cannot fall through
 * to `Unknown`: the conformance suite's first case requires a missing path to
 * stat as `NotFound`, and `NotFound` is what 550 means the overwhelming
 * majority of the time. So the default is `NotFound`, and the call sites narrow
 * through `isReplyCode` — `RMD` to `NotEmpty`, `MKD` to `AlreadyExists`.
 */
export function toOmniFsError(cause: unknown, path?: string): OmniFsError {
  if (OmniFsError.is(cause)) return cause;

  const message = cause instanceof Error ? cause.message : String(cause);
  const base = { path, providerId: 'ftp', cause } as const;

  // Built inline rather than through `OmniFsError.notFound`/`.cancelled`:
  // those factories drop `providerId` (and `cancelled` drops `path` and `cause`
  // too), which would break this function's invariant that everything it builds
  // carries both.
  if (errorName(cause) === 'AbortError') {
    return new OmniFsError({
      ...base,
      code: 'Cancelled',
      message: `Cancelled: ${path ?? 'FTP request'}`,
    });
  }

  const system = systemCode(cause);
  if (system !== undefined && CERTIFICATE_CODES.includes(system)) {
    return new OmniFsError({
      ...base,
      code: 'ConnectionFailed',
      retryable: false,
      message: `TLS certificate rejected: ${message}. Tick "Allow self-signed certificates" if this server uses one.`,
    });
  }

  if (
    (system !== undefined && PROTOCOL_VERSION_CODES.includes(system)) ||
    SECURITY_LEVEL_MESSAGE.test(message)
  ) {
    return new OmniFsError({
      ...base,
      code: 'ConnectionFailed',
      retryable: false,
      message: `TLS handshake failed: ${message}. Lower "Minimum TLS version" if this server is an old one.`,
    });
  }

  if (system !== undefined && NETWORK_CODES.includes(system)) {
    return new OmniFsError({ ...base, code: 'ConnectionFailed', message, retryable: true });
  }

  const code = replyCode(cause);
  if (code !== undefined) {
    if (code === 550) {
      return PERMISSION_MESSAGE.test(message)
        ? new OmniFsError({ ...base, code: 'PermissionDenied', message })
        : new OmniFsError({
            ...base,
            code: 'NotFound',
            message: `Not found: ${path ?? 'resource'}`,
          });
    }
    if (code === 553) return new OmniFsError({ ...base, code: 'PermissionDenied', message });
    if (code === 421 || DATA_CONNECTION_REPLIES.includes(code)) {
      return new OmniFsError({ ...base, code: 'ConnectionFailed', message, retryable: true });
    }
    if (AUTH_REPLIES.includes(code)) {
      return new OmniFsError({ ...base, code: 'AuthenticationFailed', message });
    }
    if (QUOTA_REPLIES.includes(code)) {
      return new OmniFsError({ ...base, code: 'QuotaExceeded', message });
    }
    if (UNSUPPORTED_REPLIES.includes(code)) {
      return new OmniFsError({ ...base, code: 'Unsupported', message });
    }
  }

  // `basic-ftp` reports its own inactivity timeout as a message, not a code.
  if (/^timeout/i.test(message)) {
    return new OmniFsError({ ...base, code: 'Timeout', message, retryable: true });
  }

  return new OmniFsError({ ...base, code: 'Unknown', message });
}

/**
 * Whether the server answered one of these reply codes.
 *
 * The same shape as `provider-sftp`'s `isFailure` and `provider-webdav`'s
 * `isPreconditionFailed`, for the same reason: one code, several meanings, and
 * only the caller knows which command it sent.
 */
export function isReplyCode(cause: unknown, ...codes: readonly number[]): boolean {
  const code = replyCode(cause);
  return code !== undefined && codes.includes(code);
}

/**
 * Whether a 421 means "I am full" rather than "you were idle".
 *
 * The difference matters: a connection limit shrinks the pool permanently for
 * this session, while an idle timeout must simply reconnect. Guessing wrong in
 * the second direction would leave a connection stuck at one channel for the
 * rest of its life because it was once left alone for five minutes.
 */
export function isConnectionLimit(cause: unknown): boolean {
  if (!isReplyCode(cause, 421)) return false;
  const message = cause instanceof Error ? cause.message : String(cause);
  return /too many|limit|maximum|full/i.test(message);
}

function errorName(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null) return '';
  const name = (cause as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

function replyCode(cause: unknown): number | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  if (typeof code === 'number') return code;
  // Every call site that narrows a 550 is holding an error this module already
  // translated, whose own `code` is an `OmniFsErrorCode` string and whose
  // `cause` is the original `FTPError`. Unwrapping here is what lets `RMD` and
  // `MKD` ask "was that a 550?" without reaching into `.cause` themselves.
  const inner = (cause as { cause?: unknown }).cause;
  return inner === undefined || inner === cause ? undefined : replyCode(inner);
}

function systemCode(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @omni-fs/provider-ftp exec vitest run src/errors.test.ts`
Expected: PASS, 24 tests.

- [ ] **Step 5: Run the whole package's tests**

Run: `pnpm --filter @omni-fs/provider-ftp test`
Expected: PASS — settings and errors, no live tests picked up.

- [ ] **Step 6: Lint, format and commit**

```bash
cd /Users/utain/Workspace/omni-fs
pnpm exec prettier --write packages/provider-ftp/src/errors.ts packages/provider-ftp/src/errors.test.ts
pnpm lint
git add packages/provider-ftp/src
git commit -m ":sparkles: feat translate ftp reply codes into the shared error vocabulary"
```

---

### Task 3: The pure helpers

Everything in this module is a function of its arguments — no client, no
sockets, no `await`. That is deliberate: `MLST` fact parsing and range
arithmetic are where the fiddly, protocol-shaped mistakes live, and they are
far cheaper to get right against a string than against a server.

**Files:**

- Create: `packages/provider-ftp/src/ftp-helpers.ts`
- Test: `packages/provider-ftp/src/ftp-helpers.test.ts`

**Interfaces:**

- Consumes: `trimTrailingSlashes` from `@omni-fs/core`; the types `DirEntry`, `FileStat`, `FileType`, `ReadOptions`, `RemotePath`.
- Produces:
  - `interface FtpEntry { name: string; type: FileType; size: number; mtime: number | undefined; mode: number | undefined }`
  - `interface FileInfoLike { name: string; type: number; size: number; modifiedAt?: Date | undefined; permissions?: { user: number; group: number; world: number } | undefined }`
  - `interface FtpReadRange { start: number; length?: number | undefined }`
  - `toFileType(raw: number): FileType`
  - `fromFileInfo(info: FileInfoLike): FtpEntry`
  - `toFileStat(entry: FtpEntry): FileStat`
  - `toDirEntry(entry: FtpEntry, parent: RemotePath): DirEntry`
  - `resolveBase(rootPrefix: string, loginDirectory: string): string`
  - `joinRemote(base: string, path: RemotePath): string`
  - `buildRange(options: ReadOptions | undefined): FtpReadRange | 'empty' | undefined`
  - `parseMlstResponse(text: string): FtpEntry | undefined`

`FtpEntry` and `FileInfoLike` live here rather than in `ftp-channel.ts` so the
channel can import both without a cycle. It also means every shape that crosses
the channel boundary is defined in a file with no dependencies.

- [ ] **Step 1: Write the failing test**

Create `packages/provider-ftp/src/ftp-helpers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RemotePath } from '@omni-fs/core';
import {
  buildRange,
  fromFileInfo,
  joinRemote,
  parseMlstResponse,
  resolveBase,
  toDirEntry,
  toFileStat,
  toFileType,
} from './ftp-helpers.js';

describe('toFileType', () => {
  it('maps basic-ftp numbering to the shared vocabulary', () => {
    expect(toFileType(1)).toBe('file');
    expect(toFileType(2)).toBe('directory');
    expect(toFileType(3)).toBe('symlink');
    expect(toFileType(0)).toBe('unknown');
    expect(toFileType(99)).toBe('unknown');
  });
});

describe('fromFileInfo', () => {
  it('carries a modification date through as epoch millis', () => {
    const at = new Date('2026-09-21T12:00:00.000Z');
    const entry = fromFileInfo({ name: 'readme.txt', type: 1, size: 18, modifiedAt: at });
    expect(entry).toMatchObject({ name: 'readme.txt', type: 'file', size: 18 });
    expect(entry.mtime).toBe(at.getTime());
  });

  it('leaves mtime undefined when the listing had no reliable date', () => {
    // Only MLSD guarantees a parseable date. Under LIST the year is implied and
    // the timezone is the server's, so an absent timestamp beats a wrong one.
    expect(fromFileInfo({ name: 'old.txt', type: 1, size: 3 }).mtime).toBeUndefined();
  });

  it('packs unix permissions back into mode bits', () => {
    const entry = fromFileInfo({
      name: 'script.sh',
      type: 1,
      size: 10,
      permissions: { user: 7, group: 5, world: 5 },
    });
    expect(entry.mode).toBe(0o755);
  });

  it('leaves mode undefined on a server that is not unix', () => {
    expect(fromFileInfo({ name: 'a.txt', type: 1, size: 1 }).mode).toBeUndefined();
  });
});

describe('toFileStat and toDirEntry', () => {
  it('does not invent an etag, because FTP has no version token', () => {
    const stat = toFileStat({ name: 'a.txt', type: 'file', size: 4, mtime: 1, mode: undefined });
    expect(stat.etag).toBeUndefined();
  });

  it('places a directory entry under its parent', () => {
    const entry = toDirEntry(
      { name: 'docs', type: 'directory', size: 0, mtime: undefined, mode: undefined },
      RemotePath.parse('/data'),
    );
    expect(entry.name).toBe('docs');
    expect(entry.path.value).toBe('/data/docs');
    expect(entry.type).toBe('directory');
  });
});

describe('resolveBase', () => {
  it('uses the login directory when the prefix is empty', () => {
    expect(resolveBase('', '/home/omnifs')).toBe('/home/omnifs');
  });

  it('puts a relative prefix below the login directory', () => {
    expect(resolveBase('public_html', '/home/omnifs')).toBe('/home/omnifs/public_html');
  });

  it('uses an absolute prefix as it stands', () => {
    expect(resolveBase('/srv/ftp/shared', '/home/omnifs')).toBe('/srv/ftp/shared');
  });

  it('answers the filesystem root for a lone slash', () => {
    expect(resolveBase('/', '/home/omnifs')).toBe('/');
  });

  it('collapses doubled slashes and drops a trailing one', () => {
    expect(resolveBase('docs/', '/home/omnifs/')).toBe('/home/omnifs/docs');
  });
});

describe('joinRemote', () => {
  it('returns the base itself for the connection root', () => {
    expect(joinRemote('/home/omnifs', RemotePath.ROOT)).toBe('/home/omnifs');
  });

  it('concatenates below the base', () => {
    expect(joinRemote('/home/omnifs', RemotePath.parse('/docs/guide.md'))).toBe(
      '/home/omnifs/docs/guide.md',
    );
  });

  it('does not double the slash when the base is the filesystem root', () => {
    expect(joinRemote('/', RemotePath.parse('/docs/guide.md'))).toBe('/docs/guide.md');
  });
});

describe('buildRange', () => {
  it('is undefined when no offset was asked for', () => {
    expect(buildRange(undefined)).toBeUndefined();
    expect(buildRange({})).toBeUndefined();
  });

  it('is an open-ended range when only an offset was given', () => {
    expect(buildRange({ offset: 5 })).toEqual({ start: 5 });
  });

  it('carries the length through, because FTP has no end-of-range on the wire', () => {
    expect(buildRange({ offset: 5, length: 10 })).toEqual({ start: 5, length: 10 });
  });

  it('answers empty for a zero-length range rather than an inverted one', () => {
    // Every range syntax in use is inclusive at both ends, so the arithmetic
    // alone would produce `bytes=5--1`. All four providers reached this case
    // independently; the conformance suite exists so the fifth does not have to.
    expect(buildRange({ offset: 5, length: 0 })).toBe('empty');
    expect(buildRange({ offset: 5, length: -1 })).toBe('empty');
  });
});

describe('parseMlstResponse', () => {
  const response = [
    '250-Listing /data/readme.txt',
    ' type=file;size=18;modify=20260921120000;UNIX.mode=0644; /data/readme.txt',
    '250 End',
  ].join('\n');

  it('reads the facts from the middle line of a multiline reply', () => {
    const entry = parseMlstResponse(response);
    expect(entry).toMatchObject({ name: 'readme.txt', type: 'file', size: 18, mode: 0o644 });
    expect(entry?.mtime).toBe(Date.UTC(2026, 8, 21, 12, 0, 0));
  });

  it('reads a directory', () => {
    const text = ['250-Listing', ' type=dir;size=4096; /data/docs', '250 End'].join('\n');
    expect(parseMlstResponse(text)?.type).toBe('directory');
  });

  it('reads cdir and pdir as directories too', () => {
    expect(parseMlstResponse('250-x\n type=cdir; /data\n250 End')?.type).toBe('directory');
    expect(parseMlstResponse('250-x\n type=pdir; /\n250 End')?.type).toBe('directory');
  });

  it('reads a unix symlink fact as a symlink', () => {
    const text = '250-x\n type=OS.unix=slink:/elsewhere; /data/link\n250 End';
    expect(parseMlstResponse(text)?.type).toBe('symlink');
  });

  it('is case-insensitive about fact names, as RFC 3659 requires', () => {
    const text = '250-x\n Type=File;Size=7; /data/a.txt\n250 End';
    expect(parseMlstResponse(text)).toMatchObject({ type: 'file', size: 7 });
  });

  it('keeps fractional seconds out of the way', () => {
    const text = '250-x\n type=file;size=1;modify=20260921120000.123; /data/a\n250 End';
    expect(parseMlstResponse(text)?.mtime).toBe(Date.UTC(2026, 8, 21, 12, 0, 0, 123));
  });

  it('tolerates a name containing spaces', () => {
    const text = '250-x\n type=file;size=2; /data/my file.txt\n250 End';
    expect(parseMlstResponse(text)?.name).toBe('my file.txt');
  });

  it('returns undefined when there is no fact line to read', () => {
    // The caller falls back to listing the parent, so an unparseable answer
    // costs a round trip rather than the whole stat.
    expect(parseMlstResponse('250 Command okay.')).toBeUndefined();
    expect(parseMlstResponse('')).toBeUndefined();
  });

  it('falls back to a zero size when the size fact is nonsense', () => {
    // The entry is still usable — type and name are what a listing needs — so
    // one bad fact does not cost the whole answer.
    expect(parseMlstResponse('250-x\n type=file;size=lots; /data/a\n250 End')?.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @omni-fs/provider-ftp exec vitest run src/ftp-helpers.test.ts`
Expected: FAIL — `Failed to resolve import "./ftp-helpers.js"`.

- [ ] **Step 3: Write the helpers**

Create `packages/provider-ftp/src/ftp-helpers.ts`:

```ts
import { trimTrailingSlashes } from '@omni-fs/core';
import type { DirEntry, FileStat, FileType, ReadOptions, RemotePath } from '@omni-fs/core';

/**
 * What this provider needs from a listing entry, already translated out of
 * `basic-ftp`'s vocabulary. `mtime` is epoch millis, and `undefined` when the
 * listing format could not be trusted to carry one.
 */
export interface FtpEntry {
  readonly name: string;
  readonly type: FileType;
  readonly size: number;
  readonly mtime: number | undefined;
  readonly mode: number | undefined;
}

/**
 * The part of `basic-ftp`'s `FileInfo` this provider reads. Declared
 * structurally so the helpers stay free of the library and the tests can build
 * one with an object literal.
 */
export interface FileInfoLike {
  readonly name: string;
  readonly type: number;
  readonly size: number;
  readonly modifiedAt?: Date | undefined;
  readonly permissions?:
    { readonly user: number; readonly group: number; readonly world: number } | undefined;
}

/** `length` is enforced by this client: `RETR` has no end position. */
export interface FtpReadRange {
  readonly start: number;
  readonly length?: number | undefined;
}

/** `basic-ftp`'s `FileType` enum, which reaches us as a number on `FileInfo`. */
const FILE_TYPES: Readonly<Record<number, FileType>> = {
  0: 'unknown',
  1: 'file',
  2: 'directory',
  3: 'symlink',
};

export function toFileType(raw: number): FileType {
  return FILE_TYPES[raw] ?? 'unknown';
}

export function fromFileInfo(info: FileInfoLike): FtpEntry {
  return {
    name: info.name,
    type: toFileType(info.type),
    size: info.size,
    // Only MLSD guarantees a date that can be parsed with the right timezone.
    // `basic-ftp` leaves `modifiedAt` unset for LIST formats precisely so a
    // caller does not have to guess, and guessing is what we decline to do.
    mtime: info.modifiedAt?.getTime(),
    mode: toMode(info.permissions),
  };
}

/**
 * `etag` is left unset: FTP has no version token, which is what
 * `hasVersionTokens: false` declares. Synthesising one from size and mtime
 * would make `ifMatch` look atomic when it would be a racy re-stat.
 */
export function toFileStat(entry: FtpEntry): FileStat {
  return { type: entry.type, size: entry.size, mtime: entry.mtime, mode: entry.mode };
}

export function toDirEntry(entry: FtpEntry, parent: RemotePath): DirEntry {
  return { ...toFileStat(entry), name: entry.name, path: parent.join(entry.name) };
}

/**
 * Where this connection starts on the server.
 *
 * An empty prefix is the login directory, an absolute one is itself, and a
 * relative one sits below the login directory. The login directory comes from
 * `PWD` at connect, which is the only way to learn it.
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

/**
 * `ReadOptions` to an FTP range.
 *
 * `start` becomes `REST`. `length` has no wire representation at all — `RETR`
 * runs to end of file — so the channel counts bytes and cuts the transfer,
 * which costs the control channel. See spec decision 6.
 *
 * `'empty'` means the caller asked for no bytes: `{ offset: 5, length: 0 }`
 * would otherwise be indistinguishable from an open-ended read at 5.
 */
export function buildRange(options: ReadOptions | undefined): FtpReadRange | 'empty' | undefined {
  if (options?.offset === undefined) return undefined;
  const start = options.offset;
  if (options.length === undefined) return { start };
  return options.length <= 0 ? 'empty' : { start, length: options.length };
}

/**
 * Reads the fact line out of an `MLST` reply.
 *
 * `basic-ftp` parses MLSD listings but does not re-export the line parser
 * (`parseListMLSD.parseLine` is absent from `dist/index.d.ts`), and reaching
 * into `dist/` for it would pin this package to a private module path. RFC 3659
 * section 7 is a short grammar, so it is parsed here instead.
 *
 * The reply is three lines — `250-`, one space-prefixed fact line, `250 End` —
 * and `parseControlResponse` has already joined them with `\n` and normalised
 * CRLF. Anything unparseable returns `undefined`, and the caller falls back to
 * listing the parent: a slower answer rather than a failed one.
 */
export function parseMlstResponse(text: string): FtpEntry | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/^\s+/, '');
    const space = trimmed.indexOf(' ');
    if (space <= 0) continue;

    const factText = trimmed.slice(0, space);
    if (!factText.includes('=')) continue;

    const pathname = trimmed.slice(space + 1).trim();
    if (pathname === '') continue;

    return toEntry(parseFacts(factText), pathname);
  }
  return undefined;
}

function parseFacts(factText: string): ReadonlyMap<string, string> {
  const facts = new Map<string, string>();
  for (const fact of factText.split(';')) {
    if (fact === '') continue;
    const equals = fact.indexOf('=');
    if (equals <= 0) continue;
    // RFC 3659: fact names are case-insensitive. `UNIX.mode` and `unix.mode`
    // are the same fact, and servers disagree about which to send.
    facts.set(fact.slice(0, equals).toLowerCase(), fact.slice(equals + 1));
  }
  return facts;
}

function toEntry(facts: ReadonlyMap<string, string>, pathname: string): FtpEntry {
  const size = Number(facts.get('size'));
  return {
    name: basename(pathname),
    type: factType(facts.get('type')),
    size: Number.isFinite(size) ? size : 0,
    mtime: parseMlsxDate(facts.get('modify')),
    mode: parseOctal(facts.get('unix.mode')),
  };
}

function factType(value: string | undefined): FileType {
  if (value === undefined) return 'unknown';
  const lowered = value.toLowerCase();
  if (lowered === 'file') return 'file';
  if (lowered === 'dir' || lowered === 'cdir' || lowered === 'pdir') return 'directory';
  // `type=OS.unix=slink:/target` is how a symlink arrives, when it arrives.
  if (lowered.startsWith('os.unix=slink')) return 'symlink';
  return 'unknown';
}

/** `YYYYMMDDHHMMSS[.sss]`, always UTC — RFC 3659 section 2.3. */
function parseMlsxDate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second, fraction] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    fraction === undefined ? 0 : Number(fraction.padEnd(3, '0')),
  );
}

function parseOctal(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 8);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function toMode(permissions: FileInfoLike['permissions']): number | undefined {
  if (permissions === undefined) return undefined;
  return (permissions.user << 6) | (permissions.group << 3) | permissions.world;
}

function basename(pathname: string): string {
  const slash = pathname.lastIndexOf('/');
  return slash === -1 ? pathname : pathname.slice(slash + 1);
}

function normalise(value: string): string {
  const collapsed = trimTrailingSlashes(`/${value}`.replace(/\/+/g, '/'));
  return collapsed === '' ? '/' : collapsed;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @omni-fs/provider-ftp exec vitest run src/ftp-helpers.test.ts`
Expected: PASS, 24 tests.

- [ ] **Step 5: Lint, format and commit**

```bash
cd /Users/utain/Workspace/omni-fs
pnpm exec prettier --write packages/provider-ftp/src/ftp-helpers.ts packages/provider-ftp/src/ftp-helpers.test.ts
pnpm lint
git add packages/provider-ftp/src
git commit -m ":sparkles: feat parse mlst facts and ftp listings into the shared shapes"
```

---

### Task 4: The channel

One logged-in `basic-ftp` `Client`, and the only file in the package that
imports `basic-ftp`. Above it the provider is plain `async` code over the
`FtpChannel` interface, which is what lets the hermetic tests replace one small
interface instead of a network library.

**Files:**

- Create: `packages/provider-ftp/src/ftp-channel.ts`
- Test: `packages/provider-ftp/src/ftp-channel.test.ts`

**Interfaces:**

- Consumes: `FtpSettings`, `FtpTlsMinVersion` from `./settings.js`; `toOmniFsError` from `./errors.js`; `FtpEntry`, `FtpReadRange`, `FileInfoLike`, `fromFileInfo`, `parseMlstResponse` from `./ftp-helpers.js`; `OmniFsError`, `throwIfAborted`, `withCancellation`, `Logger` from `@omni-fs/core`.
- Produces:
  - `interface FtpTransferOptions { signal?: AbortSignal | undefined; onProgress?: ((transferred: number) => void) | undefined }`
  - `interface FtpChannel` — the full method set listed in the code below
  - `interface FtpClientLike` — the structural subset of `basic-ftp`'s `Client` this package uses
  - `interface AccessOptionsLike`
  - `buildAccessOptions(settings: FtpSettings, password: string): AccessOptionsLike`
  - `class FtpControlChannel implements FtpChannel` with `static open(options: FtpChannelOptions): Promise<FtpControlChannel>`
  - `type OpenChannel = (options: FtpChannelOptions) => Promise<FtpChannel>`
  - `interface FtpChannelOptions { settings: FtpSettings; secret: Readonly<Record<string, unknown>>; logger: Logger; signal?: AbortSignal | undefined; createClient?: (() => FtpClientLike) | undefined }`

- [ ] **Step 1: Write the failing test**

Create `packages/provider-ftp/src/ftp-channel.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { Writable, type Readable } from 'node:stream';
import { NOOP_LOGGER, OmniFsError, collectStream } from '@omni-fs/core';
import type { Logger, LogLevel } from '@omni-fs/core';
import { FtpControlChannel, buildAccessOptions } from './ftp-channel.js';
import type { FtpClientLike } from './ftp-channel.js';
import { readSettings } from './settings.js';

const settings = readSettings({ host: 'ftp.example.com', username: 'alice' });

function withSettings(overrides: Readonly<Record<string, unknown>>) {
  return readSettings({ host: 'ftp.example.com', username: 'alice', ...overrides });
}

describe('buildAccessOptions', () => {
  it('asks for explicit TLS by default', () => {
    expect(buildAccessOptions(settings, 'hunter2')).toMatchObject({
      host: 'ftp.example.com',
      port: 21,
      user: 'alice',
      password: 'hunter2',
      secure: true,
    });
  });

  it('asks for implicit TLS when the mode says so', () => {
    expect(buildAccessOptions(withSettings({ secure: 'implicit' }), 'p').secure).toBe('implicit');
  });

  it('leaves TLS off, and carries no TLS options at all, for plain FTP', () => {
    const options = buildAccessOptions(withSettings({ secure: 'none' }), 'p');
    expect(options.secure).toBe(false);
    expect(options.secureOptions).toBeUndefined();
  });

  it('turns certificate verification off only when the user asked', () => {
    expect(buildAccessOptions(settings, 'p').secureOptions?.rejectUnauthorized).toBeUndefined();
    expect(
      buildAccessOptions(withSettings({ allowSelfSigned: true }), 'p').secureOptions
        ?.rejectUnauthorized,
    ).toBe(false);
  });

  it('leaves the TLS floor to Node when the setting is auto', () => {
    // Node's floor moves with Node. Pinning it here would freeze this
    // provider's floor the day Node raises its own.
    expect(buildAccessOptions(settings, 'p').secureOptions?.minVersion).toBeUndefined();
  });

  it('passes a chosen TLS floor through', () => {
    expect(
      buildAccessOptions(withSettings({ tlsMinVersion: 'TLSv1.2' }), 'p').secureOptions?.minVersion,
    ).toBe('TLSv1.2');
  });

  it('relaxes the cipher policy below TLS 1.2, because the version alone is not enough', () => {
    // OpenSSL 3 rejects these servers' small DH parameters whatever protocol
    // version is negotiated, so a version-only knob would be set correctly and
    // still fail. Spec decision 8.
    for (const version of ['TLSv1.1', 'TLSv1']) {
      const options = buildAccessOptions(withSettings({ tlsMinVersion: version }), 'p');
      expect(options.secureOptions?.ciphers, version).toBe('DEFAULT@SECLEVEL=0');
    }
  });

  it('does not relax the cipher policy at TLS 1.2 or above', () => {
    for (const version of ['auto', 'TLSv1.2', 'TLSv1.3']) {
      const options = buildAccessOptions(withSettings({ tlsMinVersion: version }), 'p');
      expect(options.secureOptions?.ciphers, version).toBeUndefined();
    }
  });
});

/**
 * A fake `basic-ftp` Client. Every method records and answers immediately.
 *
 * `FtpClientLike.closed` is readonly — it is a getter on the real class — so
 * the fake is built through a mutable mapped type and handed back as that.
 */
type MutableClient = { -readonly [K in keyof FtpClientLike]: FtpClientLike[K] } & {
  sent: string[];
};

function fakeClient(overrides: Partial<FtpClientLike> = {}): MutableClient {
  const sent: string[] = [];
  const client: MutableClient = {
    sent,
    closed: false,
    close: vi.fn(() => {
      client.closed = true;
    }),
    access: vi.fn(async () => ({ code: 220, message: '220 ready' })),
    features: vi.fn(async () => new Map([['MLST', 'type*;size*;modify*;']])),
    pwd: vi.fn(async () => '/home/alice'),
    send: vi.fn(async (command: string) => {
      sent.push(command);
      return { code: 250, message: '250 ok' };
    }),
    list: vi.fn(async () => []),
    downloadTo: vi.fn(async () => ({ code: 226, message: '226 done' })),
    uploadFrom: vi.fn(async (source: Readable) => {
      source.resume();
      return { code: 226, message: '226 done' };
    }),
    rename: vi.fn(async () => ({ code: 250, message: '250 ok' })),
    remove: vi.fn(async () => ({ code: 250, message: '250 ok' })),
    removeEmptyDir: vi.fn(async () => ({ code: 250, message: '250 ok' })),
    trackProgress: vi.fn(),
    ...overrides,
  };
  return client;
}

async function open(
  client: FtpClientLike,
  overrides: Readonly<Record<string, unknown>> = {},
  logger: Logger = NOOP_LOGGER,
): Promise<FtpControlChannel> {
  return FtpControlChannel.open({
    settings: withSettings(overrides),
    secret: { password: 'hunter2' },
    logger,
    createClient: () => client,
  });
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

describe('FtpControlChannel.open', () => {
  it('logs in and reads the feature list once', async () => {
    const client = fakeClient();
    const channel = await open(client);
    expect(client.access).toHaveBeenCalledOnce();
    expect(client.features).toHaveBeenCalledOnce();
    expect(channel.hasMlst).toBe(true);
    expect(channel.isAlive()).toBe(true);
  });

  it('notices a server without MLST, so stat can fall back', async () => {
    const client = fakeClient({ features: async () => new Map([['UTF8', '']]) });
    expect((await open(client)).hasMlst).toBe(false);
  });

  it('refuses to connect without a password', async () => {
    await expect(
      FtpControlChannel.open({
        settings,
        secret: {},
        logger: NOOP_LOGGER,
        createClient: () => fakeClient(),
      }),
    ).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'AuthenticationFailed',
    );
  });

  it('closes the client when login fails, rather than leaking a socket', async () => {
    const client = fakeClient({
      access: async () => {
        throw Object.assign(new Error('530 Login incorrect'), { code: 530 });
      },
    });
    await expect(open(client)).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'AuthenticationFailed',
    );
    expect(client.close).toHaveBeenCalled();
  });

  it('warns out loud when the cipher policy was relaxed', async () => {
    // Weakened crypto is never silent, even when it is implied by another
    // setting. Same rule as allowSelfSigned.
    const { logger, entries } = capturingLogger();
    await open(fakeClient(), { tlsMinVersion: 'TLSv1' }, logger);
    expect(entries.some((entry) => entry.level === 'warn' && /cipher/i.test(entry.message))).toBe(
      true,
    );
  });

  it('does not warn when the TLS floor is left alone', async () => {
    const { logger, entries } = capturingLogger();
    await open(fakeClient(), {}, logger);
    expect(entries.some((entry) => entry.level === 'warn')).toBe(false);
  });
});

describe('FtpControlChannel requests', () => {
  it('asks the server where it landed', async () => {
    const channel = await open(fakeClient());
    expect(await channel.pwd()).toBe('/home/alice');
  });

  it('reads a stat out of an MLST reply', async () => {
    const client = fakeClient({
      send: async () => ({
        code: 250,
        message: '250-Listing\n type=file;size=18;modify=20260921120000; /data/a.txt\n250 End',
      }),
    });
    const channel = await open(client);
    expect(await channel.mlst('/data/a.txt')).toMatchObject({ type: 'file', size: 18 });
  });

  it('drops the dot entries a listing may include', async () => {
    const client = fakeClient({
      list: async () => [
        { name: '.', type: 2, size: 0 },
        { name: '..', type: 2, size: 0 },
        { name: 'readme.txt', type: 1, size: 18 },
      ],
    });
    const channel = await open(client);
    const entries = await channel.list('/data');
    expect(entries.map((entry) => entry.name)).toEqual(['readme.txt']);
  });

  it('sends MKD for a directory, because ensureDir would move the working directory', async () => {
    // Every command this package sends carries an absolute path, which is what
    // makes a pooled channel interchangeable.
    const client = fakeClient();
    await (await open(client)).mkdir('/data/new');
    expect(client.sent).toContain('MKD /data/new');
  });

  it('translates a server refusal into the shared vocabulary', async () => {
    const client = fakeClient({
      remove: async () => {
        throw Object.assign(new Error('550 No such file'), { code: 550 });
      },
    });
    const channel = await open(client);
    await expect(channel.unlink('/data/gone.txt')).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
    );
  });

  it('refuses immediately on an already-aborted signal, without touching the client', async () => {
    const client = fakeClient();
    const channel = await open(client);
    const controller = new AbortController();
    controller.abort();

    await expect(channel.list('/data', controller.signal)).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled',
    );
    expect(client.list).not.toHaveBeenCalled();
    // Nothing was sent, so nothing is out of step: the channel survives.
    expect(channel.poisoned).toBe(false);
  });

  it('poisons itself when a request is aborted mid-flight', async () => {
    // FTP has no cancel on the wire. Abandoning a command leaves the control
    // channel out of step, so the only honest answer is to throw it away.
    const controller = new AbortController();
    const client = fakeClient({
      list: () =>
        new Promise(() => {
          /* never settles */
        }),
    });
    const channel = await open(client);
    const pending = channel.list('/data', controller.signal);
    controller.abort();

    await expect(pending).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled',
    );
    expect(channel.poisoned).toBe(true);
    expect(channel.isAlive()).toBe(false);
  });

  it('poisons itself when the connection drops', async () => {
    const client = fakeClient({
      pwd: async () => {
        throw Object.assign(new Error('socket gone'), { code: 'ECONNRESET' });
      },
    });
    const channel = await open(client);
    await expect(channel.pwd()).rejects.toThrow();
    expect(channel.poisoned).toBe(true);
  });

  it('survives an ordinary server refusal, which says nothing about the connection', async () => {
    const client = fakeClient({
      removeEmptyDir: async () => {
        throw Object.assign(new Error('550 Directory not empty'), { code: 550 });
      },
    });
    const channel = await open(client);
    await expect(channel.rmdir('/data/full')).rejects.toThrow();
    expect(channel.poisoned).toBe(false);
  });
});

describe('FtpControlChannel transfers', () => {
  /** A fake download that writes `content` into the sink `basic-ftp` was given. */
  function downloading(content: string) {
    return async (destination: Writable, _path: string, startAt = 0) => {
      destination.write(Buffer.from(content.slice(startAt)));
      destination.end();
      return { code: 226, message: '226 done' };
    };
  }

  it('reads a whole file', async () => {
    const client = fakeClient({ downloadTo: downloading('0123456789') });
    const channel = await open(client);
    const stream = await channel.openReadStream('/data/a.txt');
    expect(new TextDecoder().decode(await collectStream(stream))).toBe('0123456789');
    expect(channel.poisoned).toBe(false);
  });

  it('starts at an offset with REST, and keeps the channel', async () => {
    const client = fakeClient({ downloadTo: downloading('0123456789') });
    const channel = await open(client);
    const stream = await channel.openReadStream('/data/a.txt', { start: 4 });
    expect(new TextDecoder().decode(await collectStream(stream))).toBe('456789');
    expect(channel.poisoned).toBe(false);
  });

  it('cuts a bounded range short and poisons the channel', async () => {
    // RETR has no end position. Stopping early leaves the control channel
    // mid-command, and a desynchronised channel is worse than no channel.
    const client = fakeClient({ downloadTo: downloading('0123456789') });
    const channel = await open(client);
    const stream = await channel.openReadStream('/data/a.txt', { start: 2, length: 3 });
    expect(new TextDecoder().decode(await collectStream(stream))).toBe('234');
    expect(channel.poisoned).toBe(true);
  });

  it('surfaces a failed download on the stream, not from the call that made it', async () => {
    const client = fakeClient({
      downloadTo: async () => {
        throw Object.assign(new Error('550 No such file'), { code: 550 });
      },
    });
    const channel = await open(client);
    const stream = await channel.openReadStream('/data/gone.txt');
    await expect(collectStream(stream)).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
    );
  });

  it('uploads a buffer as one readable', async () => {
    const chunks: Buffer[] = [];
    const client = fakeClient({
      uploadFrom: async (source: Readable) => {
        for await (const chunk of source) chunks.push(chunk as Buffer);
        return { code: 226, message: '226 done' };
      },
    });
    const channel = await open(client);
    await channel.upload('/data/a.txt', new TextEncoder().encode('payload'));
    expect(Buffer.concat(chunks).toString()).toBe('payload');
  });

  it('resolves a write stream close only after the server has answered', async () => {
    // A close() that resolves for a transfer the server rejected is the defect
    // this repo has now fixed three times: S3, WebDAV and SFTP.
    let release: (() => void) | undefined;
    const client = fakeClient({
      uploadFrom: async (source: Readable) => {
        source.resume();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { code: 226, message: '226 done' };
      },
    });
    const channel = await open(client);
    const stream = await channel.openWriteStream('/data/a.txt');
    const writer = stream.getWriter();
    await writer.write(new TextEncoder().encode('payload'));

    let closed = false;
    const closing = writer.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);

    release?.();
    await closing;
    expect(closed).toBe(true);
  });

  it('fails a write stream close when the server rejects the transfer', async () => {
    const client = fakeClient({
      uploadFrom: async (source: Readable) => {
        source.resume();
        throw Object.assign(new Error('552 Quota exceeded'), { code: 552 });
      },
    });
    const channel = await open(client);
    const stream = await channel.openWriteStream('/data/a.txt');
    const writer = stream.getWriter();
    await writer.write(new TextEncoder().encode('payload'));
    await expect(writer.close()).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'QuotaExceeded',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @omni-fs/provider-ftp exec vitest run src/ftp-channel.test.ts`
Expected: FAIL — `Failed to resolve import "./ftp-channel.js"`.

- [ ] **Step 3: Write the channel**

Create `packages/provider-ftp/src/ftp-channel.ts`:

```ts
import { PassThrough, Readable, Writable } from 'node:stream';
import { Client } from 'basic-ftp';
import { OmniFsError, throwIfAborted, withCancellation } from '@omni-fs/core';
import type { Logger, OmniFsErrorCode } from '@omni-fs/core';
import { toOmniFsError } from './errors.js';
import { fromFileInfo, parseMlstResponse } from './ftp-helpers.js';
import type { FileInfoLike, FtpEntry, FtpReadRange } from './ftp-helpers.js';
import type { FtpSettings, FtpTlsMinVersion } from './settings.js';

/** Socket inactivity, not total transfer time — `basic-ftp`'s own meaning. */
const CONTROL_TIMEOUT_MS = 30_000;

/**
 * OpenSSL 3 refuses the key sizes and signature algorithms a 2012-era FTPS
 * server offers, whatever protocol version is negotiated. Lowering the floor
 * without this would be a setting the user configures correctly and which still
 * fails. See spec decision 8.
 */
const LEGACY_CIPHERS = 'DEFAULT@SECLEVEL=0';
const RELAXED_VERSIONS: readonly FtpTlsMinVersion[] = ['TLSv1', 'TLSv1.1'];

/**
 * Failures that mean the control channel can no longer be trusted. An ordinary
 * server refusal — a 550, a 553 — says nothing about the connection and leaves
 * it usable, which is the difference that keeps the pool from churning.
 */
const POISONING_CODES: ReadonlySet<OmniFsErrorCode> = new Set([
  'Cancelled',
  'ConnectionFailed',
  'Timeout',
  'ProtocolError',
]);

export interface FtpTransferOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((transferred: number) => void) | undefined;
}

/**
 * One control connection, as the rest of the package sees it.
 *
 * Every path is absolute. No method changes the working directory, which is
 * what makes a pooled channel interchangeable — and why `basic-ftp`'s
 * `ensureDir` and `removeDir`, both built on `CWD`, are not used.
 */
export interface FtpChannel {
  /** Whether the server advertised `MLST` in `FEAT`. Decides how `stat` works. */
  readonly hasMlst: boolean;
  /** Set when the control channel was abandoned mid-command. Never unset. */
  readonly poisoned: boolean;
  isAlive(): boolean;
  poison(): void;
  close(): Promise<void>;

  pwd(signal?: AbortSignal): Promise<string>;
  mlst(path: string, signal?: AbortSignal): Promise<FtpEntry | undefined>;
  list(path: string, signal?: AbortSignal): Promise<readonly FtpEntry[]>;
  mkdir(path: string, signal?: AbortSignal): Promise<void>;
  rmdir(path: string, signal?: AbortSignal): Promise<void>;
  unlink(path: string, signal?: AbortSignal): Promise<void>;
  rename(from: string, to: string, signal?: AbortSignal): Promise<void>;

  openReadStream(
    path: string,
    range?: FtpReadRange,
    options?: FtpTransferOptions,
  ): Promise<ReadableStream<Uint8Array>>;
  upload(path: string, data: Uint8Array, options?: FtpTransferOptions): Promise<void>;
  openWriteStream(path: string, options?: FtpTransferOptions): Promise<WritableStream<Uint8Array>>;
}

/**
 * The part of `basic-ftp`'s `Client` this package uses, declared structurally
 * so the hermetic tests can supply one without a socket. `Client` satisfies it
 * as written.
 */
export interface FtpClientLike {
  readonly closed: boolean;
  close(): void;
  access(options: AccessOptionsLike): Promise<unknown>;
  features(): Promise<Map<string, string>>;
  pwd(): Promise<string>;
  send(command: string): Promise<{ readonly code: number; readonly message: string }>;
  list(path: string): Promise<readonly FileInfoLike[]>;
  downloadTo(destination: Writable, path: string, startAt?: number): Promise<unknown>;
  uploadFrom(source: Readable, path: string): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  remove(path: string): Promise<unknown>;
  removeEmptyDir(path: string): Promise<unknown>;
  trackProgress(handler?: (info: { readonly bytesOverall: number }) => void): void;
}

export interface SecureOptionsLike {
  rejectUnauthorized?: boolean;
  /** Exactly Node's `SecureVersion`, which is `FtpTlsMinVersion` without `auto`. */
  minVersion?: Exclude<FtpTlsMinVersion, 'auto'>;
  ciphers?: string;
}

export interface AccessOptionsLike {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly secure: boolean | 'implicit';
  readonly secureOptions?: SecureOptionsLike | undefined;
}

export interface FtpChannelOptions {
  readonly settings: FtpSettings;
  /** Already resolved by the caller, so the channel never sees `ProviderContext`. */
  readonly secret: Readonly<Record<string, unknown>>;
  readonly logger: Logger;
  readonly signal?: AbortSignal | undefined;
  /** The seam the hermetic tests replace. Production never passes it. */
  readonly createClient?: (() => FtpClientLike) | undefined;
}

export type OpenChannel = (options: FtpChannelOptions) => Promise<FtpChannel>;

/**
 * `secureOptions` reaches both ends of the connection: `basic-ftp` keeps it as
 * `ftp.tlsOptions` and spreads it into every data connection's `tls.connect`
 * (`transfer.js:128`). That is why the TLS floor is set here once rather than
 * per transfer — a mismatch would fail the data connection rather than the
 * login, which is a far worse error to be handed.
 */
export function buildAccessOptions(settings: FtpSettings, password: string): AccessOptionsLike {
  const base = {
    host: settings.host,
    port: settings.port,
    user: settings.username,
    password,
  } as const;

  if (settings.secure === 'none') return { ...base, secure: false };

  const secureOptions: SecureOptionsLike = {};
  if (settings.allowSelfSigned) secureOptions.rejectUnauthorized = false;
  if (settings.tlsMinVersion !== 'auto') secureOptions.minVersion = settings.tlsMinVersion;
  if (relaxesCipherPolicy(settings.tlsMinVersion)) secureOptions.ciphers = LEGACY_CIPHERS;

  return { ...base, secure: settings.secure === 'implicit' ? 'implicit' : true, secureOptions };
}

export function relaxesCipherPolicy(version: FtpTlsMinVersion): boolean {
  return RELAXED_VERSIONS.includes(version);
}

export class FtpControlChannel implements FtpChannel {
  readonly hasMlst: boolean;

  readonly #client: FtpClientLike;
  readonly #logger: Logger;
  #poisoned = false;

  private constructor(client: FtpClientLike, hasMlst: boolean, logger: Logger) {
    this.#client = client;
    this.hasMlst = hasMlst;
    this.#logger = logger;
  }

  static async open(options: FtpChannelOptions): Promise<FtpControlChannel> {
    const { settings, secret, logger, signal } = options;
    const target = `ftp://${settings.host}:${settings.port}`;

    const password = secret['password'];
    if (typeof password !== 'string' || password === '') {
      throw new OmniFsError({
        code: 'AuthenticationFailed',
        message: 'FTP connection has no password.',
        providerId: 'ftp',
        path: target,
      });
    }

    const client = (options.createClient ?? (() => new Client(CONTROL_TIMEOUT_MS)))();
    try {
      await withCancellation(client.access(buildAccessOptions(settings, password)), signal, target);
      // `basic-ftp` reads FEAT during access for its own MLSD decision but does
      // not expose the map, so it is asked for once more here and cached for
      // the life of the channel. One extra round trip at login, never again.
      const features = await client.features();

      if (relaxesCipherPolicy(settings.tlsMinVersion)) {
        logger.log('warn', 'FTP TLS cipher policy relaxed for a legacy server', {
          host: settings.host,
          tlsMinVersion: settings.tlsMinVersion,
        });
      }

      return new FtpControlChannel(client, features.has('MLST'), logger);
    } catch (error) {
      client.close();
      throw toOmniFsError(error, target);
    }
  }

  get poisoned(): boolean {
    return this.#poisoned;
  }

  isAlive(): boolean {
    return !this.#poisoned && !this.#client.closed;
  }

  /**
   * Gives up on this connection. Closing the socket is what makes an abandoned
   * command actually stop, and what stops the pool handing this channel to
   * someone who would read the previous command's reply as their own.
   */
  poison(): void {
    if (this.#poisoned) return;
    this.#poisoned = true;
    this.#client.close();
  }

  async close(): Promise<void> {
    this.#client.close();
  }

  async pwd(signal?: AbortSignal): Promise<string> {
    return this.#run(() => this.#client.pwd(), 'PWD', signal);
  }

  async mlst(path: string, signal?: AbortSignal): Promise<FtpEntry | undefined> {
    const response = await this.#run(() => this.#client.send(`MLST ${path}`), path, signal);
    return parseMlstResponse(response.message);
  }

  async list(path: string, signal?: AbortSignal): Promise<readonly FtpEntry[]> {
    const infos = await this.#run(() => this.#client.list(path), path, signal);
    return infos
      .map(fromFileInfo)
      .filter((entry) => entry.name !== '.' && entry.name !== '..' && entry.name !== '');
  }

  async mkdir(path: string, signal?: AbortSignal): Promise<void> {
    await this.#run(() => this.#client.send(`MKD ${path}`), path, signal);
  }

  async rmdir(path: string, signal?: AbortSignal): Promise<void> {
    await this.#run(() => this.#client.removeEmptyDir(path), path, signal);
  }

  async unlink(path: string, signal?: AbortSignal): Promise<void> {
    await this.#run(() => this.#client.remove(path), path, signal);
  }

  async rename(from: string, to: string, signal?: AbortSignal): Promise<void> {
    await this.#run(() => this.#client.rename(from, to), from, signal);
  }

  async openReadStream(
    path: string,
    range?: FtpReadRange,
    options?: FtpTransferOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    throwIfAborted(options?.signal, path);

    const limit = range?.length;
    const pass = new PassThrough();
    let seen = 0;
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error === undefined) pass.end();
      else pass.destroy(error);
    };

    const sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        if (settled) {
          callback();
          return;
        }
        const remaining = limit === undefined ? chunk.length : limit - seen;
        const slice = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
        seen += slice.length;
        pass.write(slice);
        options?.onProgress?.(seen);

        if (limit !== undefined && seen >= limit) {
          // The protocol has no end-of-range, so the only way to stop a RETR
          // early is to tear the transfer down — which leaves the control
          // channel mid-command. ABOR would need the out-of-band IP/SYNCH
          // sequence that `basic-ftp` does not implement, and servers disagree
          // about the reply order afterwards, so the recovery path would end
          // here anyway. Spec decision 6.
          finish();
          this.poison();
        }
        callback();
      },
    });

    const onAbort = (): void => {
      this.poison();
      finish(toOmniFsError(new DOMException('Aborted', 'AbortError'), path));
    };
    options?.signal?.addEventListener('abort', onAbort, { once: true });

    void this.#client
      .downloadTo(sink, path, range?.start ?? 0)
      .then(() => finish())
      .catch((error: unknown) => finish(toOmniFsError(error, path)))
      .finally(() => options?.signal?.removeEventListener('abort', onAbort));

    return Readable.toWeb(pass) as ReadableStream<Uint8Array>;
  }

  async upload(path: string, data: Uint8Array, options?: FtpTransferOptions): Promise<void> {
    // `Readable.from(buffer)` iterates a Buffer *byte by byte*, so the array
    // wrapper is load-bearing rather than stylistic.
    const source = Readable.from([Buffer.from(data.buffer, data.byteOffset, data.byteLength)]);
    await this.#run(() => this.#client.uploadFrom(source, path), path, options?.signal);
    options?.onProgress?.(data.byteLength);
  }

  async openWriteStream(
    path: string,
    options?: FtpTransferOptions,
  ): Promise<WritableStream<Uint8Array>> {
    throwIfAborted(options?.signal, path);

    const pass = new PassThrough();
    const done = this.#run(() => this.#client.uploadFrom(pass, path), path, options?.signal);
    // The rejection is awaited by close(); this keeps it from being an
    // unhandled rejection in the window before that happens.
    done.catch(() => undefined);

    let written = 0;
    return new WritableStream<Uint8Array>({
      write: (chunk) =>
        new Promise<void>((resolve, reject) => {
          pass.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength), (error) => {
            if (error !== undefined && error !== null) {
              reject(toOmniFsError(error, path));
              return;
            }
            written += chunk.byteLength;
            options?.onProgress?.(written);
            resolve();
          });
        }),
      close: async () => {
        pass.end();
        // The whole point: close() resolves when the *server* has accepted the
        // transfer, not when the last byte left this process.
        await done;
      },
      abort: async () => {
        pass.destroy();
        this.poison();
        await done.catch(() => undefined);
      },
    });
  }

  /**
   * `AbortSignal` is honoured as a race: FTP has no cancel on the wire, so an
   * aborted command is *abandoned*. This class stops waiting, reports
   * `Cancelled`, and poisons the channel — because the server's eventual reply
   * would otherwise be read as the answer to whatever command came next. A
   * mutation already in flight may still land. That is inherent, and wider than
   * SFTP's version of the same gap, which at least keeps its connection.
   */
  async #run<T>(body: () => Promise<T>, path: string, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal, path);
    try {
      return await withCancellation(body(), signal, path);
    } catch (error) {
      const translated = toOmniFsError(error, path);
      if (POISONING_CODES.has(translated.code)) {
        this.#logger.log('debug', 'FTP channel poisoned', { path, code: translated.code });
        this.poison();
      }
      throw translated;
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @omni-fs/provider-ftp exec vitest run src/ftp-channel.test.ts`
Expected: PASS, 27 tests.

- [ ] **Step 5: Check the structural seam actually holds**

`FtpClientLike` claims `basic-ftp`'s `Client` satisfies it. Nothing has asserted
that yet, because the tests only ever pass a fake. Add this to the bottom of
`src/ftp-channel.test.ts`:

```ts
describe('FtpClientLike', () => {
  it('is satisfied by the real basic-ftp Client', async () => {
    // The fake is the only client the rest of this file uses, so without this
    // the interface could drift from the library and no test would notice
    // until a live run.
    const { Client } = await import('basic-ftp');
    const client: FtpClientLike = new Client(1);
    expect(client.closed).toBe(false);
    client.close();
  });
});
```

Run: `pnpm --filter @omni-fs/provider-ftp exec vitest run src/ftp-channel.test.ts`
Expected: PASS, 28 tests. A type error here means `FtpClientLike` and the
library have diverged — fix the interface, not the test.

- [ ] **Step 6: Typecheck, lint, format and commit**

```bash
cd /Users/utain/Workspace/omni-fs
pnpm --filter @omni-fs/provider-ftp typecheck
pnpm exec prettier --write packages/provider-ftp/src/ftp-channel.ts packages/provider-ftp/src/ftp-channel.test.ts
pnpm lint
git add packages/provider-ftp/src
git commit -m ":sparkles: feat open one ftp control channel with a configurable tls floor"
```

---

### Task 5: The pool

The channel's job is one connection's protocol. The pool's job is deciding
which connections exist. They are separate files because they fail differently,
and because keeping them apart is what lets these tests drive the pool with a
fake channel factory and never open a socket.

**Files:**

- Create: `packages/provider-ftp/src/ftp-pool.ts`
- Test: `packages/provider-ftp/src/ftp-pool.test.ts`

**Interfaces:**

- Consumes: `FtpChannel` from `./ftp-channel.js`; `isConnectionLimit`, `toOmniFsError` from `./errors.js`; `OmniFsError`, `throwIfAborted`, `Logger` from `@omni-fs/core`.
- Produces:
  - `interface FtpPoolOptions { maxConnections: number; open: (signal?: AbortSignal) => Promise<FtpChannel>; logger: Logger }`
  - `class FtpPool` with `get ceiling(): number`, `get size(): number`, `isAlive(): boolean`, `acquire(signal?): Promise<FtpChannel>`, `release(channel: FtpChannel): void`, `lease<T>(body: (channel: FtpChannel) => Promise<T>, signal?): Promise<T>`, `close(): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `packages/provider-ftp/src/ftp-pool.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @omni-fs/provider-ftp exec vitest run src/ftp-pool.test.ts`
Expected: FAIL — `Failed to resolve import "./ftp-pool.js"`.

- [ ] **Step 3: Write the pool**

Create `packages/provider-ftp/src/ftp-pool.ts`:

```ts
import { OmniFsError, throwIfAborted } from '@omni-fs/core';
import type { Logger } from '@omni-fs/core';
import { isConnectionLimit, toOmniFsError } from './errors.js';
import type { FtpChannel } from './ftp-channel.js';

export interface FtpPoolOptions {
  /** The ceiling this pool starts with. It only ever goes down. */
  readonly maxConnections: number;
  readonly open: (signal?: AbortSignal) => Promise<FtpChannel>;
  readonly logger: Logger;
}

interface PoolWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/**
 * The control channels this connection has, and who is using them.
 *
 * FTP carries one command per connection, so a single channel means a large
 * download blocks browsing until it finishes. That is a client limitation, not
 * a protocol one, and every desktop FTP client answers it the same way: open
 * another connection. The ceiling is a setting, defaulting to 1, so the
 * out-of-the-box behaviour is the conservative one no server can object to.
 *
 * Every operation leases a channel for its whole duration, which is also what
 * makes `RNFR`/`RNTO` safe — that pair must not interleave with anything.
 */
export class FtpPool {
  readonly #open: FtpPoolOptions['open'];
  readonly #logger: Logger;
  readonly #live = new Set<FtpChannel>();
  readonly #idle: FtpChannel[] = [];
  readonly #waiters: PoolWaiter[] = [];
  #ceiling: number;
  #opening = 0;
  #closed = false;

  constructor(options: FtpPoolOptions) {
    this.#ceiling = options.maxConnections;
    this.#open = options.open;
    this.#logger = options.logger;
  }

  /** What `capabilities.maxConcurrency` reports, so the queue follows it down. */
  get ceiling(): number {
    return this.#ceiling;
  }

  get size(): number {
    return this.#live.size;
  }

  isAlive(): boolean {
    if (this.#closed) return false;
    for (const channel of this.#live) if (channel.isAlive()) return true;
    return false;
  }

  async acquire(signal?: AbortSignal): Promise<FtpChannel> {
    for (;;) {
      if (this.#closed) throw closedError();
      throwIfAborted(signal, 'FTP connection');

      const idle = this.#idle.pop();
      if (idle !== undefined) {
        if (idle.isAlive()) return idle;
        // The server idles a connection out after a few minutes and says
        // nothing until the next command. Replacing it before the operation
        // starts is pool bookkeeping, not a retry: a channel that dies *during*
        // an operation surfaces `ConnectionFailed{retryable}` and is core's to
        // reconnect, through the `isAlive()` check in `ConnectionManager`.
        this.#discard(idle);
        continue;
      }

      if (this.#live.size + this.#opening < this.#ceiling) {
        const opened = await this.#openOne(signal);
        if (opened !== undefined) return opened;
        continue;
      }

      await this.#waitForRelease(signal);
    }
  }

  release(channel: FtpChannel): void {
    if (this.#closed || !channel.isAlive()) this.#discard(channel);
    else this.#idle.push(channel);
    this.#waiters.shift()?.resolve();
  }

  async lease<T>(body: (channel: FtpChannel) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const channel = await this.acquire(signal);
    try {
      return await body(channel);
    } finally {
      this.release(channel);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    for (const waiter of this.#waiters.splice(0)) waiter.reject(closedError());
    this.#idle.length = 0;

    const channels = [...this.#live];
    this.#live.clear();
    await Promise.all(channels.map((channel) => channel.close().catch(() => undefined)));
  }

  /** `undefined` means "the ceiling moved, go round again", not "it failed". */
  async #openOne(signal?: AbortSignal): Promise<FtpChannel | undefined> {
    // The slot is reserved before the await, or two concurrent acquires both
    // see room below the ceiling and open one connection too many.
    this.#opening += 1;
    try {
      const channel = await this.#open(signal);
      if (this.#closed) {
        await channel.close().catch(() => undefined);
        throw closedError();
      }
      this.#live.add(channel);
      return channel;
    } catch (error) {
      if (isConnectionLimit(error) && this.#live.size > 0) {
        this.#shrink();
        return undefined;
      }
      throw toOmniFsError(error);
    } finally {
      this.#opening -= 1;
    }
  }

  /**
   * Permanently, for the life of this connection. A server that refuses a
   * fourth login will refuse it again in a minute, and asking repeatedly is a
   * failed login per operation for as long as the connection lives.
   */
  #shrink(): void {
    const next = Math.max(1, this.#live.size);
    if (next >= this.#ceiling) return;
    this.#ceiling = next;
    this.#logger.log('warn', 'FTP server refused another login; lowering the pool ceiling', {
      ceiling: next,
    });
  }

  #discard(channel: FtpChannel): void {
    this.#live.delete(channel);
    void channel.close().catch(() => undefined);
  }

  async #waitForRelease(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const waiter: PoolWaiter = {
        resolve: () => {
          if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject: (error: unknown) => {
          if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };

      onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        waiter.reject(
          new OmniFsError({
            code: 'Cancelled',
            message: 'Cancelled: FTP connection',
            providerId: 'ftp',
          }),
        );
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }
}

function closedError(): OmniFsError {
  return new OmniFsError({
    code: 'ConnectionFailed',
    message: 'FTP connection is closed.',
    providerId: 'ftp',
    retryable: false,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @omni-fs/provider-ftp exec vitest run src/ftp-pool.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Lint, format and commit**

```bash
cd /Users/utain/Workspace/omni-fs
pnpm exec prettier --write packages/provider-ftp/src/ftp-pool.ts packages/provider-ftp/src/ftp-pool.test.ts
pnpm lint
git add packages/provider-ftp/src
git commit -m ":sparkles: feat pool ftp control channels and shrink on a refused login"
```

---

### Task 6: The file system — capabilities, connect, stat and list

The class appears here implementing the whole `RemoteFileSystem` interface, but
only four members do anything: `connect`, `isAlive`, `stat` and `list`.
`readFile`, `createReadStream`, `writeFile` and `delete` throw `Unsupported`
until Tasks 7–9 fill them in, and `createDirectory`/`rename` do not exist yet.
That is a deliberate half-built state: `src/index.ts` is not rewritten until
Task 10, so nothing registers this provider while it is in it.

**Files:**

- Create: `packages/provider-ftp/src/ftp-file-system.ts`
- Test: `packages/provider-ftp/src/ftp-file-system.test.ts`

**Interfaces:**

- Consumes: `FtpPool` from `./ftp-pool.js`; `FtpChannel`, `FtpControlChannel`, `OpenChannel` from `./ftp-channel.js`; the helpers and `readSettings`.
- Produces:
  - `FTP_CAPABILITIES: ProviderCapabilities`
  - `class FtpFileSystem implements RemoteFileSystem` with `constructor(context: ProviderContext, openChannel: OpenChannel = FtpControlChannel.open)`

- [ ] **Step 1: Write the failing test**

Create `packages/provider-ftp/src/ftp-file-system.test.ts`. This file grows in
Tasks 7–9; everything below is what it holds at the end of this task:

```ts
import { describe, expect, it, vi } from 'vitest';
import { NOOP_LOGGER, OmniFsError, RemotePath } from '@omni-fs/core';
import type { ConnectionConfig, ProviderContext } from '@omni-fs/core';
import { FTP_CAPABILITIES, FtpFileSystem } from './ftp-file-system.js';
import type { FtpChannel } from './ftp-channel.js';
import type { FtpEntry } from './ftp-helpers.js';

interface FakeChannel extends FtpChannel {
  alive: boolean;
  readonly calls: string[];
}

interface FakeChannelOptions {
  readonly hasMlst?: boolean;
  readonly mlst?: (path: string) => Promise<FtpEntry | undefined>;
  readonly list?: (path: string) => Promise<readonly FtpEntry[]>;
}

function entry(name: string, overrides: Partial<FtpEntry> = {}): FtpEntry {
  return { name, type: 'file', size: 0, mtime: undefined, mode: undefined, ...overrides };
}

function fakeChannel(options: FakeChannelOptions = {}): FakeChannel {
  const calls: string[] = [];
  const channel: FakeChannel = {
    alive: true,
    calls,
    hasMlst: options.hasMlst ?? true,
    poisoned: false,
    isAlive: () => channel.alive,
    poison: () => {
      channel.alive = false;
    },
    close: vi.fn(async () => {
      channel.alive = false;
    }),
    pwd: async () => {
      calls.push('pwd');
      return '/home/alice';
    },
    mlst: async (path) => {
      calls.push(`mlst ${path}`);
      return options.mlst === undefined ? undefined : options.mlst(path);
    },
    list: async (path) => {
      calls.push(`list ${path}`);
      return options.list === undefined ? [] : options.list(path);
    },
    mkdir: async (path) => {
      calls.push(`mkdir ${path}`);
    },
    rmdir: async (path) => {
      calls.push(`rmdir ${path}`);
    },
    unlink: async (path) => {
      calls.push(`unlink ${path}`);
    },
    rename: async (from, to) => {
      calls.push(`rename ${from} ${to}`);
    },
    openReadStream: async () => new ReadableStream<Uint8Array>(),
    upload: async (path) => {
      calls.push(`upload ${path}`);
    },
    openWriteStream: async () => new WritableStream<Uint8Array>(),
  };
  return channel;
}

function context(settings: Readonly<Record<string, unknown>> = {}): ProviderContext {
  const config: ConnectionConfig = {
    id: 'test',
    providerId: 'ftp',
    label: 'test',
    settings: { host: 'ftp.example.com', username: 'alice', ...settings },
  };
  return { config, getSecret: async () => ({ password: 'hunter2' }), logger: NOOP_LOGGER };
}

async function connected(
  channel: FtpChannel,
  settings: Readonly<Record<string, unknown>> = {},
): Promise<FtpFileSystem> {
  const fs = new FtpFileSystem(context(settings), async () => channel);
  await fs.connect();
  return fs;
}

describe('FTP_CAPABILITIES', () => {
  it('claims a recursive delete, because the provider does the walk', () => {
    // The shared suite calls delete(dir, { recursive: true }) on the raw
    // provider without gating on the flag, and S3 and SFTP already settled that
    // it means "the provider handles it", not "one server call".
    expect(FTP_CAPABILITIES.canDeleteRecursive).toBe(true);
  });

  it('claims no server-side copy, so core streams one', () => {
    expect(FTP_CAPABILITIES.canCopyServerSide).toBe(false);
  });

  it('claims no version tokens, so the ifMatch cases skip', () => {
    expect(FTP_CAPABILITIES.hasVersionTokens).toBe(false);
  });

  it('assumes one control channel before a connection exists', () => {
    expect(FTP_CAPABILITIES.maxConcurrency).toBe(1);
  });
});

describe('capabilities', () => {
  it('reports the configured pool size once the settings are known', () => {
    const fs = new FtpFileSystem(context({ maxConnections: 4 }), async () => fakeChannel());
    expect(fs.capabilities.maxConcurrency).toBe(4);
  });

  it('follows the pool ceiling down when the server refuses a login', async () => {
    let opened = 0;
    const fs = new FtpFileSystem(context({ maxConnections: 4 }), async () => {
      opened += 1;
      if (opened > 1) throw Object.assign(new Error('421 Too many connections'), { code: 421 });
      return fakeChannel();
    });
    await fs.connect();

    await Promise.all([
      fs.list(RemotePath.ROOT)[Symbol.asyncIterator]().next(),
      fs.list(RemotePath.ROOT)[Symbol.asyncIterator]().next(),
    ]);

    expect(fs.capabilities.maxConcurrency).toBe(1);
  });
});

describe('connect', () => {
  it('resolves the login directory once', async () => {
    const channel = fakeChannel();
    const fs = await connected(channel);
    expect(channel.calls).toContain('pwd');
    expect(fs.isAlive()).toBe(true);
  });

  it('is idempotent while the connection is alive', async () => {
    const open = vi.fn(async () => fakeChannel());
    const fs = new FtpFileSystem(context(), open);
    await fs.connect();
    await fs.connect();
    expect(open).toHaveBeenCalledOnce();
  });

  it('puts an absolute root prefix where it says, not below the login directory', async () => {
    const channel = fakeChannel();
    const fs = await connected(channel, { rootPrefix: '/srv/ftp/shared' });
    await collect(fs.list(RemotePath.ROOT));
    expect(channel.calls).toContain('list /srv/ftp/shared');
  });

  it('puts a relative root prefix below the login directory', async () => {
    const channel = fakeChannel();
    const fs = await connected(channel, { rootPrefix: 'public_html' });
    await collect(fs.list(RemotePath.ROOT));
    expect(channel.calls).toContain('list /home/alice/public_html');
  });

  it('closes the connection when the base cannot be resolved', async () => {
    const channel = fakeChannel();
    channel.pwd = async () => {
      throw Object.assign(new Error('530 Not logged in'), { code: 530 });
    };
    const fs = new FtpFileSystem(context(), async () => channel);
    await expect(fs.connect()).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'AuthenticationFailed',
    );
    expect(fs.isAlive()).toBe(false);
  });
});

describe('stat', () => {
  it('asks MLST first when the server advertised it', async () => {
    const channel = fakeChannel({
      mlst: async () => entry('readme.txt', { type: 'file', size: 18, mtime: 1000 }),
    });
    const fs = await connected(channel);
    const stat = await fs.stat(RemotePath.parse('/readme.txt'));
    expect(stat).toMatchObject({ type: 'file', size: 18, mtime: 1000 });
    expect(channel.calls).toContain('mlst /home/alice/readme.txt');
    expect(channel.calls.some((call) => call.startsWith('list'))).toBe(false);
  });

  it('falls back to listing the parent when the server has no MLST', async () => {
    const channel = fakeChannel({
      hasMlst: false,
      list: async () => [entry('readme.txt', { size: 18 }), entry('other.txt')],
    });
    const fs = await connected(channel);
    expect(await fs.stat(RemotePath.parse('/readme.txt'))).toMatchObject({ size: 18 });
    expect(channel.calls).toContain('list /home/alice');
  });

  it('falls back to listing when MLST answers something it cannot parse', async () => {
    // A slower answer rather than a failed one.
    const channel = fakeChannel({
      mlst: async () => undefined,
      list: async () => [entry('readme.txt', { size: 4 })],
    });
    const fs = await connected(channel);
    expect(await fs.stat(RemotePath.parse('/readme.txt'))).toMatchObject({ size: 4 });
  });

  it('reports a missing path as NotFound from the fallback too', async () => {
    const channel = fakeChannel({ hasMlst: false, list: async () => [entry('other.txt')] });
    const fs = await connected(channel);
    await expect(fs.stat(RemotePath.parse('/missing.txt'))).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
    );
  });

  it('answers for the connection root, which has no parent to list', async () => {
    const channel = fakeChannel({ hasMlst: false });
    const fs = await connected(channel);
    expect(await fs.stat(RemotePath.ROOT)).toMatchObject({ type: 'directory' });
  });

  it('refuses an already-aborted signal as Cancelled', async () => {
    const fs = await connected(fakeChannel());
    const controller = new AbortController();
    controller.abort();
    await expect(fs.stat(RemotePath.parse('/a.txt'), controller.signal)).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled',
    );
  });
});

describe('list', () => {
  it('yields entries under the path it was asked for', async () => {
    const channel = fakeChannel({
      list: async () => [entry('guide.md'), entry('nested', { type: 'directory' })],
    });
    const fs = await connected(channel);
    const entries = await collect(fs.list(RemotePath.parse('/docs')));

    expect(entries.map((e) => e.path.value)).toEqual(['/docs/guide.md', '/docs/nested']);
    expect(entries[1]?.type).toBe('directory');
    expect(channel.calls).toContain('list /home/alice/docs');
  });

  it('releases the channel before the consumer starts iterating', async () => {
    // FTP has no listing cursor, so the array is already in hand. Holding a
    // control channel while a slow consumer iterates would block every other
    // operation for nothing.
    const channel = fakeChannel({ list: async () => [entry('a.txt')] });
    const fs = await connected(channel, { maxConnections: 1 });
    const iterator = fs.list(RemotePath.ROOT)[Symbol.asyncIterator]();
    await iterator.next();

    // If the lease were still held this would deadlock at a ceiling of one.
    await expect(fs.stat(RemotePath.ROOT)).resolves.toBeDefined();
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @omni-fs/provider-ftp exec vitest run src/ftp-file-system.test.ts`
Expected: FAIL — `Failed to resolve import "./ftp-file-system.js"`.

- [ ] **Step 3: Write the file system**

Create `packages/provider-ftp/src/ftp-file-system.ts`:

```ts
import { OmniFsError } from '@omni-fs/core';
import type {
  DeleteOptions,
  DirEntry,
  FileStat,
  Logger,
  ProviderCapabilities,
  ProviderContext,
  ReadOptions,
  RemoteFileSystem,
  RemotePath,
  WriteOptions,
} from '@omni-fs/core';
import { toOmniFsError } from './errors.js';
import { FtpControlChannel } from './ftp-channel.js';
import type { FtpChannel, OpenChannel } from './ftp-channel.js';
import { joinRemote, resolveBase, toDirEntry, toFileStat } from './ftp-helpers.js';
import { FtpPool } from './ftp-pool.js';
import { readSettings } from './settings.js';
import type { FtpSettings } from './settings.js';

/**
 * What FTP can do, before a connection exists.
 *
 * `canDeleteRecursive` is `true` although no FTP command removes a tree: the
 * flag means "the provider handles a recursive delete when asked", which is how
 * `provider-s3` and `provider-sftp` already read it, and this provider walks.
 *
 * `maxConcurrency` is 1 here and answered per connection by the getter below.
 */
export const FTP_CAPABILITIES: ProviderCapabilities = {
  canWrite: true,
  canRename: true,
  canCopyServerSide: false,
  canCreateDirectory: true,
  canDeleteRecursive: true,
  canAppend: true,
  canReadRange: true,
  canStreamWrite: true,
  canWatch: false,
  hasRealDirectories: true,
  preservesMTime: false,
  hasVersionTokens: false,
  maxConcurrency: 1,
  listIsPaginated: false,
};

/**
 * FTP and FTPS (explicit `AUTH TLS` and implicit TLS-on-connect).
 *
 * The defining constraint is the control channel: one command at a time, per
 * connection. This class never sees it — `FtpPool` hands it a channel for the
 * duration of an operation, and how many channels exist is the connection's
 * `maxConnections` setting. That is also why nothing here changes the working
 * directory: every command carries an absolute path, which is what makes a
 * pooled channel interchangeable.
 */
export class FtpFileSystem implements RemoteFileSystem {
  readonly #context: ProviderContext;
  readonly #settings: FtpSettings;
  readonly #logger: Logger;
  readonly #openChannel: OpenChannel;
  #pool: FtpPool | undefined;
  #base = '/';

  /**
   * `openChannel` is the seam the hermetic tests replace. Production never
   * passes it, so `ProviderDefinition.create` stays a one-liner.
   */
  constructor(context: ProviderContext, openChannel: OpenChannel = FtpControlChannel.open) {
    this.#context = context;
    this.#settings = readSettings(context.config.settings);
    this.#logger = context.logger;
    this.#openChannel = openChannel;
  }

  /**
   * Static until the settings are read, then truthful about this connection.
   *
   * This is the first provider whose capabilities depend on a *setting* rather
   * than on the server. `TransferQueue` reads `maxConcurrency` at call time, so
   * a pool that shrank after a `421` stops the queue asking for more transfers
   * than the server will hold, without core changing.
   */
  get capabilities(): ProviderCapabilities {
    return {
      ...FTP_CAPABILITIES,
      maxConcurrency: this.#pool?.ceiling ?? this.#settings.maxConnections,
    };
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.#pool?.isAlive() === true) return;

    const previous = this.#pool;
    this.#pool = undefined;
    await previous?.close();

    const pool = new FtpPool({
      maxConnections: this.#settings.maxConnections,
      logger: this.#logger,
      open: async (openSignal) => {
        // Fetched per channel rather than once, so credentials are resolved at
        // connect time as `ProviderContext.getSecret` documents.
        const secret = await this.#context.getSecret(openSignal);
        return this.#openChannel({
          settings: this.#settings,
          secret,
          logger: this.#logger,
          ...(openSignal !== undefined ? { signal: openSignal } : {}),
        });
      },
    });

    try {
      this.#base = await pool.lease(
        async (channel) => resolveBase(this.#settings.rootPrefix, await channel.pwd(signal)),
        signal,
      );
    } catch (error) {
      await pool.close();
      throw toOmniFsError(error, this.#settings.rootPrefix);
    }

    this.#pool = pool;
    this.#logger.log('info', 'FTP connected', {
      host: this.#settings.host,
      base: this.#base,
      secure: this.#settings.secure,
      maxConnections: this.#settings.maxConnections,
    });
  }

  isAlive(): boolean {
    return this.#pool?.isAlive() ?? false;
  }

  async stat(path: RemotePath, signal?: AbortSignal): Promise<FileStat> {
    return this.#requirePool().lease((channel) => this.#stat(channel, path, signal), signal);
  }

  async *list(path: RemotePath, signal?: AbortSignal): AsyncIterable<DirEntry> {
    const remote = this.#remote(path);
    // The lease ends here, before the first entry is yielded. `list` has an
    // array in hand — FTP has no listing cursor — so holding a control channel
    // while a slow consumer iterates would block everything else for nothing.
    const entries = await this.#requirePool().lease(
      (channel) => channel.list(remote, signal),
      signal,
    );
    for (const entry of entries) yield toDirEntry(entry, path);
  }

  async readFile(_path: RemotePath, _options?: ReadOptions): Promise<Uint8Array> {
    throw notImplemented('readFile');
  }

  async createReadStream(
    _path: RemotePath,
    _options?: ReadOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    throw notImplemented('createReadStream');
  }

  async writeFile(_path: RemotePath, _data: Uint8Array, _options?: WriteOptions): Promise<void> {
    throw notImplemented('writeFile');
  }

  async delete(_path: RemotePath, _options?: DeleteOptions): Promise<void> {
    throw notImplemented('delete');
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const pool = this.#pool;
    this.#pool = undefined;
    await pool?.close();
  }

  /**
   * `MLST` where the server has it, a parent listing where it does not.
   *
   * Not `SIZE` plus `MDTM`: `SIZE` fails on directories and refuses outright in
   * ASCII mode, and `MDTM` is missing from a good fraction of servers, so
   * telling "missing" from "is a directory" would need a third probe.
   */
  async #stat(channel: FtpChannel, path: RemotePath, signal?: AbortSignal): Promise<FileStat> {
    if (channel.hasMlst) {
      const found = await channel.mlst(this.#remote(path), signal);
      if (found !== undefined) return toFileStat(found);
    }

    if (path.isRoot) {
      // The connection base has no parent inside the connection. Listing it is
      // the only question available, and a listing that succeeds answers it.
      await channel.list(this.#base, signal);
      return { type: 'directory', size: 0 };
    }

    const entries = await channel.list(this.#remote(path.parent), signal);
    const match = entries.find((entry) => entry.name === path.basename);
    if (match === undefined) throw this.#notFound(path);
    return toFileStat(match);
  }

  #notFound(path: RemotePath): OmniFsError {
    return new OmniFsError({
      code: 'NotFound',
      message: `Not found: ${path.value}`,
      path: path.value,
      providerId: 'ftp',
    });
  }

  #remote(path: RemotePath): string {
    return joinRemote(this.#base, path);
  }

  #requirePool(): FtpPool {
    const pool = this.#pool;
    if (pool === undefined) {
      throw new OmniFsError({
        code: 'ConnectionFailed',
        message: 'FTP connection is not open. Call connect() first.',
        providerId: 'ftp',
        retryable: true,
      });
    }
    return pool;
  }
}

function notImplemented(operation: string): OmniFsError {
  return new OmniFsError({
    code: 'Unsupported',
    message: `FTP provider: ${operation} is not implemented yet.`,
    providerId: 'ftp',
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @omni-fs/provider-ftp exec vitest run src/ftp-file-system.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Lint, format and commit**

```bash
cd /Users/utain/Workspace/omni-fs
pnpm exec prettier --write packages/provider-ftp/src/ftp-file-system.ts packages/provider-ftp/src/ftp-file-system.test.ts
pnpm lint
git add packages/provider-ftp/src
git commit -m ":sparkles: feat connect stat and list over a pool of ftp channels"
```

---

### Task 7: Reading

**Files:**

- Modify: `packages/provider-ftp/src/ftp-helpers.ts` (add `releasingStream`)
- Modify: `packages/provider-ftp/src/ftp-file-system.ts` (`readFile`, `createReadStream`)
- Test: `packages/provider-ftp/src/ftp-helpers.test.ts`, `packages/provider-ftp/src/ftp-file-system.test.ts`

**Interfaces:**

- Produces: `releasingStream(source: ReadableStream<Uint8Array>, onDone: () => void): ReadableStream<Uint8Array>`; working `readFile` and `createReadStream` on `FtpFileSystem`.

A read outlives the call that started it, so it cannot use `pool.lease` — the
channel has to be held until the stream ends, and released on every path out,
including a consumer that walks away. That is what `releasingStream` is for.

- [ ] **Step 1: Write the failing helper test**

Append to `packages/provider-ftp/src/ftp-helpers.test.ts`:

```ts
describe('releasingStream', () => {
  it('releases once the source is drained', async () => {
    const release = vi.fn();
    const stream = releasingStream(streamFrom(new TextEncoder().encode('hello')), release);
    expect(new TextDecoder().decode(await collectStream(stream))).toBe('hello');
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases when the consumer walks away', async () => {
    // A tree view that closes a preview halfway through must not strand a
    // control channel for the life of the connection.
    const release = vi.fn();
    const stream = releasingStream(streamFrom(new Uint8Array([1, 2, 3])), release);
    await stream.cancel('done looking');
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases when the source fails', async () => {
    const release = vi.fn();
    const failing = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('connection lost');
      },
    });
    await expect(collectStream(releasingStream(failing, release))).rejects.toThrow(
      'connection lost',
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases exactly once however the stream ends', async () => {
    const release = vi.fn();
    const stream = releasingStream(streamFrom(new Uint8Array([1])), release);
    await collectStream(stream);
    await stream.cancel().catch(() => undefined);
    expect(release).toHaveBeenCalledOnce();
  });
});
```

Add the imports this needs to the top of that file:

```ts
import { describe, expect, it, vi } from 'vitest';
import { RemotePath, collectStream, streamFrom } from '@omni-fs/core';
```

and add `releasingStream` to the existing `./ftp-helpers.js` import list.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @omni-fs/provider-ftp exec vitest run src/ftp-helpers.test.ts`
Expected: FAIL — `releasingStream is not a function`.

- [ ] **Step 3: Add the helper**

Append to `packages/provider-ftp/src/ftp-helpers.ts`:

```ts
/**
 * Hands a control channel back when the stream it belongs to is finished with.
 *
 * A read outlives the call that started it, so it cannot sit inside a
 * `lease()`. Every way out — drained, cancelled, failed — has to release
 * exactly once, or a connection at the default ceiling of one channel
 * deadlocks on its next operation.
 */
export function releasingStream(
  source: ReadableStream<Uint8Array>,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    onDone();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        release();
        throw error;
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @omni-fs/provider-ftp exec vitest run src/ftp-helpers.test.ts`
Expected: PASS, 28 tests.

- [ ] **Step 5: Teach the fake channel to serve content**

In `packages/provider-ftp/src/ftp-file-system.test.ts`, replace the
`FakeChannelOptions` interface with:

```ts
interface FakeChannelOptions {
  readonly hasMlst?: boolean;
  readonly mlst?: (path: string) => Promise<FtpEntry | undefined>;
  readonly list?: (path: string) => Promise<readonly FtpEntry[]>;
  /** Served by `openReadStream`, honouring `start` and `length`. */
  readonly content?: string;
}
```

and replace the `openReadStream` member of `fakeChannel` with:

```ts
    openReadStream: async (path, range) => {
      calls.push(`read ${path} ${range?.start ?? 0}:${range?.length ?? ''}`);
      const body = options.content ?? '';
      const start = range?.start ?? 0;
      const slice = range?.length === undefined ? body.slice(start) : body.substr(start, range.length);
      if (range?.length !== undefined) channel.poison();
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(slice));
          controller.close();
        },
      });
    },
```

- [ ] **Step 6: Write the failing read tests**

Append to `packages/provider-ftp/src/ftp-file-system.test.ts`:

```ts
describe('reading', () => {
  it('reads a whole file', async () => {
    const fs = await connected(fakeChannel({ content: 'payload' }));
    expect(new TextDecoder().decode(await fs.readFile(RemotePath.parse('/a.txt')))).toBe('payload');
  });

  it('reads a byte range', async () => {
    const fs = await connected(fakeChannel({ content: '0123456789' }));
    const slice = await fs.readFile(RemotePath.parse('/a.txt'), { offset: 2, length: 3 });
    expect(new TextDecoder().decode(slice)).toBe('234');
  });

  it('reads from an offset to the end', async () => {
    const fs = await connected(fakeChannel({ content: '0123456789' }));
    const slice = await fs.readFile(RemotePath.parse('/a.txt'), { offset: 7 });
    expect(new TextDecoder().decode(slice)).toBe('789');
  });

  it('reads no bytes for a zero-length range, without opening a data connection', async () => {
    const channel = fakeChannel({ content: '0123456789' });
    const fs = await connected(channel);
    const slice = await fs.readFile(RemotePath.parse('/a.txt'), { offset: 2, length: 0 });
    expect(slice.byteLength).toBe(0);
    expect(channel.calls.some((call) => call.startsWith('read'))).toBe(false);
  });

  it('still refuses a missing path for a zero-length range', async () => {
    // Answering locally must not turn a missing path into an empty success.
    // Existence stays the server's to decide.
    const channel = fakeChannel({ hasMlst: false, list: async () => [] });
    const fs = await connected(channel);
    await expect(
      fs.readFile(RemotePath.parse('/absent.txt'), { offset: 0, length: 0 }),
    ).rejects.toSatisfy((error: unknown) => OmniFsError.is(error) && error.code === 'NotFound');
  });

  it('releases the channel once the stream is drained', async () => {
    const fs = await connected(fakeChannel({ content: 'payload' }), { maxConnections: 1 });
    await fs.readFile(RemotePath.parse('/a.txt'));
    // At a ceiling of one this would deadlock if the read kept its lease.
    await expect(fs.stat(RemotePath.ROOT)).resolves.toBeDefined();
  });

  it('releases the channel when the consumer cancels early', async () => {
    const fs = await connected(fakeChannel({ content: 'payload' }), { maxConnections: 1 });
    const stream = await fs.createReadStream(RemotePath.parse('/a.txt'));
    await stream.cancel('changed my mind');
    await expect(fs.stat(RemotePath.ROOT)).resolves.toBeDefined();
  });

  it('releases the channel when the read cannot even start', async () => {
    const channel = fakeChannel({ content: 'payload' });
    channel.openReadStream = async () => {
      throw Object.assign(new Error('550 No such file'), { code: 550 });
    };
    const fs = await connected(channel, { maxConnections: 1 });
    await expect(fs.readFile(RemotePath.parse('/gone.txt'))).rejects.toThrow();
    await expect(fs.stat(RemotePath.ROOT)).resolves.toBeDefined();
  });

  it('replaces the channel a bounded read poisoned', async () => {
    // The protocol has no end-of-range, so a range that stops before EOF costs
    // the control channel. The pool notices on release and opens a fresh one.
    const opened: FakeChannel[] = [];
    const fs = new FtpFileSystem(context({ maxConnections: 1 }), async () => {
      const channel = fakeChannel({ content: '0123456789' });
      opened.push(channel);
      return channel;
    });
    await fs.connect();

    await fs.readFile(RemotePath.parse('/a.txt'), { offset: 0, length: 4 });
    await fs.stat(RemotePath.ROOT);

    expect(opened.length).toBe(2);
  });

  it('does not poison the channel for an unbounded read', async () => {
    const opened: FakeChannel[] = [];
    const fs = new FtpFileSystem(context({ maxConnections: 1 }), async () => {
      const channel = fakeChannel({ content: '0123456789' });
      opened.push(channel);
      return channel;
    });
    await fs.connect();

    await fs.readFile(RemotePath.parse('/a.txt'));
    await fs.stat(RemotePath.ROOT);

    expect(opened.length).toBe(1);
  });

  it('reports progress as bytes arrive', async () => {
    const seen: number[] = [];
    const fs = await connected(fakeChannel({ content: 'payload' }));
    await fs.readFile(RemotePath.parse('/a.txt'), { onProgress: (n) => seen.push(n) });
    expect(seen.at(-1)).toBe(7);
  });
});
```

For the progress case the fake must call the handler. Replace the
`openReadStream` member once more, adding one line before the `return`:

```ts
options?.onProgress?.(slice.length);
```

placed inside `openReadStream` after `slice` is computed, where `options` is
`openReadStream`'s third parameter — rename the destructured parameter list to
`async (path, range, transfer)` and call `transfer?.onProgress?.(slice.length)`
so it does not shadow the outer `options`.

- [ ] **Step 7: Run them to verify they fail**

Run: `pnpm --filter @omni-fs/provider-ftp exec vitest run src/ftp-file-system.test.ts`
Expected: FAIL — `FTP provider: readFile is not implemented yet.`

- [ ] **Step 8: Implement reading**

In `packages/provider-ftp/src/ftp-file-system.ts`, replace the two throwing
methods with:

```ts
  async readFile(path: RemotePath, options?: ReadOptions): Promise<Uint8Array> {
    return collectStream(await this.createReadStream(path, options));
  }

  async createReadStream(
    path: RemotePath,
    options?: ReadOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    const range = buildRange(options);
    const signal = options?.signal;

    if (range === 'empty') {
      // No protocol has a spelling for "zero bytes", and answering it locally
      // must not turn a missing path into an empty success — so existence
      // stays the server's to decide. The same shape, and the same reasoning,
      // as the other three providers.
      await this.stat(path, signal);
      return streamFrom(new Uint8Array());
    }

    const pool = this.#requirePool();
    const channel = await pool.acquire(signal);
    try {
      const stream = await channel.openReadStream(
        this.#remote(path),
        range,
        this.#transferOptions(options),
      );
      // The lease outlives this call: a read is only finished when its stream
      // is, and every way out of that stream has to hand the channel back.
      return releasingStream(stream, () => pool.release(channel));
    } catch (error) {
      pool.release(channel);
      throw toOmniFsError(error, path.value);
    }
  }
```

Add the private helper beside `#remote`:

```ts
  #transferOptions(options: ReadOptions | WriteOptions | undefined): FtpTransferOptions {
    return {
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      ...(options?.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
    };
  }
```

and extend the imports at the top of the file:

```ts
import { OmniFsError, collectStream, streamFrom } from '@omni-fs/core';
import {
  buildRange,
  joinRemote,
  releasingStream,
  resolveBase,
  toDirEntry,
  toFileStat,
} from './ftp-helpers.js';
import type { FtpChannel, FtpTransferOptions, OpenChannel } from './ftp-channel.js';
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm --filter @omni-fs/provider-ftp test`
Expected: PASS — every file, 28 helper tests and 28 filesystem tests.

- [ ] **Step 10: Lint, format and commit**

```bash
cd /Users/utain/Workspace/omni-fs
pnpm exec prettier --write packages/provider-ftp/src
pnpm lint
git add packages/provider-ftp/src
git commit -m ":sparkles: feat read ftp files whole and by byte range"
```

---

### Task 8: Writing, and the directories a write needs

**Files:**

- Modify: `packages/provider-ftp/src/ftp-file-system.ts` (`writeFile`, `createWriteStream`, `createDirectory`)
- Test: `packages/provider-ftp/src/ftp-file-system.test.ts`

**Interfaces:**

- Produces: working `writeFile`, `createWriteStream` and `createDirectory` on `FtpFileSystem`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/provider-ftp/src/ftp-file-system.test.ts`:

```ts
describe('writing', () => {
  it('uploads a file', async () => {
    const channel = fakeChannel();
    const fs = await connected(channel);
    await fs.writeFile(RemotePath.parse('/a.txt'), new TextEncoder().encode('payload'));
    expect(channel.calls).toContain('upload /home/alice/a.txt');
  });

  it('creates the missing ancestors of a nested write', async () => {
    // The conformance suite writes to `tree/nested/two.txt` without creating
    // either directory first, because createParents defaults to true.
    const channel = fakeChannel();
    const fs = await connected(channel);
    await fs.writeFile(RemotePath.parse('/tree/nested/two.txt'), new Uint8Array([1]));
    expect(channel.calls).toContain('mkdir /home/alice/tree');
    expect(channel.calls).toContain('mkdir /home/alice/tree/nested');
  });

  it('treats a directory that already exists as success', async () => {
    // Servers spell that refusal 550 or 521 and disagree about which, so it
    // cannot be the failure it looks like.
    const channel = fakeChannel();
    channel.mkdir = async () => {
      throw Object.assign(new Error('550 Directory already exists'), { code: 550 });
    };
    const fs = await connected(channel);
    await expect(
      fs.writeFile(RemotePath.parse('/tree/a.txt'), new Uint8Array([1])),
    ).resolves.toBeUndefined();
  });

  it('does not create parents when asked not to', async () => {
    const channel = fakeChannel();
    const fs = await connected(channel);
    await fs.writeFile(RemotePath.parse('/tree/a.txt'), new Uint8Array([1]), {
      createParents: false,
    });
    expect(channel.calls.some((call) => call.startsWith('mkdir'))).toBe(false);
  });

  it('refuses to overwrite when overwrite is false', async () => {
    const channel = fakeChannel({ mlst: async () => entry('guarded.txt', { size: 5 }) });
    const fs = await connected(channel);
    await expect(
      fs.writeFile(RemotePath.parse('/guarded.txt'), new Uint8Array([1]), { overwrite: false }),
    ).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'AlreadyExists',
    );
    expect(channel.calls.some((call) => call.startsWith('upload'))).toBe(false);
  });

  it('allows a guarded write when nothing is in the way', async () => {
    const channel = fakeChannel({ hasMlst: false, list: async () => [] });
    const fs = await connected(channel);
    await expect(
      fs.writeFile(RemotePath.parse('/fresh.txt'), new Uint8Array([1]), { overwrite: false }),
    ).resolves.toBeUndefined();
    expect(channel.calls).toContain('upload /home/alice/fresh.txt');
  });

  it('overwrites by default, without a check first', async () => {
    const channel = fakeChannel({ mlst: async () => entry('a.txt') });
    const fs = await connected(channel);
    await fs.writeFile(RemotePath.parse('/a.txt'), new Uint8Array([1]));
    expect(channel.calls.some((call) => call.startsWith('mlst'))).toBe(false);
  });

  it('opens a write stream and releases the channel when it closes', async () => {
    const channel = fakeChannel();
    const chunks: Uint8Array[] = [];
    channel.openWriteStream = async () =>
      new WritableStream<Uint8Array>({
        write: (chunk) => {
          chunks.push(chunk);
        },
      });

    const fs = await connected(channel, { maxConnections: 1 });
    const stream = await fs.createWriteStream(RemotePath.parse('/a.txt'));
    const writer = stream.getWriter();
    await writer.write(new TextEncoder().encode('payload'));
    await writer.close();

    expect(new TextDecoder().decode(chunks[0])).toBe('payload');
    // Deadlocks at a ceiling of one if the stream kept its lease.
    await expect(fs.stat(RemotePath.ROOT)).resolves.toBeDefined();
  });

  it('releases the channel when a write stream is aborted', async () => {
    const channel = fakeChannel();
    channel.openWriteStream = async () => new WritableStream<Uint8Array>();
    const fs = await connected(channel, { maxConnections: 1 });
    const stream = await fs.createWriteStream(RemotePath.parse('/a.txt'));
    await stream.abort('gave up');
    await expect(fs.stat(RemotePath.ROOT)).resolves.toBeDefined();
  });
});

describe('createDirectory', () => {
  it('creates the directory and its ancestors', async () => {
    const channel = fakeChannel({ mlst: async () => entry('deep', { type: 'directory' }) });
    const fs = await connected(channel);
    await fs.createDirectory?.(RemotePath.parse('/a/b/deep'));
    expect(channel.calls).toContain('mkdir /home/alice/a');
    expect(channel.calls).toContain('mkdir /home/alice/a/b');
    expect(channel.calls).toContain('mkdir /home/alice/a/b/deep');
  });

  it('is a no-op on a directory that already exists', async () => {
    // Matching MemoryFileSystem, which is the contract's reference.
    const channel = fakeChannel({ mlst: async () => entry('docs', { type: 'directory' }) });
    channel.mkdir = async () => {
      throw Object.assign(new Error('550 File exists'), { code: 550 });
    };
    const fs = await connected(channel);
    await expect(fs.createDirectory?.(RemotePath.parse('/docs'))).resolves.toBeUndefined();
  });

  it('refuses when a file is in the way', async () => {
    const channel = fakeChannel({ mlst: async () => entry('docs', { type: 'file' }) });
    channel.mkdir = async () => {
      throw Object.assign(new Error('550 File exists'), { code: 550 });
    };
    const fs = await connected(channel);
    await expect(fs.createDirectory?.(RemotePath.parse('/docs'))).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'AlreadyExists',
    );
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @omni-fs/provider-ftp exec vitest run src/ftp-file-system.test.ts`
Expected: FAIL — `FTP provider: writeFile is not implemented yet.`

- [ ] **Step 3: Implement writing**

In `packages/provider-ftp/src/ftp-file-system.ts`, replace the throwing
`writeFile` with these three public methods:

```ts
  async writeFile(path: RemotePath, data: Uint8Array, options?: WriteOptions): Promise<void> {
    const signal = options?.signal;
    await this.#requirePool().lease(async (channel) => {
      await this.#prepareWrite(channel, path, options, signal);
      await channel.upload(this.#remote(path), data, this.#transferOptions(options));
    }, signal);
  }

  async createWriteStream(
    path: RemotePath,
    options?: WriteOptions,
  ): Promise<WritableStream<Uint8Array>> {
    const signal = options?.signal;
    const pool = this.#requirePool();
    const channel = await pool.acquire(signal);
    try {
      await this.#prepareWrite(channel, path, options, signal);
      const stream = await channel.openWriteStream(
        this.#remote(path),
        this.#transferOptions(options),
      );
      return releasingWritable(stream, () => pool.release(channel));
    } catch (error) {
      pool.release(channel);
      throw toOmniFsError(error, path.value);
    }
  }

  async createDirectory(path: RemotePath, signal?: AbortSignal): Promise<void> {
    await this.#requirePool().lease(async (channel) => {
      await this.#mkdirp(channel, path, signal);
      // `MKD` on something that already exists is swallowed above, matching
      // `MemoryFileSystem` — the contract's reference implementation. A *file*
      // in the way is `AlreadyExists`, and only a stat can tell which it was.
      const stat = await this.#stat(channel, path, signal);
      if (stat.type !== 'directory') {
        throw new OmniFsError({
          code: 'AlreadyExists',
          message: `Already exists: ${path.value}`,
          path: path.value,
          providerId: 'ftp',
        });
      }
    }, signal);
  }
```

and add these private helpers:

```ts
  async #prepareWrite(
    channel: FtpChannel,
    path: RemotePath,
    options: WriteOptions | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (options?.createParents !== false) await this.#mkdirp(channel, path.parent, signal);
    if (options?.overwrite === false) await this.#refuseIfPresent(channel, path, signal);
  }

  /**
   * FTP has no exclusive create. `STOR` truncates whatever is there, and there
   * is no flag, no `If-None-Match` and no `wx` — so this is check-then-act,
   * with a race window of one round trip. SFTP got this for free from a `wx`
   * open and WebDAV from `If-None-Match`; this provider cannot, and the
   * difference is written down here rather than hidden behind a method that
   * looks identical from the outside.
   */
  async #refuseIfPresent(
    channel: FtpChannel,
    path: RemotePath,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (!(await this.#exists(channel, path, signal))) return;
    throw new OmniFsError({
      code: 'AlreadyExists',
      message: `Already exists: ${path.value}`,
      path: path.value,
      providerId: 'ftp',
    });
  }

  async #exists(
    channel: FtpChannel,
    path: RemotePath,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    try {
      await this.#stat(channel, path, signal);
      return true;
    } catch (error) {
      if (OmniFsError.is(error) && error.code === 'NotFound') return false;
      throw error;
    }
  }

  /**
   * Creates the ancestor chain with absolute `MKD`s.
   *
   * Not `basic-ftp`'s `ensureDir`, which is built on `CWD` and would leave a
   * pooled channel somewhere the next lease does not expect. An existing
   * directory is success: servers answer 550 or 521 for it and disagree about
   * which, so neither can be read as a failure here.
   */
  async #mkdirp(
    channel: FtpChannel,
    directory: RemotePath,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    let current = RemotePath.ROOT;
    for (const segment of directory.segments) {
      current = current.join(segment);
      try {
        await channel.mkdir(this.#remote(current), signal);
      } catch (error) {
        if (!isReplyCode(error, 550, 521)) throw error;
      }
    }
  }
```

Extend the imports:

```ts
import { OmniFsError, RemotePath, collectStream, streamFrom } from '@omni-fs/core';
import { isReplyCode, toOmniFsError } from './errors.js';
import {
  buildRange,
  joinRemote,
  releasingStream,
  releasingWritable,
  resolveBase,
  toDirEntry,
  toFileStat,
} from './ftp-helpers.js';
```

Note `RemotePath` moves from a type-only import to a value import, because
`#mkdirp` uses `RemotePath.ROOT`.

- [ ] **Step 4: Add the write-side release helper**

Append to `packages/provider-ftp/src/ftp-helpers.ts`:

```ts
/**
 * The write-side twin of `releasingStream`. A write stream's lease ends when
 * the stream does — on `close()`, on `abort()`, or on a failed write — and
 * exactly once either way.
 */
export function releasingWritable(
  target: WritableStream<Uint8Array>,
  onDone: () => void,
): WritableStream<Uint8Array> {
  const writer = target.getWriter();
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    onDone();
  };

  return new WritableStream<Uint8Array>({
    async write(chunk) {
      try {
        await writer.write(chunk);
      } catch (error) {
        release();
        throw error;
      }
    },
    async close() {
      try {
        await writer.close();
      } finally {
        release();
      }
    },
    async abort(reason) {
      try {
        await writer.abort(reason);
      } finally {
        release();
      }
    },
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @omni-fs/provider-ftp test`
Expected: PASS — 40 filesystem tests.

- [ ] **Step 6: Lint, format and commit**

```bash
cd /Users/utain/Workspace/omni-fs
pnpm exec prettier --write packages/provider-ftp/src
pnpm lint
git add packages/provider-ftp/src
git commit -m ":sparkles: feat write ftp files and the directories they need"
```

---

### Task 9: Delete and rename

**Files:**

- Modify: `packages/provider-ftp/src/ftp-file-system.ts` (`delete`, `rename`)
- Test: `packages/provider-ftp/src/ftp-file-system.test.ts`

**Interfaces:**

- Produces: working `delete` and `rename` on `FtpFileSystem`. With these the class implements every method its capabilities claim.

- [ ] **Step 1: Write the failing tests**

Append to `packages/provider-ftp/src/ftp-file-system.test.ts`:

```ts
describe('delete', () => {
  it('unlinks a file', async () => {
    const channel = fakeChannel({ mlst: async () => entry('a.txt') });
    const fs = await connected(channel);
    await fs.delete(RemotePath.parse('/a.txt'));
    expect(channel.calls).toContain('unlink /home/alice/a.txt');
  });

  it('removes an empty directory', async () => {
    const channel = fakeChannel({ mlst: async () => entry('empty', { type: 'directory' }) });
    const fs = await connected(channel);
    await fs.delete(RemotePath.parse('/empty'));
    expect(channel.calls).toContain('rmdir /home/alice/empty');
  });

  it('refuses a non-recursive delete of a directory with something in it', async () => {
    // A caller who asked to remove an empty directory must not silently lose a
    // tree. 550 from RMD means "not empty" as often as "not there", so the
    // listing is what decides which.
    const channel = fakeChannel({
      mlst: async () => entry('full', { type: 'directory' }),
      list: async () => [entry('child.txt')],
    });
    channel.rmdir = async () => {
      throw Object.assign(new Error('550 Directory not empty'), { code: 550 });
    };
    const fs = await connected(channel);
    await expect(fs.delete(RemotePath.parse('/full'))).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'NotEmpty',
    );
  });

  it('walks a tree depth first when recursive', async () => {
    const tree: Record<string, readonly FtpEntry[]> = {
      '/home/alice/tree': [entry('one.txt'), entry('nested', { type: 'directory' })],
      '/home/alice/tree/nested': [entry('two.txt')],
    };
    const channel = fakeChannel({
      mlst: async (path) =>
        path.endsWith('/tree') ? entry('tree', { type: 'directory' }) : entry('x'),
      list: async (path) => tree[path] ?? [],
    });
    const fs = await connected(channel);
    await fs.delete(RemotePath.parse('/tree'), { recursive: true });

    expect(channel.calls).toEqual(
      expect.arrayContaining([
        'unlink /home/alice/tree/nested/two.txt',
        'rmdir /home/alice/tree/nested',
        'unlink /home/alice/tree/one.txt',
        'rmdir /home/alice/tree',
      ]),
    );
    // The deepest directory goes before its parent, or the parent is never empty.
    expect(channel.calls.indexOf('rmdir /home/alice/tree/nested')).toBeLessThan(
      channel.calls.indexOf('rmdir /home/alice/tree'),
    );
  });

  it('stops a recursive walk when the signal aborts', async () => {
    const controller = new AbortController();
    const channel = fakeChannel({
      mlst: async () => entry('tree', { type: 'directory' }),
      list: async () => {
        controller.abort();
        return [entry('one.txt'), entry('two.txt')];
      },
    });
    const fs = await connected(channel);
    await expect(
      fs.delete(RemotePath.parse('/tree'), { recursive: true, signal: controller.signal }),
    ).rejects.toSatisfy((error: unknown) => OmniFsError.is(error) && error.code === 'Cancelled');
  });

  it('reports a missing path as NotFound rather than succeeding quietly', async () => {
    const channel = fakeChannel({ hasMlst: false, list: async () => [] });
    const fs = await connected(channel);
    await expect(fs.delete(RemotePath.parse('/gone.txt'))).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'NotFound',
    );
  });
});

describe('rename', () => {
  it('renames in one command pair on one channel', async () => {
    const channel = fakeChannel();
    const fs = await connected(channel);
    await fs.rename?.(RemotePath.parse('/before.txt'), RemotePath.parse('/after.txt'));
    expect(channel.calls).toContain('rename /home/alice/before.txt /home/alice/after.txt');
  });

  it('refuses to replace the destination when overwrite is false', async () => {
    const channel = fakeChannel({ mlst: async () => entry('after.txt') });
    const fs = await connected(channel);
    await expect(
      fs.rename?.(RemotePath.parse('/before.txt'), RemotePath.parse('/after.txt'), {
        overwrite: false,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && error.code === 'AlreadyExists',
    );
    expect(channel.calls.some((call) => call.startsWith('rename'))).toBe(false);
  });

  it('deletes and retries on a server whose RNTO will not replace', async () => {
    // vsftpd replaces an existing destination; others answer 550. Honouring
    // overwrite: true on the second kind takes two steps.
    let attempts = 0;
    const channel = fakeChannel({ mlst: async () => entry('after.txt') });
    channel.rename = async (from, to) => {
      attempts += 1;
      channel.calls.push(`rename ${from} ${to}`);
      if (attempts === 1) throw Object.assign(new Error('550 File exists'), { code: 550 });
    };

    const fs = await connected(channel);
    await fs.rename?.(RemotePath.parse('/before.txt'), RemotePath.parse('/after.txt'));

    expect(channel.calls).toContain('unlink /home/alice/after.txt');
    expect(attempts).toBe(2);
  });

  it('says out loud that the two-step replace was not atomic', async () => {
    const entries: { level: LogLevel; message: string }[] = [];
    const logger: Logger = {
      log: (level, message) => {
        entries.push({ level, message });
      },
      child: () => logger,
    };

    let attempts = 0;
    const channel = fakeChannel({ mlst: async () => entry('after.txt') });
    channel.rename = async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('550 File exists'), { code: 550 });
    };

    const fs = new FtpFileSystem({ ...context(), logger }, async () => channel);
    await fs.connect();
    await fs.rename?.(RemotePath.parse('/before.txt'), RemotePath.parse('/after.txt'));

    expect(entries.some((e) => e.level === 'warn' && /atomic/i.test(e.message))).toBe(true);
  });

  it('does not delete anything when the source is what was missing', async () => {
    // A 550 from RNFR means the *source* is gone. Deleting the destination
    // then would destroy a file the caller never asked about.
    const channel = fakeChannel({ hasMlst: false, list: async () => [] });
    channel.rename = async () => {
      throw Object.assign(new Error('550 No such file'), { code: 550 });
    };
    const fs = await connected(channel);
    await expect(
      fs.rename?.(RemotePath.parse('/gone.txt'), RemotePath.parse('/after.txt')),
    ).rejects.toSatisfy((error: unknown) => OmniFsError.is(error) && error.code === 'NotFound');
    expect(channel.calls.some((call) => call.startsWith('unlink'))).toBe(false);
  });
});
```

Add `Logger` and `LogLevel` to the type imports at the top of the test file:

```ts
import type { ConnectionConfig, Logger, LogLevel, ProviderContext } from '@omni-fs/core';
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @omni-fs/provider-ftp exec vitest run src/ftp-file-system.test.ts`
Expected: FAIL — `FTP provider: delete is not implemented yet.`

- [ ] **Step 3: Implement delete and rename**

In `packages/provider-ftp/src/ftp-file-system.ts`, replace the throwing
`delete` with:

```ts
  async delete(path: RemotePath, options?: DeleteOptions): Promise<void> {
    const signal = options?.signal;
    await this.#requirePool().lease(async (channel) => {
      // The stat is not overhead: 550 from `DELE` on a directory and 550 from
      // `RMD` on a non-empty one are the same reply, and sending the wrong
      // command first would make a missing file and a full directory
      // indistinguishable.
      const stat = await this.#stat(channel, path, signal);

      if (stat.type !== 'directory') {
        await channel.unlink(this.#remote(path), signal);
        return;
      }
      if (options?.recursive === true) {
        await this.#deleteTree(channel, path, signal);
        return;
      }
      await this.#removeDirectory(channel, path, signal);
    }, signal);
  }

  async rename(from: RemotePath, to: RemotePath, options?: OverwriteOptions): Promise<void> {
    const signal = options?.signal;
    await this.#requirePool().lease(async (channel) => {
      if (options?.overwrite === false) await this.#refuseIfPresent(channel, to, signal);

      try {
        await channel.rename(this.#remote(from), this.#remote(to), signal);
      } catch (error) {
        if (options?.overwrite === false || !isReplyCode(error, 550)) throw error;

        // A 550 here means either "the destination is in the way" or "the
        // source is gone", and only a look can say which. Deleting on the
        // second reading would destroy a file the caller never named.
        if (!(await this.#exists(channel, to, signal))) throw error;

        this.#logger.log(
          'warn',
          'FTP rename replaced the destination in two steps, which is not atomic',
          { from: from.value, to: to.value },
        );
        await channel.unlink(this.#remote(to), signal);
        await channel.rename(this.#remote(from), this.#remote(to), signal);
      }
    }, signal);
  }
```

and add the two private helpers:

```ts
  /**
   * Depth first, because a parent cannot be removed until it is empty. The
   * abort check is between entries rather than around the walk: a tree delete
   * is many round trips, and a cancelled one should stop at the next of them
   * rather than run to completion.
   */
  async #deleteTree(
    channel: FtpChannel,
    directory: RemotePath,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const entries = await channel.list(this.#remote(directory), signal);
    for (const child of entries) {
      throwIfAborted(signal, directory.join(child.name).value);
      const childPath = directory.join(child.name);
      if (child.type === 'directory') await this.#deleteTree(channel, childPath, signal);
      else await channel.unlink(this.#remote(childPath), signal);
    }
    await channel.rmdir(this.#remote(directory), signal);
  }

  async #removeDirectory(
    channel: FtpChannel,
    directory: RemotePath,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    try {
      await channel.rmdir(this.#remote(directory), signal);
    } catch (error) {
      if (!isReplyCode(error, 550)) throw error;
      const entries = await channel.list(this.#remote(directory), signal).catch(() => []);
      if (entries.length === 0) throw error;
      throw new OmniFsError({
        code: 'NotEmpty',
        message: `Directory is not empty: ${directory.value}`,
        path: directory.value,
        providerId: 'ftp',
        cause: error,
      });
    }
  }
```

Extend the imports once more:

```ts
import { OmniFsError, RemotePath, collectStream, streamFrom, throwIfAborted } from '@omni-fs/core';
import type { DeleteOptions, /* … */ OverwriteOptions /* … */ } from '@omni-fs/core';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @omni-fs/provider-ftp test`
Expected: PASS — 51 filesystem tests.

- [ ] **Step 5: Check the class now matches what it claims**

Every capability `FTP_CAPABILITIES` declares true must have its method. Confirm
by reading the class: `canWrite` → `writeFile`, `canRename` → `rename`,
`canCreateDirectory` → `createDirectory`, `canStreamWrite` →
`createWriteStream`, `canReadRange` → the `range` path in `createReadStream`,
`canDeleteRecursive` → `#deleteTree`. `canCopyServerSide` is false and there is
no `copy` method; `canWatch` is false and there is no `watch`. No `Unsupported`
stub remains in the file.

Run: `grep -n "notImplemented" packages/provider-ftp/src/ftp-file-system.ts`
Expected: no output. Delete the now-unused `notImplemented` function if the
grep finds its definition.

- [ ] **Step 6: Lint, format and commit**

```bash
cd /Users/utain/Workspace/omni-fs
pnpm exec prettier --write packages/provider-ftp/src
pnpm lint
git add packages/provider-ftp/src
git commit -m ":sparkles: feat delete and rename over ftp including a recursive walk"
```

---

### Task 10: The provider definition, and the one core comment

The package becomes usable from outside. `apps/vscode/src/extension.ts` already
imports `ftpProvider` and registers it, so this task is what turns that
existing line from a skeleton into a working protocol — no host change at all,
which is the whole point of `ProviderRegistry`.

**Files:**

- Rewrite: `packages/provider-ftp/src/index.ts`
- Modify: `packages/core/src/capabilities.ts` (the `maxConcurrency` comment)

**Interfaces:**

- Produces: `ftpProvider: ProviderDefinition`, plus re-exports of `FTP_CAPABILITIES`, `FtpFileSystem`, `FTP_SETTINGS_SCHEMA`, `FTP_SECRET_SCHEMA`, `readSettings`, and the settings types.

- [ ] **Step 1: Rewrite the index**

Replace the entire contents of `packages/provider-ftp/src/index.ts` — the
schemas and capabilities it currently declares now live in `settings.ts` and
`ftp-file-system.ts`, and the `TODO(provider-ftp)` block this plan implements
goes with it:

```ts
import type { ProviderDefinition } from '@omni-fs/core';
import { FTP_CAPABILITIES, FtpFileSystem } from './ftp-file-system.js';
import { FTP_SECRET_SCHEMA, FTP_SETTINGS_SCHEMA } from './settings.js';

/**
 * What a host needs from this package: one definition object. Adding FTP
 * support is `registry.register(ftpProvider)`, and it teaches the host nothing
 * about control channels or TLS modes. The re-exports below expose the pieces
 * it is built from, for callers that construct or inspect them directly.
 */
export const ftpProvider: ProviderDefinition = {
  id: 'ftp',
  displayName: 'FTP / FTPS',
  schemes: ['ftp', 'ftps'],
  settingsSchema: FTP_SETTINGS_SCHEMA,
  secretSchema: FTP_SECRET_SCHEMA,
  defaultCapabilities: FTP_CAPABILITIES,
  create: (context) => new FtpFileSystem(context),
};

export { FTP_CAPABILITIES, FtpFileSystem } from './ftp-file-system.js';
export { FTP_SECRET_SCHEMA, FTP_SETTINGS_SCHEMA, readSettings } from './settings.js';
export type { FtpSecureMode, FtpSettings, FtpTlsMinVersion } from './settings.js';
export { FtpControlChannel } from './ftp-channel.js';
export type { FtpChannel, FtpChannelOptions, OpenChannel } from './ftp-channel.js';
export { FtpPool } from './ftp-pool.js';
```

- [ ] **Step 2: Sharpen the capability comment in core**

In `packages/core/src/capabilities.ts`, replace the `maxConcurrency` comment:

```ts
  /**
   * Safe number of in-flight operations this connection can carry. S3 is happy
   * with 16+ over one HTTPS client.
   *
   * FTP carries one command per control connection, so `provider-ftp` answers
   * with the size of its channel pool — a per-connection setting, which also
   * falls when a server refuses another login. That makes this the first
   * capability whose value is neither a constant nor a property of the server,
   * and it is safe because `TransferQueue` reads it at call time rather than
   * caching it at connect.
   */
  readonly maxConcurrency: number;
```

- [ ] **Step 3: Build and typecheck everything downstream**

Packages resolve each other through `dist/`, so the extension's typecheck means
nothing until core and the provider are rebuilt.

```bash
cd /Users/utain/Workspace/omni-fs
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Expected: all green. `apps/vscode` needs no source change — it already
registers `ftpProvider`.

- [ ] **Step 4: Confirm the boundary still holds**

```bash
grep -rnE "from '(vscode|electron)'" packages/ --include='*.ts' --include='*.tsx'
grep -rnE "from '(@aws-sdk/|basic-ftp|ssh2|webdav)" packages/core/src --include='*.ts'
```

Expected: no output from either. These are the two CI grep jobs; running them
here is cheaper than finding out from a red build.

- [ ] **Step 5: Commit**

```bash
cd /Users/utain/Workspace/omni-fs
pnpm exec prettier --write packages/provider-ftp/src/index.ts packages/core/src/capabilities.ts
git add packages/provider-ftp/src/index.ts packages/core/src/capabilities.ts
git commit -m ":sparkles: feat register the ftp provider definition"
```

---

### Task 11: The test server

Three listeners, one container, built here rather than pulled — for the reasons
`docker/sftp`'s own comment gives: the widely-used images are either single
architecture or configure auth through a bespoke schema, and a mutable tag
means the test server is whatever was pushed today.

**Files:**

- Create: `docker/ftp/Dockerfile`
- Create: `docker/ftp/entrypoint.sh`
- Create: `docker/ftp/vsftpd-common.conf`, `docker/ftp/explicit.conf`, `docker/ftp/implicit.conf`, `docker/ftp/legacy.conf`
- Create: `docker/ftp/openssl-legacy.cnf`
- Modify: `compose.yaml`

- [ ] **Step 1: Write the shared configuration**

Create `docker/ftp/vsftpd-common.conf`:

```
# Shared by all three listeners. Everything here is throwaway: the credentials
# are committed on purpose and must never be used anywhere real.
listen=YES
listen_ipv6=NO
background=NO
anonymous_enable=NO
local_enable=YES
write_enable=YES
local_umask=022
dirmessage_enable=NO
xferlog_enable=YES
xferlog_stdout=YES

# Not chrooted, on purpose: the login directory is /data and the server's
# filesystem root stays reachable, which is what gives the absolute rootPrefix
# rule something real to name. docker/sftp does not chroot either.
chroot_local_user=NO

# Containers and vsftpd's sandbox do not agree, and the sandbox buys nothing
# for a throwaway test server.
seccomp_sandbox=NO
secure_chroot_dir=/var/run/vsftpd/empty

pasv_enable=YES
pasv_address=127.0.0.1
pasv_addr_resolve=NO

ssl_enable=YES
allow_anon_ssl=NO
rsa_cert_file=/etc/vsftpd/vsftpd.crt
rsa_private_key_file=/etc/vsftpd/vsftpd.key
```

Create `docker/ftp/explicit.conf`:

```
# Plain FTP *and* AUTH TLS on the same port: TLS is enabled but not forced, so
# one listener covers two of the three modes the provider offers.
listen_port=21
implicit_ssl=NO
force_local_logins_ssl=NO
force_local_data_ssl=NO
pasv_min_port=21000
pasv_max_port=21010
```

Create `docker/ftp/implicit.conf`:

```
# TLS on connect, no AUTH TLS negotiation. Forced by construction.
listen_port=990
implicit_ssl=YES
force_local_logins_ssl=YES
force_local_data_ssl=YES
pasv_min_port=21011
pasv_max_port=21021
```

Create `docker/ftp/legacy.conf`:

```
# A 2012-era server, on purpose: the target for tlsMinVersion. The version cap
# itself is not here — vsftpd can enable TLS 1.0 but cannot forbid 1.2 — so the
# entrypoint runs this instance under an OpenSSL config that pins the range.
listen_port=2100
implicit_ssl=NO
force_local_logins_ssl=YES
force_local_data_ssl=YES
ssl_sslv2=NO
ssl_sslv3=NO
ssl_tlsv1=YES
ssl_ciphers=DEFAULT@SECLEVEL=0
pasv_min_port=21022
pasv_max_port=21032
```

- [ ] **Step 2: Write the OpenSSL config that caps the legacy listener**

Create `docker/ftp/openssl-legacy.cnf`:

```
# vsftpd has no setting for "TLS 1.0 and nothing newer" — ssl_tlsv1 enables
# TLS 1.0 without disabling anything above it. OpenSSL does, so the legacy
# instance runs with this as OPENSSL_CONF and the range is pinned at the
# library. Without it the listener would accept TLS 1.3 and the test asserting
# that a raised floor is refused would pass for the wrong reason.
openssl_conf = default_conf

[default_conf]
ssl_conf = ssl_sect

[ssl_sect]
system_default = system_default_sect

[system_default_sect]
MinProtocol = TLSv1
MaxProtocol = TLSv1
CipherString = DEFAULT@SECLEVEL=0
Options = UnsafeLegacyRenegotiation
```

- [ ] **Step 3: Write the entrypoint**

Create `docker/ftp/entrypoint.sh`:

```sh
#!/bin/sh
# Three listeners, one container. The implicit and legacy instances go to the
# background and the explicit one is exec'd, so the container's main process is
# a real server rather than a shell — a shell would swallow signals and make
# `docker compose down` slow and untidy.
set -e

mkdir -p /var/run/vsftpd/empty

vsftpd /etc/vsftpd/implicit.conf &
OPENSSL_CONF=/etc/vsftpd/openssl-legacy.cnf vsftpd /etc/vsftpd/legacy.conf &

exec vsftpd /etc/vsftpd/explicit.conf
```

- [ ] **Step 4: Write the Dockerfile**

Create `docker/ftp/Dockerfile`:

```dockerfile
# A minimal FTP/FTPS server with three listeners: plain and explicit TLS on 21,
# implicit TLS on 990, and a TLS-1.0-only listener on 2100 for the legacy
# server the tlsMinVersion setting exists to reach.
#
# Built here rather than pulled, and pinned by digest, for the same reasons
# docker/sftp is: a tag is mutable, so the test server would otherwise be
# whatever was pushed under it today. The digest is the manifest list, not one
# platform's image, so this still builds natively on both runners and laptops.
# Dependabot's docker ecosystem bumps it when Alpine ships a patch.
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc

RUN apk add --no-cache vsftpd openssl \
  && adduser -D -u 1001 -h /data omnifs \
  && echo 'omnifs:omnifs-dev-secret' | chpasswd \
  && mkdir -p /data /var/run/vsftpd/empty /etc/vsftpd \
  && chown omnifs:omnifs /data \
  && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
       -subj '/CN=localhost' \
       -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
       -keyout /etc/vsftpd/vsftpd.key \
       -out /etc/vsftpd/vsftpd.crt \
  && chmod 600 /etc/vsftpd/vsftpd.key

COPY vsftpd-common.conf /etc/vsftpd/vsftpd-common.conf
COPY explicit.conf /etc/vsftpd/explicit.conf.part
COPY implicit.conf /etc/vsftpd/implicit.conf.part
COPY legacy.conf /etc/vsftpd/legacy.conf.part
COPY openssl-legacy.cnf /etc/vsftpd/openssl-legacy.cnf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

# vsftpd takes one config file and has no include directive, so the shared part
# is concatenated in at build time rather than repeated three times by hand.
RUN for name in explicit implicit legacy; do \
      cat /etc/vsftpd/vsftpd-common.conf "/etc/vsftpd/$name.conf.part" > "/etc/vsftpd/$name.conf"; \
      rm "/etc/vsftpd/$name.conf.part"; \
    done \
  && chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 21 990 2100 21000-21032
CMD ["/usr/local/bin/entrypoint.sh"]
```

- [ ] **Step 5: Point compose at it**

In `compose.yaml`, replace the whole `ftp` service and its comment with:

```yaml
# --- FTP / FTPS ------------------------------------------------------------
# Three listeners, all serving the same /data volume as the same user:
#   2121 -> 21    plain FTP and explicit AUTH TLS
#   2990 -> 990   implicit TLS on connect
#   2100 -> 2100  TLS 1.0 only, the legacy server tlsMinVersion exists for
# Passive mode needs the data ports published too, or listings hang.
ftp:
  build: ./docker/ftp
  ports:
    - '127.0.0.1:2121:21'
    - '127.0.0.1:2990:990'
    - '127.0.0.1:2100:2100'
    - '127.0.0.1:21000-21032:21000-21032'
  volumes:
    - ftp-data:/data
```

and update the file's header comment, which currently says FTP "is still a
skeleton that throws `Unsupported` from connect()", to say that all four
providers implement the conformance suite.

The `file-seed` service already chowns the FTP volume to `1001:1001`, which is
the uid this image's `omnifs` user is created with, so its `ftp-data:/seed/ftp`
mount needs no change.

- [ ] **Step 6: Prove the server actually serves**

This is the step that catches the two risks the spec flagged as gating, and it
is worth doing before writing a line of the live test.

```bash
cd /Users/utain/Workspace/omni-fs
docker compose up -d --build ftp file-seed
docker compose ps
```

Then check each listener from the host:

```bash
# Plain FTP on 2121 — should print the seeded tree.
curl -s --ftp-pasv ftp://omnifs:omnifs-dev-secret@localhost:2121/

# Explicit TLS on the same port.
curl -s -k --ssl-reqd --ftp-pasv ftp://omnifs:omnifs-dev-secret@localhost:2121/

# Implicit TLS on 2990.
curl -s -k --ftp-pasv ftps://omnifs:omnifs-dev-secret@localhost:2990/

# TLS 1.0 only on 2100. --tlsv1.0 --tls-max 1.0 makes the client match.
curl -s -k --ssl-reqd --ftp-pasv --tlsv1.0 --tls-max 1.0 \
  ftp://omnifs:omnifs-dev-secret@localhost:2100/
```

Expected: each prints a listing containing `readme.txt`, `docs` and `data`.

**If the explicit or implicit TLS listing hangs after the login succeeds**,
`require_ssl_reuse` is the cause: the data connection is not resuming the
control connection's TLS session. Confirm with
`docker compose logs ftp | tail -30`, then add `require_ssl_reuse=NO` to
`vsftpd-common.conf` **with a comment saying the reuse path is therefore not
covered here** — a silent flip would leave the live suite proving less than its
name claims.

**If the 2100 listener refuses every connection**, Alpine's OpenSSL was built
without TLS 1.0 and no configuration brings it back. Drop the legacy listener,
its config, its ports and the fourth conformance run, keep the low-version path
covered by the `buildAccessOptions` tests from Task 4, and say plainly in
`docker/README.md` that no server here speaks TLS 1.0.

- [ ] **Step 7: Commit**

```bash
cd /Users/utain/Workspace/omni-fs
pnpm exec prettier --write compose.yaml
git add docker/ftp compose.yaml
git commit -m ":construction_worker: ci serve ftp plain explicit implicit and legacy tls"
```

---

### Task 12: The live suite, CI and the docs

**Files:**

- Create: `packages/provider-ftp/src/ftp.live.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `docker/README.md`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: Write the live test**

Create `packages/provider-ftp/src/ftp.live.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { NOOP_LOGGER, OmniFsError, RemotePath } from '@omni-fs/core';
import type { ConnectionConfig, FileType, Logger, LogLevel, RemoteFileSystem } from '@omni-fs/core';
import { runConformanceSuite } from '@omni-fs/testing';
import { FtpControlChannel } from './ftp-channel.js';
import { FtpFileSystem } from './ftp-file-system.js';
import { readSettings } from './settings.js';

const HOST = process.env['OMNI_FS_FTP_HOST'] ?? 'localhost';
const PORT = Number(process.env['OMNI_FS_FTP_PORT'] ?? '2121');
const IMPLICIT_PORT = Number(process.env['OMNI_FS_FTP_IMPLICIT_PORT'] ?? '2990');
const LEGACY_PORT = Number(process.env['OMNI_FS_FTP_LEGACY_PORT'] ?? '2100');
const USERNAME = process.env['OMNI_FS_FTP_USER'] ?? 'omnifs';
const PASSWORD = process.env['OMNI_FS_FTP_PASSWORD'] ?? 'omnifs-dev-secret';
/** The seeded volume. Absolute on purpose: it is also the test of that rule. */
const ROOT_PREFIX = process.env['OMNI_FS_FTP_ROOT'] ?? '/data';

/** The server's certificate is self-signed at build, so every run must say so. */
const BASE = {
  host: HOST,
  port: PORT,
  username: USERNAME,
  secure: 'explicit',
  allowSelfSigned: true,
  rootPrefix: ROOT_PREFIX,
} as const;

function connect(
  settings: Readonly<Record<string, unknown>> = {},
  logger: Logger = NOOP_LOGGER,
): FtpFileSystem {
  const config: ConnectionConfig = {
    id: 'live',
    providerId: 'ftp',
    label: 'live',
    settings: { ...BASE, ...settings },
  };
  return new FtpFileSystem({
    config,
    getSecret: async () => ({ password: PASSWORD }),
    logger,
  });
}

/**
 * A transport-only channel, for setup and cleanup that must not use the
 * methods under test. A cleanup that ran through one could not fail safely,
 * and one failure leaves a `conformance-*` directory behind for every run
 * after it — the reason `provider-sftp` has `withTransport` too.
 */
async function withTransport<T>(body: (channel: FtpControlChannel) => Promise<T>): Promise<T> {
  const channel = await FtpControlChannel.open({
    settings: readSettings({ ...BASE }),
    secret: { password: PASSWORD },
    logger: NOOP_LOGGER,
  });
  try {
    return await body(channel);
  } finally {
    await channel.close();
  }
}

/**
 * The type travels with the recursion rather than being probed for. `LIST` on a
 * *file* answers with that file on several servers, so a type-blind walk would
 * recurse forever on a name that is never going to be a directory — and this
 * runs in cleanup, where a hang is a stuck CI job rather than a failed test.
 */
async function removeTree(
  channel: FtpControlChannel,
  absolute: string,
  type: FileType,
): Promise<void> {
  if (type !== 'directory') {
    await channel.unlink(absolute).catch(() => undefined);
    return;
  }
  const entries = await channel.list(absolute).catch(() => []);
  for (const child of entries) {
    await removeTree(channel, `${absolute}/${child.name}`, child.type);
  }
  await channel.rmdir(absolute).catch(() => undefined);
}

/**
 * Readiness is the suite's job, not a compose flag: `docker compose up -d`
 * returns before vsftpd is listening, and the workflow starts the tests a
 * second later.
 */
beforeAll(async () => {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await withTransport(async (channel) => channel.pwd());
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}, 70_000);

const roots = new WeakMap<RemoteFileSystem, RemotePath>();
let counter = 0;

function runLiveSuite(name: string, settings: Readonly<Record<string, unknown>>): void {
  runConformanceSuite({
    name,
    setup: async () => {
      const fs = connect(settings);
      await fs.connect();
      const root = RemotePath.parse(`/conformance-${Date.now()}-${(counter += 1)}`);
      await fs.createDirectory(root);
      roots.set(fs, root);
      return { fs, root };
    },
    teardown: async (fs) => {
      const root = roots.get(fs);
      roots.delete(fs);
      if (root !== undefined) {
        await withTransport((channel) =>
          removeTree(channel, `${ROOT_PREFIX}${root.value}`, 'directory'),
        );
      }
      await fs[Symbol.asyncDispose]();
    },
  });
}

runLiveSuite('FTP (plain, vsftpd)', { secure: 'none' });
runLiveSuite('FTPS (explicit AUTH TLS, vsftpd)', { secure: 'explicit' });
runLiveSuite('FTPS (implicit TLS, vsftpd)', { secure: 'implicit', port: IMPLICIT_PORT });
runLiveSuite('FTPS (TLS 1.0 legacy, vsftpd)', {
  secure: 'explicit',
  port: LEGACY_PORT,
  tlsMinVersion: 'TLSv1',
});

describe('FTP live behaviour the shared suite cannot express', () => {
  it('lands in the login directory when the root prefix is empty', async () => {
    const fs = connect({ rootPrefix: '' });
    await fs.connect();
    try {
      const entries = await collect(fs.list(RemotePath.ROOT));
      expect(entries.map((entry) => entry.name)).toContain('readme.txt');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('puts a relative root prefix below the login directory', async () => {
    const fs = connect({ rootPrefix: 'docs' });
    await fs.connect();
    try {
      const entries = await collect(fs.list(RemotePath.ROOT));
      expect(entries.map((entry) => entry.name)).toContain('guide.md');
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('carries a modification time, because this server offers MLSD', async () => {
    const fs = connect();
    await fs.connect();
    try {
      const stat = await fs.stat(RemotePath.parse('/readme.txt'));
      expect(stat.mtime).toBeGreaterThan(0);
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('refuses a self-signed certificate when the setting is off, and says which setting', async () => {
    const fs = connect({ allowSelfSigned: false });
    await expect(fs.connect()).rejects.toSatisfy(
      (error: unknown) =>
        OmniFsError.is(error) &&
        error.code === 'ConnectionFailed' &&
        /Allow self-signed certificates/.test(error.message),
    );
  });

  it('still reaches a modern server with the TLS floor lowered', async () => {
    // Lowering the floor must not break a good server: this connection should
    // negotiate the same version it always would have.
    const fs = connect({ tlsMinVersion: 'TLSv1' });
    await expect(fs.connect()).resolves.toBeUndefined();
    await fs[Symbol.asyncDispose]();
  });

  it('is refused by the legacy server when the TLS floor is raised above it', async () => {
    // The other direction, which is the one that proves the setting is wired
    // to the socket at all. A knob only ever tested where it succeeds has not
    // been tested.
    const fs = connect({ port: LEGACY_PORT, tlsMinVersion: 'TLSv1.3' });
    await expect(fs.connect()).rejects.toSatisfy(
      (error: unknown) => OmniFsError.is(error) && /Minimum TLS version/.test(error.message),
    );
  });

  it('overlaps transfers when the pool is allowed more than one channel', async () => {
    const fs = connect({ maxConnections: 3 });
    await fs.connect();
    try {
      expect(fs.capabilities.maxConcurrency).toBe(3);

      const reads = await Promise.all([
        fs.readFile(RemotePath.parse('/data/large.bin')),
        fs.readFile(RemotePath.parse('/data/large.bin')),
        fs.readFile(RemotePath.parse('/data/large.bin')),
      ]);

      // The claim is not that this was faster — a single channel would finish
      // too, only serially. It is that three transfers overlapping on three
      // logins each came back whole, which is what breaks if the pool ever
      // hands the same control channel to two of them. `large.bin` is the 1 MiB
      // file `file-seed` writes.
      expect(reads.map((bytes) => bytes.byteLength)).toEqual([1048576, 1048576, 1048576]);

      // And that the ceiling never fell, i.e. the server really did allow three.
      expect(fs.capabilities.maxConcurrency).toBe(3);
    } finally {
      await fs[Symbol.asyncDispose]();
    }
  });

  it('warns that a replacing rename was not atomic', async () => {
    const entries: { level: LogLevel; message: string }[] = [];
    const logger: Logger = {
      log: (level, message) => {
        entries.push({ level, message });
      },
      child: () => logger,
    };

    const fs = connect({}, logger);
    await fs.connect();
    const dir = RemotePath.parse(`/rename-${Date.now()}`);
    try {
      await fs.createDirectory(dir);
      await fs.writeFile(dir.join('from.txt'), new TextEncoder().encode('a'));
      await fs.writeFile(dir.join('to.txt'), new TextEncoder().encode('b'));
      await fs.rename(dir.join('from.txt'), dir.join('to.txt'));

      // The replace happened, whichever route it took.
      expect(new TextDecoder().decode(await fs.readFile(dir.join('to.txt')))).toBe('a');

      // And on *this* server it took the atomic one: vsftpd's RNTO replaces an
      // existing destination, so the delete-then-retry fallback must not have
      // run. The warning itself is pinned by the hermetic test in
      // ftp-file-system.test.ts, against a server that refuses. If this ever
      // starts warning, vsftpd changed behaviour and the two-step path is now
      // live here — which is worth knowing, and is what makes this assertion
      // strict rather than decorative.
      expect(entries.some((entry) => entry.level === 'warn' && /atomic/i.test(entry.message))).toBe(
        false,
      );
    } finally {
      await withTransport((channel) =>
        removeTree(channel, `${ROOT_PREFIX}${dir.value}`, 'directory'),
      );
      await fs[Symbol.asyncDispose]();
    }
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
```

- [ ] **Step 2: Run the live suite**

```bash
cd /Users/utain/Workspace/omni-fs
docker compose up -d --build
pnpm build
pnpm --filter @omni-fs/provider-ftp test:conformance
```

Expected: four conformance runs pass, plus the eight FTP-specific cases.

This is the step where the protocol meets reality, so expect to iterate. The
failures worth anticipating:

- **Listings hang on a TLS listener** → `require_ssl_reuse`, per Task 11 Step 6.
- **`stat` of the connection root fails on the plain listener** → the `MLST`
  reply for the base directory is parsed but the pathname is `/data` rather
  than a child; confirm `parseMlstResponse` handles it and that
  `#stat` short-circuits `path.isRoot` before the parent listing.
- **The recursive delete leaves the outermost directory** → `RMD` ran while a
  child listing was still in flight on the same channel; every call inside
  `#deleteTree` must be awaited in order.
- **A bounded-range read hangs the next operation** → the poisoned channel was
  returned to the pool instead of discarded; check `release()` consults
  `isAlive()`.

- [ ] **Step 3: Run the whole conformance suite, all four providers**

```bash
pnpm test:conformance
```

Expected: S3, WebDAV, SFTP and FTP all green. This is what the new CI job will
run, so it has to pass locally first.

- [ ] **Step 4: Add the CI job**

In `.github/workflows/ci.yml`, add this job after `extension-tests-live`:

```yaml
conformance-live:
  name: conformance (live)
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

    # The providers resolve @omni-fs/core through dist/, so the suite would
    # run against a stale build without this.
    - run: pnpm build

    # --build because docker/sftp and docker/ftp are built here rather than
    # pulled. Readiness is the suites' job: each retries its first call for
    # up to 60s, so starting the tests a second after `up` is fine.
    - run: docker compose up -d --build

    - run: pnpm test:conformance

    # The one job a contributor cannot reproduce without Docker, and a
    # container that never came up reaches the log as a single assertion.
    # Failure-only, so the green path pays nothing.
    - if: failure()
      run: docker compose ps && docker compose logs --tail=50
```

Linux only, like `extension-tests-live`: the compose stack is the reason, and
running it three times would treble the cost for no extra signal.

- [ ] **Step 5: Update the docs**

`docker/README.md` — move FTP out of "not yet implemented" and give it a
section naming the three listeners (`2121` plain and explicit, `2990` implicit,
`2100` TLS 1.0 only), the credentials (`omnifs` / `omnifs-dev-secret`), and the
root prefix `/data`.

`README.md` — three edits:

- Line ~39, which says FTP "allows one operation at a time, so bulk uploads
  serialise": this is now the _default_, not the ceiling. Say that FTP carries
  one command per control connection, and that the provider opens a pool whose
  size is a per-connection setting, defaulting to one.
- The protocol table row for **FTP / FTPS**: 🚧 Scaffolded becomes
  ✅ Implemented, and the notes column mentions the configurable TLS floor.
- The roadmap checkbox `- [ ] FTP / FTPS provider` becomes `- [x]`. This is the
  last one.

`CLAUDE.md` — the "Current state" paragraph: FTP is no longer "a deliberate
skeleton: capabilities and schemas declared, methods throwing `Unsupported`".
All four protocols are implemented and all four pass `pnpm test:conformance`
against the compose stack, which CI now runs.

- [ ] **Step 6: Full verification**

```bash
cd /Users/utain/Workspace/omni-fs
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
docker compose up -d --build
pnpm test:conformance
pnpm test:extension
```

Expected: all green. Every command's output must be read, not assumed — a
claim that this passes is worth exactly as much as the output behind it.

- [ ] **Step 7: Commit**

```bash
cd /Users/utain/Workspace/omni-fs
pnpm exec prettier --write packages/provider-ftp/src/ftp.live.test.ts .github/workflows/ci.yml docker/README.md README.md CLAUDE.md
git add packages/provider-ftp/src/ftp.live.test.ts .github/workflows/ci.yml docker/README.md README.md CLAUDE.md
git commit -m ":white_check_mark: test run the shared conformance suite against live ftp and ftps"
```

---

## Done when

- `pnpm test` passes with no Docker running, and covers settings, errors,
  helpers, the channel, the pool and the file system.
- `pnpm test:conformance` passes for all four providers against
  `docker compose up -d --build`, with FTP running the shared suite four times:
  plain, explicit TLS, implicit TLS, and TLS 1.0 against the legacy listener.
- `pnpm build`, `pnpm typecheck`, `pnpm lint` and `pnpm format:check` are green
  on Linux, macOS and Windows.
- `pnpm test:extension` still passes: the extension registers a provider that
  now works, and nothing in `apps/vscode` changed.
- Neither CI grep job has anything to say: no host import in `packages/`, no
  protocol SDK in `packages/core`.
- `FTP_CAPABILITIES` declares nothing the class does not implement, and
  implements nothing it declares false.
- `README.md`'s protocol table has no 🚧 left in it.

## Deliberately not done

These are named so a reviewer does not read them as omissions:

- **No `copy` method.** `canCopyServerSide: false` is true of FTP, so
  `ManagedFileSystem` streams a copy down and back up.
- **No `watch`.** `canWatch: false`, and core does not poll — the same answer
  the other three give.
- **No append method**, though `canAppend` is true: `RemoteFileSystem` exposes
  no append operation, and inventing one is not this phase.
- **No `MFMT`.** No `WriteOption` carries a client mtime, so
  `preservesMTime: false` is honest.
- **No maximum TLS version.** A server that breaks on a TLS 1.3 handshake is
  rarer than one that needs TLS 1.0, and adding the field later is one line.
- **No active mode.** Passive only, which is what works from behind NAT.
- **No `ABOR`.** Spec decision 6: the recovery path would end in a discarded
  channel anyway, by a more complicated route.
- **No download/upload commands.** The extension's local-file stubs stay stubs;
  that phase needs a `LocalFiles` port.
- **No `rootPath` / `rootPrefix` consolidation.** Still its own plan.
