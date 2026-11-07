import { describe, expect, it } from 'vitest';
import {
  AUDIO_FRAME_HEADER_BYTES,
  decodeAudioFrame,
  decodePcmFrame,
  DEFAULT_FRAME_SAMPLES,
  encodeAudioFrame,
  encodePcmFrame,
  FrameError,
  int16ToFloat32,
  isStaleGeneration,
  PCM_FRAME_HEADER_BYTES,
  peekFrameKind,
} from '../src/binary';

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof FrameError) return e.code;
    throw e;
  }
  return 'no_error';
};

const audio = () =>
  encodeAudioFrame({
    audio_frame: 3200,
    mic: Int16Array.from([1, -2, 32767, -32768]),
    sys: Int16Array.from([5, 6, 7, 8]),
  });
const pcm = () =>
  encodePcmFrame({
    audio_playback_id: 11,
    generation: 3,
    seq: 7,
    sample_rate_hz: 24000,
    pcm: Int16Array.from([100, -100]),
  });

describe('audio frame', () => {
  it('round-trips', () => {
    const f = decodeAudioFrame(audio());
    expect(f.audio_frame).toBe(3200);
    expect(f.sample_count).toBe(4);
    expect(f.format).toBe('Int16LE');
    expect(Array.from(f.mic)).toEqual([1, -2, 32767, -32768]);
    expect(Array.from(f.sys)).toEqual([5, 6, 7, 8]);
  });

  it('keeps channels apart at the frame size used in production', () => {
    const mic = new Int16Array(DEFAULT_FRAME_SAMPLES).fill(1000);
    const sys = new Int16Array(DEFAULT_FRAME_SAMPLES).fill(-1000);
    const f = decodeAudioFrame(encodeAudioFrame({ audio_frame: 0, mic, sys }));
    expect(f.mic.every((s) => s === 1000)).toBe(true);
    expect(f.sys.every((s) => s === -1000)).toBe(true);
  });

  it('is little endian on the wire', () => {
    const bytes = encodeAudioFrame({
      audio_frame: 0x01020304,
      mic: Int16Array.from([0x0102]),
      sys: Int16Array.from([0x0304]),
    });
    expect(Array.from(bytes.slice(4, 8))).toEqual([0x04, 0x03, 0x02, 0x01]);
    expect(Array.from(bytes.slice(AUDIO_FRAME_HEADER_BYTES))).toEqual([0x02, 0x01, 0x04, 0x03]);
  });

  it('decodes from an odd byte offset (pooled Node Buffer)', () => {
    const inner = audio();
    const shifted = new Uint8Array(inner.length + 1);
    shifted.set(inner, 1);
    expect(decodeAudioFrame(shifted.subarray(1)).audio_frame).toBe(3200);
    expect(decodeAudioFrame(Buffer.from(inner)).sample_count).toBe(4);
  });

  it('accepts an ArrayBuffer', () => {
    const bytes = audio();
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    expect(decodeAudioFrame(ab as ArrayBuffer).audio_frame).toBe(3200);
  });

  it('rejects mismatched channels and bad fields when encoding', () => {
    const one = Int16Array.from([1]);
    expect(code(() => encodeAudioFrame({ audio_frame: 0, mic: one, sys: new Int16Array(2) }))).toBe('bad_field');
    expect(code(() => encodeAudioFrame({ audio_frame: -1, mic: one, sys: one }))).toBe('bad_field');
    expect(code(() => encodeAudioFrame({ audio_frame: 2 ** 32, mic: one, sys: one }))).toBe('bad_field');
    expect(code(() => encodeAudioFrame({ audio_frame: 0.5, mic: one, sys: one }))).toBe('bad_field');
    const empty = new Int16Array(0);
    expect(code(() => encodeAudioFrame({ audio_frame: 0, mic: empty, sys: empty }))).toBe('bad_field');
  });

  it('rejects malformed input when decoding', () => {
    expect(code(() => decodeAudioFrame(new Uint8Array(2)))).toBe('too_short');
    const trunc = audio().slice(0, -1);
    expect(code(() => decodeAudioFrame(trunc))).toBe('bad_length');
    const extra = new Uint8Array(audio().length + 2);
    extra.set(audio());
    expect(code(() => decodeAudioFrame(extra))).toBe('bad_length');
    const version = audio();
    version[0] = 99;
    expect(code(() => decodeAudioFrame(version))).toBe('bad_version');
    const format = audio();
    format[2] = 2;
    expect(code(() => decodeAudioFrame(format))).toBe('bad_format');
    expect(code(() => decodeAudioFrame(pcm()))).toBe('bad_kind');
    const zero = audio().slice(0, AUDIO_FRAME_HEADER_BYTES);
    zero[8] = 0;
    zero[9] = 0;
    expect(code(() => decodeAudioFrame(zero))).toBe('bad_field');
  });
});

describe('pcm frame', () => {
  it('round-trips', () => {
    const f = decodePcmFrame(pcm());
    expect(f).toMatchObject({
      audio_playback_id: 11,
      generation: 3,
      seq: 7,
      sample_rate_hz: 24000,
      sample_count: 2,
      end_of_stream: false,
    });
    expect(Array.from(f.pcm)).toEqual([100, -100]);
  });

  it('allows an empty frame only as end_of_stream', () => {
    const base = { audio_playback_id: 1, generation: 0, seq: 0, sample_rate_hz: 16000, pcm: new Int16Array(0) };
    const end = decodePcmFrame(encodePcmFrame({ ...base, end_of_stream: true }));
    expect(end.end_of_stream).toBe(true);
    expect(end.sample_count).toBe(0);
    expect(code(() => encodePcmFrame(base))).toBe('bad_field');
    const forged = encodePcmFrame({ ...base, end_of_stream: true });
    forged[3] = 0;
    expect(code(() => decodePcmFrame(forged))).toBe('bad_field');
  });

  it('rejects malformed input', () => {
    expect(code(() => decodePcmFrame(pcm().slice(0, PCM_FRAME_HEADER_BYTES - 1)))).toBe('too_short');
    expect(code(() => decodePcmFrame(pcm().slice(0, -2)))).toBe('bad_length');
    expect(code(() => decodePcmFrame(audio()))).toBe('bad_kind');
    const noRate = pcm();
    noRate.fill(0, 16, 20);
    expect(code(() => decodePcmFrame(noRate))).toBe('bad_field');
  });
});

describe('helpers', () => {
  it('peeks the kind', () => {
    expect(peekFrameKind(audio())).toBe('audio');
    expect(peekFrameKind(pcm())).toBe('pcm');
    expect(code(() => peekFrameKind(new Uint8Array([1, 9])))).toBe('bad_kind');
    expect(code(() => peekFrameKind(new Uint8Array([9, 1])))).toBe('bad_version');
    expect(code(() => peekFrameKind(new Uint8Array([1])))).toBe('too_short');
  });

  it('compares generations', () => {
    expect(isStaleGeneration(2, 3)).toBe(true);
    expect(isStaleGeneration(3, 3)).toBe(false);
    expect(isStaleGeneration(4, 3)).toBe(false);
  });

  it('converts to Float32 in [-1, 1)', () => {
    expect(Array.from(int16ToFloat32(Int16Array.from([-32768, 0, 16384])))).toEqual([-1, 0, 0.5]);
  });

  it('frame size divides the MaAI frame periods (plan §3.2)', () => {
    expect(16000 / 10 % DEFAULT_FRAME_SAMPLES).toBe(0);
    expect(16000 / 12.5 % DEFAULT_FRAME_SAMPLES).toBe(0);
  });
});
