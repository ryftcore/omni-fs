import { readdirSync, rmSync } from 'node:fs';
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
// `--tests-only` builds the test bundles and nothing else, so it cannot touch
// `out/`. That matters twice: turbo's `build:tests` declares only `out-test/**`
// as its output and has no edge to `build`, so writing `out/` too would make
// two unordered tasks write the same files; and `build:tests` after
// `package:vsix` would otherwise replace the minified production bundle with a
// dev one. `--tests` still builds all three, which is what the F5 watch loop
// wants.
const testsOnly = process.argv.includes('--tests-only');
const withTests = testsOnly || process.argv.includes('--tests');

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
 * they compose. A separate directory buys nothing from `.vscodeignore`, which
 * lists paths explicitly rather than shipping an allowlist: `out-test/**` has
 * an entry there, and needs one.
 *
 * Never minified and always sourcemapped, whatever `--production` says: a
 * failing assertion inside an Electron host is read off its stack trace or not
 * at all.
 *
 * `outbase` keeps `hermetic/` and `live/` as real directories under
 * `out-test/`, which is what the two `files` globs in `.vscode-test.mjs`
 * select on.
 *
 * The entry set is a snapshot, taken once when this module loads. esbuild then
 * watches the import graph of the entries it was handed, so under `--watch` an
 * *edit* to a test file rebuilds but a *new* test file is never picked up:
 * restart the watcher after adding one. `test:extension` runs `--tests-only`
 * first for exactly this reason — otherwise a suite can report green over a
 * bundle that never contained the new file.
 */
function testEntryPoints() {
  const entries = readdirSync('src/test', { recursive: true })
    .map((entry) => String(entry).replaceAll('\\', '/'))
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `src/test/${name}`);

  // A glob that matches nothing is a silent green, not an error, at every
  // step after this one: esbuild builds `entryPoints: []` without complaint,
  // and @vscode/test-cli treats a `files` pattern matching no file as a run
  // that passed. So renaming or moving `src/test/hermetic/` or `src/test/live/`
  // would leave both CI jobs reporting success over zero assertions — and the
  // live job's production-bundle guard disappears with them, since that guard
  // is itself one of the files that stopped matching. Fail loudly instead.
  if (!entries.length) throw new Error('No *.test.ts under src/test — the test glob is broken.');

  return entries;
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

const targets = testsOnly
  ? [tests]
  : withTests
    ? [extension, webview, tests]
    : [extension, webview];

// esbuild writes into outdir without emptying it, so a deleted or renamed
// test file would leave its bundle behind and vscode-test's glob would keep
// running it — a test that no longer exists, still reporting green. Cleaning
// here rather than in the script covers every path that builds tests,
// including the watcher, which empties once at start.
if (withTests) rmSync('out-test', { recursive: true, force: true });

if (watch) {
  const contexts = await Promise.all(targets.map((target) => context(target)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(targets.map((target) => build(target)));
}
