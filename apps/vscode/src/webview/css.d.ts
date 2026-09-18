// esbuild resolves and bundles these at build time; tsc only needs to know the
// import is valid. Side-effect only, so an empty module is enough.
declare module '*.css';
