import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { OmniFsApi } from '../../extension.js';
import { EXTENSION_ID } from '../helpers.js';

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
    // The contract this line depends on, stated because it is written down
    // nowhere else: a provider package named `@omni-fs/provider-<x>` must
    // export a definition whose `id` is exactly `<x>`. Name the package and
    // the id differently and this test fails, which is the intended way to
    // find out.
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
      // `inspect` rather than `get`: a user or workspace value would otherwise
      // mask a missing contribution and the test would pass on a dev machine
      // and fail nowhere. `inspect` itself proves nothing — it returns an
      // object for any section name, contributed or not — so `defaultValue`
      // is the only assertion worth making.
      assert.notEqual(
        configuration.inspect(key)?.defaultValue,
        undefined,
        `omniFs.${key} is read by the code but contributes no default`,
      );
    }
  });
});
