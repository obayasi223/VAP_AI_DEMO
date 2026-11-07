/**
 * WAV を 16kHz モノラル 16bit へ。Windows の録音アプリが出す 24bit や 32bit 浮動小数も受ける。
 * ボックスフィルタの間引きで、調査用の品質（provider_probe と同じ）。本番の音声経路には使わない。
 */
import { readFileSync } from 'node:fs';

export interface WavInfo {
  format_tag: number;
  channels: number;
  sample_rate: number;
  bits: number;
  duration_s: number;
}

export class WavFormatError extends Error {}

export function parseWav(buf: Buffer): { info: WavInfo; data: Buffer } {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new WavFormatError('WAV 形式ではありません（m4a や mp3 のままかもしれません）。');
  }
  let pos = 12;
  let fmt: Omit<WavInfo, 'duration_s'> | null = null;
  let data: Buffer | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      let format_tag = buf.readUInt16LE(pos + 8);
      const bits = buf.readUInt16LE(pos + 22);
      // WAVE_FORMAT_EXTENSIBLE は副形式の先頭2バイトで実体を見る。
      if (format_tag === 0xfffe && size >= 26) format_tag = buf.readUInt16LE(pos + 32);
      fmt = { format_tag, channels: buf.readUInt16LE(pos + 10), sample_rate: buf.readUInt32LE(pos + 12), bits };
    } else if (id === 'data') {
      data = buf.subarray(pos + 8, Math.min(pos + 8 + size, buf.length));
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new WavFormatError('WAV の中に fmt または data がありません。');
  const supported =
    (fmt.format_tag === 1 && [16, 24, 32].includes(fmt.bits)) || (fmt.format_tag === 3 && fmt.bits === 32);
  if (!supported) throw new WavFormatError(`対応していない WAV です（format=${fmt.format_tag}, ${fmt.bits}bit）。`);
  const frames = Math.floor(data.length / ((fmt.bits / 8) * fmt.channels));
  return { info: { ...fmt, duration_s: frames / fmt.sample_rate }, data };
}

function sampleAt(data: Buffer, offset: number, info: WavInfo): number {
  if (info.format_tag === 3) return data.readFloatLE(offset) * 32767;
  if (info.bits === 16) return data.readInt16LE(offset);
  if (info.bits === 24) return data.readIntLE(offset, 3) / 256;
  return data.readInt32LE(offset) / 65536;
}

export function toPcm16kMono(info: WavInfo, data: Buffer): Buffer {
  const bytes = info.bits / 8;
  const frames = Math.floor(data.length / (bytes * info.channels));
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < info.channels; c++) sum += sampleAt(data, (i * info.channels + c) * bytes, info);
    mono[i] = sum / info.channels;
  }
  const length = Math.floor((frames * 16000) / info.sample_rate);
  const step = info.sample_rate / 16000;
  const out = Buffer.alloc(length * 2);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * step);
    const end = Math.max(start + 1, Math.min(frames, Math.floor((i + 1) * step)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += mono[j] as number;
    const value = sum / (end - start);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), i * 2);
  }
  return out;
}

export function readWavFile(path: string): { info: WavInfo; pcm: Buffer } {
  const { info, data } = parseWav(readFileSync(path));
  return { info, pcm: toPcm16kMono(info, data) };
}
