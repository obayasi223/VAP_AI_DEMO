/**
 * 実 API で切替を跨ぐ確認（課金あり。約 6 分、約 $0.11）。受け入れ試験ではなく測定用。
 *   node --env-file=.env --import tsx apps/orchestrator/src/providers/stt/live_handover_check.ts --yes
 * 短い動作確認: --smoke（約 25 秒、無音の切替のみ）。
 *
 * 1本目は overlap を 60 秒で手動で始め、無音を挟んだ音声で「無音の切替」を起こす。
 * 2本目は既定の 240／285 秒のまま、無音のない音声を流して「期限の切替」を起こす。
 * 無音の判定をデジタルの無音だけに絞るため silence_rms を 1 にする（ja.wav の語間は無音に数えない）。
 * 結果の本文は tools/provider_probe/out/（git の対象外）にだけ書く。
 */
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { SystemTimeSource, createEventEmitter, MemoryEventSink } from '@llm-vap/contracts';
import { createGoogleSttProviderFromEnv } from './index';
import type { GoogleSttV2Session } from './google_v2';

const ROOT = new URL('../../../../../', import.meta.url).pathname;
const smoke = process.argv.includes('--smoke');
if (!process.argv.includes('--yes')) {
  console.error('課金が発生します。実行するには --yes を付けてください。');
  process.exit(3);
}

function readWav16k(path: string): Int16Array {
  const buf = readFileSync(path);
  let pos = 12;
  let rate = 0;
  let data: Buffer | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') rate = buf.readUInt32LE(pos + 12);
    if (id === 'data') data = buf.subarray(pos + 8, pos + 8 + size);
    pos += 8 + size + (size % 2);
  }
  if (!data || !rate) throw new Error('bad wav');
  const frames = Math.floor(data.length / 2);
  const out = new Int16Array(Math.floor((frames * 16000) / rate));
  const step = rate / 16000;
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * step);
    const b = Math.max(a + 1, Math.min(frames, Math.floor((i + 1) * step)));
    let sum = 0;
    for (let j = a; j < b; j++) sum += data.readInt16LE(j * 2);
    out[i] = Math.round(sum / (b - a));
  }
  return out;
}

const speech = readWav16k(`${ROOT}models/ja.wav`);
const GAP_SAMPLES = 16000;

const outDir = `${ROOT}tools/provider_probe/out`;
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const log = createWriteStream(`${outDir}/stt-c-handover${smoke ? '-smoke' : ''}-${stamp}.jsonl`);
const write = (o: unknown) => log.write(`${JSON.stringify(o)}\n`);

const time = new SystemTimeSource();
const sink = new MemoryEventSink();
const emitter = createEventEmitter({ time, session_id: 'live_check', condition: () => 'reactive', sink });
const provider = await createGoogleSttProviderFromEnv({
  time,
  emitter,
  options: { silence_rms: 1, silence_floor_ratio: 1 },
  onRaw: (stream_no, raw) => {
    const billed = raw.metadata?.totalBilledDuration;
    if (billed) write({ kind: 'billed', stream_no, seconds: Number(billed.seconds ?? 0) });
  },
});
const session = (await provider.open({
  language_code: 'ja-JP',
  sample_rate_hz: 16000,
  interim_results: true,
  start_audio_frame: 0,
})) as GoogleSttV2Session;

const total = { sent: 0 };
session.onResult((r) => {
  write({
    kind: 'result',
    type: r.kind,
    at: r.received_at,
    sent_frame: total.sent,
    text: r.text,
    stable_len: r.stable_text.length,
    segment_id: r.segment_id,
    asr: r.asr_segment_id,
    rev: r.transcript_revision,
    end: r.audio_frame_end,
    stream: r.stream_id,
    has_words: r.words.value !== null,
  });
});
session.onStatus((s) => write({ kind: 'status', at: time.monotonicMs(), status: s.status, reason: s.reason.value, attempt: s.retry_attempt }));
session.onHandover((h) => {
  write({ kind: 'handover', at: time.monotonicMs(), ...h });
  console.log('handover', JSON.stringify(h));
});

const OVERLAP_AT_S = smoke ? 8 : 60;
const SEGMENT_AT_S = smoke ? 4.2 : 30.2;
// 1回目の切替まで: 音声＋1秒の無音を繰り返す。その後は無音なし。期限の切替の後しばらく流して終える。
const firstDeadlineS = OVERLAP_AT_S + 15 + 285;
const maxS = smoke ? 25 : firstDeadlineS + 30;
const begin = performance.now();
const chunk = 320;
let pos = 0;
let inGap = 0;
let requested = false;
let advanced = false;
for (let i = 0; total.sent < maxS * 16000; i++) {
  const seconds = total.sent / 16000;
  const handovers = session.diagnostics().handovers.length;
  const withGaps = handovers === 0;
  const pcm = new Int16Array(chunk);
  for (let n = 0; n < chunk; n++) {
    if (inGap > 0) {
      inGap -= 1;
      pcm[n] = 0;
      continue;
    }
    pcm[n] = speech[pos] as number;
    pos += 1;
    if (pos >= speech.length) {
      pos = 0;
      if (withGaps) inGap = GAP_SAMPLES;
    }
  }
  session.pushAudio(total.sent, pcm);
  total.sent += chunk;
  if (!advanced && seconds >= SEGMENT_AT_S) {
    advanced = true;
    session.advanceSegment(1, total.sent);
    write({ kind: 'boundary', at: time.monotonicMs(), frame: total.sent, segment_id: 1 });
  }
  if (!requested && seconds >= OVERLAP_AT_S) {
    requested = true;
    session.startOverlapNow();
  }
  if (!smoke && session.diagnostics().handovers.length >= 2 && total.sent > (session.diagnostics().handovers[1]?.h_frame ?? 0) + 30 * 16000) break;
  const wait = begin + ((total.sent / 16000) * 1000) - performance.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
await session.close();
const diag = session.diagnostics();
write({ kind: 'diagnostics', ...diag });
write({
  kind: 'cost',
  usage: sink.ofType('cost.usage').map((c) => ({ q: c.quantity, usd: c.estimated_cost_usd.value })),
});
await new Promise<void>((r) => log.end(() => r()));
console.log(JSON.stringify({ log: `tools/provider_probe/out/stt-c-handover${smoke ? '-smoke' : ''}-${stamp}.jsonl`, ...diag }, null, 1));
process.exit(0);
