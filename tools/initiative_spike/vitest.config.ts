import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// ルートの npm test にも含まれる。S の試験だけを走らせるときに使う。
//   npx vitest run --config tools/initiative_spike/vitest.config.ts
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: [
      'apps/orchestrator/src/cognition/initiative/__tests__/**/*.test.ts',
      'tools/initiative_spike/test/**/*.test.ts',
    ],
    testTimeout: 15000,
  },
});
