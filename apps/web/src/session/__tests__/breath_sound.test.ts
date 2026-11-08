import { describe, expect, it, vi } from 'vitest';
import { BreathSound, DEFAULT_BREATH_SOUND_GAIN, parseBreathSoundGain } from '../breath_sound';

function fakeContext() {
  const param = () => ({ value: 0.01, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn() });
  const sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; onended: (() => void) | null; buffer: unknown }> = [];
  const gains: Array<{ gain: ReturnType<typeof param>; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  const context = {
    currentTime: 10,
    sampleRate: 1000,
    destination: { name: 'destination' },
    createBuffer: (_channels: number, length: number) => {
      const data = new Float32Array(length);
      return { getChannelData: () => data, length };
    },
    createBufferSource: () => {
      const source = { start: vi.fn(), stop: vi.fn(), connect: vi.fn(), onended: null, buffer: null };
      sources.push(source);
      return source;
    },
    createBiquadFilter: () => ({ type: '', Q: { value: 0 }, frequency: param(), connect: vi.fn() }),
    createGain: () => {
      const gain = { gain: param(), connect: vi.fn(), disconnect: vi.fn() };
      gains.push(gain);
      return gain;
    },
  };
  return { context: context as unknown as AudioContext, destination: context.destination, sources, gains };
}

describe('parseBreathSoundGain', () => {
  it.each([
    [null, DEFAULT_BREATH_SOUND_GAIN],
    ['', DEFAULT_BREATH_SOUND_GAIN],
    ['abc', DEFAULT_BREATH_SOUND_GAIN],
    ['-1', DEFAULT_BREATH_SOUND_GAIN],
    ['0', 0],
    ['0.04', 0.04],
    ['5', 0.1],
  ])('%s → %s', (raw, expected) => {
    expect(parseBreathSoundGain(raw)).toBe(expected);
  });
});

describe('BreathSound', () => {
  it('吸気の長さで鳴らし、頂点は指定の音量で、終わりは 0 に戻す', () => {
    const f = fakeContext();
    new BreathSound(f.context, 0.02).play(700);
    const ramps = f.gains[0]!.gain.linearRampToValueAtTime.mock.calls;
    expect(Math.max(...ramps.map((c) => c[0] as number))).toBeCloseTo(0.02, 6);
    expect(ramps.at(-1)).toEqual([0, expect.closeTo(10.7, 6)]);
    expect(f.sources[0]!.start).toHaveBeenCalledWith(10);
    expect(f.sources[0]!.stop).toHaveBeenCalledWith(expect.closeTo(10.7, 6));
  });

  it('スピーカーへ直接つなぐ（AI の再生音の経路には入れない）', () => {
    const f = fakeContext();
    new BreathSound(f.context, 0.02).play(700);
    expect(f.gains[0]!.connect).toHaveBeenCalledWith(f.destination);
  });

  it('音量 0 は何も作らない', () => {
    const f = fakeContext();
    new BreathSound(f.context, 0).play(700);
    expect(f.sources).toHaveLength(0);
  });

  it('途中で止めると短く消す。止めた後の stop は何もしない', () => {
    const f = fakeContext();
    const sound = new BreathSound(f.context, 0.02);
    sound.play(700);
    sound.stop();
    expect(f.gains[0]!.gain.cancelScheduledValues).toHaveBeenCalledWith(10);
    expect(f.gains[0]!.gain.setTargetAtTime).toHaveBeenCalledTimes(1);
    expect(f.sources[0]!.stop).toHaveBeenLastCalledWith(expect.closeTo(10.1, 6));
    sound.stop();
    expect(f.gains[0]!.gain.setTargetAtTime).toHaveBeenCalledTimes(1);
  });

  it('鳴っている間に次を鳴らすと前の音を止める', () => {
    const f = fakeContext();
    const sound = new BreathSound(f.context, 0.02);
    sound.play(700);
    sound.play(700);
    expect(f.gains[0]!.gain.setTargetAtTime).toHaveBeenCalledTimes(1);
    expect(f.sources).toHaveLength(2);
  });
});
