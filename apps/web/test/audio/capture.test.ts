import { describe, expect, it } from 'vitest';
import { DuplexCapture, floatToInt16 } from '../../src/audio/dsp/capture';
import { designResampler } from '../../src/audio/dsp/resampler';

describe('DuplexCapture', () => {
  it('audio_frame は 16kHz の連番で、320 ずつ進む。mic と sys は同じ番号', () => {
    const capture = new DuplexCapture(designResampler(48000, 16000), 320);
    const seen: { n: number; micLen: number; sysLen: number }[] = [];
    const quantum = new Float32Array(128);
    for (let q = 0; q < 1000; q++) {
      capture.push(quantum, quantum, 128, (n, mic, sys) =>
        seen.push({ n, micLen: mic.length, sysLen: sys.length }),
      );
    }
    expect(seen.length).toBeGreaterThan(100);
    seen.forEach((f, i) => {
      expect(f.n).toBe(i * 320);
      expect(f.micLen).toBe(320);
      expect(f.sysLen).toBe(320);
    });
  });

  it('同じ信号を両チャネルへ入れると全サンプル一致（チャネルずれなし）', () => {
    const capture = new DuplexCapture(designResampler(48000, 16000), 320);
    const quantum = new Float32Array(128);
    let t = 0;
    let checked = 0;
    for (let q = 0; q < 500; q++) {
      for (let i = 0; i < 128; i++) quantum[i] = 0.3 * Math.sin((2 * Math.PI * 1000 * t++) / 48000);
      capture.push(quantum, quantum, 128, (_n, mic, sys) => {
        expect(Array.from(mic)).toEqual(Array.from(sys));
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('渡した枠の配列は使い回さない（転送しても次の枠が壊れない）', () => {
    const capture = new DuplexCapture(designResampler(48000, 16000), 320);
    const quantum = new Float32Array(128);
    const buffers = new Set<ArrayBufferLike>();
    for (let q = 0; q < 100; q++) {
      capture.push(quantum, quantum, 128, (_n, mic, sys) => {
        expect(buffers.has(mic.buffer)).toBe(false);
        buffers.add(mic.buffer);
        buffers.add(sys.buffer);
      });
    }
  });

  it('floatToInt16 は範囲で飽和し、/32768 の逆になる', () => {
    expect(floatToInt16(0)).toBe(0);
    expect(floatToInt16(1)).toBe(32767);
    expect(floatToInt16(-1)).toBe(-32768);
    expect(floatToInt16(2)).toBe(32767);
    expect(floatToInt16(0.5)).toBe(16384);
  });
});
