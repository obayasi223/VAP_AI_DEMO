/**
 * Gemini TTS の実 API 確認（短文1回）。本文と音声は保存しない。キーは環境変数から読み、表示しない。
 *   node --env-file=.env --import tsx apps/orchestrator/src/providers/tts/live_gemini_check.ts --yes
 */
import { SystemTimeSource } from '@llm-vap/contracts';
import { createGeminiTtsProviderFromEnv, ttsCapabilitiesOf } from './index';
import type { TtsChunkWithEstimate } from './index';

if (!process.argv.includes('--yes')) {
  console.error('実 API を呼びます。実行するには --yes を付けてください。');
  process.exit(3);
}
const provider = createGeminiTtsProviderFromEnv({ time: new SystemTimeSource() });
const connection = await provider.open({ preferred_sample_rate_hz: 24000 });
let samples = 0;
let estimatedChars = '';
let rate = 0;
const done = new Promise<void>((resolve) => {
  connection.onChunk((chunk: TtsChunkWithEstimate) => {
    samples += chunk.pcm.length;
    if (chunk.pcm.length > 0) rate = chunk.sample_rate_hz;
    estimatedChars += chunk.estimated_alignment?.chars.join('') ?? '';
    if (chunk.is_last) resolve();
  });
});
const statuses: string[] = [];
connection.onStatus((s) => statuses.push(`${s.status}: ${s.reason.value}`));
const text = '承知しました。少し確認します。';
const context = connection.openContext({ audio_playback_id: 1, generation: 1 });
context.sendText(text);
context.endInput();
await done;
console.log(JSON.stringify({
  model: provider.model_version,
  rate,
  audio_ms: Math.round((samples / rate) * 1000),
  alignment_chars_match_input: estimatedChars === text,
  statuses,
  capabilities: ttsCapabilitiesOf(connection),
  diagnostics: connection.diagnostics(),
}));
await connection.close();
