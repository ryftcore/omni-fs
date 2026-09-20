import { configDefaults, defineConfig } from 'vitest/config';

// `dist/**` is named because vitest's defaults do not cover it and the packages
// emit there. Mirrors `packages/provider-webdav/vitest.config.ts`, which adds
// the live-test exclusion this package will need once it grows a conformance
// run against MinIO.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '**/dist/**'] },
});
