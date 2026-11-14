/**
 * WP1a の同一性の試験（docs/design/two_ai/01 §6.2、05 §6）。session.ts から共有の部品（session_io/）を切り出す前に書き、
 * 1 対 1 の台本のセッションの events.jsonl の行（wall_clock を除く）と manifest が、切り出しの前の写しと 1 バイトも違わないことを確かめる。
 *
 * 筋：時計の報告（ping／report）、audio.report、gaze.report（時計の前と後）、ゼロ埋めの FRAMES_DROPPED、STT の interim と final、
 * 完了の推定（値を返す偽の推定器）、AI の応答の再生（started／position／ended）、割り込み、avatar.report、close。
 * 写しは同じディレクトリの session_io_identity.golden.jsonl（初回の実行で作る。以後は比べるだけ）。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ManualTimeSource, MemoryEventSink, createEventEmitter, encodeAudioFrame, present } from '@llm-vap/contracts';
import type { BrowserToNode, TurnCompletionEstimate, TurnCompletionEstimator } from '@llm-vap/contracts';
import { ScriptedLlmProvider, ScriptedSttProvider, ScriptedTtsProvider } from '@llm-vap/testkit';
import type { ScriptedSttSession, ScriptedTtsConnection } from '@llm-vap/testkit';
import type { SessionProviders } from '../../src/app/providers';
import type { SessionLog, SessionManifestDetails } from '../../src/logging';
import type { MaaiWorkerClient } from '../../src/maai';
import { Session } from '../../src/session/session';
import { FRAME, FakeLink, FakeMaai, TICK_MS, ended, flush, hello, position, productionJaPolicy, started } from './helpers';

/** 決まった値を返す完了の推定器（文字数で決める。非同期の順は flush で固定）。 */
class FixedCompletion implements TurnCompletionEstimator {
  readonly name = 'identity_fixed_v1';
  async estimate(_history: unknown, partial: string): Promise<TurnCompletionEstimate> {
    return { p: present(Math.min(0.95, 0.1 + partial.length * 0.1)), estimator: this.name };
  }
}

const GOLDEN = join(import.meta.dirname, 'session_io_identity.golden.jsonl');

async function runScriptedSession(): Promise<string> {
  const time = new ManualTimeSource(1000);
  const events = new MemoryEventSink();
  const emitter = createEventEmitter({ time, session_id: 's_identity', condition: () => 'reactive', sink: events });
  const sttProvider = new ScriptedSttProvider(() => time.monotonicMs());
  const ttsProvider = new ScriptedTtsProvider({ ms_per_char: 100, chars_per_chunk: 4 });
  const llm = new ScriptedLlmProvider({ responder: () => '今日はとても良い天気ですね。', chars_per_delta: 3 });
  const providers: SessionProviders = {
    stt: { ok: true, value: sttProvider },
    tts: { ok: true, value: ttsProvider },
    llm: { ok: true, value: llm },
    completion: new FixedCompletion(),
    classes: { stt: 'test_double', tts: 'test_double', llm: 'test_double' },
    names: { stt: sttProvider.provider, tts: ttsProvider.provider, llm: llm.provider },
    requested: { stt: 'test_double', tts: 'test_double', llm: 'test_double' },
    completion_name: 'identity_fixed_v1',
    completion_error: null,
  };
  const described: SessionManifestDetails[] = [];
  const log = {
    describe: async (details: SessionManifestDetails) => {
      described.push(structuredClone(details));
      return true;
    },
    close: async () => ({ ok: true }),
    paths: { dir: '/nonexistent' },
  } as unknown as SessionLog;
  const maai = new FakeMaai();
  const session = new Session({
    session_id: 's_identity',
    condition: 'reactive',
    policy: productionJaPolicy(),
    time,
    emitter,
    log,
    providers,
    maai: maai as unknown as MaaiWorkerClient,
    sessionAudio: { enabled: false, min_free_bytes: 0 } as never,
    tickTimer: false,
  });
  const link = new FakeLink();
  await session.start(link, hello());
  const stt = (): ScriptedSttSession => sttProvider.sessions.at(-1) as ScriptedSttSession;
  const tts = (): ScriptedTtsConnection => ttsProvider.connections.at(-1) as ScriptedTtsConnection;
  const loud = new Int16Array(FRAME).map((_, i) => (i % 2 === 0 ? 6000 : -6000));
  const quiet = new Int16Array(FRAME);
  let frame = 0;
  const step = async (o: { loud?: boolean; p?: [number, number, boolean] } = {}): Promise<void> => {
    time.advance(TICK_MS);
    session.handleBinary(encodeAudioFrame({ audio_frame: frame, mic: o.loud ? loud : quiet, sys: quiet }));
    frame += FRAME;
    const [pn, pf, speaking] = o.p ?? [0.9, 0.9, false];
    maai.vap(time.monotonicMs(), frame, pn, pf, speaking);
    session.tick();
    await flush();
    for (const context of tts().contexts) context.pumpAll();
  };
  const steps = async (n: number, o: { loud?: boolean; p?: [number, number, boolean] } = {}): Promise<void> => {
    for (let i = 0; i < n; i++) await step(o);
  };
  const browser = (m: BrowserToNode): void => session.handleJson(m);
  const gaze = (client: number): BrowserToNode => ({ type: 'gaze.report', target: 'user', visible: true, client_t_ms: present(client) });
  const audioReport = (client: number): BrowserToNode =>
    ({
      type: 'audio.report',
      client_t_ms: client,
      audio_frame: frame,
      frames_lost: 0,
      underrun_count: 0,
      underrun_total_ms: 0,
      stale_pcm_frames_dropped: 0,
      latency: hello().latency,
      track_settings: hello().track_settings,
      system_ch_source: 'written',
      audio_context_state: 'running',
      visibility: 'visible',
    }) as BrowserToNode;

  // 時計の前の報告（数えるだけで記録しない）。
  browser(audioReport(10));
  browser(gaze(10));
  browser({ type: 'clock.ping', seq: 0, client_t_ms: 5 });
  browser({ type: 'clock.report', offset_ms: 990, rtt_ms: 4, uncertainty_ms: 2, samples: 3, client_t_ms: 12 });
  browser({
    type: 'avatar.report',
    avatar_id: 'test',
    kind: 'none',
    model_url: null,
    source: 'default',
    status: 'disabled',
    error: null,
    breath_sound_gain: 0,
    client_t_ms: 13,
  });
  maai.ready(time.monotonicMs());
  // ゼロ埋めの範囲（この窓の VAP は使わない）。
  for (const l of (maai as unknown as { session(): { onFramesDropped?: (m: unknown, at: number) => void }[] }).session()) {
    l.onFramesDropped?.({ type: 'FRAMES_DROPPED', from_audio_frame: 3200, sample_count: 640, cause: 'network_gap', zero_filled: true, channels: 'both' }, time.monotonicMs());
  }
  await steps(Math.ceil(10_000 / TICK_MS) + 1);
  browser(audioReport(500));
  browser(gaze(510));

  // 人の発話（interim → final）と AI の応答。
  await steps(5, { loud: true, p: [0.1, 0.1, true] });
  stt().deliver({ kind: 'interim', text: 'こんに', audio_frame_end: frame });
  await steps(5, { loud: true, p: [0.1, 0.1, true] });
  stt().deliver({ kind: 'final', text: 'こんにちは', audio_frame_end: frame });
  let begin: { audio_playback_id: number; generation: number } | null = null;
  for (let i = 0; i < 200 && begin === null; i++) {
    await step();
    begin = link.of('playback.begin').at(-1) ?? null;
  }
  if (begin === null) throw new Error('AI did not start');
  browser(started(begin));
  await steps(5);
  browser(position(begin, 4800));
  browser(gaze(900));
  // 割り込み：人が話し始めて止まる。
  await steps(8, { loud: true, p: [0.1, 0.1, true] });
  const stop = link.of('playback.stop').at(-1);
  browser(ended({ audio_playback_id: begin.audio_playback_id, generation: stop?.generation ?? begin.generation }, stop ? 'stopped' : 'completed', 9600));
  await steps(5, { loud: true, p: [0.1, 0.1, true] });
  stt().deliver({ kind: 'final', text: 'ちょっと待って', audio_frame_end: frame });
  await steps(120);
  const second = link.of('playback.begin').at(-1);
  if (second && second.audio_playback_id !== begin.audio_playback_id) {
    browser(started(second));
    await steps(3);
    browser(ended(second, 'completed', 16000));
    await steps(3);
  }
  session.detach('ws_closed');
  await steps(2);
  const link2 = new FakeLink();
  session.reattach(link2, hello('s_identity'));
  await steps(2);
  await session.close('test_done');

  const lines = events.events.map((e) => {
    const { wall_clock: _w, ...rest } = e as Record<string, unknown>;
    return JSON.stringify(rest);
  });
  const sent = [...link.json, ...link2.json].map((m) => `send ${JSON.stringify(m)}`);
  const manifests = described.map((d) => `manifest ${JSON.stringify(d)}`);
  const counters = `counters ${JSON.stringify(session.counters)}`;
  return [...lines, ...sent, ...manifests, counters, `binary ${link.binary + link2.binary}`].join('\n') + '\n';
}

describe('WP1a：session_io の切り出しの前後で 1 対 1 のセッションが同じ', () => {
  it('events.jsonl（wall_clock を除く）、送ったメッセージ、manifest、数えがバイト同一', async () => {
    const out = await runScriptedSession();
    expect(out.split('\n').some((l) => l.includes('"event":"clock.sync"') || l.includes('clock'))).toBe(true);
    await expect(out).toMatchFileSnapshot(GOLDEN);
  });

  it('2 回走らせても同じ（試験そのものが決まった出力）', async () => {
    expect(await runScriptedSession()).toBe(await runScriptedSession());
  });
});
