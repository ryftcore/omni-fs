import { configDefaults, defineConfig } from 'vitest/config';

// Live tests need the compose stack, so the default run excludes them and
// `pnpm test` stays hermetic. `dist/**` is named as well because vitest's
// defaults do not cover it and the packages emit there.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '**/dist/**', '**/*.live.test.ts'] },
});
