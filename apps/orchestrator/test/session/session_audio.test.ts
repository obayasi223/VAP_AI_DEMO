/**
 * Session と音声の保存の配線。既定で何も作らないこと、設定時に上りの枠がそのまま WAV へ入ること、終了で閉じて manifest に残ること。
 * 音声はすべて合成（helpers の loud／quiet）。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeAudioFrame } from '@llm-vap/contracts';
import { SESSION_AUDIO_FILE, SESSION_AUDIO_SYNC_FILE } from '../../src/logging/session_audio';
import type { SessionAudioFile, SessionAudioFileSystem } from '../../src/logging/session_audio';
import type { Rig } from './helpers';
import { FRAME, createRig } from './helpers';

type DescribedAudio = { session_audio?: { enabled: boolean; saved: boolean; reason: string | null; wav_samples: number; status: string; first_t_monotonic_ms: number | null } };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'session-audio-wiring-'));
}

function lastAudio(rig: Rig) {
  return (rig.described.at(-1) as DescribedAudio).session_audio;
}

let rig: Rig | null = null;
afterEach(async () => {
  await rig?.session.close('test_done');
  rig = null;
  delete process.env.SAVE_SESSION_AUDIO;
  vi.restoreAllMocks();
});

const enabled = (dir: string) => ({ enabled: true, min_free_bytes: 0, dir });

describe('既定', () => {
  it('設定がなければ何も書かず、manifest と起動ログに「保存しない」を残す', async () => {
    const log = vi.spyOn(console, 'log');
    const dir = tempDir();
    rig = await createRig();
    await rig.steps(20, { loud: true });
    await rig.session.close('test_done');
    expect(lastAudio(rig)).toMatchObject({ enabled: false, saved: false, status: 'off' });
    expect(readdirSync(dir)).toEqual([]);
    expect(log.mock.calls.some(([m]) => String(m).includes('session audio: not saved'))).toBe(true);
  });

  it('SAVE_SESSION_AUDIO=1 でないなら環境からも始めない', async () => {
    process.env.SAVE_SESSION_AUDIO = '0';
    rig = await createRig();
    await rig.steps(5);
    expect(lastAudio(rig)).toMatchObject({ enabled: false, saved: false });
  });
});

describe('設定あり', () => {
  it('上りの枠が ch1=mic、ch2=sys でそのまま WAV に入る', async () => {
    const dir = tempDir();
    const log = vi.spyOn(console, 'log');
    rig = await createRig({ sessionAudio: enabled(dir) });
    const mic = new Int16Array(FRAME).fill(1234);
    const sys = new Int16Array(FRAME).fill(-4321);
    rig.session.handleBinary(encodeAudioFrame({ audio_frame: 0, mic, sys }));
    rig.session.handleBinary(encodeAudioFrame({ audio_frame: FRAME, mic, sys }));
    await rig.session.close('test_done');

    const wav = readFileSync(join(dir, SESSION_AUDIO_FILE));
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(40)).toBe(2 * FRAME * 4);
    expect(wav.readInt16LE(44)).toBe(1234);
    expect(wav.readInt16LE(46)).toBe(-4321);
    expect(readFileSync(join(dir, SESSION_AUDIO_SYNC_FILE), 'utf8')).toContain('"type":"anchor"');
    expect(lastAudio(rig)).toMatchObject({ enabled: true, saved: true, status: 'closed', wav_samples: 2 * FRAME, reason: null });
    expect(log.mock.calls.some(([m]) => String(m).includes('session audio: SAVING'))).toBe(true);
  });

  it('時刻は Session の時計（JSONL と同じ）で渡る', async () => {
    const dir = tempDir();
    rig = await createRig({ sessionAudio: enabled(dir) });
    rig.time.advance(500);
    const t = rig.time.monotonicMs();
    rig.session.handleBinary(encodeAudioFrame({ audio_frame: 0, mic: new Int16Array(FRAME), sys: new Int16Array(FRAME) }));
    await rig.session.close('test_done');
    expect(lastAudio(rig)?.first_t_monotonic_ms).toBe(t);
  });

  it('壊れた枠では保存せず、制御も止まらない', async () => {
    const dir = tempDir();
    rig = await createRig({ sessionAudio: enabled(dir) });
    rig.session.handleBinary(new Uint8Array([1, 2, 3]));
    await rig.session.close('test_done');
    expect(rig.session.counters.bad_uplink_frames).toBe(1);
    expect(existsSync(join(dir, SESSION_AUDIO_FILE))).toBe(false);
    expect(lastAudio(rig)).toMatchObject({ saved: false, reason: 'no_audio_frames' });
  });

  it('書き込みが詰まっても tick と上りの処理は進み、close も期限で返る', async () => {
    const stalled: SessionAudioFile = {
      write: () => new Promise(() => undefined),
      writeAt: async () => undefined,
      sync: async () => undefined,
      close: async () => undefined,
    };
    const fs: SessionAudioFileSystem = { createExclusive: async () => stalled, freeBytes: async () => 10 ** 12 };
    rig = await createRig({ sessionAudio: { ...enabled('unused'), fs, recorder: { maxQueueBytes: FRAME * 4 * 3, closeTimeoutMs: 30 } } });
    const before = rig.session.counters.uplink_frames;
    await rig.steps(30, { loud: true });
    expect(rig.session.counters.uplink_frames).toBe(before + 30);
    expect(rig.session.counters.tick_errors).toBe(0);
    await rig.session.close('test_done');
    expect(lastAudio(rig)).toMatchObject({ enabled: true, status: 'closed' });
    expect(rig.events.events.some((e) => e.event === 'provider.status' && (e as { provider: string }).provider === 'session_audio')).toBe(true);
  });
});
