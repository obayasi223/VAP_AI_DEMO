import { defineConfig } from 'vitest/config';

// ルートの tests/（旧デモ）は node --test のままで、ここには含めない。
export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'apps/orchestrator/src/cognition/initiative/__tests__/**/*.test.ts',
      'apps/web/src/avatar/__tests__/**/*.test.ts',
      'tools/initiative_spike/test/**/*.test.ts',
      'tools/initiative_review/test/**/*.test.ts',
    ],
    testTimeout: 15000,
  },
});
