import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // No jsdom: everything tested here is a pure function. That is why the
    // state machine is a reducer rather than a hook.
    environment: 'node',
  },
});
