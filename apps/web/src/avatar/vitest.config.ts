import { defineConfig } from 'vitest/config';

// ルートの vitest.config.ts は apps/*/test/ だけを見るので、持ち場の中で別に動かす。
//   npx vitest run --config apps/web/src/avatar/vitest.config.ts
export default defineConfig({
  // キャッシュをソースの中に作らない。
  cacheDir: new URL('../../../../node_modules/.vite-avatar', import.meta.url).pathname,
  test: {
    root: import.meta.dirname,
    include: ['__tests__/**/*.test.ts'],
    testTimeout: 15000,
  },
});
