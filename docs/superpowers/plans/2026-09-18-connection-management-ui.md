# Connection Management UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the eight-prompt connection wizard in the VS Code extension with a two-pane connection manager whose state machine and components are reused unchanged by the future desktop app.

**Architecture:** Three layers. `packages/core/src/forms/` holds a pure draft model (no React, no DOM). A new `packages/ui` package holds the React state machine and our own components over native HTML elements, talking to the host through a single serializable Port, `ConnectionsBackend`. `apps/vscode/src/webview/` implements that Port over `postMessage` and hosts the panel. Dependency arrows point one way: `ui -> core`, `apps/* -> ui`.

**Tech Stack:** TypeScript 6.0.x, React 19, vitest 5, esbuild, pnpm workspaces, turborepo. No widget library — `@vscode/webview-ui-toolkit` is deprecated and its successor hard-codes VS Code theming.

**Spec:** `docs/superpowers/specs/2026-09-18-connection-management-ui-design.md`

## Global Constraints

- **Nothing in `packages/` may import `vscode` or `electron`.** Nothing in `packages/core` may import a protocol SDK. Enforced by ESLint and a CI grep.
- **TypeScript is held at 6.0.x.** Do not upgrade it. `@types/node` is held at 22.
- **Strictness is high:** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`. Optional properties need an explicit `| undefined`. Type-only imports need `import type`.
- **Commits are a single title line:** `:emoji: <type> <description>`, matching `^:[a-z0-9_+-]+: (feat|fix|docs|refactor|test|build|chore|perf|style|ci) .+`. **No body. No `Co-Authored-By`. No session attribution.** CI enforces both.
- **Prettier settings:** `semi: true`, `singleQuote: true`, `printWidth: 100`, `trailingComma: 'all'`, `arrowParens: 'always'`. Run `pnpm format` before committing; CI runs `pnpm format:check`.
- **`.npmrc` sets `hoist=false`:** a package may only import what its own `package.json` declares.
- **Imports use the `.js` extension** even from `.ts`/`.tsx` sources (`module: Node16`).
- **The `.vsix` must stay under 2 MB.** The packaging job fails otherwise.
- **`packages/*` build with `tsc -b`** (composite projects). After changing core, run `pnpm build` before the extension's typecheck means anything — it resolves `@omni-fs/core` through `dist/`.

---

## File Structure

**Created:**

| File                                                  | Responsibility                                                                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/forms/types.ts`                    | `ConnectionDraft`, `SecretFieldState`, `FieldError`, `ProviderSummary`, `SecretPatchEntry`                                                           |
| `packages/core/src/forms/draft.ts`                    | `createDraft`, `setLabel`, `setField`, `clearSecretField`, `setRootPath`, `setReadOnly`, `isDirty`, `toConfig`, `toSecretPatch`, `toProviderSummary` |
| `packages/core/src/forms/validation.ts`               | `validateDraft`, `validateField`                                                                                                                     |
| `packages/core/src/forms/secret-merge.ts`             | `mergeSecret` — stored + patch, pruned to the schema                                                                                                 |
| `packages/core/src/forms/*.test.ts`                   | vitest for the above                                                                                                                                 |
| `packages/ui/src/ports/connections-backend.ts`        | the Port: `ConnectionsBackend` and its data types                                                                                                    |
| `packages/ui/src/ports/in-memory-backend.ts`          | `InMemoryConnectionsBackend` for tests and desktop development                                                                                       |
| `packages/ui/src/model/reducer.ts`                    | pure `managerReducer` — the whole UI state machine                                                                                                   |
| `packages/ui/src/model/use-connection-manager.ts`     | thin `useReducer` + effects wrapper                                                                                                                  |
| `packages/ui/src/model/field-props.ts`                | `fieldInputProps` — pure schema-to-props mapping, unit-testable without a DOM                                                                        |
| `packages/ui/src/components/`                         | `ConnectionManagerApp`, `ConnectionList`, `ConnectionForm`, `SchemaField`                                                                            |
| `packages/ui/src/components/primitives/`              | `TextField`, `Checkbox`, `Select`, `Button`, `StatusDot`, `FormRow`, `SplitPane`                                                                     |
| `packages/ui/src/theme/tokens.css`                    | `--omni-*` contract with standalone fallbacks                                                                                                        |
| `apps/vscode/src/webview/protocol.ts`                 | `ViewToHost` / `HostToView` unions                                                                                                                   |
| `apps/vscode/src/webview/backend.ts`                  | `WebviewBackend implements ConnectionsBackend`                                                                                                       |
| `apps/vscode/src/webview/index.tsx`                   | webview entry: `createRoot` + `acquireVsCodeApi`                                                                                                     |
| `apps/vscode/src/webview/theme-vscode.css`            | `--omni-*` -> `--vscode-*`, the only visual coupling                                                                                                 |
| `apps/vscode/src/webview/connection-manager-panel.ts` | singleton panel, CSP HTML, method table                                                                                                              |

**Modified:** `packages/core/src/index.ts`, `packages/core/src/connection/manager.ts`, `apps/vscode/src/commands/index.ts`, `apps/vscode/src/extension.ts`, `apps/vscode/package.json`, `apps/vscode/esbuild.mjs`, `eslint.config.mjs`, `.github/workflows/ci.yml`, `CLAUDE.md`.

---

## Task 1: Core draft model

**Files:**

- Create: `packages/core/src/forms/types.ts`, `packages/core/src/forms/draft.ts`, `packages/core/src/forms/validation.ts`, `packages/core/src/forms/secret-merge.ts`
- Test: `packages/core/src/forms/draft.test.ts`, `packages/core/src/forms/validation.test.ts`, `packages/core/src/forms/secret-merge.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

- Consumes: `SettingsField`, `SettingsSchema`, `ProviderDefinition` from `../provider.js`; `ConnectionConfig`, `ConnectionId`, `ConnectionSecret`, `ProviderId` from `../model/connection.js`
- Produces: every symbol listed in the file table above. Tasks 3, 4 and 8 all import from here.

- [ ] **Step 1: Write the types**

Create `packages/core/src/forms/types.ts`:

```ts
import type { ConnectionId, ProviderId } from '../model/connection.js';
import type { SettingsSchema } from '../provider.js';

/** Which half of a connection a field belongs to. */
export type DraftSection = 'settings' | 'secret';

/**
 * A secret field in an unsaved draft. Three states, not two: without
 * `cleared`, an optional credential (S3's session token) could never be
 * removed once stored, because "empty" is indistinguishable from "untouched".
 */
export type SecretFieldState =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'set'; readonly value: string }
  | { readonly kind: 'cleared' };

/** The serializable subset of a provider a form needs. `ProviderDefinition`
 *  carries a `create()` closure and cannot cross a `postMessage` boundary. */
export interface ProviderSummary {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly settingsSchema: SettingsSchema;
  readonly secretSchema: SettingsSchema;
}

export interface DraftBaseline {
  readonly label: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly rootPath: string;
  readonly readOnly: boolean;
}

export interface ConnectionDraft {
  /** `undefined` means this draft has never been saved. */
  readonly id: ConnectionId | undefined;
  readonly providerId: ProviderId;
  readonly label: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly secret: Readonly<Record<string, SecretFieldState>>;
  readonly rootPath: string;
  readonly readOnly: boolean;
  /** What was loaded, so `isDirty` can compare without a second source. */
  readonly baseline: DraftBaseline;
}

export interface FieldError {
  readonly section: DraftSection | 'label';
  readonly key: string;
  readonly message: string;
}

export type SecretPatchEntry = { readonly set: string } | { readonly clear: true };
```

- [ ] **Step 2: Write failing tests for the draft**

Create `packages/core/src/forms/draft.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  clearSecretField,
  createDraft,
  isDirty,
  setField,
  setLabel,
  toConfig,
  toSecretPatch,
} from './draft.js';
import type { ProviderSummary } from './types.js';

const provider: ProviderSummary = {
  id: 'demo',
  displayName: 'Demo',
  settingsSchema: {
    fields: [
      { kind: 'text', key: 'host', label: 'Host', required: true },
      { kind: 'number', key: 'port', label: 'Port', default: 22 },
      { kind: 'boolean', key: 'secure', label: 'Secure', default: true },
      {
        kind: 'select',
        key: 'mode',
        label: 'Mode',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
        default: 'a',
      },
    ],
  },
  secretSchema: {
    fields: [
      { kind: 'password', key: 'password', label: 'Password', required: true },
      { kind: 'password', key: 'token', label: 'Token' },
    ],
  },
};

describe('createDraft', () => {
  it('applies schema defaults for a new connection', () => {
    const draft = createDraft(provider);
    expect(draft.id).toBeUndefined();
    expect(draft.settings).toEqual({ port: 22, secure: true, mode: 'a' });
    expect(draft.label).toBe('');
  });

  it('loads an existing config and marks every secret unchanged', () => {
    const draft = createDraft(
      provider,
      {
        id: 'c1',
        providerId: 'demo',
        label: 'prod',
        settings: { host: 'example.com', port: 2222 },
        rootPath: '/srv',
      },
      ['password'],
    );
    expect(draft.id).toBe('c1');
    expect(draft.settings['host']).toBe('example.com');
    // A stored value wins over the schema default.
    expect(draft.settings['port']).toBe(2222);
    // A field with no stored value still gets its default.
    expect(draft.settings['secure']).toBe(true);
    expect(draft.secret['password']).toEqual({ kind: 'unchanged' });
    // Not in secretFieldsPresent, so there is nothing stored to keep.
    expect(draft.secret['token']).toEqual({ kind: 'unchanged' });
  });
});

describe('isDirty', () => {
  it('is false for a freshly loaded draft and true after any edit', () => {
    const draft = createDraft(provider, {
      id: 'c1',
      providerId: 'demo',
      label: 'prod',
      settings: { host: 'example.com' },
    });
    expect(isDirty(draft)).toBe(false);
    expect(isDirty(setLabel(draft, 'staging'))).toBe(true);
    expect(isDirty(setField(draft, 'settings', 'host', 'other.com'))).toBe(true);
  });

  it('notices a touched secret even when nothing else changed', () => {
    const draft = createDraft(provider, {
      id: 'c1',
      providerId: 'demo',
      label: 'prod',
      settings: {},
    });
    expect(isDirty(setField(draft, 'secret', 'password', 'hunter2'))).toBe(true);
    expect(isDirty(clearSecretField(draft, 'token'))).toBe(true);
  });

  it('returns to clean when an edit is reversed', () => {
    const draft = createDraft(provider, {
      id: 'c1',
      providerId: 'demo',
      label: 'prod',
      settings: { host: 'example.com' },
    });
    const there = setLabel(draft, 'staging');
    expect(isDirty(setLabel(there, 'prod'))).toBe(false);
  });
});

describe('toSecretPatch', () => {
  it('emits only touched fields', () => {
    let draft = createDraft(provider, {
      id: 'c1',
      providerId: 'demo',
      label: 'prod',
      settings: {},
    });
    draft = setField(draft, 'secret', 'password', 'hunter2');
    draft = clearSecretField(draft, 'token');
    expect(toSecretPatch(draft)).toEqual({
      password: { set: 'hunter2' },
      token: { clear: true },
    });
  });

  it('is empty when no secret was touched', () => {
    const draft = createDraft(provider, {
      id: 'c1',
      providerId: 'demo',
      label: 'prod',
      settings: {},
    });
    expect(toSecretPatch(draft)).toEqual({});
  });
});

describe('toConfig', () => {
  it('produces a ConnectionConfig and never leaks a secret into it', () => {
    let draft = createDraft(provider);
    draft = setLabel(draft, '  prod  ');
    draft = setField(draft, 'settings', 'host', 'example.com');
    draft = setField(draft, 'secret', 'password', 'hunter2');

    const config = toConfig(draft, 'c9');
    expect(config).toEqual({
      id: 'c9',
      providerId: 'demo',
      label: 'prod',
      settings: { host: 'example.com', port: 22, secure: true, mode: 'a' },
      readOnly: false,
    });
    expect(JSON.stringify(config)).not.toContain('hunter2');
  });

  it('includes rootPath only when it is not the default root', () => {
    const draft = createDraft(provider);
    expect(toConfig(draft, 'c9').rootPath).toBeUndefined();
    expect(toConfig({ ...draft, rootPath: '/srv' }, 'c9').rootPath).toBe('/srv');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @omni-fs/core exec vitest run src/forms/draft.test.ts`
Expected: FAIL — `Failed to resolve import "./draft.js"`.

- [ ] **Step 4: Implement the draft model**

Create `packages/core/src/forms/draft.ts`:

```ts
import type { ConnectionConfig, ConnectionId } from '../model/connection.js';
import type { ProviderDefinition, SettingsField } from '../provider.js';
import type { ConnectionDraft, DraftSection, ProviderSummary, SecretPatchEntry } from './types.js';

/** Projects a registered provider onto the serializable subset a form needs. */
export function toProviderSummary(definition: ProviderDefinition): ProviderSummary {
  return {
    id: definition.id,
    displayName: definition.displayName,
    settingsSchema: definition.settingsSchema,
    secretSchema: definition.secretSchema,
  };
}

/**
 * Builds a draft. Pass `config` to edit an existing connection, and
 * `secretFieldsPresent` so the form can say "stored" without ever being told
 * what is stored.
 */
export function createDraft(
  provider: ProviderSummary,
  config?: ConnectionConfig,
  secretFieldsPresent: readonly string[] = [],
): ConnectionDraft {
  const settings: Record<string, unknown> = {};
  for (const field of provider.settingsSchema.fields) {
    const stored = config?.settings[field.key];
    if (stored !== undefined) {
      settings[field.key] = stored;
      continue;
    }
    const fallback = defaultValue(field);
    if (fallback !== undefined) settings[field.key] = fallback;
  }

  const secret: Record<string, { kind: 'unchanged' }> = {};
  for (const field of provider.secretSchema.fields) {
    secret[field.key] = { kind: 'unchanged' };
  }
  // `secretFieldsPresent` drives the UI's "stored" placeholder; it is read by
  // the form, not by the draft, so nothing else is needed here.
  void secretFieldsPresent;

  const label = config?.label ?? '';
  const rootPath = config?.rootPath ?? '/';
  const readOnly = config?.readOnly ?? false;

  return {
    id: config?.id,
    providerId: provider.id,
    label,
    settings,
    secret,
    rootPath,
    readOnly,
    baseline: { label, settings: { ...settings }, rootPath, readOnly },
  };
}

export function setLabel(draft: ConnectionDraft, label: string): ConnectionDraft {
  return { ...draft, label };
}

export function setRootPath(draft: ConnectionDraft, rootPath: string): ConnectionDraft {
  return { ...draft, rootPath };
}

export function setReadOnly(draft: ConnectionDraft, readOnly: boolean): ConnectionDraft {
  return { ...draft, readOnly };
}

export function setField(
  draft: ConnectionDraft,
  section: DraftSection,
  key: string,
  value: unknown,
): ConnectionDraft {
  if (section === 'settings') {
    return { ...draft, settings: { ...draft.settings, [key]: value } };
  }
  return {
    ...draft,
    secret: { ...draft.secret, [key]: { kind: 'set', value: String(value) } },
  };
}

export function clearSecretField(draft: ConnectionDraft, key: string): ConnectionDraft {
  return { ...draft, secret: { ...draft.secret, [key]: { kind: 'cleared' } } };
}

export function isDirty(draft: ConnectionDraft): boolean {
  if (draft.label !== draft.baseline.label) return true;
  if (draft.rootPath !== draft.baseline.rootPath) return true;
  if (draft.readOnly !== draft.baseline.readOnly) return true;

  const keys = new Set([...Object.keys(draft.settings), ...Object.keys(draft.baseline.settings)]);
  for (const key of keys) {
    if (draft.settings[key] !== draft.baseline.settings[key]) return true;
  }

  return Object.values(draft.secret).some((state) => state.kind !== 'unchanged');
}

export function toSecretPatch(draft: ConnectionDraft): Readonly<Record<string, SecretPatchEntry>> {
  const patch: Record<string, SecretPatchEntry> = {};
  for (const [key, state] of Object.entries(draft.secret)) {
    if (state.kind === 'set') patch[key] = { set: state.value };
    else if (state.kind === 'cleared') patch[key] = { clear: true };
  }
  return patch;
}

export function toConfig(draft: ConnectionDraft, id: ConnectionId): ConnectionConfig {
  return {
    id,
    providerId: draft.providerId,
    label: draft.label.trim(),
    settings: { ...draft.settings },
    // `exactOptionalPropertyTypes` means an absent optional must be absent,
    // not `undefined`, so these are spread in conditionally.
    ...(draft.rootPath !== '/' ? { rootPath: draft.rootPath } : {}),
    readOnly: draft.readOnly,
  };
}

function defaultValue(field: SettingsField): unknown {
  switch (field.kind) {
    case 'number':
      return field.default;
    case 'boolean':
      return field.default;
    case 'select':
      return field.default;
    default:
      return undefined;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @omni-fs/core exec vitest run src/forms/draft.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Write failing tests for validation**

Create `packages/core/src/forms/validation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createDraft, setField, setLabel } from './draft.js';
import { validateDraft } from './validation.js';
import type { ProviderSummary } from './types.js';

const provider: ProviderSummary = {
  id: 'demo',
  displayName: 'Demo',
  settingsSchema: {
    fields: [
      { kind: 'text', key: 'host', label: 'Host', required: true },
      { kind: 'number', key: 'port', label: 'Port', min: 1, max: 65535 },
      {
        kind: 'select',
        key: 'mode',
        label: 'Mode',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      },
    ],
  },
  secretSchema: {
    fields: [{ kind: 'password', key: 'password', label: 'Password', required: true }],
  },
};

describe('validateDraft', () => {
  it('requires a label', () => {
    const errors = validateDraft(createDraft(provider), provider);
    expect(errors).toContainEqual({
      section: 'label',
      key: 'label',
      message: 'A name is required',
    });
  });

  it('requires required settings and reports the field label', () => {
    const errors = validateDraft(createDraft(provider), provider);
    expect(errors).toContainEqual({
      section: 'settings',
      key: 'host',
      message: 'Host is required',
    });
  });

  it('rejects a number outside its range and a non-numeric value', () => {
    let draft = setLabel(createDraft(provider), 'x');
    draft = setField(draft, 'settings', 'host', 'h');
    draft = setField(draft, 'secret', 'password', 'p');

    expect(validateDraft(setField(draft, 'settings', 'port', 0), provider)).toContainEqual({
      section: 'settings',
      key: 'port',
      message: 'Port must be between 1 and 65535',
    });
    expect(validateDraft(setField(draft, 'settings', 'port', 70000), provider)).toContainEqual({
      section: 'settings',
      key: 'port',
      message: 'Port must be between 1 and 65535',
    });
    expect(validateDraft(setField(draft, 'settings', 'port', 'abc'), provider)).toContainEqual({
      section: 'settings',
      key: 'port',
      message: 'Port must be a number',
    });
  });

  it('rejects a select value that is not an option', () => {
    let draft = setLabel(createDraft(provider), 'x');
    draft = setField(draft, 'settings', 'host', 'h');
    draft = setField(draft, 'secret', 'password', 'p');
    draft = setField(draft, 'settings', 'mode', 'zzz');
    expect(validateDraft(draft, provider)).toContainEqual({
      section: 'settings',
      key: 'mode',
      message: 'Mode is not a valid option',
    });
  });

  it('accepts an unchanged required secret on a saved connection', () => {
    // The value lives in the keychain; the draft only knows it was not touched.
    let draft = createDraft(
      provider,
      { id: 'c1', providerId: 'demo', label: 'prod', settings: { host: 'h' } },
      ['password'],
    );
    draft = setField(draft, 'settings', 'mode', 'a');
    expect(validateDraft(draft, provider, ['password'])).toEqual([]);
  });

  it('requires a secret when nothing is stored and nothing was typed', () => {
    let draft = setLabel(createDraft(provider), 'x');
    draft = setField(draft, 'settings', 'host', 'h');
    expect(validateDraft(draft, provider)).toContainEqual({
      section: 'secret',
      key: 'password',
      message: 'Password is required',
    });
  });

  it('requires a secret again once it is explicitly cleared', () => {
    let draft = createDraft(
      provider,
      { id: 'c1', providerId: 'demo', label: 'prod', settings: { host: 'h' } },
      ['password'],
    );
    draft = { ...draft, secret: { ...draft.secret, password: { kind: 'cleared' } } };
    expect(validateDraft(draft, provider, ['password'])).toContainEqual({
      section: 'secret',
      key: 'password',
      message: 'Password is required',
    });
  });
});
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `pnpm --filter @omni-fs/core exec vitest run src/forms/validation.test.ts`
Expected: FAIL — `Failed to resolve import "./validation.js"`.

- [ ] **Step 8: Implement validation**

Create `packages/core/src/forms/validation.ts`:

```ts
import type { SettingsField } from '../provider.js';
import type { ConnectionDraft, FieldError, ProviderSummary } from './types.js';

/**
 * Validates only what the schema can express: required, number range, select
 * membership. Provider-specific rules stay in the provider, where
 * `readSettings()` already enforces them.
 */
export function validateDraft(
  draft: ConnectionDraft,
  provider: ProviderSummary,
  secretFieldsPresent: readonly string[] = [],
): readonly FieldError[] {
  const errors: FieldError[] = [];

  if (draft.label.trim() === '') {
    errors.push({ section: 'label', key: 'label', message: 'A name is required' });
  }

  for (const field of provider.settingsSchema.fields) {
    const error = validateField(field, draft.settings[field.key]);
    if (error !== undefined) errors.push({ section: 'settings', key: field.key, ...error });
  }

  for (const field of provider.secretSchema.fields) {
    if (field.required !== true) continue;
    const state = draft.secret[field.key] ?? { kind: 'unchanged' as const };

    // Satisfied if the user typed something, or if it is untouched and the
    // keychain already holds a value.
    const satisfied =
      (state.kind === 'set' && state.value !== '') ||
      (state.kind === 'unchanged' && secretFieldsPresent.includes(field.key));

    if (!satisfied) {
      errors.push({
        section: 'secret',
        key: field.key,
        message: `${field.label} is required`,
      });
    }
  }

  return errors;
}

export function validateField(
  field: SettingsField,
  value: unknown,
): { message: string } | undefined {
  const missing = value === undefined || value === null || value === '';

  if (field.required === true && missing) {
    return { message: `${field.label} is required` };
  }
  if (missing) return undefined;

  if (field.kind === 'number') {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(numeric)) return { message: `${field.label} must be a number` };

    const min = field.min;
    const max = field.max;
    if (min !== undefined && max !== undefined && (numeric < min || numeric > max)) {
      return { message: `${field.label} must be between ${min} and ${max}` };
    }
    if (min !== undefined && numeric < min) {
      return { message: `${field.label} must be at least ${min}` };
    }
    if (max !== undefined && numeric > max) {
      return { message: `${field.label} must be at most ${max}` };
    }
  }

  if (field.kind === 'select') {
    const allowed = field.options.some((option) => option.value === value);
    if (!allowed) return { message: `${field.label} is not a valid option` };
  }

  return undefined;
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm --filter @omni-fs/core exec vitest run src/forms/validation.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 10: Write failing tests for the secret merge**

Create `packages/core/src/forms/secret-merge.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mergeSecret } from './secret-merge.js';
import type { SettingsSchema } from '../provider.js';

const schema: SettingsSchema = {
  fields: [
    { kind: 'password', key: 'accessKeyId', label: 'Access key ID', required: true },
    { kind: 'password', key: 'secretAccessKey', label: 'Secret access key', required: true },
    { kind: 'password', key: 'sessionToken', label: 'Session token' },
  ],
};

describe('mergeSecret', () => {
  it('keeps stored values that the patch does not mention', () => {
    const merged = mergeSecret({ accessKeyId: 'A', secretAccessKey: 'B' }, {}, schema);
    expect(merged).toEqual({ accessKeyId: 'A', secretAccessKey: 'B' });
  });

  it('overwrites a stored value when the patch sets it', () => {
    const merged = mergeSecret(
      { accessKeyId: 'A', secretAccessKey: 'B' },
      { accessKeyId: { set: 'NEW' } },
      schema,
    );
    expect(merged).toEqual({ accessKeyId: 'NEW', secretAccessKey: 'B' });
  });

  it('removes a value the patch clears', () => {
    const merged = mergeSecret(
      { accessKeyId: 'A', sessionToken: 'T' },
      { sessionToken: { clear: true } },
      schema,
    );
    expect(merged).toEqual({ accessKeyId: 'A' });
  });

  it('drops stored keys the schema no longer declares', () => {
    // A provider dropped a field in an upgrade; the stale credential should
    // not be written back to the keychain forever.
    const merged = mergeSecret({ accessKeyId: 'A', legacyToken: 'stale' }, {}, schema);
    expect(merged).toEqual({ accessKeyId: 'A' });
  });

  it('builds the whole secret for a brand-new connection', () => {
    const merged = mergeSecret(
      undefined,
      { accessKeyId: { set: 'A' }, secretAccessKey: { set: 'B' } },
      schema,
    );
    expect(merged).toEqual({ accessKeyId: 'A', secretAccessKey: 'B' });
  });
});
```

- [ ] **Step 11: Run the tests to verify they fail**

Run: `pnpm --filter @omni-fs/core exec vitest run src/forms/secret-merge.test.ts`
Expected: FAIL — `Failed to resolve import "./secret-merge.js"`.

- [ ] **Step 12: Implement the merge**

Create `packages/core/src/forms/secret-merge.ts`:

```ts
import type { ConnectionSecret } from '../model/connection.js';
import type { SettingsSchema } from '../provider.js';
import type { SecretPatchEntry } from './types.js';

/**
 * Applies a patch from the UI to whatever the keychain already holds.
 *
 * This runs in the host, never in a webview: the stored secret is one of its
 * two inputs, and the whole design keeps stored secrets out of the UI process.
 */
export function mergeSecret(
  stored: ConnectionSecret | undefined,
  patch: Readonly<Record<string, SecretPatchEntry>>,
  schema: SettingsSchema,
): ConnectionSecret {
  const declared = new Set(schema.fields.map((field) => field.key));
  const next: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(stored ?? {})) {
    if (declared.has(key)) next[key] = value;
  }

  for (const [key, entry] of Object.entries(patch)) {
    if (!declared.has(key)) continue;
    if ('clear' in entry) delete next[key];
    else next[key] = entry.set;
  }

  return next;
}
```

- [ ] **Step 13: Run the tests to verify they pass**

Run: `pnpm --filter @omni-fs/core exec vitest run src/forms/secret-merge.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 14: Export from the core barrel**

In `packages/core/src/index.ts`, add after the `ProviderRegistry` export line:

```ts
// Connection form model, shared by every host's connection editor
export {
  clearSecretField,
  createDraft,
  isDirty,
  setField,
  setLabel,
  setReadOnly,
  setRootPath,
  toConfig,
  toProviderSummary,
  toSecretPatch,
} from './forms/draft.js';
export { validateDraft, validateField } from './forms/validation.js';
export { mergeSecret } from './forms/secret-merge.js';
export type {
  ConnectionDraft,
  DraftBaseline,
  DraftSection,
  FieldError,
  ProviderSummary,
  SecretFieldState,
  SecretPatchEntry,
} from './forms/types.js';
```

- [ ] **Step 15: Verify the whole package**

Run: `pnpm --filter @omni-fs/core exec vitest run && pnpm --filter @omni-fs/core build && pnpm lint && pnpm format:check`
Expected: all tests pass, `dist/` builds, no lint or format errors.

- [ ] **Step 16: Commit**

```bash
git add packages/core/src/forms packages/core/src/index.ts
git commit -m ":sparkles: feat add connection draft model to core"
```

---

## Task 2: Core probe

**Files:**

- Modify: `packages/core/src/connection/manager.ts`, `packages/core/src/index.ts`
- Test: `packages/core/src/connection/probe.test.ts`

**Interfaces:**

- Consumes: `ProviderRegistry`, `RemoteFileSystem`, `OmniFsError`, `RemotePath`, `ProviderCapabilities`
- Produces: `ConnectionManager.probe(target, secret, signal?)`, plus exported types `ProbeTarget` and `ProbeResult`. Task 8 calls this.

**Why this exists:** `acquire()` reads the config from the store and the secret from the keychain, both by id, so it cannot test a draft that has never been saved.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/connection/probe.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @omni-fs/core exec vitest run src/connection/probe.test.ts`
Expected: FAIL — `manager.probe is not a function`.

- [ ] **Step 3: Implement probe**

In `packages/core/src/connection/manager.ts`, add these types above the `ConnectionManager` class:

```ts
/** A connection being tested. No id: it may never have been saved. */
export interface ProbeTarget {
  readonly providerId: ProviderId;
  readonly label: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly rootPath?: string | undefined;
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly capabilities?: ProviderCapabilities | undefined;
  readonly error?: OmniFsError | undefined;
  readonly durationMs: number;
}

/** Id given to a throwaway probe filesystem. Never stored, never looked up. */
const PROBE_ID = '__probe__';
```

Add these imports to the existing import block:

```ts
import { RemotePath } from '../model/path.js';
import type { ProviderCapabilities } from '../capabilities.js';
import type { ProviderId } from '../model/connection.js';
```

Add the method to the class, after `acquire`:

```ts
  /**
   * Connects a draft without saving anything, then throws the connection away.
   *
   * Deliberately bypasses `#live`, `#states`, `#connecting` and `#idleTimers`:
   * a draft is not a connection, and a failing test must not paint an existing
   * connection's state red. Returns failure rather than throwing, because "it
   * did not work" is the expected outcome of a test, not an exception.
   */
  async probe(
    target: ProbeTarget,
    secret: ConnectionSecret,
    signal?: AbortSignal,
  ): Promise<ProbeResult> {
    const started = Date.now();
    const definition = this.#options.registry.get(target.providerId);
    const fs = definition.create({
      config: {
        id: PROBE_ID,
        providerId: target.providerId,
        label: target.label,
        settings: target.settings,
        ...(target.rootPath !== undefined ? { rootPath: target.rootPath } : {}),
      },
      getSecret: async () => secret,
      logger: this.#options.logger.child(`probe:${target.providerId}`),
    });

    try {
      await fs.connect(signal);
      // A real round trip. `connect` alone is a no-op for stateless protocols
      // like S3, so it proves nothing about the credentials.
      await fs.stat(RemotePath.parse(target.rootPath ?? '/'), signal);
      return { ok: true, capabilities: fs.capabilities, durationMs: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
        error: OmniFsError.wrap(error, { providerId: target.providerId }),
        durationMs: Date.now() - started,
      };
    } finally {
      try {
        await fs[Symbol.asyncDispose]();
      } catch {
        // A teardown failure must not mask the probe result.
      }
    }
  }
```

Also add `ConnectionSecret` to the `import type { ... } from '../model/connection.js'` line if it is not already there.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @omni-fs/core exec vitest run src/connection/probe.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Export the types**

In `packages/core/src/index.ts`, extend the existing manager export line to:

```ts
export type {
  ConnectionManagerOptions,
  ConnectionStateChange,
  ProbeResult,
  ProbeTarget,
} from './connection/manager.js';
```

- [ ] **Step 6: Verify and commit**

Run: `pnpm --filter @omni-fs/core exec vitest run && pnpm --filter @omni-fs/core build && pnpm lint && pnpm format:check`
Expected: all green.

```bash
git add packages/core/src/connection packages/core/src/index.ts
git commit -m ":sparkles: feat add connection probe for testing unsaved drafts"
```

---

## Task 3: Scaffold `packages/ui` and its Port

**Files:**

- Create: `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/vitest.config.ts`, `packages/ui/src/index.ts`, `packages/ui/src/ports/connections-backend.ts`, `packages/ui/src/ports/in-memory-backend.ts`
- Test: `packages/ui/src/ports/in-memory-backend.test.ts`
- Modify: `eslint.config.mjs`, `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: `ProviderSummary`, `SecretPatchEntry`, `ConnectionId`, `ConnectionState`, `ProviderId`, `ProviderCapabilities`, `OmniFsErrorCode` from `@omni-fs/core` (Task 1 exported the first two)
- Produces: `ConnectionsBackend`, `ConnectionSummary`, `SaveConnectionInput`, `TestConnectionInput`, `ProbeOutcome`, `InMemoryConnectionsBackend`. Tasks 4, 6 and 7 all depend on these.

- [ ] **Step 1: Create the package manifest**

Create `packages/ui/package.json`:

```json
{
  "name": "@omni-fs/ui",
  "version": "0.0.0",
  "description": "Host-agnostic React connection management UI for omni-fs. No host APIs, no protocol SDKs, no widget library.",
  "license": "MIT",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./tokens.css": "./src/theme/tokens.css"
  },
  "files": ["dist", "src/theme"],
  "scripts": {
    "build": "tsc -b",
    "dev": "tsc -b --watch",
    "typecheck": "tsc -b --noEmit false --emitDeclarationOnly",
    "lint": "eslint src",
    "test": "vitest run",
    "clean": "rm -rf dist *.tsbuildinfo"
  },
  "dependencies": {
    "@omni-fs/core": "workspace:*"
  },
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "typescript": "^6.0.3",
    "vitest": "^5.0.0"
  }
}
```

React is a **peer** dependency so the host owns the version and the bundle never contains two copies of React.

- [ ] **Step 2: Create the TypeScript and vitest config**

Create `packages/ui/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "jsx": "react-jsx",
    "lib": ["ES2023", "ESNext.Disposable", "DOM", "DOM.Iterable"],
    "types": []
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["src/**/*.test.ts", "src/**/*.test.tsx"],
  "references": [{ "path": "../core" }]
}
```

Three deliberate choices: `types: []` drops `@types/node`, so `process`, `Buffer` and `require` stop typechecking and a component cannot reach a host API by accident; `DOM` replaces it; `ESNext.Disposable` is needed because `ConnectionsBackend.onDidChange` returns a `Disposable`, matching core's ports.

Create `packages/ui/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // No jsdom: everything tested here is a pure function. That is why the
    // state machine is a reducer rather than a hook.
    environment: 'node',
  },
});
```

- [ ] **Step 3: Write the Port**

Create `packages/ui/src/ports/connections-backend.ts`:

```ts
import type {
  ConnectionId,
  ConnectionState,
  OmniFsErrorCode,
  ProviderCapabilities,
  ProviderId,
  ProviderSummary,
  SecretPatchEntry,
} from '@omni-fs/core';

/**
 * PORT. Everything the connection manager needs from a host.
 *
 * The same idea as core's `SecretStore`, `ConfigStore` and `Logger`, one layer
 * up: `apps/vscode` implements it over `postMessage`, `apps/desktop` will
 * implement it over Electron IPC, and the UI above it changes not at all.
 *
 * Every type crossing this interface is plain serializable data. That is not a
 * style preference — in VS Code it travels through `postMessage`, which
 * structured-clones its argument and throws on a function. It is why
 * `ProviderSummary` is used here and `ProviderDefinition` (which carries a
 * `create()` closure) is not.
 */
export interface ConnectionsBackend {
  listProviders(): Promise<readonly ProviderSummary[]>;
  listConnections(): Promise<readonly ConnectionSummary[]>;
  save(input: SaveConnectionInput): Promise<ConnectionId>;
  remove(id: ConnectionId): Promise<void>;
  test(input: TestConnectionInput): Promise<ProbeOutcome>;
  connect(id: ConnectionId): Promise<void>;
  /**
   * Where to open. Lets a host deep-link: VS Code's "Edit Connection" on a
   * tree node opens the panel already showing that connection.
   */
  initialSelection(): Promise<InitialSelection | undefined>;
  /**
   * Opens the host's native file dialog for a `kind: 'file'` field — SFTP's
   * private key path. A sandboxed webview cannot do this itself.
   */
  pickFile(): Promise<string | undefined>;
  onDidChange(listener: () => void): Disposable;
}

export type InitialSelection =
  | { readonly kind: 'connection'; readonly id: ConnectionId }
  | { readonly kind: 'new'; readonly providerId: ProviderId };

export interface ConnectionSummary {
  readonly id: ConnectionId;
  readonly providerId: ProviderId;
  readonly label: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly rootPath: string | undefined;
  readonly readOnly: boolean;
  /** Which secret keys hold a stored value. Never the values themselves. */
  readonly secretFieldsPresent: readonly string[];
  readonly state: ConnectionState;
}

export interface SaveConnectionInput {
  /** `undefined` creates a connection; the host generates the id. */
  readonly id: ConnectionId | undefined;
  readonly providerId: ProviderId;
  readonly label: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly rootPath: string | undefined;
  readonly readOnly: boolean;
  /** Only touched secret fields. Untouched ones keep their stored value. */
  readonly secretPatch: Readonly<Record<string, SecretPatchEntry>>;
}

export type TestConnectionInput = Omit<SaveConnectionInput, 'readOnly'>;

/** The serializable form of core's `ProbeResult`, converted at the boundary. */
export interface ProbeOutcome {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly capabilities?: ProviderCapabilities | undefined;
  readonly error?:
    | { readonly code: OmniFsErrorCode; readonly message: string; readonly retryable: boolean }
    | undefined;
}
```

- [ ] **Step 4: Write the failing test for the in-memory backend**

Create `packages/ui/src/ports/in-memory-backend.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { InMemoryConnectionsBackend } from './in-memory-backend.js';
import type { ProviderSummary } from '@omni-fs/core';

const provider: ProviderSummary = {
  id: 'demo',
  displayName: 'Demo',
  settingsSchema: { fields: [{ kind: 'text', key: 'host', label: 'Host', required: true }] },
  secretSchema: { fields: [{ kind: 'password', key: 'password', label: 'Password' }] },
};

function backend(): InMemoryConnectionsBackend {
  return new InMemoryConnectionsBackend([provider]);
}

describe('InMemoryConnectionsBackend', () => {
  it('creates a connection and reports which secret fields are present', async () => {
    const api = backend();
    const id = await api.save({
      id: undefined,
      providerId: 'demo',
      label: 'prod',
      settings: { host: 'example.com' },
      rootPath: undefined,
      readOnly: false,
      secretPatch: { password: { set: 'hunter2' } },
    });

    const [saved] = await api.listConnections();
    expect(saved?.id).toBe(id);
    expect(saved?.label).toBe('prod');
    expect(saved?.secretFieldsPresent).toEqual(['password']);
    // The summary is what reaches the UI; it must never carry the value.
    expect(JSON.stringify(saved)).not.toContain('hunter2');
  });

  it('keeps an untouched secret when the connection is updated', async () => {
    const api = backend();
    const id = await api.save({
      id: undefined,
      providerId: 'demo',
      label: 'prod',
      settings: { host: 'example.com' },
      rootPath: undefined,
      readOnly: false,
      secretPatch: { password: { set: 'hunter2' } },
    });

    await api.save({
      id,
      providerId: 'demo',
      label: 'renamed',
      settings: { host: 'example.com' },
      rootPath: undefined,
      readOnly: false,
      secretPatch: {},
    });

    expect(api.secretFor(id)).toEqual({ password: 'hunter2' });
  });

  it('removes a secret the patch clears', async () => {
    const api = backend();
    const id = await api.save({
      id: undefined,
      providerId: 'demo',
      label: 'prod',
      settings: { host: 'example.com' },
      rootPath: undefined,
      readOnly: false,
      secretPatch: { password: { set: 'hunter2' } },
    });

    await api.save({
      id,
      providerId: 'demo',
      label: 'prod',
      settings: { host: 'example.com' },
      rootPath: undefined,
      readOnly: false,
      secretPatch: { password: { clear: true } },
    });

    expect(api.secretFor(id)).toEqual({});
  });

  it('notifies listeners on save and remove, and stops after dispose', async () => {
    const api = backend();
    let calls = 0;
    const subscription = api.onDidChange(() => (calls += 1));

    const id = await api.save({
      id: undefined,
      providerId: 'demo',
      label: 'prod',
      settings: {},
      rootPath: undefined,
      readOnly: false,
      secretPatch: {},
    });
    expect(calls).toBe(1);

    await api.remove(id);
    expect(calls).toBe(2);

    subscription[Symbol.dispose]();
    await api.save({
      id: undefined,
      providerId: 'demo',
      label: 'other',
      settings: {},
      rootPath: undefined,
      readOnly: false,
      secretPatch: {},
    });
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm --filter @omni-fs/ui exec vitest run src/ports/in-memory-backend.test.ts`
Expected: FAIL — `Failed to resolve import "./in-memory-backend.js"`.

- [ ] **Step 6: Implement the in-memory backend**

Create `packages/ui/src/ports/in-memory-backend.ts`:

```ts
import { mergeSecret } from '@omni-fs/core';
import type { ConnectionId, ProviderSummary } from '@omni-fs/core';
import type {
  ConnectionSummary,
  ConnectionsBackend,
  InitialSelection,
  ProbeOutcome,
  SaveConnectionInput,
  TestConnectionInput,
} from './connections-backend.js';

/**
 * A working backend with no host behind it.
 *
 * Mirrors `InMemoryConfigStore` in core, and serves the same two purposes:
 * reducer tests run against a real implementation rather than a hand-rolled
 * stub, and the desktop renderer can be built before any Electron IPC exists.
 */
export class InMemoryConnectionsBackend implements ConnectionsBackend {
  readonly #providers: readonly ProviderSummary[];
  readonly #connections = new Map<ConnectionId, ConnectionSummary>();
  readonly #secrets = new Map<ConnectionId, Record<string, unknown>>();
  readonly #listeners = new Set<() => void>();
  #counter = 0;

  /** Set to make the next `test()` fail, for exercising the error path. */
  nextProbe: ProbeOutcome = { ok: true, durationMs: 1 };
  /** Set to make `pickFile()` return a path. */
  nextFile: string | undefined = undefined;
  /** Set to open on a particular connection. */
  nextInitialSelection: InitialSelection | undefined = undefined;

  constructor(providers: readonly ProviderSummary[]) {
    this.#providers = providers;
  }

  async listProviders(): Promise<readonly ProviderSummary[]> {
    return this.#providers;
  }

  async listConnections(): Promise<readonly ConnectionSummary[]> {
    return [...this.#connections.values()];
  }

  async save(input: SaveConnectionInput): Promise<ConnectionId> {
    const id = input.id ?? `mem${(this.#counter += 1)}`;
    const provider = this.#providers.find((candidate) => candidate.id === input.providerId);
    if (provider === undefined) throw new Error(`Unknown provider: ${input.providerId}`);

    const merged = mergeSecret(this.#secrets.get(id), input.secretPatch, provider.secretSchema);
    this.#secrets.set(id, { ...merged });

    this.#connections.set(id, {
      id,
      providerId: input.providerId,
      label: input.label,
      settings: input.settings,
      rootPath: input.rootPath,
      readOnly: input.readOnly,
      secretFieldsPresent: Object.keys(merged),
      state: { status: 'disconnected' },
    });

    this.#emit();
    return id;
  }

  async remove(id: ConnectionId): Promise<void> {
    this.#connections.delete(id);
    this.#secrets.delete(id);
    this.#emit();
  }

  async test(_input: TestConnectionInput): Promise<ProbeOutcome> {
    return this.nextProbe;
  }

  async connect(_id: ConnectionId): Promise<void> {
    // Nothing to connect to in memory.
  }

  async initialSelection(): Promise<InitialSelection | undefined> {
    return this.nextInitialSelection;
  }

  async pickFile(): Promise<string | undefined> {
    return this.nextFile;
  }

  onDidChange(listener: () => void): Disposable {
    this.#listeners.add(listener);
    return { [Symbol.dispose]: () => this.#listeners.delete(listener) };
  }

  /** Test-only window onto stored credentials. Not part of the Port. */
  secretFor(id: ConnectionId): Record<string, unknown> | undefined {
    return this.#secrets.get(id);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
```

- [ ] **Step 7: Create the barrel**

Create `packages/ui/src/index.ts`:

```ts
export type {
  ConnectionSummary,
  ConnectionsBackend,
  InitialSelection,
  ProbeOutcome,
  SaveConnectionInput,
  TestConnectionInput,
} from './ports/connections-backend.js';
export { InMemoryConnectionsBackend } from './ports/in-memory-backend.js';
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm install && pnpm --filter @omni-fs/core build && pnpm --filter @omni-fs/ui exec vitest run`
Expected: PASS, 4 tests. `pnpm install` is needed because the workspace gained a package.

- [ ] **Step 9: Widen the boundary rules to cover `.tsx`**

This is a live bug, not a new requirement: both guards match `*.ts` only, so the first `.tsx` file in `packages/` silently escapes them.

In `eslint.config.mjs`, change the boundary block's selector:

```js
    files: ['packages/**/*.ts', 'packages/**/*.tsx'],
```

In `.github/workflows/ci.yml:70`, change the grep:

```bash
          if grep -rnE "from '(vscode|electron)'" packages/ --include='*.ts' --include='*.tsx'; then
```

- [ ] **Step 10: Keep transport out of `packages/ui`**

Append this block to `eslint.config.mjs`, immediately before the closing `);`:

```js
  // packages/ui renders the connection editor for every host, so it must not
  // reach a host's transport — not through an import (the block above) and not
  // through a global. The seam is the ConnectionsBackend port and nothing else.
  {
    files: ['packages/ui/**/*.ts', 'packages/ui/**/*.tsx'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'acquireVsCodeApi',
          message:
            'packages/ui must stay transport-agnostic. Implement ConnectionsBackend in apps/vscode instead.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='window'][property.name='parent']",
          message: 'packages/ui must stay transport-agnostic. Use the ConnectionsBackend port.',
        },
      ],
    },
  },
```

- [ ] **Step 11: Verify the guards actually fire**

Prove the rules work rather than assuming they do:

```bash
echo "import * as vscode from 'vscode';" > packages/ui/src/guard-check.tsx
pnpm lint 2>&1 | grep -q "host-agnostic" && echo "ESLint guard OK" || echo "ESLint guard BROKEN"
grep -rnE "from '(vscode|electron)'" packages/ --include='*.ts' --include='*.tsx' && echo "CI grep OK"
rm packages/ui/src/guard-check.tsx
```

Expected: both print OK. Delete the probe file before continuing — the last line does it.

- [ ] **Step 12: Commit**

```bash
pnpm format
git add packages/ui eslint.config.mjs .github/workflows/ci.yml pnpm-lock.yaml
git commit -m ":sparkles: feat add omni-fs ui package with a connections backend port"
```

---

## Task 4: The reducer

**Files:**

- Create: `packages/ui/src/model/reducer.ts`
- Test: `packages/ui/src/model/reducer.test.ts`
- Modify: `packages/ui/src/index.ts`

**Interfaces:**

- Consumes: `ConnectionSummary`, `ProbeOutcome` from Task 3; `createDraft`, `setField`, `setLabel`, `setRootPath`, `setReadOnly`, `clearSecretField`, `isDirty`, `validateDraft`, `toSecretPatch` from Task 1
- Produces: `managerReducer`, `initialManagerState`, `ManagerState`, `ManagerAction`, `Selection`, `TestState`, `selectedProvider`, `saveInputFrom`. Task 6 consumes all of these.

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/src/model/reducer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { initialManagerState, managerReducer } from './reducer.js';
import type { ManagerAction, ManagerState } from './reducer.js';
import type { ConnectionSummary } from '../ports/connections-backend.js';
import type { ProviderSummary } from '@omni-fs/core';

const provider: ProviderSummary = {
  id: 'demo',
  displayName: 'Demo',
  settingsSchema: { fields: [{ kind: 'text', key: 'host', label: 'Host', required: true }] },
  secretSchema: {
    fields: [{ kind: 'password', key: 'password', label: 'Password', required: true }],
  },
};

const prod: ConnectionSummary = {
  id: 'c1',
  providerId: 'demo',
  label: 'prod',
  settings: { host: 'example.com' },
  rootPath: undefined,
  readOnly: false,
  secretFieldsPresent: ['password'],
  state: { status: 'disconnected' },
};

const staging: ConnectionSummary = { ...prod, id: 'c2', label: 'staging' };

function run(actions: readonly ManagerAction[], from = initialManagerState): ManagerState {
  return actions.reduce(managerReducer, from);
}

const loaded = run([{ type: 'loaded', providers: [provider], connections: [prod, staging] }]);

describe('managerReducer: loading', () => {
  it('becomes ready and selects the first connection', () => {
    expect(loaded.status).toBe('ready');
    expect(loaded.selection).toEqual({ kind: 'connection', id: 'c1' });
    expect(loaded.draft?.label).toBe('prod');
    expect(loaded.dirty).toBe(false);
    // A stored secret satisfies the required credential, so a freshly loaded
    // connection is valid without retyping anything.
    expect(loaded.errors).toEqual([]);
  });

  it('opens on the connection the host asked for', () => {
    const deepLinked = run([
      {
        type: 'loaded',
        providers: [provider],
        connections: [prod, staging],
        selection: { kind: 'connection', id: 'c2' },
      },
    ]);
    expect(deepLinked.selection).toEqual({ kind: 'connection', id: 'c2' });
    expect(deepLinked.draft?.label).toBe('staging');
  });

  it('opens on a blank draft when the host asks for a new connection', () => {
    const fresh = run([
      {
        type: 'loaded',
        providers: [provider],
        connections: [prod],
        selection: { kind: 'new', providerId: 'demo' },
      },
    ]);
    expect(fresh.selection).toEqual({ kind: 'new', providerId: 'demo' });
    expect(fresh.draft?.label).toBe('');
  });

  it('shows an empty state when there are no connections', () => {
    const empty = run([{ type: 'loaded', providers: [provider], connections: [] }]);
    expect(empty.selection).toEqual({ kind: 'none' });
    expect(empty.draft).toBeUndefined();
  });
});

describe('managerReducer: editing', () => {
  it('marks the draft dirty and recomputes errors on every change', () => {
    const edited = run(
      [{ type: 'fieldChanged', section: 'settings', key: 'host', value: '' }],
      loaded,
    );
    expect(edited.dirty).toBe(true);
    expect(edited.errors).toContainEqual({
      section: 'settings',
      key: 'host',
      message: 'Host is required',
    });
    // Errors exist but stay hidden until a save is attempted.
    expect(edited.showErrors).toBe(false);
  });

  it('reveals errors when a save is attempted', () => {
    const revealed = run(
      [
        { type: 'fieldChanged', section: 'settings', key: 'host', value: '' },
        { type: 'validationRevealed' },
      ],
      loaded,
    );
    expect(revealed.showErrors).toBe(true);
    expect(revealed.saving).toBe(false);
  });

  it('invalidates a test result as soon as a field changes', () => {
    // A green tick next to edited settings would be a lie.
    const tested = run([{ type: 'testFinished', outcome: { ok: true, durationMs: 12 } }], loaded);
    expect(tested.test.kind).toBe('done');

    const after = managerReducer(tested, {
      type: 'fieldChanged',
      section: 'settings',
      key: 'host',
      value: 'other.com',
    });
    expect(after.test.kind).toBe('idle');
  });

  it('reverts to the loaded values', () => {
    const reverted = run(
      [
        { type: 'fieldChanged', section: 'settings', key: 'host', value: 'changed' },
        { type: 'reverted' },
      ],
      loaded,
    );
    expect(reverted.draft?.settings['host']).toBe('example.com');
    expect(reverted.dirty).toBe(false);
  });
});

describe('managerReducer: the unsaved-changes guard', () => {
  it('switches immediately when the draft is clean', () => {
    const next = managerReducer(loaded, {
      type: 'selectRequested',
      target: { kind: 'connection', id: 'c2' },
    });
    expect(next.selection).toEqual({ kind: 'connection', id: 'c2' });
    expect(next.pendingSelection).toBeUndefined();
    expect(next.draft?.label).toBe('staging');
  });

  it('holds the switch when the draft is dirty', () => {
    const dirty = managerReducer(loaded, {
      type: 'fieldChanged',
      section: 'settings',
      key: 'host',
      value: 'changed',
    });
    const held = managerReducer(dirty, {
      type: 'selectRequested',
      target: { kind: 'connection', id: 'c2' },
    });

    expect(held.selection).toEqual({ kind: 'connection', id: 'c1' });
    expect(held.pendingSelection).toEqual({ kind: 'connection', id: 'c2' });
    expect(held.draft?.settings['host']).toBe('changed');
  });

  it('applies the held switch on confirm and drops it on cancel', () => {
    const dirty = managerReducer(loaded, {
      type: 'fieldChanged',
      section: 'settings',
      key: 'host',
      value: 'changed',
    });
    const held = managerReducer(dirty, {
      type: 'selectRequested',
      target: { kind: 'connection', id: 'c2' },
    });

    const confirmed = managerReducer(held, { type: 'selectConfirmed' });
    expect(confirmed.selection).toEqual({ kind: 'connection', id: 'c2' });
    expect(confirmed.dirty).toBe(false);

    const cancelled = managerReducer(held, { type: 'selectCancelled' });
    expect(cancelled.selection).toEqual({ kind: 'connection', id: 'c1' });
    expect(cancelled.pendingSelection).toBeUndefined();
    expect(cancelled.draft?.settings['host']).toBe('changed');
  });
});

describe('managerReducer: new and duplicate', () => {
  it('starts a blank draft for a new connection', () => {
    const fresh = managerReducer(loaded, {
      type: 'selectRequested',
      target: { kind: 'new', providerId: 'demo' },
    });
    expect(fresh.selection).toEqual({ kind: 'new', providerId: 'demo' });
    expect(fresh.draft?.id).toBeUndefined();
    expect(fresh.draft?.label).toBe('');
  });

  it('duplicates settings but never credentials', () => {
    const copy = managerReducer(loaded, { type: 'duplicateRequested' });
    expect(copy.draft?.id).toBeUndefined();
    expect(copy.draft?.label).toBe('prod (copy)');
    expect(copy.draft?.settings['host']).toBe('example.com');
    // The copy has its own id, so nothing is in the keychain for it yet and
    // the required credential must be retyped.
    expect(copy.errors).toContainEqual({
      section: 'secret',
      key: 'password',
      message: 'Password is required',
    });
  });
});

describe('managerReducer: saving', () => {
  it('rebaselines and selects the saved connection', () => {
    const dirty = managerReducer(loaded, { type: 'labelChanged', value: 'renamed' });
    const saved = run(
      [
        { type: 'saveStarted' },
        {
          type: 'connectionsChanged',
          connections: [{ ...prod, label: 'renamed' }, staging],
        },
        { type: 'saveSucceeded', id: 'c1' },
      ],
      dirty,
    );

    expect(saved.saving).toBe(false);
    expect(saved.dirty).toBe(false);
    expect(saved.draft?.label).toBe('renamed');
    expect(saved.selection).toEqual({ kind: 'connection', id: 'c1' });
  });

  it('keeps the draft and surfaces the message when a save fails', () => {
    const failed = run(
      [{ type: 'saveStarted' }, { type: 'saveFailed', message: 'keychain locked' }],
      managerReducer(loaded, { type: 'labelChanged', value: 'renamed' }),
    );
    expect(failed.saving).toBe(false);
    expect(failed.lastError).toBe('keychain locked');
    expect(failed.draft?.label).toBe('renamed');
  });

  it('does not clobber a dirty draft when connections change underneath', () => {
    // settings.json edited by hand while the user is mid-edit.
    const dirty = managerReducer(loaded, { type: 'labelChanged', value: 'mine' });
    const changed = managerReducer(dirty, {
      type: 'connectionsChanged',
      connections: [{ ...prod, label: 'theirs' }, staging],
    });

    expect(changed.draft?.label).toBe('mine');
    expect(changed.connections[0]?.label).toBe('theirs');
  });

  it('refreshes a clean draft when connections change underneath', () => {
    const changed = managerReducer(loaded, {
      type: 'connectionsChanged',
      connections: [{ ...prod, label: 'theirs' }, staging],
    });
    expect(changed.draft?.label).toBe('theirs');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @omni-fs/ui exec vitest run src/model/reducer.test.ts`
Expected: FAIL — `Failed to resolve import "./reducer.js"`.

- [ ] **Step 3: Implement the reducer**

Create `packages/ui/src/model/reducer.ts`:

```ts
import {
  clearSecretField,
  createDraft,
  isDirty,
  setField,
  setLabel,
  setReadOnly,
  setRootPath,
  toSecretPatch,
  validateDraft,
} from '@omni-fs/core';
import type {
  ConnectionDraft,
  ConnectionId,
  DraftSection,
  FieldError,
  ProviderId,
  ProviderSummary,
} from '@omni-fs/core';
import type {
  ConnectionSummary,
  InitialSelection,
  ProbeOutcome,
  SaveConnectionInput,
} from '../ports/connections-backend.js';

export type Selection =
  | { readonly kind: 'none' }
  | { readonly kind: 'connection'; readonly id: ConnectionId }
  | { readonly kind: 'new'; readonly providerId: ProviderId };

export type TestState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly outcome: ProbeOutcome };

export interface ManagerState {
  readonly status: 'loading' | 'ready';
  readonly providers: readonly ProviderSummary[];
  readonly connections: readonly ConnectionSummary[];
  readonly selection: Selection;
  readonly draft: ConnectionDraft | undefined;
  readonly errors: readonly FieldError[];
  /** Errors exist from the first keystroke; they are shown from the first save. */
  readonly showErrors: boolean;
  readonly dirty: boolean;
  readonly test: TestState;
  readonly saving: boolean;
  /** A selection change held back by the unsaved-changes guard. */
  readonly pendingSelection: Selection | undefined;
  readonly lastError: string | undefined;
}

export type ManagerAction =
  | {
      readonly type: 'loaded';
      readonly providers: readonly ProviderSummary[];
      readonly connections: readonly ConnectionSummary[];
      /** Where to open, when the host asked for somewhere specific. */
      readonly selection?: InitialSelection | undefined;
    }
  | { readonly type: 'connectionsChanged'; readonly connections: readonly ConnectionSummary[] }
  | { readonly type: 'selectRequested'; readonly target: Selection }
  | { readonly type: 'selectConfirmed' }
  | { readonly type: 'selectCancelled' }
  | { readonly type: 'duplicateRequested' }
  | { readonly type: 'labelChanged'; readonly value: string }
  | {
      readonly type: 'fieldChanged';
      readonly section: DraftSection;
      readonly key: string;
      readonly value: unknown;
    }
  | { readonly type: 'secretCleared'; readonly key: string }
  | { readonly type: 'rootPathChanged'; readonly value: string }
  | { readonly type: 'readOnlyChanged'; readonly value: boolean }
  | { readonly type: 'reverted' }
  | { readonly type: 'validationRevealed' }
  | { readonly type: 'testStarted' }
  | { readonly type: 'testFinished'; readonly outcome: ProbeOutcome }
  | { readonly type: 'saveStarted' }
  | { readonly type: 'saveSucceeded'; readonly id: ConnectionId }
  | { readonly type: 'saveFailed'; readonly message: string };

export const initialManagerState: ManagerState = {
  status: 'loading',
  providers: [],
  connections: [],
  selection: { kind: 'none' },
  draft: undefined,
  errors: [],
  showErrors: false,
  dirty: false,
  test: { kind: 'idle' },
  saving: false,
  pendingSelection: undefined,
  lastError: undefined,
};

export function managerReducer(state: ManagerState, action: ManagerAction): ManagerState {
  switch (action.type) {
    case 'loaded': {
      const base: ManagerState = {
        ...state,
        status: 'ready',
        providers: action.providers,
        connections: action.connections,
      };
      if (action.selection !== undefined) return applySelection(base, action.selection);

      const first = action.connections[0];
      return first === undefined
        ? base
        : applySelection(base, { kind: 'connection', id: first.id });
    }

    case 'connectionsChanged': {
      const next = { ...state, connections: action.connections };
      // A dirty draft is the user's work in progress; an external change must
      // update the list without discarding it.
      return state.dirty ? next : applySelection(next, next.selection);
    }

    case 'selectRequested':
      return state.dirty
        ? { ...state, pendingSelection: action.target }
        : applySelection(state, action.target);

    case 'selectConfirmed':
      return state.pendingSelection === undefined
        ? state
        : applySelection(state, state.pendingSelection);

    case 'selectCancelled':
      return { ...state, pendingSelection: undefined };

    case 'duplicateRequested': {
      const source = selectedConnection(state);
      const provider = providerFor(state, source?.providerId);
      if (source === undefined || provider === undefined) return state;

      // No id and no stored credentials: a copy is a new connection, and its
      // secrets live under a different key.
      const draft = createDraft(provider, {
        id: `${source.id}-copy`,
        providerId: source.providerId,
        label: `${source.label} (copy)`,
        settings: source.settings,
        ...(source.rootPath !== undefined ? { rootPath: source.rootPath } : {}),
        readOnly: source.readOnly,
      });

      return withDraft(
        { ...state, selection: { kind: 'new', providerId: source.providerId } },
        { ...draft, id: undefined },
        [],
      );
    }

    case 'labelChanged':
      return editDraft(state, (draft) => setLabel(draft, action.value));

    case 'fieldChanged':
      return editDraft(state, (draft) => setField(draft, action.section, action.key, action.value));

    case 'secretCleared':
      return editDraft(state, (draft) => clearSecretField(draft, action.key));

    case 'rootPathChanged':
      return editDraft(state, (draft) => setRootPath(draft, action.value));

    case 'readOnlyChanged':
      return editDraft(state, (draft) => setReadOnly(draft, action.value));

    case 'reverted':
      return applySelection(state, state.selection);

    case 'validationRevealed':
      return { ...state, showErrors: true };

    case 'testStarted':
      return { ...state, test: { kind: 'running' }, lastError: undefined };

    case 'testFinished':
      return { ...state, test: { kind: 'done', outcome: action.outcome } };

    case 'saveStarted':
      return { ...state, saving: true, lastError: undefined };

    case 'saveSucceeded': {
      if (state.draft === undefined) return { ...state, saving: false };

      // Rebaseline in place rather than re-deriving from `connections`: the
      // list is refreshed by a separate event, and relying on it arriving
      // first would make saving a new connection a race.
      const secret = Object.fromEntries(
        Object.keys(state.draft.secret).map((key) => [key, { kind: 'unchanged' } as const]),
      );
      const draft: ConnectionDraft = {
        ...state.draft,
        id: action.id,
        secret,
        baseline: {
          label: state.draft.label,
          settings: { ...state.draft.settings },
          rootPath: state.draft.rootPath,
          readOnly: state.draft.readOnly,
        },
      };

      return {
        ...state,
        draft,
        dirty: false,
        selection: { kind: 'connection', id: action.id },
        ...cleared(),
      };
    }

    case 'saveFailed':
      return { ...state, saving: false, lastError: action.message };
  }
}

/** Builds the payload the backend's `save` expects. */
export function saveInputFrom(draft: ConnectionDraft): SaveConnectionInput {
  return {
    id: draft.id,
    providerId: draft.providerId,
    label: draft.label.trim(),
    settings: draft.settings,
    rootPath: draft.rootPath === '/' ? undefined : draft.rootPath,
    readOnly: draft.readOnly,
    secretPatch: toSecretPatch(draft),
  };
}

export function selectedProvider(state: ManagerState): ProviderSummary | undefined {
  return providerFor(state, state.draft?.providerId);
}

export function selectedConnection(state: ManagerState): ConnectionSummary | undefined {
  return state.selection.kind === 'connection'
    ? state.connections.find((candidate) => candidate.id === state.selection.id)
    : undefined;
}

function providerFor(state: ManagerState, id: ProviderId | undefined): ProviderSummary | undefined {
  return id === undefined ? undefined : state.providers.find((candidate) => candidate.id === id);
}

/** Rebuilds the draft for a selection and clears everything derived from the old one. */
function applySelection(state: ManagerState, selection: Selection): ManagerState {
  if (selection.kind === 'none') {
    return { ...state, selection, draft: undefined, ...cleared() };
  }

  if (selection.kind === 'new') {
    const provider = providerFor(state, selection.providerId);
    if (provider === undefined) return state;
    return withDraft({ ...state, selection }, createDraft(provider), []);
  }

  const connection = state.connections.find((candidate) => candidate.id === selection.id);
  const provider = providerFor(state, connection?.providerId);
  if (connection === undefined || provider === undefined) {
    return { ...state, selection: { kind: 'none' }, draft: undefined, ...cleared() };
  }

  const draft = createDraft(
    provider,
    {
      id: connection.id,
      providerId: connection.providerId,
      label: connection.label,
      settings: connection.settings,
      ...(connection.rootPath !== undefined ? { rootPath: connection.rootPath } : {}),
      readOnly: connection.readOnly,
    },
    connection.secretFieldsPresent,
  );

  return withDraft({ ...state, selection }, draft, connection.secretFieldsPresent);
}

/**
 * A draft that has never been saved counts as dirty: there is nothing to
 * compare it against, and Save has to be reachable for a new connection.
 */
function dirtyFor(draft: ConnectionDraft): boolean {
  return draft.id === undefined || isDirty(draft);
}

function editDraft(
  state: ManagerState,
  change: (draft: ConnectionDraft) => ConnectionDraft,
): ManagerState {
  if (state.draft === undefined) return state;
  const draft = change(state.draft);
  const provider = providerFor(state, draft.providerId);
  if (provider === undefined) return state;

  return {
    ...state,
    draft,
    dirty: dirtyFor(draft),
    errors: validateDraft(draft, provider, secretFieldsFor(state)),
    // A result that described the previous values is worse than no result.
    test: { kind: 'idle' },
  };
}

function withDraft(
  state: ManagerState,
  draft: ConnectionDraft,
  secretFieldsPresent: readonly string[],
): ManagerState {
  const provider = providerFor(state, draft.providerId);
  return {
    ...state,
    draft,
    dirty: dirtyFor(draft),
    errors: provider === undefined ? [] : validateDraft(draft, provider, secretFieldsPresent),
    ...cleared(),
  };
}

function secretFieldsFor(state: ManagerState): readonly string[] {
  return selectedConnection(state)?.secretFieldsPresent ?? [];
}

function cleared(): Pick<
  ManagerState,
  'showErrors' | 'test' | 'pendingSelection' | 'lastError' | 'saving'
> {
  return {
    showErrors: false,
    test: { kind: 'idle' },
    pendingSelection: undefined,
    lastError: undefined,
    saving: false,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @omni-fs/ui exec vitest run src/model/reducer.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Export and commit**

Add to `packages/ui/src/index.ts`:

```ts
export {
  initialManagerState,
  managerReducer,
  saveInputFrom,
  selectedConnection,
  selectedProvider,
} from './model/reducer.js';
export type { ManagerAction, ManagerState, Selection, TestState } from './model/reducer.js';
```

Run: `pnpm --filter @omni-fs/ui exec vitest run && pnpm --filter @omni-fs/ui build && pnpm lint && pnpm format:check`
Expected: all green.

```bash
git add packages/ui
git commit -m ":sparkles: feat add connection manager state machine"
```

---

## Task 5: Field view model, primitives and theme

**Files:**

- Create: `packages/ui/src/model/field-view.ts`, `packages/ui/src/theme/tokens.css`, `packages/ui/src/components/primitives/index.tsx`
- Test: `packages/ui/src/model/field-view.test.ts`
- Modify: `packages/ui/src/index.ts`

**Interfaces:**

- Consumes: `SettingsField`, `ConnectionDraft`, `FieldError`, `DraftSection` from `@omni-fs/core`
- Produces: `fieldView`, `FieldView`, `FieldControl`; the primitives `TextField`, `Checkbox`, `Select`, `Button`, `StatusDot`, `FormRow`. Task 6 consumes all of them.

**Why a view model:** `SchemaField` has the only real branching logic in the UI — six field kinds, plus three secret states. Extracting the decision into a pure function means it is unit-tested in plain vitest, and the component that renders it stays trivial enough not to need a DOM test.

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/src/model/field-view.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createDraft, setField } from '@omni-fs/core';
import type { ProviderSummary } from '@omni-fs/core';
import { fieldView } from './field-view.js';

const provider: ProviderSummary = {
  id: 'demo',
  displayName: 'Demo',
  settingsSchema: {
    fields: [
      { kind: 'text', key: 'host', label: 'Host', required: true, placeholder: 'example.com' },
      { kind: 'number', key: 'port', label: 'Port', default: 22 },
      { kind: 'boolean', key: 'secure', label: 'Secure', default: true, help: 'Use TLS.' },
      {
        kind: 'select',
        key: 'mode',
        label: 'Mode',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
        default: 'a',
      },
      { kind: 'file', key: 'keyPath', label: 'Private key' },
    ],
  },
  secretSchema: {
    fields: [{ kind: 'password', key: 'password', label: 'Password', required: true }],
  },
};

const field = (key: string) =>
  provider.settingsSchema.fields.find((candidate) => candidate.key === key)!;
const secretField = provider.secretSchema.fields[0]!;

describe('fieldView', () => {
  it('describes a required text field with its placeholder', () => {
    const view = fieldView(field('host'), 'settings', createDraft(provider), undefined, []);
    expect(view.label).toBe('Host');
    expect(view.required).toBe(true);
    expect(view.control).toEqual({
      kind: 'text',
      type: 'text',
      value: '',
      placeholder: 'example.com',
    });
  });

  it('renders a number as a numeric input carrying its default', () => {
    const view = fieldView(field('port'), 'settings', createDraft(provider), undefined, []);
    expect(view.control).toEqual({
      kind: 'text',
      type: 'number',
      value: '22',
      placeholder: undefined,
    });
  });

  it('carries help text and the boolean default', () => {
    const view = fieldView(field('secure'), 'settings', createDraft(provider), undefined, []);
    expect(view.help).toBe('Use TLS.');
    expect(view.control).toEqual({ kind: 'checkbox', checked: true });
  });

  it('passes select options through unchanged', () => {
    const view = fieldView(field('mode'), 'settings', createDraft(provider), undefined, []);
    expect(view.control).toEqual({
      kind: 'select',
      value: 'a',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
  });

  it('describes a file field so the host can open a dialog', () => {
    const view = fieldView(field('keyPath'), 'settings', createDraft(provider), undefined, []);
    expect(view.control).toEqual({ kind: 'file', value: '' });
  });

  it('shows a stored secret as present without revealing it', () => {
    const draft = createDraft(
      provider,
      { id: 'c1', providerId: 'demo', label: 'p', settings: {} },
      ['password'],
    );
    const view = fieldView(secretField, 'secret', draft, undefined, ['password']);
    expect(view.control).toEqual({
      kind: 'password',
      value: '',
      placeholder: '•••••••• stored — type to replace',
      stored: true,
    });
  });

  it('shows an unset secret as empty', () => {
    const view = fieldView(secretField, 'secret', createDraft(provider), undefined, []);
    expect(view.control).toEqual({
      kind: 'password',
      value: '',
      placeholder: 'Not set',
      stored: false,
    });
  });

  it('shows a typed secret and stops calling it stored', () => {
    const draft = setField(
      createDraft(provider, { id: 'c1', providerId: 'demo', label: 'p', settings: {} }, [
        'password',
      ]),
      'secret',
      'password',
      'typed',
    );
    const view = fieldView(secretField, 'secret', draft, undefined, ['password']);
    expect(view.control).toEqual({
      kind: 'password',
      value: 'typed',
      placeholder: 'Not set',
      stored: false,
    });
  });

  it('attaches an error message when one applies', () => {
    const view = fieldView(
      field('host'),
      'settings',
      createDraft(provider),
      {
        section: 'settings',
        key: 'host',
        message: 'Host is required',
      },
      [],
    );
    expect(view.error).toBe('Host is required');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @omni-fs/ui exec vitest run src/model/field-view.test.ts`
Expected: FAIL — `Failed to resolve import "./field-view.js"`.

- [ ] **Step 3: Implement the view model**

Create `packages/ui/src/model/field-view.ts`:

```ts
import type { ConnectionDraft, DraftSection, FieldError, SettingsField } from '@omni-fs/core';

export const STORED_SECRET_PLACEHOLDER = '•••••••• stored — type to replace';

export type FieldControl =
  | {
      readonly kind: 'text';
      readonly type: 'text' | 'number';
      readonly value: string;
      readonly placeholder: string | undefined;
    }
  | {
      readonly kind: 'password';
      readonly value: string;
      readonly placeholder: string;
      /** True when the keychain holds a value the user has not replaced. */
      readonly stored: boolean;
    }
  | { readonly kind: 'checkbox'; readonly checked: boolean }
  | {
      readonly kind: 'select';
      readonly value: string;
      readonly options: readonly { readonly value: string; readonly label: string }[];
    }
  | { readonly kind: 'file'; readonly value: string };

export interface FieldView {
  readonly key: string;
  readonly section: DraftSection;
  readonly label: string;
  readonly required: boolean;
  readonly help: string | undefined;
  readonly error: string | undefined;
  readonly control: FieldControl;
}

/**
 * Turns one schema field plus the current draft into everything the renderer
 * needs. Pure, so the branching that actually matters is unit-tested without a
 * DOM and `SchemaField` stays a dumb switch.
 */
export function fieldView(
  field: SettingsField,
  section: DraftSection,
  draft: ConnectionDraft,
  error: FieldError | undefined,
  secretFieldsPresent: readonly string[],
): FieldView {
  return {
    key: field.key,
    section,
    label: field.label,
    required: field.required === true,
    help: 'help' in field ? field.help : undefined,
    error: error?.message,
    control:
      section === 'secret'
        ? secretControl(field, draft, secretFieldsPresent)
        : settingsControl(field, draft.settings[field.key]),
  };
}

function settingsControl(field: SettingsField, value: unknown): FieldControl {
  switch (field.kind) {
    case 'boolean':
      return { kind: 'checkbox', checked: value === true };
    case 'select':
      return {
        kind: 'select',
        value: typeof value === 'string' ? value : '',
        options: field.options,
      };
    case 'file':
      return { kind: 'file', value: typeof value === 'string' ? value : '' };
    case 'number':
      return {
        kind: 'text',
        type: 'number',
        value: value === undefined ? '' : String(value),
        placeholder: undefined,
      };
    case 'password':
      return { kind: 'password', value: '', placeholder: 'Not set', stored: false };
    default:
      return {
        kind: 'text',
        type: 'text',
        value: typeof value === 'string' ? value : '',
        placeholder: field.placeholder,
      };
  }
}

function secretControl(
  field: SettingsField,
  draft: ConnectionDraft,
  secretFieldsPresent: readonly string[],
): FieldControl {
  const state = draft.secret[field.key] ?? { kind: 'unchanged' as const };

  if (state.kind === 'set') {
    return { kind: 'password', value: state.value, placeholder: 'Not set', stored: false };
  }
  if (state.kind === 'cleared') {
    return { kind: 'password', value: '', placeholder: 'Not set', stored: false };
  }

  const stored = secretFieldsPresent.includes(field.key);
  return {
    kind: 'password',
    value: '',
    placeholder: stored ? STORED_SECRET_PLACEHOLDER : 'Not set',
    stored,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @omni-fs/ui exec vitest run src/model/field-view.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Write the theme contract**

Create `packages/ui/src/theme/tokens.css`. Every value is a standalone fallback, so the package renders correctly with no host at all; a host overrides the tokens and nothing else.

```css
/*
 * The theming contract for @omni-fs/ui.
 *
 * Components reference only these tokens. A host remaps them - apps/vscode to
 * var(--vscode-*), the desktop app to its own palette - and that remap file is
 * the only visual coupling in the stack.
 */
:root {
  --omni-font: system-ui, -apple-system, 'Segoe UI', sans-serif;
  --omni-font-size: 13px;
  --omni-fg: #1f2328;
  --omni-fg-muted: #656d76;
  --omni-bg: #ffffff;
  --omni-bg-raised: #f6f8fa;
  --omni-border: #d0d7de;
  --omni-input-bg: #ffffff;
  --omni-input-fg: #1f2328;
  --omni-accent: #0969da;
  --omni-accent-fg: #ffffff;
  --omni-error: #cf222e;
  --omni-success: #1a7f37;
  --omni-focus: #0969da;
  --omni-selection-bg: #ddf4ff;
  --omni-radius: 4px;
  --omni-gap: 8px;
}

.omni-root {
  font-family: var(--omni-font);
  font-size: var(--omni-font-size);
  color: var(--omni-fg);
  background: var(--omni-bg);
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.omni-split {
  display: flex;
  flex: 1;
  min-height: 0;
}

.omni-list {
  width: 220px;
  border-right: 1px solid var(--omni-border);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.omni-list-item {
  display: flex;
  align-items: center;
  gap: var(--omni-gap);
  padding: 6px 10px;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  width: 100%;
}

.omni-list-item[aria-current='true'] {
  background: var(--omni-selection-bg);
}

.omni-form {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  max-width: 560px;
}

.omni-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}

.omni-row label {
  color: var(--omni-fg-muted);
}

.omni-input,
.omni-select {
  font: inherit;
  color: var(--omni-input-fg);
  background: var(--omni-input-bg);
  border: 1px solid var(--omni-border);
  border-radius: var(--omni-radius);
  padding: 4px 6px;
  width: 100%;
  box-sizing: border-box;
}

.omni-input:focus-visible,
.omni-select:focus-visible,
.omni-button:focus-visible,
.omni-list-item:focus-visible {
  outline: 1px solid var(--omni-focus);
  outline-offset: 1px;
}

.omni-input[aria-invalid='true'] {
  border-color: var(--omni-error);
}

.omni-error {
  color: var(--omni-error);
}

.omni-help {
  color: var(--omni-fg-muted);
}

.omni-button {
  font: inherit;
  border: 1px solid var(--omni-border);
  border-radius: var(--omni-radius);
  background: var(--omni-bg-raised);
  color: var(--omni-fg);
  padding: 4px 12px;
  cursor: pointer;
}

.omni-button[data-variant='primary'] {
  background: var(--omni-accent);
  color: var(--omni-accent-fg);
  border-color: var(--omni-accent);
}

.omni-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.omni-actions {
  display: flex;
  gap: var(--omni-gap);
  margin-top: 16px;
}

.omni-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--omni-fg-muted);
  flex: none;
}

.omni-dot[data-status='connected'] {
  background: var(--omni-success);
}

.omni-dot[data-status='error'] {
  background: var(--omni-error);
}

.omni-section-heading {
  margin: 20px 0 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--omni-border);
  color: var(--omni-fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 11px;
}
```

- [ ] **Step 6: Write the primitives**

Create `packages/ui/src/components/primitives/index.tsx`:

```tsx
import type { ChangeEvent, ReactNode } from 'react';
import type { ConnectionState } from '@omni-fs/core';

/**
 * Our own controls over native HTML elements.
 *
 * No widget library: @vscode/webview-ui-toolkit is deprecated and its
 * successor styles itself from --vscode-* variables that do not exist in
 * Electron, which would hard-couple this shared package to one host.
 * Native elements also bring keyboard and screen-reader behaviour for free.
 */

export function FormRow(props: {
  readonly label: string;
  readonly htmlFor: string;
  readonly required?: boolean | undefined;
  readonly help?: string | undefined;
  readonly error?: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const describedBy = props.error !== undefined ? `${props.htmlFor}-error` : undefined;
  return (
    <div className="omni-row">
      <label htmlFor={props.htmlFor}>
        {props.label}
        {props.required === true ? ' *' : ''}
      </label>
      {props.children}
      {props.help !== undefined && <small className="omni-help">{props.help}</small>}
      {props.error !== undefined && (
        <small className="omni-error" id={describedBy} role="alert">
          {props.error}
        </small>
      )}
    </div>
  );
}

export function TextField(props: {
  readonly id: string;
  readonly type: 'text' | 'password' | 'number';
  readonly value: string;
  readonly placeholder?: string | undefined;
  readonly invalid?: boolean | undefined;
  readonly readOnly?: boolean | undefined;
  readonly onChange: (value: string) => void;
}): ReactNode {
  return (
    <input
      className="omni-input"
      id={props.id}
      type={props.type}
      value={props.value}
      placeholder={props.placeholder}
      readOnly={props.readOnly === true}
      aria-invalid={props.invalid === true}
      onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(event.target.value)}
    />
  );
}

export function Checkbox(props: {
  readonly id: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}): ReactNode {
  return (
    <input
      id={props.id}
      type="checkbox"
      checked={props.checked}
      onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(event.target.checked)}
    />
  );
}

export function Select(props: {
  readonly id: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
}): ReactNode {
  return (
    <select
      className="omni-select"
      id={props.id}
      value={props.value}
      onChange={(event: ChangeEvent<HTMLSelectElement>) => props.onChange(event.target.value)}
    >
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Button(props: {
  readonly variant?: 'primary' | 'default' | undefined;
  readonly disabled?: boolean | undefined;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <button
      className="omni-button"
      type="button"
      data-variant={props.variant ?? 'default'}
      disabled={props.disabled === true}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function StatusDot(props: { readonly state: ConnectionState }): ReactNode {
  return <span className="omni-dot" data-status={props.state.status} aria-hidden="true" />;
}
```

- [ ] **Step 7: Export, verify and commit**

Add to `packages/ui/src/index.ts`:

```ts
export { fieldView, STORED_SECRET_PLACEHOLDER } from './model/field-view.js';
export type { FieldControl, FieldView } from './model/field-view.js';
```

Run: `pnpm --filter @omni-fs/ui exec vitest run && pnpm --filter @omni-fs/ui build && pnpm lint && pnpm format:check`
Expected: all green, 30 tests in the package.

```bash
git add packages/ui
git commit -m ":sparkles: feat add field view model primitives and theme tokens"
```

---

## Task 6: Components and the hook

**Files:**

- Create: `packages/ui/src/components/SchemaField.tsx`, `packages/ui/src/components/ConnectionList.tsx`, `packages/ui/src/components/ConnectionForm.tsx`, `packages/ui/src/components/ConnectionManagerApp.tsx`, `packages/ui/src/model/use-connection-manager.ts`
- Modify: `packages/ui/src/index.ts`

**Interfaces:**

- Consumes: everything from Tasks 3, 4 and 5
- Produces: `ConnectionManagerApp`, a single component taking `{backend}`. Task 7 renders exactly this and nothing else.

**Verification note:** these are presentational; `packages/ui` has no jsdom by design, so the logic they depend on is already covered by the reducer and field-view tests. They are verified here by typecheck and lint, and end-to-end by the manual checklist in Task 8. Do not add `@testing-library/react` — the spec chose the reducer split precisely to avoid needing it.

- [ ] **Step 1: Write `SchemaField`**

Create `packages/ui/src/components/SchemaField.tsx`:

```tsx
import type { ReactNode } from 'react';
import type { FieldView } from '../model/field-view.js';
import { Button, Checkbox, FormRow, Select, TextField } from './primitives/index.js';

/** A dumb switch over `FieldControl`. All decisions were made by `fieldView`. */
export function SchemaField(props: {
  readonly view: FieldView;
  readonly onChange: (value: unknown) => void;
  readonly onClear: () => void;
  readonly onPickFile: () => void;
}): ReactNode {
  const { view } = props;
  const id = `omni-${view.section}-${view.key}`;
  const control = view.control;

  const inner = ((): ReactNode => {
    switch (control.kind) {
      case 'checkbox':
        return <Checkbox id={id} checked={control.checked} onChange={props.onChange} />;
      case 'select':
        return (
          <Select
            id={id}
            value={control.value}
            options={control.options}
            onChange={props.onChange}
          />
        );
      case 'file':
        return (
          <span className="omni-actions">
            <TextField id={id} type="text" value={control.value} onChange={props.onChange} />
            <Button onClick={props.onPickFile}>Browse…</Button>
          </span>
        );
      case 'password':
        return (
          <span className="omni-actions">
            <TextField
              id={id}
              type="password"
              value={control.value}
              placeholder={control.placeholder}
              invalid={view.error !== undefined}
              onChange={props.onChange}
            />
            {control.stored && <Button onClick={props.onClear}>Clear</Button>}
          </span>
        );
      default:
        return (
          <TextField
            id={id}
            type={control.type}
            value={control.value}
            placeholder={control.placeholder}
            invalid={view.error !== undefined}
            onChange={props.onChange}
          />
        );
    }
  })();

  return (
    <FormRow
      label={view.label}
      htmlFor={id}
      required={view.required}
      help={view.help}
      error={view.error}
    >
      {inner}
    </FormRow>
  );
}
```

- [ ] **Step 2: Write `ConnectionList`**

Create `packages/ui/src/components/ConnectionList.tsx`:

```tsx
import type { ReactNode } from 'react';
import type { ProviderSummary } from '@omni-fs/core';
import type { ConnectionSummary } from '../ports/connections-backend.js';
import type { Selection } from '../model/reducer.js';
import { Button, StatusDot } from './primitives/index.js';

export function ConnectionList(props: {
  readonly connections: readonly ConnectionSummary[];
  readonly providers: readonly ProviderSummary[];
  readonly selection: Selection;
  readonly onSelect: (target: Selection) => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
}): ReactNode {
  const selectedId = props.selection.kind === 'connection' ? props.selection.id : undefined;

  return (
    <div className="omni-list">
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, flex: 1 }}>
        {props.connections.map((connection) => (
          <li key={connection.id}>
            <button
              type="button"
              className="omni-list-item"
              aria-current={connection.id === selectedId}
              onClick={() => props.onSelect({ kind: 'connection', id: connection.id })}
            >
              <StatusDot state={connection.state} />
              <span>{connection.label}</span>
            </button>
          </li>
        ))}
        {props.connections.length === 0 && (
          <li className="omni-help" style={{ padding: 10 }}>
            No connections yet.
          </li>
        )}
      </ul>

      <div className="omni-actions" style={{ padding: 8, flexWrap: 'wrap' }}>
        {props.providers.map((provider) => (
          <Button
            key={provider.id}
            onClick={() => props.onSelect({ kind: 'new', providerId: provider.id })}
          >
            + {provider.displayName}
          </Button>
        ))}
        <Button disabled={selectedId === undefined} onClick={props.onDuplicate}>
          Duplicate
        </Button>
        <Button disabled={selectedId === undefined} onClick={props.onDelete}>
          Delete
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write `ConnectionForm`**

Create `packages/ui/src/components/ConnectionForm.tsx`:

```tsx
import type { ReactNode } from 'react';
import type {
  ConnectionDraft,
  DraftSection,
  FieldError,
  ProviderSummary,
  SettingsField,
} from '@omni-fs/core';
import { fieldView } from '../model/field-view.js';
import type { TestState } from '../model/reducer.js';
import { Button, Checkbox, FormRow, TextField } from './primitives/index.js';
import { SchemaField } from './SchemaField.js';

export function ConnectionForm(props: {
  readonly draft: ConnectionDraft;
  readonly provider: ProviderSummary;
  readonly errors: readonly FieldError[];
  readonly showErrors: boolean;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly test: TestState;
  readonly lastError: string | undefined;
  readonly secretFieldsPresent: readonly string[];
  readonly onLabelChange: (value: string) => void;
  readonly onFieldChange: (section: DraftSection, key: string, value: unknown) => void;
  readonly onSecretClear: (key: string) => void;
  readonly onRootPathChange: (value: string) => void;
  readonly onReadOnlyChange: (value: boolean) => void;
  readonly onPickFile: (key: string) => void;
  readonly onTest: () => void;
  readonly onRevert: () => void;
  readonly onSave: () => void;
}): ReactNode {
  const errorFor = (section: DraftSection | 'label', key: string): FieldError | undefined =>
    props.showErrors
      ? props.errors.find((error) => error.section === section && error.key === key)
      : undefined;

  const renderSection = (fields: readonly SettingsField[], section: DraftSection): ReactNode =>
    fields.map((field) => (
      <SchemaField
        key={field.key}
        view={fieldView(
          field,
          section,
          props.draft,
          errorFor(section, field.key),
          props.secretFieldsPresent,
        )}
        onChange={(value) => props.onFieldChange(section, field.key, value)}
        onClear={() => props.onSecretClear(field.key)}
        onPickFile={() => props.onPickFile(field.key)}
      />
    ));

  return (
    <div className="omni-form">
      <FormRow
        label="Name"
        htmlFor="omni-label"
        required
        error={errorFor('label', 'label')?.message}
      >
        <TextField
          id="omni-label"
          type="text"
          value={props.draft.label}
          placeholder="production-bucket"
          invalid={errorFor('label', 'label') !== undefined}
          onChange={props.onLabelChange}
        />
      </FormRow>

      <FormRow label="Protocol" htmlFor="omni-protocol">
        {/* Locked after the first save: changing it would invalidate every
            settings field at once. Duplicate is the path to "same server,
            different protocol". */}
        <TextField
          id="omni-protocol"
          type="text"
          value={props.provider.displayName}
          readOnly
          onChange={() => undefined}
        />
      </FormRow>

      <h2 className="omni-section-heading">Settings</h2>
      {renderSection(props.provider.settingsSchema.fields, 'settings')}

      <FormRow label="Root path" htmlFor="omni-root" help="Folder to treat as the connection root.">
        <TextField
          id="omni-root"
          type="text"
          value={props.draft.rootPath}
          onChange={props.onRootPathChange}
        />
      </FormRow>

      <FormRow label="Read only" htmlFor="omni-readonly">
        <Checkbox
          id="omni-readonly"
          checked={props.draft.readOnly}
          onChange={props.onReadOnlyChange}
        />
      </FormRow>

      <h2 className="omni-section-heading">Credentials (stored in the OS keychain)</h2>
      {renderSection(props.provider.secretSchema.fields, 'secret')}

      <div className="omni-actions">
        <Button disabled={props.test.kind === 'running'} onClick={props.onTest}>
          {props.test.kind === 'running' ? 'Testing…' : 'Test Connection'}
        </Button>
        <Button disabled={!props.dirty} onClick={props.onRevert}>
          Revert
        </Button>
        <Button variant="primary" disabled={props.saving || !props.dirty} onClick={props.onSave}>
          {props.saving ? 'Saving…' : 'Save'}
        </Button>
      </div>

      <TestReport test={props.test} />
      {props.lastError !== undefined && (
        <p className="omni-error" role="alert">
          {props.lastError}
        </p>
      )}
    </div>
  );
}

function TestReport(props: { readonly test: TestState }): ReactNode {
  if (props.test.kind !== 'done') return null;
  const { outcome } = props.test;

  if (!outcome.ok) {
    return (
      <p className="omni-error" role="alert">
        {outcome.error?.message ?? 'Connection failed.'}
      </p>
    );
  }

  const capabilities = outcome.capabilities;
  const notes =
    capabilities === undefined
      ? ''
      : ` · ${capabilities.canRename ? 'rename' : 'no rename'}, ${String(capabilities.maxConcurrency)} parallel`;

  return (
    <p style={{ color: 'var(--omni-success)' }} role="status">
      Connected in {outcome.durationMs} ms{notes}
    </p>
  );
}
```

- [ ] **Step 4: Write the hook**

Create `packages/ui/src/model/use-connection-manager.ts`:

```ts
import { useCallback, useEffect, useReducer } from 'react';
import type { ConnectionId } from '@omni-fs/core';
import type { ConnectionsBackend } from '../ports/connections-backend.js';
import {
  initialManagerState,
  managerReducer,
  saveInputFrom,
  selectedConnection,
} from './reducer.js';
import type { ManagerAction, ManagerState } from './reducer.js';

export interface ConnectionManagerController {
  readonly state: ManagerState;
  readonly dispatch: (action: ManagerAction) => void;
  readonly save: () => Promise<void>;
  readonly test: () => Promise<void>;
  readonly remove: () => Promise<void>;
  readonly pickFile: (key: string) => Promise<void>;
}

/**
 * The only stateful piece in the package, and a thin one: every decision lives
 * in `managerReducer`, so this wrapper just performs effects against the Port.
 */
export function useConnectionManager(backend: ConnectionsBackend): ConnectionManagerController {
  const [state, dispatch] = useReducer(managerReducer, initialManagerState);

  useEffect(() => {
    let cancelled = false;

    const load = async (initial: boolean): Promise<void> => {
      if (!initial) {
        const connections = await backend.listConnections();
        if (!cancelled) dispatch({ type: 'connectionsChanged', connections });
        return;
      }

      const [providers, connections, selection] = await Promise.all([
        backend.listProviders(),
        backend.listConnections(),
        backend.initialSelection(),
      ]);
      if (cancelled) return;
      dispatch({ type: 'loaded', providers, connections, selection });
    };

    void load(true);
    const subscription = backend.onDidChange(() => void load(false));

    return () => {
      cancelled = true;
      subscription[Symbol.dispose]();
    };
  }, [backend]);

  const save = useCallback(async (): Promise<void> => {
    if (state.draft === undefined) return;
    if (state.errors.length > 0) {
      dispatch({ type: 'validationRevealed' });
      return;
    }

    dispatch({ type: 'saveStarted' });
    try {
      const id = await backend.save(saveInputFrom(state.draft));
      dispatch({ type: 'saveSucceeded', id });
    } catch (error) {
      dispatch({ type: 'saveFailed', message: messageOf(error) });
    }
  }, [backend, state.draft, state.errors]);

  const test = useCallback(async (): Promise<void> => {
    if (state.draft === undefined) return;
    dispatch({ type: 'testStarted' });
    try {
      const { readOnly: _readOnly, ...input } = saveInputFrom(state.draft);
      dispatch({ type: 'testFinished', outcome: await backend.test(input) });
    } catch (error) {
      dispatch({
        type: 'testFinished',
        outcome: {
          ok: false,
          durationMs: 0,
          error: { code: 'Unknown', message: messageOf(error), retryable: false },
        },
      });
    }
  }, [backend, state.draft]);

  const remove = useCallback(async (): Promise<void> => {
    const connection = selectedConnection(state);
    if (connection === undefined) return;
    await backend.remove(connection.id as ConnectionId);
  }, [backend, state]);

  const pickFile = useCallback(
    async (key: string): Promise<void> => {
      const path = await backend.pickFile();
      if (path !== undefined) {
        dispatch({ type: 'fieldChanged', section: 'settings', key, value: path });
      }
    },
    [backend],
  );

  return { state, dispatch, save, test, remove, pickFile };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

- [ ] **Step 5: Write the shell**

Create `packages/ui/src/components/ConnectionManagerApp.tsx`:

```tsx
import type { ReactNode } from 'react';
import type { ConnectionsBackend } from '../ports/connections-backend.js';
import { useConnectionManager } from '../model/use-connection-manager.js';
import { selectedConnection, selectedProvider } from '../model/reducer.js';
import { ConnectionForm } from './ConnectionForm.js';
import { ConnectionList } from './ConnectionList.js';
import { Button } from './primitives/index.js';

/**
 * The whole UI. It takes a Port and nothing else, so `apps/vscode` and
 * `apps/desktop` render the identical tree over different transports.
 */
export function ConnectionManagerApp(props: { readonly backend: ConnectionsBackend }): ReactNode {
  const manager = useConnectionManager(props.backend);
  const { state, dispatch } = manager;
  const provider = selectedProvider(state);

  if (state.status === 'loading') {
    return <div className="omni-root omni-help">Loading…</div>;
  }

  return (
    <div className="omni-root">
      <div className="omni-split">
        <ConnectionList
          connections={state.connections}
          providers={state.providers}
          selection={state.selection}
          onSelect={(target) => dispatch({ type: 'selectRequested', target })}
          onDuplicate={() => dispatch({ type: 'duplicateRequested' })}
          onDelete={() => void manager.remove()}
        />

        {state.draft === undefined || provider === undefined ? (
          <div className="omni-form omni-help">
            Select a connection, or add one with a button on the left.
          </div>
        ) : (
          <ConnectionForm
            draft={state.draft}
            provider={provider}
            errors={state.errors}
            showErrors={state.showErrors}
            dirty={state.dirty}
            saving={state.saving}
            test={state.test}
            lastError={state.lastError}
            secretFieldsPresent={selectedConnection(state)?.secretFieldsPresent ?? []}
            onLabelChange={(value) => dispatch({ type: 'labelChanged', value })}
            onFieldChange={(section, key, value) =>
              dispatch({ type: 'fieldChanged', section, key, value })
            }
            onSecretClear={(key) => dispatch({ type: 'secretCleared', key })}
            onRootPathChange={(value) => dispatch({ type: 'rootPathChanged', value })}
            onReadOnlyChange={(value) => dispatch({ type: 'readOnlyChanged', value })}
            onPickFile={(key) => void manager.pickFile(key)}
            onTest={() => void manager.test()}
            onRevert={() => dispatch({ type: 'reverted' })}
            onSave={() => void manager.save()}
          />
        )}
      </div>

      {state.pendingSelection !== undefined && (
        <div
          className="omni-actions"
          style={{ padding: 8, borderTop: '1px solid var(--omni-border)' }}
        >
          <span>Discard unsaved changes?</span>
          <Button variant="primary" onClick={() => dispatch({ type: 'selectConfirmed' })}>
            Discard
          </Button>
          <Button onClick={() => dispatch({ type: 'selectCancelled' })}>Keep editing</Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Export, verify and commit**

Add to `packages/ui/src/index.ts`:

```ts
export { ConnectionManagerApp } from './components/ConnectionManagerApp.js';
export { useConnectionManager } from './model/use-connection-manager.js';
export type { ConnectionManagerController } from './model/use-connection-manager.js';
```

Run: `pnpm --filter @omni-fs/ui exec vitest run && pnpm --filter @omni-fs/ui build && pnpm lint && pnpm format:check`
Expected: all green. The build proves the components typecheck under
`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.

```bash
git add packages/ui
git commit -m ":sparkles: feat add connection manager components"
```

---

## Task 7: Webview client and the build

**Files:**

- Create: `apps/vscode/src/webview/protocol.ts`, `apps/vscode/src/webview/backend.ts`, `apps/vscode/src/webview/index.tsx`, `apps/vscode/src/webview/theme-vscode.css`
- Modify: `apps/vscode/package.json`, `apps/vscode/esbuild.mjs`, `apps/vscode/tsconfig.json`

**Interfaces:**

- Consumes: `ConnectionManagerApp`, `ConnectionsBackend` and its data types from `@omni-fs/ui` (Tasks 3 and 6)
- Produces: `ViewToHost`, `HostToView`, `MethodName` (Task 8 implements the other end of all three), and the `out/webview.js` + `out/webview.css` bundle Task 8's HTML loads.

- [ ] **Step 1: Add the dependencies**

In `apps/vscode/package.json`, add to `dependencies`:

```json
    "@omni-fs/ui": "workspace:*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
```

and to `devDependencies`:

```json
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0"
```

Run `pnpm install`. `.npmrc` sets `hoist=false`, so these must be declared here for esbuild to resolve them.

- [ ] **Step 2: Define the wire protocol**

Create `apps/vscode/src/webview/protocol.ts`:

```ts
import type { ConnectionState } from '@omni-fs/core';

/** Backend methods that may be called across the wire. */
export type MethodName =
  | 'listProviders'
  | 'listConnections'
  | 'initialSelection'
  | 'save'
  | 'remove'
  | 'test'
  | 'connect'
  | 'pickFile';

export interface SerializedError {
  readonly message: string;
}

export type ViewToHost =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'request';
      readonly id: number;
      readonly method: MethodName;
      readonly params: unknown;
    };

export type HostToView =
  | { readonly kind: 'response'; readonly id: number; readonly ok: true; readonly value: unknown }
  | {
      readonly kind: 'response';
      readonly id: number;
      readonly ok: false;
      readonly error: SerializedError;
    }
  | { readonly kind: 'event'; readonly event: 'connectionsChanged' }
  | {
      readonly kind: 'event';
      readonly event: 'stateChanged';
      readonly connectionId: string;
      readonly state: ConnectionState;
    };
```

- [ ] **Step 3: Implement the backend over postMessage**

Create `apps/vscode/src/webview/backend.ts`:

```ts
import type {
  ConnectionSummary,
  ConnectionsBackend,
  InitialSelection,
  ProbeOutcome,
  SaveConnectionInput,
  TestConnectionInput,
} from '@omni-fs/ui';
import type { ConnectionId, ProviderSummary } from '@omni-fs/core';
import type { HostToView, MethodName, ViewToHost } from './protocol.js';

interface VsCodeApi {
  postMessage(message: ViewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/**
 * The VS Code half of the seam. Turns the Port's method calls into correlated
 * postMessage round trips. `apps/desktop` will have a sibling of this file
 * over `ipcRenderer` — and nothing in `packages/ui` will change.
 */
export class WebviewBackend implements ConnectionsBackend {
  readonly #api: VsCodeApi = acquireVsCodeApi();
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly #listeners = new Set<() => void>();
  #nextId = 0;

  constructor() {
    window.addEventListener('message', (event: MessageEvent) => {
      this.#receive(event.data as HostToView);
    });
    // The host replies with full state; this also covers a webview reload.
    this.#api.postMessage({ kind: 'ready' });
  }

  listProviders(): Promise<readonly ProviderSummary[]> {
    return this.#call('listProviders', undefined);
  }

  listConnections(): Promise<readonly ConnectionSummary[]> {
    return this.#call('listConnections', undefined);
  }

  initialSelection(): Promise<InitialSelection | undefined> {
    return this.#call('initialSelection', undefined);
  }

  save(input: SaveConnectionInput): Promise<ConnectionId> {
    return this.#call('save', input);
  }

  remove(id: ConnectionId): Promise<void> {
    return this.#call('remove', id);
  }

  test(input: TestConnectionInput): Promise<ProbeOutcome> {
    return this.#call('test', input);
  }

  connect(id: ConnectionId): Promise<void> {
    return this.#call('connect', id);
  }

  pickFile(): Promise<string | undefined> {
    return this.#call('pickFile', undefined);
  }

  onDidChange(listener: () => void): Disposable {
    this.#listeners.add(listener);
    return { [Symbol.dispose]: () => this.#listeners.delete(listener) };
  }

  #call<T>(method: MethodName, params: unknown): Promise<T> {
    const id = (this.#nextId += 1);
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#api.postMessage({ kind: 'request', id, method, params });
    });
  }

  #receive(message: HostToView): void {
    if (message.kind === 'event') {
      for (const listener of this.#listeners) listener();
      return;
    }

    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);

    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.error.message));
  }
}
```

- [ ] **Step 4: Map the theme tokens**

Create `apps/vscode/src/webview/theme-vscode.css`. This file is the only visual coupling to VS Code in the whole stack.

```css
/*
 * Remaps @omni-fs/ui's tokens onto VS Code's theme variables, so the panel
 * follows the user's colour theme. apps/desktop writes its own sibling of this
 * file and no component changes.
 */
:root {
  --omni-font: var(--vscode-font-family);
  --omni-font-size: var(--vscode-font-size);
  --omni-fg: var(--vscode-foreground);
  --omni-fg-muted: var(--vscode-descriptionForeground);
  --omni-bg: var(--vscode-editor-background);
  --omni-bg-raised: var(--vscode-button-secondaryBackground);
  --omni-border: var(--vscode-panel-border);
  --omni-input-bg: var(--vscode-input-background);
  --omni-input-fg: var(--vscode-input-foreground);
  --omni-accent: var(--vscode-button-background);
  --omni-accent-fg: var(--vscode-button-foreground);
  --omni-error: var(--vscode-errorForeground);
  --omni-success: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
  --omni-focus: var(--vscode-focusBorder);
  --omni-selection-bg: var(--vscode-list-activeSelectionBackground);
}

body {
  margin: 0;
  padding: 0;
}
```

- [ ] **Step 5: Write the entry point**

Create `apps/vscode/src/webview/index.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionManagerApp } from '@omni-fs/ui';
import '@omni-fs/ui/tokens.css';
import './theme-vscode.css';
import { WebviewBackend } from './backend.js';

const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <ConnectionManagerApp backend={new WebviewBackend()} />
    </StrictMode>,
  );
}
```

- [ ] **Step 6: Teach esbuild about the second bundle**

Replace the body of `apps/vscode/esbuild.mjs` below the doc comment with:

```js
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const shared = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/** The extension host: CommonJS, Node, `vscode` provided at runtime. */
/** @type {import('esbuild').BuildOptions} */
const extension = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
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

if (watch) {
  const contexts = await Promise.all([context(extension), context(webview)]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all([build(extension), build(webview)]);
}
```

- [ ] **Step 7: Let the extension's typecheck see TSX**

In `apps/vscode/tsconfig.json`, add `"jsx": "react-jsx"` to `compilerOptions` and make sure `include` covers `.tsx`:

```json
  "include": ["src/**/*.ts", "src/**/*.tsx"]
```

- [ ] **Step 8: Verify the build**

Run:

```bash
pnpm build
pnpm --filter omni-fs-vscode exec tsc -p tsconfig.json --noEmit
ls -la apps/vscode/out/
```

Expected: `out/extension.js`, `out/webview.js` and `out/webview.css` all exist, and the typecheck is clean. `pnpm build` must come first — the extension resolves `@omni-fs/ui` through `dist/`, not source.

- [ ] **Step 9: Commit**

```bash
pnpm format
git add apps/vscode pnpm-lock.yaml
git commit -m ":sparkles: feat add connection manager webview client"
```

---

## Task 8: The panel, commands and cleanup

**Files:**

- Create: `apps/vscode/src/webview/connection-manager-panel.ts`
- Modify: `apps/vscode/src/commands/index.ts`, `apps/vscode/src/extension.ts`, `apps/vscode/package.json`, `CLAUDE.md`

**Interfaces:**

- Consumes: `ViewToHost`, `HostToView`, `MethodName` (Task 7); `ConnectionManager.probe`, `ProbeTarget` (Task 2); `mergeSecret`, `toProviderSummary` (Task 1); `SaveConnectionInput`, `TestConnectionInput`, `ProbeOutcome`, `InitialSelection` (Task 3)
- Produces: `ConnectionManagerPanel.show(deps, selection?)`, called by three commands.

- [ ] **Step 1: Write the panel**

Create `apps/vscode/src/webview/connection-manager-panel.ts`:

```ts
import * as vscode from 'vscode';
import { mergeSecret, toProviderSummary } from '@omni-fs/core';
import type {
  ConfigStore,
  ConnectionConfig,
  ConnectionManager,
  ProviderRegistry,
  SecretStore,
} from '@omni-fs/core';
import type {
  ConnectionSummary,
  InitialSelection,
  ProbeOutcome,
  SaveConnectionInput,
  TestConnectionInput,
} from '@omni-fs/ui';
import type { HostToView, MethodName, ViewToHost } from './protocol.js';

export interface PanelDeps {
  readonly extensionUri: vscode.Uri;
  readonly manager: ConnectionManager;
  readonly configStore: ConfigStore;
  readonly secretStore: SecretStore;
  readonly registry: ProviderRegistry;
  readonly onChanged: () => void;
}

/**
 * The extension-host half of the connection manager.
 *
 * This is the only file that touches ConfigStore, SecretStore, the registry and
 * the ConnectionManager on the panel's behalf. The webview gets data and
 * nothing else — in particular it never receives a stored credential.
 */
export class ConnectionManagerPanel {
  static #current: ConnectionManagerPanel | undefined;

  readonly #panel: vscode.WebviewPanel;
  readonly #deps: PanelDeps;
  readonly #disposables: vscode.Disposable[] = [];
  #selection: InitialSelection | undefined;

  static show(deps: PanelDeps, selection?: InitialSelection): void {
    const existing = ConnectionManagerPanel.#current;
    if (existing !== undefined) {
      existing.#selection = selection;
      existing.#panel.reveal(vscode.ViewColumn.Active);
      if (selection !== undefined) existing.#post({ kind: 'event', event: 'connectionsChanged' });
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'omniFs.connectionManager',
      'Omni-FS Connections',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // The draft survives hiding via the webview's own setState, and a
        // `ready` message resyncs everything else, so retaining the whole
        // context in memory buys nothing.
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, 'out')],
      },
    );

    ConnectionManagerPanel.#current = new ConnectionManagerPanel(panel, deps, selection);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    deps: PanelDeps,
    selection: InitialSelection | undefined,
  ) {
    this.#panel = panel;
    this.#deps = deps;
    this.#selection = selection;

    panel.webview.html = this.#html();

    this.#disposables.push(
      panel.webview.onDidReceiveMessage((message: ViewToHost) => void this.#receive(message)),
    );

    // Hand-editing settings.json updates an open panel.
    const configSubscription = deps.configStore.onDidChange(() => {
      this.#post({ kind: 'event', event: 'connectionsChanged' });
    });
    const stateSubscription = deps.manager.onDidChangeState((change) => {
      this.#post({
        kind: 'event',
        event: 'stateChanged',
        connectionId: change.connectionId,
        state: change.state,
      });
    });

    panel.onDidDispose(() => {
      configSubscription[Symbol.dispose]();
      stateSubscription[Symbol.dispose]();
      for (const disposable of this.#disposables) disposable.dispose();
      ConnectionManagerPanel.#current = undefined;
    });
  }

  #post(message: HostToView): void {
    void this.#panel.webview.postMessage(message);
  }

  async #receive(message: ViewToHost): Promise<void> {
    if (message.kind === 'ready') {
      this.#post({ kind: 'event', event: 'connectionsChanged' });
      return;
    }

    try {
      this.#post({
        kind: 'response',
        id: message.id,
        ok: true,
        value: await this.#dispatch(message.method, message.params),
      });
    } catch (error) {
      this.#post({
        kind: 'response',
        id: message.id,
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  async #dispatch(method: MethodName, params: unknown): Promise<unknown> {
    switch (method) {
      case 'listProviders':
        return this.#deps.registry.list().map(toProviderSummary);

      case 'listConnections':
        return this.#listConnections();

      case 'initialSelection': {
        const selection = this.#selection;
        // One-shot: reopening the panel later should not jump back.
        this.#selection = undefined;
        return selection;
      }

      case 'save':
        return this.#save(params as SaveConnectionInput);

      case 'remove':
        return this.#remove(params as string);

      case 'test':
        return this.#test(params as TestConnectionInput);

      case 'connect':
        await this.#deps.manager.acquire(params as string);
        return undefined;

      case 'pickFile': {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false });
        return picked?.[0]?.fsPath;
      }
    }
  }

  async #listConnections(): Promise<readonly ConnectionSummary[]> {
    const configs = await this.#deps.configStore.list();

    return Promise.all(
      configs.map(async (config): Promise<ConnectionSummary> => {
        const secret = await this.#deps.secretStore.get(config.id);
        return {
          id: config.id,
          providerId: config.providerId,
          label: config.label,
          settings: config.settings,
          rootPath: config.rootPath,
          readOnly: config.readOnly ?? false,
          // Keys only. The values stay in this process.
          secretFieldsPresent: Object.keys(secret ?? {}),
          state: this.#deps.manager.getState(config.id),
        };
      }),
    );
  }

  async #save(input: SaveConnectionInput): Promise<string> {
    const definition = this.#deps.registry.get(input.providerId);
    const id = input.id ?? generateId();

    const config: ConnectionConfig = {
      id,
      providerId: input.providerId,
      label: input.label,
      settings: input.settings,
      ...(input.rootPath !== undefined ? { rootPath: input.rootPath } : {}),
      readOnly: input.readOnly,
    };

    const stored = await this.#deps.secretStore.get(id);
    const merged = mergeSecret(stored, input.secretPatch, definition.secretSchema);

    await this.#deps.configStore.save(config);
    await this.#deps.secretStore.set(id, merged);
    // Settings may have changed, so any live connection is stale.
    await this.#deps.manager.invalidate(config);
    this.#deps.onChanged();

    return id;
  }

  async #remove(id: string): Promise<void> {
    await this.#deps.manager.disconnect(id);
    await this.#deps.configStore.delete(id);
    await this.#deps.secretStore.delete(id);
    this.#deps.onChanged();
  }

  async #test(input: TestConnectionInput): Promise<ProbeOutcome> {
    const definition = this.#deps.registry.get(input.providerId);
    const stored = input.id === undefined ? undefined : await this.#deps.secretStore.get(input.id);
    // The merge happens here, not in the webview, which never sees `stored`.
    const secret = mergeSecret(stored, input.secretPatch, definition.secretSchema);

    const result = await this.#deps.manager.probe(
      {
        providerId: input.providerId,
        label: input.label,
        settings: input.settings,
        ...(input.rootPath !== undefined ? { rootPath: input.rootPath } : {}),
      },
      secret,
    );

    // Convert at the boundary: an OmniFsError instance cannot be
    // structured-cloned to the webview.
    return {
      ok: result.ok,
      durationMs: result.durationMs,
      ...(result.capabilities !== undefined ? { capabilities: result.capabilities } : {}),
      ...(result.error !== undefined
        ? {
            error: {
              code: result.error.code,
              message: result.error.message,
              retryable: result.error.retryable,
            },
          }
        : {}),
    };
  }

  #html(): string {
    const webview = this.#panel.webview;
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.#deps.extensionUri, 'out', 'webview.js'),
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.#deps.extensionUri, 'out', 'webview.css'),
    );
    const nonce = generateNonce();

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${style.toString()}" rel="stylesheet" />
    <title>Omni-FS Connections</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${script.toString()}"></script>
  </body>
</html>`;
  }
}

function generateId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function generateNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}
```

- [ ] **Step 2: Rewire the commands**

In `apps/vscode/src/commands/index.ts`:

1. Add `readonly extensionUri: vscode.Uri;` to `CommandDeps`.
2. Add the import: `import { ConnectionManagerPanel } from '../webview/connection-manager-panel.js';`
3. Replace the `addConnection` and `editConnection` registrations and add the new command:

```ts
    vscode.commands.registerCommand('omniFs.addConnection', () => {
      const first = deps.registry.list()[0];
      showPanel(deps, first === undefined ? undefined : { kind: 'new', providerId: first.id });
    }),
    vscode.commands.registerCommand('omniFs.editConnection', (node?: ConnectionNode) => {
      showPanel(
        deps,
        node?.kind === 'connection' ? { kind: 'connection', id: node.config.id } : undefined,
      );
    }),
    vscode.commands.registerCommand('omniFs.manageConnections', () => showPanel(deps)),
```

4. Add the helper:

```ts
function showPanel(deps: CommandDeps, selection?: InitialSelection): void {
  ConnectionManagerPanel.show(
    {
      extensionUri: deps.extensionUri,
      manager: deps.manager,
      configStore: deps.configStore,
      secretStore: deps.secretStore,
      registry: deps.registry,
      onChanged: () => deps.connectionsTree.refresh(),
    },
    selection,
  );
}
```

with `import type { InitialSelection } from '@omni-fs/ui';`

5. **Delete** `addConnection`, `editConnection`, `pickProvider` and `promptForFields` entirely — roughly 100 lines. Keep `removeConnection`, `connect`, `connectById`, `disconnect`, `mount`, `resolveConfig`, `notYet` and `generateId`.

6. Remove now-unused imports: `ProviderDefinition` and `SettingsField`.

- [ ] **Step 3: Pass the extension URI**

In `apps/vscode/src/extension.ts`, add `extensionUri: context.extensionUri,` to the `registerCommands({...})` call.

- [ ] **Step 4: Declare the new command**

In `apps/vscode/package.json`, add to `contributes.commands`:

```json
{
  "command": "omniFs.manageConnections",
  "title": "Manage Connections",
  "category": "Omni-FS",
  "icon": "$(settings-gear)"
}
```

and to `contributes.menus`, in `view/title`:

```json
{
  "command": "omniFs.manageConnections",
  "when": "view == omniFs.connections",
  "group": "navigation@3"
}
```

- [ ] **Step 5: Update the docs**

In `CLAUDE.md`, under **Tests**, the line stating that only `@omni-fs/core` and `@omni-fs/testing` have tests is now wrong. Change it to name `@omni-fs/ui` as well, and note that `packages/ui` runs its tests without jsdom because its state machine is a pure reducer.

Under **Architecture**, add a short paragraph after the `ProviderRegistry` section:

```markdown
**`@omni-fs/ui`** is the connection manager, shared by both hosts. It depends on
React and `@omni-fs/core` and nothing else — no widget library, no host APIs.
Its single seam is the `ConnectionsBackend` port: `apps/vscode` implements it
over `postMessage`, `apps/desktop` will implement it over IPC, and the
components above it do not change. Everything crossing that port is plain
serializable data, because in VS Code it is structured-cloned.
```

- [ ] **Step 6: Verify the whole repo**

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm format:check
pnpm package:vsix
ls -la apps/vscode/*.vsix
```

Expected: everything green, and the `.vsix` well under 2 MB. If it is not, the cause is a `.vscodeignore` miss, not React.

- [ ] **Step 7: Verify by hand in the extension host**

Press <kbd>F5</kbd>, then walk this list. Each line is a behaviour the automated tests cannot reach:

1. **Add** — the Omni-FS view's _Manage Connections_ opens one panel; clicking it again reveals the same panel rather than opening a second.
2. **Create** — add an S3 connection, filling bucket, region and credentials. Save is disabled until the form is dirty and valid.
3. **Test before saving** — _Test Connection_ on the unsaved draft reports "Connected in N ms · no rename, 16 parallel". Nothing appears in `settings.json` or the keychain yet.
4. **Bad credentials** — break the secret key and test again: an `AuthenticationFailed` message appears, and the connections tree shows no error state for anything.
5. **Save and browse** — save, then expand the connection in the tree. It lists objects.
6. **Edit without retyping** — reopen it. Credential fields read `•••••••• stored — type to replace`. Change only the label and save; the connection still works, so the stored secret survived.
7. **Clear an optional credential** — set a session token, save, reopen, press _Clear_, save. The keychain entry loses that key.
8. **External edit** — with the panel open, hand-edit a label in `settings.json`. The list updates. Repeat while a draft is dirty: the list updates, the draft does not.
9. **Unsaved-changes guard** — edit a field, click another connection: the discard prompt appears. _Keep editing_ preserves the edit; _Discard_ switches.
10. **Duplicate** — duplicate a connection. Settings copy across, credentials do not, and the required credential is flagged.
11. **File field** — on an SFTP connection, the private key field's _Browse…_ opens a native dialog and fills the path.
12. **Theme** — switch between a light and a dark theme. The panel follows, with no unreadable text.

- [ ] **Step 8: Commit**

```bash
pnpm format
git add apps/vscode CLAUDE.md
git commit -m ":sparkles: feat replace connection prompts with a manager panel"
```

---

## Notes for the executor

**Order matters.** Tasks 1 and 2 can run in parallel; 3 depends on 1; 4 and 5 depend on 3; 6 depends on 4 and 5; 7 depends on 6; 8 depends on 7 and 2.

**After any change to `packages/`, run `pnpm build` before trusting the extension's typecheck.** `apps/vscode` resolves `@omni-fs/core` and `@omni-fs/ui` through `dist/`, not source, so a stale build produces type errors that describe code you already fixed.

**If a step's test does not fail the way the plan predicts, stop.** A test that passes before the implementation exists is testing nothing.
