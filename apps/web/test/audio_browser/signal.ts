/** 実ブラウザ試験の信号処理の道具。 */
import { readFile, writeFile } from 'node:fs/promises';
import { PolyphaseResampler, designResampler } from '../../src/audio/dsp/resampler';

export function toneInt16(freq: number, rate: number, n: number, amp = 0.4, startPhase = 0): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(32767 * amp * Math.sin(startPhase + (2 * Math.PI * freq * i) / rate));
  }
  return out;
}

export function rms(x: ArrayLike<number>, start = 0, end = x.length): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += (x[i] as number) ** 2;
  return Math.sqrt(sum / Math.max(1, end - start));
}

export function db(x: number): number {
  return 20 * Math.log10(x + 1e-12);
}

/** x[start..end) の周波数 f 成分の振幅と位相（sin 基準）。 */
export function sineFit(
  x: ArrayLike<number>,
  f: number,
  fs: number,
  start: number,
  end: number,
): { amp: number; phase: number } {
  let re = 0;
  let im = 0;
  for (let i = start; i < end; i++) {
    const w = (2 * Math.PI * f * i) / fs;
    re += (x[i] as number) * Math.sin(w);
    im += (x[i] as number) * Math.cos(w);
  }
  const n = end - start;
  return { amp: (2 * Math.hypot(re, im)) / n, phase: Math.atan2(im, re) };
}

/** b が a に対して何サンプル遅れているか（放物線補間、正規化相関つき）。 */
export function crossCorrelate(
  a: ArrayLike<number>,
  aStart: number,
  length: number,
  b: ArrayLike<number>,
  minLag: number,
  maxLag: number,
): { lag: number; corr: number } {
  let bestLag = minLag;
  let best = -Infinity;
  const scores = new Float64Array(maxLag - minLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < length; i++) {
      sum += (a[aStart + i] as number) * ((b[aStart + i + lag] ?? 0) as number);
    }
    scores[lag - minLag] = sum;
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  let ea = 0;
  let eb = 0;
  for (let i = 0; i < length; i++) {
    ea += (a[aStart + i] as number) ** 2;
    eb += ((b[aStart + i + bestLag] ?? 0) as number) ** 2;
  }
  const idx = bestLag - minLag;
  let frac = 0;
  if (idx > 0 && idx < scores.length - 1) {
    const l = scores[idx - 1] as number;
    const c = scores[idx] as number;
    const r = scores[idx + 1] as number;
    const denom = l - 2 * c + r;
    if (denom !== 0) frac = (0.5 * (l - r)) / denom;
  }
  return { lag: bestLag + frac, corr: best / Math.sqrt(ea * eb + 1e-30) };
}

export function peakIndex(x: ArrayLike<number>, start: number, end: number): number {
  let at = start;
  let best = -1;
  for (let i = start; i < end; i++) {
    const v = Math.abs(x[i] as number);
    if (v > best) {
      best = v;
      at = i;
    }
  }
  return at;
}

/** 窓つきの短いパルス（24kHz なら帯域内）を k の位置へ置く。 */
export function addPulse(x: Int16Array, at: number, halfWidth = 6, amp = 20000): void {
  for (let i = -halfWidth; i <= halfWidth; i++) {
    const w = 0.5 + 0.5 * Math.cos((Math.PI * i) / (halfWidth + 1));
    const s = i === 0 ? 1 : Math.sin((Math.PI * i) / 2) / ((Math.PI * i) / 2);
    x[at + i] = Math.round(amp * w * s);
  }
}

export function resampleInt16(x: Int16Array, inRate: number, outRate: number): Int16Array {
  const r = new PolyphaseResampler(designResampler(inRate, outRate));
  const input = Float32Array.from(x, (v) => v / 32768);
  const out = new Float32Array(r.maxOutput(input.length));
  const n = r.process(input, 0, input.length, out, 0);
  const tail = r.flush();
  const result = new Int16Array(n + tail.length);
  for (let i = 0; i < n; i++) result[i] = Math.max(-32768, Math.min(32767, Math.round((out[i] as number) * 32768)));
  for (let i = 0; i < tail.length; i++) {
    result[n + i] = Math.max(-32768, Math.min(32767, Math.round((tail[i] as number) * 32768)));
  }
  return result;
}

export async function readWavMono16(path: string): Promise<{ rate: number; samples: Int16Array }> {
  const buf = await readFile(path);
  let at = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  while (at + 8 <= buf.length) {
    const id = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(at + 10);
      rate = buf.readUInt32LE(at + 12);
      bits = buf.readUInt16LE(at + 22);
    } else if (id === 'data') {
      if (channels !== 1 || bits !== 16) throw new Error(`expected mono 16-bit, got ${channels}ch ${bits}bit`);
      const samples = new Int16Array(size / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(at + 8 + i * 2);
      return { rate, samples };
    }
    at += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

export async function writeWavMono16(path: string, rate: number, samples: Int16Array): Promise<void> {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i] as number, 44 + i * 2);
  await writeFile(path, buf);
}
