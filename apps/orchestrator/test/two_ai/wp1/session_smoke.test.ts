/**
 * TwoAiSession の一通り（偽のプロバイダ、手で進める時計、黙っている本人、自動で再生を報告する偽のブラウザ）。
 * 02（cognition/discussion）は本物。intake → discussion → response → next_step → end まで進み、
 * 契約に合わないイベント（emitter は throw）と tick の失敗がないことを確かめる。
 */
import { ManualTimeSource, MemoryEventSink, createEventEmitter } from '@llm-vap/contracts';
import { ScriptedTtsProvider } from '@llm-vap/testkit';
import type { BrowserToNode, NodeToBrowser, TwoAiCondition } from '@llm-vap/contracts';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../../src/app/config';
import { createTwoAiProviders } from '../../../src/app/providers';
import { loadDiscussionAssets } from '../../../src/cognition/discussion';
import type { SessionLog } from '../../../src/logging';
import { encodeAudioFrame } from '@llm-vap/contracts';
import { TwoAiSession } from '../../../src/two_ai/two_ai_session';
import { loadTwoAiSettings } from '../../../src/two_ai/settings';
import { FRAME, TICK_MS, hello, productionJaPolicy, repoRoot } from '../../session/helpers';

const PLAY_MS = 1200;

async function run(condition: TwoAiCondition, config_path = 'config/two_ai/session.demo_short.ja.json') {
  const time = new ManualTimeSource(1000);
  const events = new MemoryEventSink();
  const loaded = loadTwoAiSettings({ root: repoRoot, config_path, script_path: 'config/two_ai/scripts/demo_career.ja.json' });
  if (!loaded.ok) throw new Error(loaded.reason);
  const settings = loaded.settings;
  const script = settings.scripts.get(settings.default_script_id!)!;
  let context: () => ReturnType<NonNullable<Parameters<typeof createEventEmitter>[0]['two_ai_context']>> = () => null;
  const emitter = createEventEmitter({ time, session_id: 's_two_ai', condition: () => condition, two_ai_context: () => context(), sink: events });
  const config = readConfig({ STT_PROVIDER_CLASS: 'test_double', TTS_PROVIDER_CLASS: 'test_double', LLM_PROVIDER_CLASS: 'test_double', MAAI_ENABLED: '0' });
  const personas = loadDiscussionAssets(settings.root, settings.config, script.script.personas_file).personas;
  const providers = await createTwoAiProviders({ config, twoAi: settings.config, personas, time, emitter, env: {} });
  if (!providers.ok) throw new Error(providers.reason);
  // 声は手で進める台本の TTS（実時間の timer を使わない）。tick ごとに文を全部出す。
  const tts = { A: new ScriptedTtsProvider({ ms_per_char: 100, chars_per_chunk: 8 }), B: new ScriptedTtsProvider({ ms_per_char: 100, chars_per_chunk: 8 }) };
  providers.slotTts = tts as never;
  const pumpTts = () => {
    for (const p of [tts.A, tts.B]) for (const c of p.connections) for (const ctx of c.contexts) ctx.pumpAll();
  };
  const log = { describe: async () => true, close: async () => ({ ok: true }), paths: null } as unknown as SessionLog;
  const session = new TwoAiSession({
    session_id: 's_two_ai',
    condition,
    condition_source: 'env',
    arm: null,
    policy: productionJaPolicy(),
    time,
    emitter,
    bindEmitContext: (c) => {
      context = c;
    },
    log,
    settings,
    script,
    providers,
    maai: null,
    maaiUnavailableReason: 'maai_disabled_in_test',
    tickTimer: false,
    sessionAudio: { enabled: false, reason: 'SAVE_SESSION_AUDIO_not_set' } as never,
  });
  const sent: NodeToBrowser[] = [];
  // 再生中の発話（偽のブラウザ）：begin で始め、PLAY_MS の後に completed で終える。
  const playing = new Map<number, { generation: number; until: number }>();
  const link = {
    sendJson: (m: NodeToBrowser) => {
      sent.push(m);
      if (m.type === 'playback.begin') {
        playing.set(m.audio_playback_id, { generation: m.generation, until: time.monotonicMs() + PLAY_MS });
        queue.push({ type: 'playback.started', audio_playback_id: m.audio_playback_id, generation: m.generation, audio_frame: frame, client_t_ms: 0, output_latency_ms: { value: 0 } } as BrowserToNode);
      }
      if (m.type === 'playback.stop') {
        const p = playing.get(m.audio_playback_id);
        if (p !== undefined) p.until = time.monotonicMs();
      }
      return true;
    },
    sendBinary: () => undefined,
  };
  const queue: BrowserToNode[] = [];
  let frame = 0;
  const pumping = setInterval(pumpTts, 1);
  await session.start(link, hello());
  clearInterval(pumping);
  const quiet = new Int16Array(FRAME);
  const phases: string[] = [];
  let afterEnd = 0;
  const resumes: string[] = [];
  for (let i = 0; i < Math.ceil(900_000 / TICK_MS); i++) {
    time.advance(TICK_MS);
    session.handleBinary(encodeAudioFrame({ audio_frame: frame, mic: quiet, sys: quiet }));
    frame += FRAME;
    for (const m of queue.splice(0)) session.handleJson(m);
    for (const [id, p] of playing) {
      if (time.monotonicMs() < p.until) continue;
      playing.delete(id);
      session.handleJson({ type: 'playback.ended', audio_playback_id: id, generation: p.generation, reason: 'completed', samples_written: (PLAY_MS * 16000) / 1000, samples_discarded: 0, audio_frame: frame, client_t_ms: 0, output_latency_ms: { value: 0 } } as BrowserToNode);
    }
    session.tick();
    for (let k = 0; k < 3; k++) await new Promise((r) => setImmediate(r));
    pumpTts();
    // 研究用の設定は計画の待ちの上限で止まる（pause）。研究者の resume で続ける。
    if (session.directorState.woz_paused && i % 50 === 0) {
      resumes.push(session.handleWoz({ type: 'research.woz', woz_id: `w${i}`, action: 'resume', point_id: null, operator: 'test', client_wall_clock: '2026-01-01T00:00:00.000Z' }).status);
    }
    const phase = session.directorState.phase;
    if (phases.at(-1) !== phase) phases.push(phase);
    // end の後は撤回（end_of_session なら話してから）の記録まで進める。
    if (phase === 'end' && (events.events.some((e) => e.event === 'two_ai.retraction') || ++afterEnd > 3000)) break;
  }
  await session.close('test_end');
  return { session, events, sent, phases, resumes };
}

describe('TwoAiSession の一通り（偽のプロバイダ）', () => {
  it.each(['respond_at_end', 'respond_on_spot'] as const)('%s：end まで進み、tick の失敗と契約の違反がない', async (condition) => {
    const { session, events, sent, phases } = await run(condition);
    expect(session.counters.tick_errors).toBe(0);
    expect(phases).toEqual(['intake', 'discussion', 'response', 'next_step', 'end']);
    const names = new Set(events.events.map((e) => e.event));
    for (const n of ['two_ai.phase_changed', 'two_ai.sync_mark', 'two_ai.turn', 'two_ai.board', 'two_ai.retraction']) expect(names.has(n as never), n).toBe(true);
    const marks = events.ofType('two_ai.sync_mark' as never) as unknown as { seq: number; trigger: string }[];
    expect(marks.map((m) => m.seq)).toEqual(marks.map((_, i) => i + 1));
    expect(marks[0]!.trigger).toBe('intake');
    expect(marks.at(-1)!.trigger).toBe('end');
    const retraction = events.ofType('two_ai.retraction' as never) as unknown as { timing: string; lines: unknown[]; ai_id: string | null; played_ms: { value: number | null } }[];
    expect(retraction).toHaveLength(1);
    // demo_short は end_of_session：撤回の文を話してから出す。
    expect(retraction[0]).toMatchObject({ timing: 'end_of_session' });
    expect(retraction[0]!.lines.length).toBeGreaterThan(0);
    expect(retraction[0]!.ai_id).not.toBeNull();
    expect(retraction[0]!.played_ms.value).toBeGreaterThan(0);
    // 2 体の発話の再生は 2 つの声に分かれ、playback.begin に ai_id が載る。
    const begins = sent.filter((m) => m.type === 'playback.begin') as { ai_id?: string }[];
    expect(new Set(begins.map((b) => b.ai_id))).toEqual(new Set(['A', 'B']));
    expect(sent.some((m) => m.type === 'server.hello' && (m as { mode?: string }).mode === 'two_ai')).toBe(true);
  }, 120_000);

  it('研究用の設定（after_measures）：撤回の文は話さず、end に入ったとき文とハッシュだけを記録する', async () => {
    const { session, events, sent, phases, resumes } = await run('respond_at_end', 'config/two_ai/session.ja.json');
    // 計画の待ちで止まったとき（実時間の早さによる）は resume が通る。
    expect(resumes.every((r) => r === 'applied' || r === 'rejected')).toBe(true);
    expect(session.counters.tick_errors).toBe(0);
    expect(phases.at(-1)).toBe('end');
    const retraction = events.ofType('two_ai.retraction' as never) as unknown as { timing: string; trigger: string; lines: unknown[]; ai_id: string | null; script_sha256: string }[];
    expect(retraction).toHaveLength(1);
    expect(retraction[0]).toMatchObject({ timing: 'after_measures', trigger: 'end', ai_id: null });
    expect(retraction[0]!.lines.length).toBeGreaterThan(0);
    const begins = sent.filter((m) => m.type === 'playback.begin') as { turn_kind?: string }[];
    expect(begins.some((b) => b.turn_kind === 'retraction')).toBe(false);
  }, 180_000);
});
