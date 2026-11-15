// 本人役の合成の声（Gemini TTS、声 Kore）を作る。実在の人の声は使わない（技術評価の規則）。
//   node --env-file=.env tools/two_ai_eval/synth_voices.mjs --yes
// 既にあるファイルは作り直さない（再実行で課金しない）。出力：tools/two_ai_eval/stimuli/<id>.wav（24 kHz、mono、16 bit）。
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'stimuli');
const MODEL = 'gemini-3.8-flash-lite-tts';
export const VOICES = [
  // 相づち（停止させない方がよいもの）
  { id: 'bc_un', kind: 'backchannel', text: 'うん。' },
  { id: 'bc_hai', kind: 'backchannel', text: 'はい。' },
  { id: 'bc_unun', kind: 'backchannel', text: 'うんうん。' },
  { id: 'bc_naruhodo', kind: 'backchannel', text: 'なるほど。' },
  // 割り込み（中身のある発言）
  { id: 'sp_chigau', kind: 'speech', text: 'いや、そこは少し違うと思います。' },
  { id: 'sp_shimekiri', kind: 'speech', text: '締切は二月末で合っています。' },
  { id: 'sp_kenkyu', kind: 'speech', text: '研究が嫌いなわけではないんです。' },
  { id: 'sp_chotto', kind: 'speech', text: 'ちょっといいですか、それは前提が違います。' },
  { id: 'sp_sounan', kind: 'speech', text: 'そうなんですけど、お金のことも気になっていて。' },
  { id: 'sp_senpai', kind: 'speech', text: '先輩にも同じことを言われました。' },
  // intake の穴を埋める文（実の STT の通しで使う）
  { id: 'in_1', kind: 'intake', text: '博士課程に進むか、インターンに応募して就職するかで迷っています。' },
  { id: 'in_2', kind: 'intake', text: 'いちばん引っかかっているのは、自分に研究の才能があるか分からないことです。' },
  { id: 'in_3', kind: 'intake', text: 'インターンの締切は二月末で、研究科の説明会は一月十五日です。' },
  { id: 'in_4', kind: 'intake', text: 'はい、そのとおりです。' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pcmToWav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function synth(text) {
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Api-Revision': '2026-05-20' },
    body: JSON.stringify({
      model: MODEL,
      input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: 'Kore' }] },
      stream: true,
      store: false,
    }),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const pcm = [];
  let rate = 24000;
  const dec = new TextDecoder();
  let buf = '';
  for await (const piece of res.body) {
    buf += dec.decode(piece, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      const ev = JSON.parse(payload);
      if (ev.error || ev.event_type === 'error' || ev.event_type === 'interaction.failed') throw new Error('Gemini stream error');
      if (ev.event_type === 'step.delta' && ev.delta?.type === 'audio' && ev.delta.data) {
        pcm.push(Buffer.from(ev.delta.data, 'base64'));
        rate = ev.delta.sample_rate ?? rate;
      }
    }
  }
  return { pcm: Buffer.concat(pcm), rate };
}

if (!process.argv.includes('--yes')) {
  console.log(`作るもの ${VOICES.filter((v) => !existsSync(join(OUT, `${v.id}.wav`))).length} 本（--yes で実行）`);
  process.exit(3);
}
if (!process.env.GEMINI_API_KEY) { console.error('GEMINI_API_KEY がない'); process.exit(2); }
mkdirSync(OUT, { recursive: true });
let calls = 0;
for (const v of VOICES) {
  const file = join(OUT, `${v.id}.wav`);
  if (existsSync(file)) continue;
  if (calls > 0) await sleep(6500);
  const { pcm, rate } = await synth(v.text);
  calls += 1;
  writeFileSync(file, pcmToWav(pcm, rate));
  console.log(`${v.id} ${(pcm.length / 2 / rate).toFixed(2)} s`);
}
console.log(`API calls: ${calls}`);
