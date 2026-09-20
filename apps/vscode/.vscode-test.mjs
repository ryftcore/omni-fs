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
