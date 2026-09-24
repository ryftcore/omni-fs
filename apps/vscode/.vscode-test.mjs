import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

/**
 * Three labels, run separately.
 *
 * `hermetic` needs no network and no Docker, so it runs on all three desktop
 * platforms in the normal PR path. `workspace` is hermetic too, and runs
 * straight after it from the same script; it exists only because it has to
 * open a different kind of window (see below). `live` needs `compose.yaml` up
 * and the production bundle in `out/`, so it is Linux-only and runs in its own
 * job.
 *
 * None joins `pnpm test`, which stays the fast hermetic loop. A 150 MB editor
 * download and an Electron launch do not belong in it — the same reason
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

/**
 * A throwaway multi-root workspace and profile for the `workspace` label.
 *
 * Adding a folder to a single-folder window makes VS Code enter a new
 * untitled workspace, which it refuses under test — and after that it refuses
 * every folder update for the rest of the run. So the suites that open a
 * connection as a workspace folder need a window that is a workspace already.
 *
 * Generated rather than committed, because VS Code rewrites the file on every
 * folder change. And a profile of its own, fresh per run: VS Code reopens
 * every untitled workspace in a profile at startup, whatever
 * `window.restoreWindows` says, and a single-folder window that tries to add
 * a folder leaves one behind — it is written before VS Code refuses to enter
 * it. A shared profile would hand such a leftover to this label as a second
 * window, running the suite alongside it.
 *
 * Both names are short on purpose. VS Code puts its IPC socket inside the
 * profile, and a Unix socket path is capped at 103 characters, which macOS's
 * own temp directory already takes half of.
 *
 * Created whenever this file loads, whichever label runs, and removed when
 * the run exits — except for `--list-configuration`, whose caller launches
 * from the listed paths after this process is gone.
 */
const scratch = mkdtempSync(join(tmpdir(), 'omnifs-'));
const workspaceFile = join(scratch, 'omni-fs.code-workspace');
writeFileSync(
  workspaceFile,
  JSON.stringify({
    folders: [{ path: join(import.meta.dirname, 'src/test/fixtures/workspace') }],
  }),
);
if (!process.argv.includes('--list-configuration')) {
  process.on('exit', () => {
    try {
      // By exit, VS Code has quit. The retries are for Windows, where one of
      // its helper processes can hold a file for a moment longer.
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A temp directory the OS will clear eventually is not worth failing a run.
    }
  });
}

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
    label: 'workspace',
    workspaceFolder: workspaceFile,
    launchArgs: [...shared.launchArgs, `--user-data-dir=${join(scratch, 'ud')}`],
    files: 'out-test/workspace/**/*.test.js',
    mocha: { ui: 'tdd', timeout: 20_000 },
  },
  {
    ...shared,
    label: 'live',
    files: 'out-test/live/**/*.test.js',
    // Longer again: suiteSetup here waits for the compose stack's one-shot
    // seed container to finish chowning the SFTP volume.
    //
    // Strictly greater than that wait's own budget — `WRITABLE_BUDGET_MS` in
    // live/bundled-sdk.test.ts — and that margin is load-bearing. At exactly
    // 60_000 the two expire together and Mocha wins, so a stopped server
    // reports `Timeout of 60000ms exceeded` instead of naming the server: a
    // failure either way, but the one that does not say which server is down.
    mocha: { ui: 'tdd', timeout: 90_000 },
  },
]);
