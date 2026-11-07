/**
 * 実装を通した実 API の確認（ElevenLabs、短文1回、約 25 文字）。キーは表示しない。
 *   node --env-file=.env --import tsx apps/orchestrator/src/providers/tts/live_provider_check.ts --yes
 * D と同じ手順（sendText、flush、endInput）で呼び、chunk 相対の時刻と PCM の累積、取消の棄却を確かめる。
 */
import { SystemTimeSource } from '@llm-vap/contracts';
import { createElevenLabsTtsProviderFromEnv, ttsCapabilitiesOf } from './index';
import type { ElevenLabsConnection } from './index';

if (!process.argv.includes('--yes')) {
  console.error('実 API を呼びます。実行するには --yes を付けてください。');
  process.exit(3);
}
const provider = createElevenLabsTtsProviderFromEnv({ time: new SystemTimeSource() });
const connection = (await provider.open({ preferred_sample_rate_hz: 24000 })) as ElevenLabsConnection;
const statuses: string[] = [];
connection.onStatus((s) => statuses.push(`${s.status}: ${s.reason.value}`));
const rows: unknown[] = [];
let cumulativeMs = 0;
let lastAlignedEnd = 0;
let chars = '';
const t0 = performance.now();
let first: number | null = null;
const done = new Promise<void>((resolve) => {
  connection.onChunk((chunk) => {
    if (chunk.pcm.length > 0 && first === null) first = performance.now() - t0;
    const a = chunk.alignment.value;
    if (a) {
      chars += a.chars.join('');
      lastAlignedEnd = cumulativeMs + (a.char_start_ms.at(-1) ?? 0) + (a.char_duration_ms.at(-1) ?? 0);
    }
    rows.push({
      seq: chunk.seq,
      pcm_ms: Math.round((chunk.pcm.length / chunk.sample_rate_hz) * 1000),
      first_start: a?.char_start_ms[0] ?? null,
      n: a?.chars.length ?? 0,
      cumulative_before: Math.round(cumulativeMs),
      is_last: chunk.is_last,
    });
    cumulativeMs += (chunk.pcm.length / chunk.sample_rate_hz) * 1000;
    if (chunk.is_last) resolve();
  });
});
const context = connection.openContext({ audio_playback_id: 1, generation: 1 });
context.sendText('今日は晴れです。');
context.flush();
context.sendText('明日は雨が降ります。');
context.flush();
context.endInput();
await done;
console.log(JSON.stringify({
  first_audio_ms: first && Math.round(first),
  total_audio_ms: Math.round(cumulativeMs),
  aligned_end_ms: Math.round(lastAlignedEnd),
  chars,
  rows,
  statuses,
  capabilities: ttsCapabilitiesOf(connection),
  diagnostics: connection.diagnostics(),
  failure: connection.lastFailure?.kind ?? null,
}));
await connection.close();
process.exit(0);
