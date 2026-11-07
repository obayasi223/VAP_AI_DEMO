// 台本から手書きの逐次 ASR の JSONL を作る。実 ASR ではない（予備調査用）。API は呼ばない。
import { writeJson, writeJsonl, loadPolicy, loadScenarios, scenarioText, sttPath } from './lib/project';
import { generateHandwrittenAsr, HANDWRITTEN_DEFAULTS } from './lib/handwritten';
import { injectMisrecognition } from './lib/inject';

const policy = loadPolicy();
const minStability = policy.initiative.min_stability;
if (minStability === null) throw new Error('policy.initiative.min_stability is null');
const all = loadScenarios();
for (const scenario of all) {
  if (scenario.expected.outcome === 'not_applicable_until_g3') continue;
  let events = generateHandwrittenAsr(scenarioText(scenario, all), `handwritten_${scenario.id}`, minStability);
  if (scenario.inject) events = injectMisrecognition(events, scenario.inject, minStability);
  const path = sttPath('handwritten', scenario.id);
  writeJsonl(path, events);
  writeJson(path.replace(/\.stt\.jsonl$/, '.meta.json'), {
    asr_origin: 'handwritten',
    not_real_asr: true,
    note: '台本から機械的に作った逐次 ASR。実音声でも実 ASR でもない。§4.5a の関門の素材にならない。',
    scenario: scenario.id,
    generator: HANDWRITTEN_DEFAULTS,
    inject: scenario.inject ?? null,
    events: events.length,
    duration_ms: events.at(-1)?.t_monotonic_ms,
  });
  console.log(`${scenario.id}: ${events.length} events, ${Math.round((events.at(-1)?.t_monotonic_ms ?? 0) / 1000)}s -> ${path}`);
}
