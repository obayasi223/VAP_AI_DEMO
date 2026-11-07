// TTS へ送る文の候補を、本番と同じ変換（apps/orchestrator/src/speech/reading）で作って固定する。ネットに出ない。
//   npx tsx tools/provider_probe/reading_variants.ts      （リポジトリのルートで）
// lib/reading_variants.json に書く。reading_roundtrip.mjs の el_risky_ja／el_all_ja はこのファイルの文を送る。
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzePieces, convertForTts, loadKuromojiAnalyzer, replacesForTts } from '../../apps/orchestrator/src/speech/reading';
// @ts-ignore: .mjs の定数（型なし）
import { SENTENCES, SENTENCES_NEW } from './lib/reading_sentences.mjs';

interface Sentence {
  id: string;
  kanji: string;
  kana: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const analyzer = await loadKuromojiAnalyzer();
const out: Record<string, { kanji: string; risky: string; all: string; risky_words: string[] }> = {};
let chars = { kanji: 0, risky: 0, all: 0 };
for (const s of [...(SENTENCES as Sentence[]), ...(SENTENCES_NEW as Sentence[])]) {
  const risky = convertForTts(s.kanji, analyzer, 'risky');
  const all = convertForTts(s.kanji, analyzer, 'all');
  const risky_words = analyzePieces(s.kanji, analyzer)
    .filter((p) => replacesForTts(p, 'risky'))
    .map((p) => `${s.kanji.slice(p.start, p.end)}→${p.kana}`);
  out[s.id] = { kanji: s.kanji, risky, all, risky_words };
  chars = { kanji: chars.kanji + [...s.kanji].length, risky: chars.risky + [...risky].length, all: chars.all + [...all].length };
  console.log(`${s.id}\n  a ${s.kanji}\n  b ${risky}  [${risky_words.join(' ')}]\n  c ${all}\n  h ${s.kana}`);
}
writeFileSync(join(here, 'lib', 'reading_variants.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ analyzer: analyzer.name, chars }));
