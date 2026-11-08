// 発話ごとの声のばらつきを条件ごとに測るための音声を作る（docs/tts_consistency.md）。
//   本番と同じ multi-stream-input の手順（空白で文脈を開く→本文→flush→close_context）で 1 発話ずつ生成し、
//   WAV と、最初の音声までの時間・alignment を --out に残す。解析は tts_consistency_analyze.py。
//   --max-calls は --out の ledger.json に累積で数える（試行の失敗も 1 回）。文は 40 字以内に制限する。
//   例: node --env-file=../../.env tts_consistency.mjs --out DIR --conditions base,stab90 --reps 4 --yes
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireEnv, requireConfirm, fail, redact, sleep, pcmToWav } from './lib/common.mjs';
import { wsUrl, connect } from './lib/tts.mjs';

/** 試験用に自作した文。mora は手で数えた読みのモーラ数（話速に使う）。 */
export const SENTENCES = [
  { id: 's1', kind: 'short', mora: 5, text: 'そうですね。' },
  { id: 's2', kind: 'short', mora: 9, text: 'なるほど、いいですね。' },
  { id: 'm1', kind: 'medium', mora: 21, text: 'それは面白い考え方だと思います。' },
  { id: 'l1', kind: 'long', mora: 31, text: '朝の時間を少し使えば、無理なく続けられるかもしれません。' },
  { id: 'l2', kind: 'long', mora: 37, text: '次に進む前に、もう少し具体的な例を一緒に考えてみませんか。' },
  // 別々の文のばらつきを見るための追加（1 テイクずつ生成する）。
  { id: 's3', kind: 'short', mora: 8, text: 'はい、わかりました。' },
  { id: 's4', kind: 'short', mora: 10, text: 'ちょっと待ってください。' },
  { id: 's5', kind: 'short', mora: 7, text: '本当ですか。' },
  { id: 'm2', kind: 'medium', mora: 18, text: '今日は天気が良くて気持ちいいですね。' },
  { id: 'm3', kind: 'medium', mora: 23, text: 'その話をもう少し詳しく聞かせてください。' },
  { id: 'l3', kind: 'long', mora: 30, text: '私は静かな場所で本を読む時間がいちばん好きなんです。' },
  { id: 'l4', kind: 'long', mora: 30, text: '明日は朝から雨らしいので、傘を忘れないようにしましょう。' },
  { id: 'l5', kind: 'long', mora: 33, text: '新しいことを始めるときは、最初の一歩がいちばん大事ですね。' },
];

const FLASH = 'eleven_flash_v2_5';
/** 登録済みの声の設定（GET /v1/voices/{id}/settings、2026-11-09）と同じ値。stability だけを変えた条件の基準。 */
const STORED = { similarity_boost: 0.67, style: 0, use_speaker_boost: true, speed: 0.98 };
const SEED = 20261109;
const PREVIOUS_TEXT = '今日は少し涼しいですね。';

/** voice_settings なしは、現行（登録済みの設定がそのまま使われる）。 */
export const CONDITIONS = {
  base: { model: FLASH },
  stab50: { model: FLASH, voice_settings: { ...STORED, stability: 0.5 } },
  stab90: { model: FLASH, voice_settings: { ...STORED, stability: 0.9 } },
  stab100: { model: FLASH, voice_settings: { ...STORED, stability: 1.0 } },
  seed: { model: FLASH, seed: SEED },
  seed2: { model: FLASH, seed: 777 },
  stab90_seed: { model: FLASH, seed: SEED, voice_settings: { ...STORED, stability: 0.9 } },
  ml2: { model: 'eleven_multilingual_v2', no_language_code: true },
  http_prev: { model: FLASH, transport: 'http', previous_text: PREVIOUS_TEXT },
  http_plain: { model: FLASH, transport: 'http' },
  speed_slow: { model: FLASH, voice_settings: { ...STORED, stability: 0.76, speed: 0.8 } },
  speed_fast: { model: FLASH, voice_settings: { ...STORED, stability: 0.76, speed: 1.2 } },
};

const MAX_TEXT_CHARS = 40;
const FORMAT = 'pcm_24000';
const SAMPLE_RATE = 24000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(list, random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function readLedger(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { total_calls: 0, per_condition: {}, chars: 0 };
}

class Ledger {
  constructor(path, maxCalls) {
    this.path = path;
    this.maxCalls = maxCalls;
    this.state = readLedger(path);
  }

  /** 呼ぶ前に数える。上限を超えるなら投げる。 */
  take(condition, chars) {
    if (this.state.total_calls >= this.maxCalls) throw new Error(`call budget exhausted (${this.maxCalls})`);
    this.state.total_calls += 1;
    this.state.chars += chars;
    this.state.per_condition[condition] = (this.state.per_condition[condition] ?? 0) + 1;
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }
}

/** 接続は条件ごとに 1 本（seed とモデルは接続のクエリ）。切れていたら張り直す。 */
class WsCondition {
  constructor(name, condition, voice) {
    this.name = name;
    this.condition = condition;
    this.voice = voice;
    this.socket = null;
    this.used = 0;
    this.pending = new Map();
  }

  async ensure() {
    if (this.socket && this.socket.readyState === this.socket.OPEN) return;
    const c = this.condition;
    const query = {
      model_id: c.model,
      output_format: FORMAT,
      language_code: c.no_language_code ? undefined : 'ja',
      auto_mode: true,
      sync_alignment: true,
      inactivity_timeout: 180,
      seed: c.seed,
    };
    const { ws, opened } = connect(wsUrl('multi-stream-input', this.voice, query));
    await opened;
    this.used = 0;
    this.socket = ws;
    ws.on('message', (data) => this.onMessage(data));
    ws.on('close', (code, reason) => {
      for (const p of this.pending.values()) p.reject(new Error(`socket closed ${code} ${redact(reason.toString())}`));
      this.pending.clear();
    });
  }

  onMessage(data) {
    const msg = JSON.parse(data.toString());
    const id = msg.contextId ?? msg.context_id;
    if (msg.error || (msg.message && !id)) {
      const err = new Error(redact(JSON.stringify(msg)).slice(0, 300));
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      return;
    }
    const p = id ? this.pending.get(id) : undefined;
    if (!p) return;
    if (msg.audio) {
      p.firstAudio ??= performance.now();
      p.pcm.push(Buffer.from(msg.audio, 'base64'));
    }
    if (msg.alignment) p.alignments.push(msg.alignment);
    if (msg.isFinal || msg.is_final) {
      this.pending.delete(id);
      p.resolve();
    }
  }

  async generate(text, contextId) {
    await this.ensure();
    const cold = this.used === 0;
    this.used += 1;
    const p = { pcm: [], alignments: [], firstAudio: null };
    const done = new Promise((resolve, reject) => {
      p.resolve = resolve;
      p.reject = reject;
    });
    this.pending.set(contextId, p);
    const c = this.condition;
    const init = { context_id: contextId, text: ' ' };
    if (c.voice_settings) init.voice_settings = c.voice_settings;
    this.socket.send(JSON.stringify(init));
    const sentAt = performance.now();
    this.socket.send(JSON.stringify({ context_id: contextId, text: `${text} ` }));
    this.socket.send(JSON.stringify({ context_id: contextId, flush: true }));
    this.socket.send(JSON.stringify({ context_id: contextId, close_context: true }));
    const outcome = await Promise.race([done.then(() => 'ok'), sleep(20_000).then(() => 'timeout')]);
    if (outcome === 'timeout') {
      this.pending.delete(contextId);
      throw new Error('timeout');
    }
    return {
      pcm: Buffer.concat(p.pcm),
      first_audio_ms: p.firstAudio === null ? null : p.firstAudio - sentAt,
      total_ms: performance.now() - sentAt,
      cold,
      alignments: p.alignments,
    };
  }

  close() {
    if (this.socket && this.socket.readyState === this.socket.OPEN) this.socket.close();
  }
}

class HttpCondition {
  constructor(name, condition, voice) {
    this.name = name;
    this.condition = condition;
    this.voice = voice;
    this.used = 0;
  }

  async ensure() {}

  async generate(text) {
    const cold = this.used === 0;
    this.used += 1;
    const c = this.condition;
    const body = { text, model_id: c.model, language_code: 'ja' };
    if (c.previous_text) body.previous_text = c.previous_text;
    const sentAt = performance.now();
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voice)}/stream?output_format=${FORMAT}`, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${redact((await res.text()).slice(0, 200))}`);
    const pcm = [];
    let firstAudio = null;
    for await (const chunk of res.body) {
      firstAudio ??= performance.now();
      pcm.push(Buffer.from(chunk));
    }
    return { pcm: Buffer.concat(pcm), first_audio_ms: firstAudio === null ? null : firstAudio - sentAt, total_ms: performance.now() - sentAt, cold, alignments: [] };
  }

  close() {}
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      out: { type: 'string' },
      conditions: { type: 'string' },
      sentences: { type: 'string', default: SENTENCES.map((s) => s.id).join(',') },
      reps: { type: 'string', default: '4' },
      'max-calls': { type: 'string', default: '150' },
      'shuffle-seed': { type: 'string', default: '1' },
      tag: { type: 'string', default: '' },
      yes: { type: 'boolean', default: false },
    },
  });
  if (!args.out || !args.conditions) {
    console.error('--out と --conditions を指定してください');
    process.exit(1);
  }
  requireEnv(['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'], 'ELEVENLABS_API_KEY と ELEVENLABS_VOICE_ID を設定してください');
  const names = args.conditions.split(',');
  for (const name of names) if (!CONDITIONS[name]) throw new Error(`unknown condition ${name}`);
  const sentences = args.sentences.split(',').map((id) => {
    const s = SENTENCES.find((x) => x.id === id);
    if (!s) throw new Error(`unknown sentence ${id}`);
    if ([...s.text].length > MAX_TEXT_CHARS) throw new Error(`too long: ${id}`);
    return s;
  });
  const reps = Number(args.reps);
  const planned = names.length * sentences.length * reps;
  const maxCalls = Number(args['max-calls']);
  mkdirSync(args.out, { recursive: true });
  const ledgerPath = join(args.out, 'ledger.json');
  const before = readLedger(ledgerPath).total_calls;
  console.log(`予定 ${planned} 回（これまで ${before} 回、上限 ${maxCalls} 回）`);
  if (before + planned > maxCalls) {
    console.error('上限を超えるので実行しません。');
    process.exit(1);
  }
  requireConfirm(args, `${planned} 回の生成（文は 40 字以内）`);
  const ledger = new Ledger(ledgerPath, maxCalls);
  const random = mulberry32(Number(args['shuffle-seed']));
  const voice = process.env.ELEVENLABS_VOICE_ID;
  const runners = Object.fromEntries(names.map((name) => [name, CONDITIONS[name].transport === 'http' ? new HttpCondition(name, CONDITIONS[name], voice) : new WsCondition(name, CONDITIONS[name], voice)]));
  const wavDir = join(args.out, 'wav');
  mkdirSync(wavDir, { recursive: true });
  const rows = [];
  const tag = args.tag ? `${args.tag}_` : '';
  let index = 0;
  let consecutiveErrors = 0;
  for (let rep = 0; rep < reps; rep++) {
    const trials = shuffled(sentences.flatMap((s) => names.map((name) => ({ s, name }))), random);
    for (const { s, name } of trials) {
      ledger.take(name, [...s.text].length);
      const contextId = `${tag}${name}_${s.id}_${rep}_${index++}`;
      const row = { condition: name, sentence: s.id, kind: s.kind, mora: s.mora, rep, context_id: contextId, wall_clock: new Date().toISOString() };
      try {
        const r = await runners[name].generate(s.text, contextId);
        writeFileSync(join(wavDir, `${contextId}.wav`), pcmToWav(r.pcm, SAMPLE_RATE));
        row.first_audio_ms = r.first_audio_ms;
        row.total_ms = r.total_ms;
        row.cold = r.cold;
        row.pcm_bytes = r.pcm.length;
        row.alignment_chars = r.alignments.flatMap((a) => a.chars ?? []).length;
        row.alignment_end_ms = r.alignments.length ? lastAlignmentEnd(r.alignments) : null;
        console.log(`${index} ${name} ${s.id} r${rep} ttfb=${r.first_audio_ms?.toFixed(0)}ms bytes=${r.pcm.length}`);
      } catch (err) {
        row.error = redact(err.message);
        console.log(`${index} ${name} ${s.id} r${rep} ERROR ${row.error}`);
        consecutiveErrors += 1;
        if (consecutiveErrors >= 2) {
          rows.push(row);
          writeFileSync(join(args.out, `runs_${args.tag || 'default'}.jsonl`), `${rows.map((r2) => JSON.stringify(r2)).join('\n')}\n`);
          throw new Error('2 回続けて失敗したので止めます（予算を使い切らないため）');
        }
        rows.push(row);
        await sleep(150);
        continue;
      }
      consecutiveErrors = 0;
      rows.push(row);
      writeFileSync(join(args.out, `runs_${args.tag || 'default'}.jsonl`), `${rows.map((r2) => JSON.stringify(r2)).join('\n')}\n`);
      await sleep(150);
    }
  }
  for (const runner of Object.values(runners)) runner.close();
  await sleep(200);
  console.log(`完了。累積 ${ledger.state.total_calls} 回。`);
  process.exit(0);
}

/** 累積の時刻でも chunk 相対でも、最後の chunk の最後の文字の終わりを返す（chunk 相対なら参考値）。 */
function lastAlignmentEnd(alignments) {
  const last = alignments[alignments.length - 1];
  const starts = last.charStartTimesMs ?? [];
  const durations = last.charDurationsMs ?? [];
  if (starts.length === 0) return null;
  return starts[starts.length - 1] + durations[durations.length - 1];
}

main().catch(fail);
