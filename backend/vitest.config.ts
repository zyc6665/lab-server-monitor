import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The differential suites replay many scenarios; on slower CI runners a
    // single case can exceed Vitest's 5s default. Give them headroom.
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary'],
      // 覆盖率棘轮：略低于当前基线（statements 85.0 / branches 73.8 / functions 92.4 / lines 86.4），
      // 只允许上升、不允许回退。
      thresholds: { statements: 84, branches: 72, functions: 90, lines: 85 },
    },
  },
});
