import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ConnectionSecret } from '@omni-fs/core';
import {
  EXTENSION_ID,
  activateExtension,
  bytes,
  isFileSystemError,
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
 * `pnpm package:vsix` leaves exactly that behind. The first suite below
 * asserts the second half of that, because nothing in the task graph does.
 *
 * The four cases in each provider suite share one scratch file on a real
 * server and run in Mocha's declaration order: the last one destroys what the
 * first three read. Do not reach for `.only` on one of them, and do not run
 * this label in parallel mode — either gives a confusing failure that is about
 * the ordering rather than about the bundle.
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

/**
 * Declared before the provider suites so it fails before anything touches a
 * server: every case below it would pass just as happily over a dev bundle,
 * and would then be proving nothing.
 */
suite('the bundle under test', () => {
  test('is the production build, not a dev one', async () => {
    // The live label's entire claim is about the artifact that ships, and
    // nothing in the task graph guarantees `out/` holds it — `test:extension:live`
    // deliberately has no turbo edge to `build`, so `pnpm build`, `pnpm dev` or
    // an F5 session all leave a dev bundle there. Asserted here rather than
    // left to whoever remembers to grep.
    //
    // `package:vsix` is trustworthy for this only because its turbo task is
    // `"cache": false`. It writes `out/` as a side effect while declaring only
    // the .vsix, so while it was cacheable a replay restored the artifact,
    // skipped the script, and left whatever dev bundle `build` wrote last —
    // observed, not hypothetical, and invisible without this test.
    const bundle = await readFile(extensionPath('out', 'extension.js'), 'utf8');
    assert.ok(
      !bundle.includes('SftpFileSystem') && !bundle.includes('//# sourceMappingURL'),
      'out/extension.js is a development bundle — run `pnpm package:vsix` first',
    );
  });
});

for (const [name, target] of Object.entries(targets())) {
  suite(`bundled ${name}`, () => {
    const connectionId = `${RUN}-${name}`;
    // Pure functions of `connectionId`, so they are consts rather than
    // assigned in `suiteSetup`. That is what lets `suiteTeardown` below clean
    // up after a setup that failed before it got anywhere near them.
    const scratch = vscode.Uri.from({
      scheme: 'omnifs',
      authority: connectionId,
      path: `/${RUN}`,
    });
    const file = scratch.with({ path: `${scratch.path}/hello.txt` });
    let registration: Disposable | undefined;

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

      // Readiness is proved by actually writing, not by connecting.
      // compose.yaml seeds the tree from a one-shot `file-seed` container
      // that starts *after* the servers and ends with `chown -R 1000:1000`,
      // so there is a window in which SFTP accepts a login and a write fails
      // with PermissionDenied. Retry that, not the connect.
      //
      // Never skip: a live label that passes with nothing running is the
      // failure this suite exists to prevent.
      //
      // Each provider's `rootPrefix`/`baseUrl`/`bucket` already points at the
      // seeded tree, so the paths above are relative to that root.
      await waitUntilWritable(name, async () => {
        await vscode.workspace.fs.createDirectory(scratch).then(undefined, (error: unknown) => {
          // MKCOL on an existing collection is a 405 that WebDAV maps to
          // FileExists. Harmless, and it must not poison the retry: without
          // this, one transient PUT failure after a successful MKCOL makes
          // every later attempt fail here, burn the full budget and blame a
          // healthy server. The write below is the signal we actually want.
          if (!isFileSystemError(error, 'FileExists')) throw error;
        });
        await vscode.workspace.fs.writeFile(file, bytes(PAYLOAD));
      });
    });

    suiteTeardown(async () => {
      // Best-effort: the delete test below is the one that asserts. This is
      // the safety net for a run that failed before reaching it — including
      // one that failed inside `suiteSetup`, which is why `registration` is
      // optional-called and `scratch` is a const declared above.
      await vscode.workspace.fs
        .delete(scratch, { recursive: true })
        .then(undefined, () => undefined);
      registration?.[Symbol.dispose]();
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

      // `async` rather than a bare call: `workspace.fs` returns a `Thenable`
      // and `assert.rejects` takes a real `Promise`, as everywhere else in
      // this suite.
      //
      // `FileNotFound` specifically, not any FileSystemError: all three
      // providers really do surface that code for a stat of a deleted path,
      // and the weaker predicate would be satisfied by a stat that failed
      // because the connection dropped.
      await assert.rejects(
        async () => vscode.workspace.fs.stat(file),
        (error: unknown) => isFileSystemError(error, 'FileNotFound'),
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

/** How long a server is given to become writable before the suite gives up. */
const WRITABLE_BUDGET_MS = 60_000;

/**
 * Assumed worst case for one attempt, so the loop stops *starting* them with
 * less than this left rather than overshooting by however long the last one
 * takes.
 */
const ATTEMPT_BUDGET_MS = 15_000;

/**
 * Retries `attempt` until it succeeds or the budget runs out, then fails with
 * the last error and the name of the server that never became writable.
 *
 * Both numbers above are coupled to something outside this file, and raising
 * either means revisiting the other two:
 *
 * `WRITABLE_BUDGET_MS` must stay **below** the live label's `mocha.timeout` in
 * `.vscode-test.mjs`. If Mocha's hook timeout expires first it reports a
 * generic `Timeout of …ms exceeded` and the name of the unreachable server —
 * the entire point of this helper — is lost. They were equal once, and Mocha
 * won.
 *
 * `ATTEMPT_BUDGET_MS` is what keeps that inequality true in the bad case. A
 * stopped container refuses instantly, but a *wedged* one (SYN accepted, no
 * reply) makes an attempt cost a provider connect timeout plus its SDK's
 * retries, and starting one of those at the 59th second would blow straight
 * through the harness timeout — in precisely the case where "which server is
 * down" is hardest to guess.
 */
async function waitUntilWritable(name: string, attempt: () => Promise<void>): Promise<void> {
  const started = Date.now();
  const deadline = started + WRITABLE_BUDGET_MS;
  let last: unknown;

  while (Date.now() + ATTEMPT_BUDGET_MS < deadline) {
    try {
      await attempt();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  // Elapsed rather than the budget: the loop stops an attempt-budget early,
  // and a message that rounds its own wait up is one more thing to distrust
  // while working out why a server is unreachable.
  const elapsed = Math.round((Date.now() - started) / 1_000);
  assert.fail(
    `${name} never became writable within ${String(elapsed)}s. Is \`docker compose up -d\` running? Last error: ${String(last)}`,
  );
}
