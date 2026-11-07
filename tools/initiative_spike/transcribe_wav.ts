// 録音した WAV を Google STT へ実時間で流し、§3.5 の stt.* の JSONL を fixtures/initiative/recorded/ へ保存する。
// 呼び方は tools/provider_probe/lib/stt.mjs のとおり。既定は long、asia-northeast1。
//   --check-only        録音の確認だけ（課金なし）
//   --yes               確認なしで実行（課金あり）
//   --only C1,C2        対象を絞る。既定は recordings/initiative/ の全部
//   --wav <path> --scenario <id>  1ファイルだけ指定
//   --take <n>          同じ台本の取り直しの番号（既定 1）
//   --out <path>        保存先を変える（動作確認用。--wav と一緒に使う）
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { RECORDINGS_DIR, existsSync, loadPolicy, loadScenarios, sttPath, writeJson, writeJsonl } from './lib/project';
import type { SttEvent } from '../../apps/orchestrator/src/cognition/initiative/transcript_view';
import { StableTranscriptView } from '../../apps/orchestrator/src/cognition/initiative/transcript_view';
import { GoogleResponseMapper } from './lib/stt_events';
import { WavFormatError, readWavFile } from './lib/wav';
import { BYTES_PER_MS, makeClient, normalizeResponse, openStream, pacedSend } from '../provider_probe/lib/stt.mjs';

const { values: args } = parseArgs({
  options: {
    wav: { type: 'string' },
    scenario: { type: 'string' },
    only: { type: 'string' },
    take: { type: 'string', default: '1' },
    out: { type: 'string' },
    model: { type: 'string', default: 'long' },
    location: { type: 'string', default: 'asia-northeast1' },
    'chunk-ms': { type: 'string', default: '40' },
    'check-only': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    'force-overwrite': { type: 'boolean', default: false },
  },
});

const scenarios = loadScenarios();
const readable = scenarios.filter((s) => !s.handwritten_only).map((s) => s.id);

function targets(): { id: string; path: string }[] {
  if (args.wav) {
    if (!args.scenario) throw new Error('--wav には --scenario も指定してください');
    return [{ id: args.scenario, path: args.wav }];
  }
  if (!existsSync(RECORDINGS_DIR)) throw new Error(`録音の置き場がありません: ${RECORDINGS_DIR}`);
  const only = args.only?.split(',');
  return readdirSync(RECORDINGS_DIR)
    .filter((f) => !f.endsWith(':Zone.Identifier'))
    .map((f) => ({ id: basename(f).replace(/\.[^.]+$/, ''), path: join(RECORDINGS_DIR, f) }))
    .filter((t) => !only || only.includes(t.id));
}

function checkFile(id: string, path: string): { ok: boolean; seconds: number } {
  if (!readable.includes(id)) {
    console.log(`× ${basename(path)}: ファイル名が台本の番号（${readable.join(', ')}）ではありません。`);
    return { ok: false, seconds: 0 };
  }
  try {
    const { info } = readWavFile(path);
    const warn: string[] = [];
    if (info.duration_s < 20) warn.push('短すぎます（台本の途中で切れていませんか）');
    if (info.duration_s > 120) warn.push('長すぎます（余計な部分が入っていませんか）');
    const mark = warn.length ? '△' : '○';
    console.log(`${mark} ${basename(path)}: ${info.duration_s.toFixed(1)} 秒、${info.sample_rate}Hz、${info.bits}bit、${info.channels}ch ${warn.join(' ')}`);
    return { ok: true, seconds: info.duration_s };
  } catch (error) {
    if (!(error instanceof WavFormatError)) throw error;
    console.log(`× ${basename(path)}: ${error.message} 手順書の「録音の形式」を見てください。`);
    return { ok: false, seconds: 0 };
  }
}

async function transcribe(id: string, path: string, take: number, minStability: number): Promise<void> {
  const { info, pcm } = readWavFile(path);
  const client = await makeClient(args.location);
  const cfg = { project: process.env.GOOGLE_CLOUD_PROJECT, location: args.location, model: args.model, language: 'ja-JP', interim: true, wordOffsets: true };
  const stream = openStream(client, cfg);
  const begin = performance.now();
  const clock = () => performance.now() - begin;
  let sentBytes = 0;
  let error: { code?: number; message: string } | null = null;
  const mapper = new GoogleResponseMapper({
    session_id: `recorded_${id}_take${take}`,
    provider: 'google_stt_v2',
    model_version: `${args.model}@${args.location}`,
    stream_id: 'stream_1',
    min_stability: minStability,
    wall_origin_ms: Date.now(),
  });
  const events: SttEvent[] = [];
  let lastT = 0;
  const done = new Promise<void>((resolve) => {
    stream.on('data', (res: unknown) => {
      const n = normalizeResponse(res, clock(), sentBytes / BYTES_PER_MS);
      lastT = n.received_ms;
      events.push(...mapper.map(n.results, n.received_ms, n.audio_sent_ms));
    });
    stream.on('error', (err: { code?: number; message: string }) => {
      error = { code: err.code, message: err.message };
      resolve();
    });
    stream.on('end', () => resolve());
  });
  await pacedSend(pcm, Number(args['chunk-ms']), (chunk: Buffer) => {
    sentBytes += chunk.length;
    stream.write({ audio: chunk });
  });
  stream.end();
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 20_000))]);
  await client.close();
  if (error) throw new Error(`STT error: ${JSON.stringify(error)}`);
  if (events.length === 0) throw new Error('STT から結果が1件も返りませんでした（無音、または音量不足の可能性）');

  const out = args.out ?? sttPath('recorded', id, take);
  writeJsonl(out, events);
  const view = new StableTranscriptView({ min_stability: minStability });
  for (const event of events) view.apply(event);
  const interims = events.filter((e) => e.event === 'stt.interim');
  const stable = interims.filter((e) => e.stable_text.length > 0).length;
  const finals = events.filter((e) => e.event === 'stt.final');
  writeJson(out.replace(/\.stt\.jsonl$/, '.meta.json'), {
    asr_origin: 'recorded',
    not_real_asr: false,
    scenario: id,
    take,
    wav_file: basename(path),
    wav: info,
    stt: { model: args.model, location: args.location, chunk_ms: Number(args['chunk-ms']) },
    recorded_at: new Date().toISOString(),
    events: events.length,
    interims: interims.length,
    finals: finals.length,
    interims_with_stable_part: stable,
    rewrites_of_stable_text: view.totalRewrites(),
    last_response_ms: lastT,
  });
  console.log(`\n--- ${id} の認識結果（台本と違っていても構いません）---`);
  console.log(finals.map((f) => f.text).join('\n'));
  console.log(`--- 保存: ${out}（書き換え ${view.totalRewrites()} 回）\n`);
}

async function main(): Promise<void> {
  const list = targets();
  if (list.length === 0) {
    console.log(`録音が見つかりません: ${RECORDINGS_DIR}`);
    process.exit(1);
  }
  const checks = list.map((t) => ({ ...t, ...checkFile(t.id, t.path) }));
  const missing = readable.filter((id) => !list.some((t) => t.id === id));
  if (!args.wav && missing.length > 0) console.log(`まだ録音がない台本: ${missing.join(', ')}`);
  if (args['check-only']) return;
  const usable = checks.filter((c) => c.ok);
  if (usable.length === 0) process.exit(1);
  if (!process.env.GOOGLE_CLOUD_PROJECT) {
    console.log('GOOGLE_CLOUD_PROJECT が設定されていません。.env を確認してください。');
    process.exit(2);
  }
  const seconds = usable.reduce((sum, c) => sum + c.seconds, 0);
  if (!args.yes) {
    console.log(`\n${usable.length} 本、合計 ${Math.round(seconds)} 秒を実時間で送ります（標準料金なら約 $${((seconds / 60) * 0.016).toFixed(3)}）。`);
    console.log('課金が発生するので、実行するには --yes を付けてください。Google へは何も送っていません。');
    process.exit(3);
  }
  const policy = loadPolicy();
  const minStability = policy.initiative.min_stability;
  if (minStability === null) throw new Error('policy.initiative.min_stability is null');
  const take = Number(args.take);
  for (const c of usable) {
    const out = sttPath('recorded', c.id, take);
    if (!args.out && existsSync(out) && !args['force-overwrite']) {
      console.log(`${c.id}: すでに ${out} があるので飛ばします（取り直しは --take 2 など）。`);
      continue;
    }
    console.log(`${c.id}: 送信中（${Math.round(c.seconds)} 秒かかります）...`);
    await transcribe(c.id, c.path, take, minStability);
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(`エラー: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
