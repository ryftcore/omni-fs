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

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
