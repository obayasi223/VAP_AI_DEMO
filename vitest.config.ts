import { defineConfig } from 'vitest/config';

// ルートの tests/（旧デモ）は node --test のままで、ここには含めない。
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    testTimeout: 15000,
  },
});
