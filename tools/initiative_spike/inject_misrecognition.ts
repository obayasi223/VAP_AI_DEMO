// 実 ASR の JSONL に誤認を人工的に入れる（C3 で誤認が起きなかったとき用）。API は呼ばない。
//   --take 1 --correct 五十万円 --wrong 五千万円
// C3 の録音から C3a（未安定にとどまる）と C3b（一度安定に入り書き換わる）を作る。
import { parseArgs } from 'node:util';
import { loadPolicy, readSttJsonl, sttPath, writeJson, writeJsonl } from './lib/project';
import { injectMisrecognition } from './lib/inject';

const { values: args } = parseArgs({
  options: {
    take: { type: 'string', default: '1' },
    correct: { type: 'string', default: '五十万円' },
    wrong: { type: 'string', default: '五千万円' },
  },
});
const take = Number(args.take);
const minStability = loadPolicy().initiative.min_stability;
if (minStability === null) throw new Error('policy.initiative.min_stability is null');
const source = readSttJsonl(sttPath('recorded', 'C3', take));
const variants = [
  { id: 'C3a', stage: 'unstable' as const, hold_ms: 2500 },
  { id: 'C3b', stage: 'stable' as const, hold_ms: 6000 },
];
for (const v of variants) {
  const spec = { correct: args.correct as string, wrong: args.wrong as string, stage: v.stage, hold_ms: v.hold_ms };
  const events = injectMisrecognition(source, spec, minStability);
  const out = sttPath('recorded', v.id, take);
  writeJsonl(out, events);
  writeJson(out.replace(/\.stt\.jsonl$/, '.meta.json'), {
    asr_origin: 'recorded',
    not_real_asr: false,
    injected_misrecognition: spec,
    note: '実音声の実 ASR の時刻と形に、誤認を人工的に入れたもの。',
    source: `C3.take${take}`,
    scenario: v.id,
    take,
    events: events.length,
  });
  console.log(`${v.id}: ${out}`);
}
