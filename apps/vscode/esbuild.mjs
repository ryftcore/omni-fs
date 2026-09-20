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
/** @type {import('esbuild').BuildOptions} */
const extension = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode', 'cpu-features', '*.node'],
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
