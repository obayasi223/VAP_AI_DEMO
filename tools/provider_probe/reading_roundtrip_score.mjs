// Scores the transcripts from reading_roundtrip.mjs against the expected text. Makes no network call.
//   KUROMOJI_DIR=<dir holding node_modules/kuromoji> node reading_roundtrip_score.mjs
// surface: character match with the kanji text. kana: character match after turning both sides into katakana.
// kuromoji is not a dependency of this package; install it anywhere with `npm i --ignore-scripts kuromoji@0.1.2`.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SENTENCES } from './lib/reading_sentences.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out', 'reading_roundtrip');
const require = createRequire(join(process.env.KUROMOJI_DIR, 'x.js'));
const kuromoji = require('kuromoji');
const dicPath = join(dirname(require.resolve('kuromoji')), '..', 'dict');
const tokenizer = await new Promise((resolve, reject) => {
  kuromoji.builder({ dicPath }).build((err, t) => (err ? reject(err) : resolve(t)));
});

const strip = (s) => s.normalize('NFKC').replace(/[\s、。,.!?！？「」・]/g, '');
const toKata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
const DIGIT = '〇一二三四五六七八九';
function numToKanji(n) {
  if (n === 0) return '〇';
  let out = '';
  const places = [[1000, '千'], [100, '百'], [10, '十']];
  for (const [v, name] of places) {
    const d = Math.floor(n / v);
    if (d > 0) out += (d > 1 ? DIGIT[d] : '') + name;
    n %= v;
  }
  return out + (n > 0 ? DIGIT[n] : '');
}
function kana(s) {
  const prepared = strip(s)
    .replace(/\d{1,4}/g, (m) => numToKanji(Number(m)))
    .replace(/AI/gi, 'エーアイ');
  return toKata(tokenizer.tokenize(prepared).map((t) => (t.reading && t.reading !== '*' ? t.reading : t.surface_form)).join(''));
}
function sim(a, b) {
  const x = [...a];
  const y = [...b];
  if (x.length === 0 && y.length === 0) return 1;
  let row = y.map((_, i) => i + 1);
  row.unshift(0);
  for (let i = 1; i <= x.length; i++) {
    const next = [i];
    for (let j = 1; j <= y.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return 1 - row[y.length] / Math.max(x.length, y.length);
}

const conditions = process.argv.slice(2);
const conds = conditions.length ? conditions : ['el_ja', 'el_nolang', 'el_hira_ja', 'gemini'];
const pct = (x) => (x === null ? '-' : (x * 100).toFixed(0));
const rows = [];
for (const s of SENTENCES) {
  for (const cond of conds) {
    const p = join(OUT, `${cond}__${s.id}.stt.json`);
    if (!existsSync(p)) continue;
    const stt = JSON.parse(readFileSync(p, 'utf8'));
    const tts = JSON.parse(readFileSync(join(OUT, `${cond}__${s.id}.tts.json`), 'utf8'));
    const hyp = kana(stt.text);
    rows.push({
      id: s.id,
      group: s.group,
      cond,
      expected: s.kanji,
      text: stt.text,
      hyp_kana: hyp,
      audio_s: tts.audio_s,
      mora_per_s: [...toKata(strip(s.kana)).replace(/[ャュョァィゥェォ]/g, '')].length / tts.audio_s,
      surface: sim(strip(stt.text), strip(s.kanji)),
      // kuromoji may pick another valid reading for the same kanji (明日 = アス), so take the better reference.
      kana: Math.max(sim(hyp, toKata(strip(s.kana))), sim(hyp, kana(s.kanji))),
    });
  }
}
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
let md = '## 条件別\n\n| 条件 | n | 表記一致 平均 | かな一致 平均 | かな一致 最低 | かな90%未満の文 | 音声秒 平均 |\n|---|---|---|---|---|---|---|\n';
for (const c of conds) {
  const r = rows.filter((x) => x.cond === c);
  if (!r.length) continue;
  md += `| ${c} | ${r.length} | ${pct(mean(r.map((x) => x.surface)))} | ${pct(mean(r.map((x) => x.kana)))} | ${pct(Math.min(...r.map((x) => x.kana)))} | ${r.filter((x) => x.kana < 0.9).length} | ${mean(r.map((x) => x.audio_s)).toFixed(2)} |\n`;
}
md += `\n## 文別（表記一致/かな一致）\n\n| 文 | 種類 | 正解 | ${conds.join(' | ')} |\n|---|---|---|${conds.map(() => '---').join('|')}|\n`;
for (const s of SENTENCES) {
  const cells = conds.map((c) => {
    const x = rows.find((r) => r.id === s.id && r.cond === c);
    return x ? `${pct(x.surface)}/${pct(x.kana)}` : '-';
  });
  md += `| ${s.id} | ${s.group} | ${s.kanji} | ${cells.join(' | ')} |\n`;
}
md += `\n## 書き起こし\n\n| 文 | 条件 | 書き起こし | かな一致 | 音声秒 |\n|---|---|---|---|---|\n`;
for (const x of rows) md += `| ${x.id} | ${x.cond} | ${x.text} | ${pct(x.kana)} | ${x.audio_s.toFixed(2)} |\n`;
writeFileSync(join(OUT, `report_${conds.join('+')}.md`), md);
writeFileSync(join(OUT, `report_${conds.join('+')}.json`), `${JSON.stringify(rows, null, 2)}\n`);
console.log(md);
