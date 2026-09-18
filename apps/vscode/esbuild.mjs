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
