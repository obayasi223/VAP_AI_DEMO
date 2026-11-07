// Shared helpers. Credentials come only from environment variables and are never written out.
import { mkdirSync, createWriteStream, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT_NO_CREDENTIAL = 2;
export const EXIT_NEEDS_CONFIRM = 3;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SECRET_ENV = ['GEMINI_API_KEY', 'ELEVENLABS_API_KEY'];

export function redact(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return text;
  for (const name of SECRET_ENV) {
    const secret = process.env[name];
    if (secret) text = text.split(secret).join(`<${name}>`);
  }
  return text.replace(/(xi-api-key|x-goog-api-key|authorization)(["':=\s]+)[^\s"',}]+/gi, '$1$2<redacted>');
}

export function fail(err) {
  console.error(`error: ${redact(err?.stack ?? String(err))}`);
  process.exit(1);
}

/** Prints what is missing and exits. Never prints a value. */
export function requireEnv(names, guide) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length === 0) return;
  console.error(`未設定の環境変数: ${missing.join(', ')}`);
  console.error(guide);
  console.error('実 API は呼び出していません。');
  process.exit(EXIT_NO_CREDENTIAL);
}

export const GOOGLE_STT_GUIDE = [
  'Google STT の測定には次を設定してください:',
  '  GOOGLE_CLOUD_PROJECT=<プロジェクト ID>',
  '  GOOGLE_APPLICATION_CREDENTIALS=<このプロジェクト用のサービスアカウント JSON のパス>',
  '  （gcloud の既定認証を使う場合は GOOGLE_APPLICATION_CREDENTIALS の代わりに GOOGLE_STT_USE_ADC=1）',
].join('\n');

/** ADC is opt-in, so a stray credential on this machine is never picked up by accident. */
export function requireGoogleStt() {
  requireEnv(['GOOGLE_CLOUD_PROJECT'], GOOGLE_STT_GUIDE);
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.GOOGLE_STT_USE_ADC !== '1') {
    requireEnv(['GOOGLE_APPLICATION_CREDENTIALS'], GOOGLE_STT_GUIDE);
  }
}

/** Real calls cost money, so a run needs an explicit --yes even when a key is present. */
export function requireConfirm(args, plan) {
  if (args.yes) return;
  console.error(`実行内容: ${plan}`);
  console.error('課金が発生するので、実行するには --yes を付けてください。実 API は呼び出していません。');
  process.exit(EXIT_NEEDS_CONFIRM);
}

export function openLog(name) {
  const dir = join(ROOT, 'out');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `${name}-${stamp}.jsonl`);
  const stream = createWriteStream(path);
  return {
    path,
    dir,
    stamp,
    write: (obj) => stream.write(`${redact(JSON.stringify(obj))}\n`),
    close: () => new Promise((resolve) => stream.end(resolve)),
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function quantile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  return Math.round((sorted[low] + (sorted[high] - sorted[low]) * (pos - low)) * 10) / 10;
}

export function distribution(values) {
  return { n: values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95), max: quantile(values, 1) };
}

/** Parses PCM16 WAV into mono 16 kHz Int16 samples; other rates are resampled and flagged. */
export function readWav16kMono(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path} は RIFF/WAVE ではありません`);
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(pos + 8),
        channels: buf.readUInt16LE(pos + 10),
        rate: buf.readUInt32LE(pos + 12),
        bits: buf.readUInt16LE(pos + 22),
      };
    } else if (id === 'data') {
      data = buf.subarray(pos + 8, Math.min(pos + 8 + size, buf.length));
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${path} に fmt または data がありません`);
  const pcmFormat = fmt.format === 1 || fmt.format === 0xfffe;
  if (!pcmFormat || fmt.bits !== 16) throw new Error(`${path} は 16bit PCM ではありません`);

  const frames = Math.floor(data.length / 2 / fmt.channels);
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) sum += data.readInt16LE((i * fmt.channels + c) * 2);
    mono[i] = sum / fmt.channels;
  }
  const out = fmt.rate === 16000 ? mono : resampleAverage(mono, fmt.rate, 16000);
  const pcm = Buffer.alloc(out.length * 2);
  for (let i = 0; i < out.length; i++) {
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i]))), i * 2);
  }
  return { pcm, durationS: out.length / 16000, sourceRate: fmt.rate, sourceChannels: fmt.channels, resampled: fmt.rate !== 16000 };
}

/** Box-filter resampler. Good enough for probing a provider, not for the production audio path. */
function resampleAverage(input, from, to) {
  const length = Math.floor((input.length * to) / from);
  const out = new Float64Array(length);
  const step = from / to;
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * step);
    const end = Math.max(start + 1, Math.min(input.length, Math.floor((i + 1) * step)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / (end - start);
  }
  return out;
}

export function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
