import { defineConfig } from 'vitest/config';

// ルートの vitest.config.ts の include に入っていないので、この道具の試験はここから動かす。
//   npx vitest run --config tools/initiative_review/vitest.config.ts
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
  },
});
