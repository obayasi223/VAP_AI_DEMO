/**
 * WebSocket のバイナリ枠。AudioWorklet と Worker からも読み込むので、このファイルは依存を持たない
 * （`@llm-vap/contracts/binary` で単独 import できる）。
 * Python 側の実装は workers/maai/contract/frames.py。バイト列の一致は共通の固定値で試験している。
 *
 * すべてリトルエンディアン。
 *
 * AUDIO 枠（kind=1）: Browser→Node の上りと Node→Python で同じ形式（計画 §3.3）
 *   0  u8   version
 *   1  u8   kind = 1
 *   2  u8   format = 1 (Int16LE)
 *   3  u8   flags（予約、0）
 *   4  u32  audio_frame   この枠の先頭サンプルの番号（16kHz サンプルの連番、計画 §3.2）
 *   8  u16  sample_count  チャネルあたりのサンプル数
 *   10 u16  予約、0
 *   12 ...  mic[sample_count] Int16LE, sys[sample_count] Int16LE
 *
 * PCM 枠（kind=2）: Node→Browser の下り（再生用）
 *   0  u8   version
 *   1  u8   kind = 2
 *   2  u8   format = 1 (Int16LE)
 *   3  u8   flags（bit0: end_of_stream）
 *   4  u32  audio_playback_id
 *   8  u32  generation
 *   12 u32  seq           同じ audio_playback_id の中の連番（0 始まり）
 *   16 u32  sample_rate_hz
 *   20 u16  sample_count  0 は end_of_stream のときだけ許す
 *   22 u16  予約、0
 *   24 ...  pcm[sample_count] Int16LE（モノラル）
 */

export const FRAME_PROTOCOL_VERSION = 1 as const;
export const FRAME_KIND_AUDIO = 1 as const;
export const FRAME_KIND_PCM = 2 as const;
export const FRAME_FORMAT_INT16LE = 1 as const;
export const AUDIO_FRAME_HEADER_BYTES = 12 as const;
export const PCM_FRAME_HEADER_BYTES = 24 as const;
export const PCM_FLAG_END_OF_STREAM = 0x01 as const;

/** audio_frame の時間軸。16kHz サンプルの連番（計画 §3.2）。 */
export const SAMPLE_RATE_HZ = 16000 as const;
/** 送信単位の初期値 20ms。MaAI の frame 周期（10Hz=1600、12.5Hz=1280）の約数。 */
export const DEFAULT_FRAME_SAMPLES = 320 as const;

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

export interface AudioFrame {
  version: number;
  audio_frame: number;
  sample_count: number;
  format: 'Int16LE';
  mic: Int16Array;
  sys: Int16Array;
}

export interface PcmFrame {
  version: number;
  audio_playback_id: number;
  generation: number;
  seq: number;
  sample_rate_hz: number;
  sample_count: number;
  format: 'Int16LE';
  end_of_stream: boolean;
  pcm: Int16Array;
}

export type FrameErrorCode =
  | 'too_short'
  | 'bad_version'
  | 'bad_kind'
  | 'bad_format'
  | 'bad_length'
  | 'bad_field';

export class FrameError extends Error {
  readonly code: FrameErrorCode;
  constructor(code: FrameErrorCode, message: string) {
    super(message);
    this.name = 'FrameError';
    this.code = code;
  }
}

function asBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function checkU32(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new FrameError('bad_field', `${name} must be a u32, got ${value}`);
  }
}

function checkSampleCount(value: number, min: number): void {
  if (!Number.isInteger(value) || value < min || value > U16_MAX) {
    throw new FrameError('bad_field', `sample_count must be in ${min}..${U16_MAX}, got ${value}`);
  }
}

function writeSamples(view: DataView, offset: number, samples: Int16Array): number {
  let at = offset;
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(at, samples[i] as number, true);
    at += 2;
  }
  return at;
}

function readSamples(view: DataView, offset: number, count: number): Int16Array {
  // Node の Buffer は奇数の byteOffset を持ちうるので、ビューを作らず必ずコピーする。
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(offset + i * 2, true);
  return out;
}

function checkCommon(bytes: Uint8Array, expectedKind: number, minLength: number): DataView {
  if (bytes.length < 4) throw new FrameError('too_short', `frame too short: ${bytes.length} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== FRAME_PROTOCOL_VERSION) {
    throw new FrameError('bad_version', `unsupported frame version ${version}`);
  }
  const kind = view.getUint8(1);
  if (kind !== expectedKind) {
    throw new FrameError('bad_kind', `expected frame kind ${expectedKind}, got ${kind}`);
  }
  const format = view.getUint8(2);
  if (format !== FRAME_FORMAT_INT16LE) {
    throw new FrameError('bad_format', `unsupported sample format ${format}`);
  }
  if (bytes.length < minLength) {
    throw new FrameError('too_short', `frame too short: ${bytes.length} bytes, need ${minLength}`);
  }
  return view;
}

/** 枠の種類を調べる。受信側の振り分け用。解釈できなければ FrameError。 */
export function peekFrameKind(data: ArrayBuffer | ArrayBufferView): 'audio' | 'pcm' {
  const bytes = asBytes(data);
  if (bytes.length < 2) throw new FrameError('too_short', `frame too short: ${bytes.length} bytes`);
  if (bytes[0] !== FRAME_PROTOCOL_VERSION) {
    throw new FrameError('bad_version', `unsupported frame version ${bytes[0]}`);
  }
  if (bytes[1] === FRAME_KIND_AUDIO) return 'audio';
  if (bytes[1] === FRAME_KIND_PCM) return 'pcm';
  throw new FrameError('bad_kind', `unknown frame kind ${bytes[1]}`);
}

export function encodeAudioFrame(input: {
  audio_frame: number;
  mic: Int16Array;
  sys: Int16Array;
}): Uint8Array {
  checkU32('audio_frame', input.audio_frame);
  if (input.mic.length !== input.sys.length) {
    throw new FrameError(
      'bad_field',
      `mic and sys must have the same length (${input.mic.length} != ${input.sys.length})`,
    );
  }
  checkSampleCount(input.mic.length, 1);
  const out = new Uint8Array(AUDIO_FRAME_HEADER_BYTES + input.mic.length * 4);
  const view = new DataView(out.buffer);
  view.setUint8(0, FRAME_PROTOCOL_VERSION);
  view.setUint8(1, FRAME_KIND_AUDIO);
  view.setUint8(2, FRAME_FORMAT_INT16LE);
  view.setUint32(4, input.audio_frame, true);
  view.setUint16(8, input.mic.length, true);
  const afterMic = writeSamples(view, AUDIO_FRAME_HEADER_BYTES, input.mic);
  writeSamples(view, afterMic, input.sys);
  return out;
}

export function decodeAudioFrame(data: ArrayBuffer | ArrayBufferView): AudioFrame {
  const bytes = asBytes(data);
  const view = checkCommon(bytes, FRAME_KIND_AUDIO, AUDIO_FRAME_HEADER_BYTES);
  const audio_frame = view.getUint32(4, true);
  const sample_count = view.getUint16(8, true);
  if (sample_count === 0) throw new FrameError('bad_field', 'audio frame with sample_count 0');
  const expected = AUDIO_FRAME_HEADER_BYTES + sample_count * 4;
  if (bytes.length !== expected) {
    throw new FrameError('bad_length', `audio frame length ${bytes.length}, expected ${expected}`);
  }
  return {
    version: FRAME_PROTOCOL_VERSION,
    audio_frame,
    sample_count,
    format: 'Int16LE',
    mic: readSamples(view, AUDIO_FRAME_HEADER_BYTES, sample_count),
    sys: readSamples(view, AUDIO_FRAME_HEADER_BYTES + sample_count * 2, sample_count),
  };
}

export function encodePcmFrame(input: {
  audio_playback_id: number;
  generation: number;
  seq: number;
  sample_rate_hz: number;
  pcm: Int16Array;
  end_of_stream?: boolean;
}): Uint8Array {
  checkU32('audio_playback_id', input.audio_playback_id);
  checkU32('generation', input.generation);
  checkU32('seq', input.seq);
  checkU32('sample_rate_hz', input.sample_rate_hz);
  if (input.sample_rate_hz === 0) throw new FrameError('bad_field', 'sample_rate_hz must not be 0');
  const endOfStream = input.end_of_stream === true;
  checkSampleCount(input.pcm.length, endOfStream ? 0 : 1);
  const out = new Uint8Array(PCM_FRAME_HEADER_BYTES + input.pcm.length * 2);
  const view = new DataView(out.buffer);
  view.setUint8(0, FRAME_PROTOCOL_VERSION);
  view.setUint8(1, FRAME_KIND_PCM);
  view.setUint8(2, FRAME_FORMAT_INT16LE);
  view.setUint8(3, endOfStream ? PCM_FLAG_END_OF_STREAM : 0);
  view.setUint32(4, input.audio_playback_id, true);
  view.setUint32(8, input.generation, true);
  view.setUint32(12, input.seq, true);
  view.setUint32(16, input.sample_rate_hz, true);
  view.setUint16(20, input.pcm.length, true);
  writeSamples(view, PCM_FRAME_HEADER_BYTES, input.pcm);
  return out;
}

export function decodePcmFrame(data: ArrayBuffer | ArrayBufferView): PcmFrame {
  const bytes = asBytes(data);
  const view = checkCommon(bytes, FRAME_KIND_PCM, PCM_FRAME_HEADER_BYTES);
  const flags = view.getUint8(3);
  const end_of_stream = (flags & PCM_FLAG_END_OF_STREAM) !== 0;
  const sample_rate_hz = view.getUint32(16, true);
  if (sample_rate_hz === 0) throw new FrameError('bad_field', 'sample_rate_hz must not be 0');
  const sample_count = view.getUint16(20, true);
  if (sample_count === 0 && !end_of_stream) {
    throw new FrameError('bad_field', 'pcm frame with sample_count 0 and no end_of_stream');
  }
  const expected = PCM_FRAME_HEADER_BYTES + sample_count * 2;
  if (bytes.length !== expected) {
    throw new FrameError('bad_length', `pcm frame length ${bytes.length}, expected ${expected}`);
  }
  return {
    version: FRAME_PROTOCOL_VERSION,
    audio_playback_id: view.getUint32(4, true),
    generation: view.getUint32(8, true),
    seq: view.getUint32(12, true),
    sample_rate_hz,
    sample_count,
    format: 'Int16LE',
    end_of_stream,
    pcm: readSamples(view, PCM_FRAME_HEADER_BYTES, sample_count),
  };
}

/**
 * 世代の判定。全段（LLM→ElevenLabs→Node→Worklet）で同じ規則を使う（計画 §4.3）。
 * generation はセッション内で単調増加し、停止命令のたびに増える。現在の世代より古いものは棄てる。
 */
export function isStaleGeneration(chunkGeneration: number, currentGeneration: number): boolean {
  return chunkGeneration < currentGeneration;
}

/** MaAI へ渡す直前の変換（計画 §3.3）。 */
export function int16ToFloat32(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = (samples[i] as number) / 32768;
  return out;
}
