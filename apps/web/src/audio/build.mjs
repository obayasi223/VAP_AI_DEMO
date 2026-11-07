// Worklet と Worker を public/worklets/ へ束ねる。`npm run build:audio -w @llm-vap/web`。
// 生成物はリポジトリに含める（next dev / next build だけで動くように）。古さは test/audio/bundle.test.ts で検出する。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../public/worklets');

export const ENTRIES = [
  { in: path.join(here, 'duplex.worklet.ts'), out: 'duplex.worklet.js' },
  { in: path.join(here, 'transport.worker.ts'), out: 'transport.worker.js' },
];

/** @param {boolean} write */
export async function bundle(write) {
  const results = [];
  for (const entry of ENTRIES) {
    const result = await build({
      entryPoints: [entry.in],
      outfile: path.join(outDir, entry.out),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      minify: false,
      legalComments: 'none',
      charset: 'utf8',
      write,
      absWorkingDir: path.resolve(here, '../..'),
      banner: { js: '// 生成物。編集しない。元は apps/web/src/audio/（npm run build:audio）。' },
    });
    results.push({ name: entry.out, text: result.outputFiles?.[0]?.text ?? null });
  }
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await bundle(true);
  console.log(`bundled ${ENTRIES.map((e) => e.out).join(', ')}`);
}
