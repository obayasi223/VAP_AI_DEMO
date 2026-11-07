import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error build.mjs は型を持たない
import { bundle } from '../../src/audio/build.mjs';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/worklets');

describe('public/worklets の生成物', () => {
  it('ソースと一致する（違うなら npm run build:audio -w @llm-vap/web）', async () => {
    const built = (await bundle(false)) as { name: string; text: string }[];
    for (const file of built) {
      expect(await readFile(path.join(dir, file.name), 'utf8')).toBe(file.text);
    }
  });

  it('Worklet の束に import が残らず、zod を含まない', async () => {
    const text = await readFile(path.join(dir, 'duplex.worklet.js'), 'utf8');
    expect(text).not.toMatch(/^import /m);
    expect(text).not.toMatch(/zod/i);
  });
});
