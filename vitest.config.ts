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
      'tools/latency_initiative/test/**/*.test.ts',
      // two_ai（docs/design/two_ai/05 §5.1 の WP0）
      'apps/orchestrator/src/cognition/discussion/__tests__/**/*.test.ts',
      'apps/web/test/two_ai/**/*.test.ts',
      'tools/two_ai_*/test/**/*.test.ts',
    ],
    testTimeout: 15000,
  },
});
