import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The differential suites replay many scenarios; on slower CI runners a
    // single case can exceed Vitest's 5s default. Give them headroom.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
