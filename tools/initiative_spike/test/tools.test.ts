/** 実行器の試験。LLM の判断は試していない。 */
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ManualTimeSource, MemoryEventSink, ResearchEvent, createEventEmitter } from '@llm-vap/contracts';
import { ScriptedReplyLlm } from '../../../apps/orchestrator/src/app/scripted';
import { InitiativeWiring, NO_CANDIDATE_SPEECH } from '../../../apps/orchestrator/src/session/initiative_wiring';
import { StableTranscriptView } from '../../../apps/orchestrator/src/cognition/initiative/transcript_view';
import { CallBudget, CallBudgetExceeded } from '../lib/call_budget';
import { textFromEvent } from '../lib/gemini_thin';
import { HANDWRITTEN_PROVIDER, generateHandwrittenAsr } from '../lib/handwritten';
import { injectMisrecognition } from '../lib/inject';
import { ROOT, loadPersona, loadPolicy, loadScenarios, readSttJsonl, scenarioText, sttPath } from '../lib/project';
import { replayStt } from '../lib/replay';
import { buildEvalCsv, matchesHypothesis, summarizeRun } from '../lib/report_core';
import type { RawEvent } from '../lib/report_core';
import { GoogleResponseMapper } from '../lib/stt_events';
import { parseWav, toPcm16kMono } from '../lib/wav';

const TEXT = '予算は百万円です。出展料は五十万円なんですね。\n残りで装飾をやります。';

describe('素材', () => {
  it('手書きの素材は契約に合い、実 ASR でないと明記している', () => {
    const scenarios = loadScenarios();
    for (const s of scenarios) {
      if (s.expected.outcome === 'not_applicable_until_g3') continue;
      const events = readSttJsonl(sttPath('handwritten', s.id));
      expect(events.every((e) => e.provider.startsWith(HANDWRITTEN_PROVIDER))).toBe(true);
      for (const e of events) expect(ResearchEvent.safeParse(e).success).toBe(true);
    }
  });

  it('読み上げる台本は 30〜60 秒の長さ', () => {
    for (const s of loadScenarios()) {
      if (!s.text) continue;
      const chars = s.text.replace(/\s/g, '').length;
      // 実測の根拠はなく、話す速さ毎秒 4〜6.5 文字の目安。
      expect(chars / 6.5).toBeGreaterThanOrEqual(25);
      expect(chars / 4).toBeLessThanOrEqual(65);
    }
  });

  it('台本は手順書に全文を載せている', () => {
    const doc = readFileSync(join(ROOT, 'docs', 'initiative_spike.md'), 'utf8');
    for (const s of loadScenarios()) {
      if (!s.text || s.handwritten_only) continue;
      for (const line of s.text.split('\n')) expect(doc).toContain(line);
    }
  });

  it('全部の台本で persona を読める', () => {
    for (const s of loadScenarios()) expect(loadPersona(s).persona_id.length).toBeGreaterThan(0);
  });

  it('手書きの素材は実測と同じく 0.9 の範囲が伸び縮みし、最後は全文になる', () => {
    const events = generateHandwrittenAsr(TEXT, 's', 0.8);
    const lengths = events.filter((e) => e.event === 'stt.interim').map((e) => e.stable_text.length);
    expect(lengths.some((len, i) => i > 0 && len < (lengths[i - 1] as number))).toBe(true);
    const view = new StableTranscriptView({ min_stability: 0.8 });
    for (const e of events) view.apply(e);
    expect(view.snapshot().map((s) => s.stable_text).join('\n')).toBe(TEXT);
    expect(view.totalRewrites()).toBe(0);
  });
});

describe('誤認の注入', () => {
  const spec = { correct: '五十万円', wrong: '五千万円', hold_ms: 2500 };
  const base = () => generateHandwrittenAsr(TEXT, 's', 0.8, { revision_interval_ms: 100 });

  it('unstable: 誤った語は 0.9 の部分に入らず、モデルに渡る安定テキストにも入らない', () => {
    const events = injectMisrecognition(base(), { ...spec, stage: 'unstable' }, 0.8);
    expect(events.some((e) => e.unstable_text.includes('五千万円'))).toBe(true);
    expect(events.some((e) => e.stable_text.includes('五千万円'))).toBe(false);
    const view = new StableTranscriptView({ min_stability: 0.8 });
    for (const e of events) {
      view.apply(e);
      expect(view.snapshot().map((s) => s.stable_text).join('')).not.toContain('五千万円');
    }
  });

  it('stable: 誤った語が一度安定に入り、後で書き換わる', () => {
    const events = injectMisrecognition(base(), { ...spec, stage: 'stable', hold_ms: 4000 }, 0.8);
    const view = new StableTranscriptView({ min_stability: 0.8 });
    let seen = false;
    for (const e of events) {
      view.apply(e);
      seen ||= view.snapshot().map((s) => s.stable_text).join('').includes('五千万円');
    }
    expect(seen).toBe(true);
    expect(view.totalRewrites()).toBeGreaterThan(0);
    expect(view.snapshot().map((s) => s.stable_text).join('')).not.toContain('五千万円');
  });

  it('語が見つからなければ分かるように失敗する', () => {
    expect(() => injectMisrecognition(base(), { ...spec, correct: '存在しない', stage: 'stable' }, 0.8)).toThrow(/見つかりません/);
  });

  it('注入したことを provider に残す', () => {
    const events = injectMisrecognition(base(), { ...spec, stage: 'stable' }, 0.8);
    expect(events.every((e) => e.provider.includes('injected_misrecognition'))).toBe(true);
  });
});

describe('リプレイ', () => {
  it('記録の時刻どおりに、順番を変えずに流す（仮想時刻）', async () => {
    const events = generateHandwrittenAsr(TEXT, 's', 0.8);
    const time = new ManualTimeSource();
    const seen: number[] = [];
    await replayStt(events, {
      time,
      waitUntil: async (t) => {
        time.set(Math.max(t, time.monotonicMs()));
      },
      onEvent: (e) => {
        seen.push(e.transcript_revision);
        expect(time.monotonicMs()).toBe(e.t_monotonic_ms);
      },
    });
    expect(seen).toEqual(events.map((e) => e.transcript_revision));
  });
});

describe('本実装の経路でのリプレイ（run_replay.ts と同じ部品。LLM は台本で、判断は試していない）', () => {
  it('手書きの素材を InitiativeWiring に流すと、プロバイダの llm.* から集計でき、入力の区間も読める', async () => {
    const scenario = loadScenarios().find((s) => s.id === 'C2')!;
    const source = readSttJsonl(sttPath('handwritten', 'C2'));
    const time = new ManualTimeSource();
    const sink = new MemoryEventSink();
    const emitter = createEventEmitter({ time, session_id: 's', condition: () => 'initiative_no_cue', sink });
    const wiring = new InitiativeWiring({
      llm: new ScriptedReplyLlm({ time, emitter, first_delta_delay_ms: 0, delta_delay_ms: 0, chars_per_delta: 100_000 }),
      persona: loadPersona(scenario),
      policy: loadPolicy(),
      emitter,
      time,
      speech: () => NO_CANDIDATE_SPEECH,
      trigger: { min_new_stable_chars: 40, min_new_chars_at_boundary: null },
    });
    await replayStt(source, {
      time,
      waitUntil: async (t) => {
        time.set(Math.max(t, time.monotonicMs()));
      },
      onEvent: (e) => {
        wiring.onStt(e);
      },
    });
    await wiring.monitor.finishInput();
    const events = sink.events as unknown as RawEvent[];
    const summary = summarizeRun(events, time.monotonicMs());
    expect(summary.llm_requests).toBeGreaterThan(1);
    expect(summary.llm_requests).toBe(wiring.monitor.requestCount());
    expect(summary.rows.every((r) => r.decision === 'NONE' && r.gate === 'not_applicable')).toBe(true);
    expect(summary.rows[0]?.stable_input).toMatch(/^#\d+ /);
    expect(summary.rows[0]?.output.decision).toBe('NONE');
    // 台本の LLM は cost.usage を出さず、monitor も出さない（二重計上しない）。
    expect(sink.ofType('cost.usage')).toHaveLength(0);
  });
});

describe('Google の応答の写像', () => {
  const ctx = { session_id: 's', provider: 'google_stt_v2', model_version: 'long', stream_id: 'stream_1', min_stability: 0.8, wall_origin_ms: 0 };
  it('interim は安定と未安定に分かれ、final で区間が進み、stability 0 は未設定として扱う', () => {
    const mapper = new GoogleResponseMapper(ctx);
    const [a] = mapper.map(
      [
        { text: '国があなたの', is_final: false, stability: 0.9, end_ms: 1000, words: [] },
        { text: 'ために', is_final: false, stability: 0.01, end_ms: 1000, words: [] },
      ],
      1100,
      1100,
    );
    expect(a).toMatchObject({ event: 'stt.interim', stable_text: '国があなたの', unstable_text: 'ために', asr_segment_id: 0, audio_frame_end: 16000 });
    const [b] = mapper.map([{ text: '国があなたのために。', is_final: true, stability: 0, end_ms: 2000, words: [{ word: '国', start_ms: 0, end_ms: 200 }] }], 2100, 2100);
    expect(b).toMatchObject({ event: 'stt.final', stable_text: '国があなたのために。', stability: { value: null }, asr_segment_id: 0, words: { value: [{ text: '国', audio_frame_start: 0, audio_frame_end: 3200 }] } });
    const [c] = mapper.map([{ text: '次', is_final: false, stability: 0.01, end_ms: 2500, words: [] }], 2600, 2600);
    expect(c).toMatchObject({ asr_segment_id: 1, asr_segment_frame_start: 32000, transcript_revision: 3 });
    for (const e of [a, b, c]) expect(ResearchEvent.safeParse(e).success).toBe(true);
  });
  it('resultEndOffset がなければ送信位置を使い、精度を下げて記録する', () => {
    const mapper = new GoogleResponseMapper(ctx);
    const [a] = mapper.map([{ text: 'あ', is_final: false, stability: 0.01, end_ms: null, words: [] }], 500, 480);
    expect(a).toMatchObject({ audio_frame_end: 7680, timing_precision: 'arrival_minus_rtt' });
  });
});

describe('WAV', () => {
  function wav(format: number, bits: number, rate: number, channels: number, samples: number[]): Buffer {
    const bytes = bits / 8;
    const data = Buffer.alloc(samples.length * bytes);
    samples.forEach((v, i) => {
      if (format === 3) data.writeFloatLE(v, i * 4);
      else if (bits === 16) data.writeInt16LE(v, i * 2);
      else if (bits === 24) data.writeIntLE(v, i * 3, 3);
      else data.writeInt32LE(v, i * 4);
    });
    const head = Buffer.alloc(44);
    head.write('RIFF', 0);
    head.writeUInt32LE(36 + data.length, 4);
    head.write('WAVEfmt ', 8);
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(format, 20);
    head.writeUInt16LE(channels, 22);
    head.writeUInt32LE(rate, 24);
    head.writeUInt16LE(bits, 34);
    head.write('data', 36);
    head.writeUInt32LE(data.length, 40);
    return Buffer.concat([head, data]);
  }
  it('16bit 16kHz モノラルはそのまま', () => {
    const { info, data } = parseWav(wav(1, 16, 16000, 1, [100, -100, 200]));
    expect([...new Int16Array(new Uint8Array(toPcm16kMono(info, data)).buffer)]).toEqual([100, -100, 200]);
  });
  it('24bit と 32bit 浮動小数のステレオ 48kHz を 16kHz モノラルへ', () => {
    const left24 = 256 * 1000;
    const a = parseWav(wav(1, 24, 48000, 2, Array(12).fill(left24)));
    expect(toPcm16kMono(a.info, a.data).readInt16LE(0)).toBe(1000);
    const b = parseWav(wav(3, 32, 48000, 2, Array(12).fill(0.5)));
    expect(toPcm16kMono(b.info, b.data).readInt16LE(0)).toBe(16384);
    expect(toPcm16kMono(b.info, b.data).length).toBe(4);
  });
  it('WAV でなければ案内できる形で失敗する', () => {
    expect(() => parseWav(Buffer.from('ftypM4A not a wav file'))).toThrow(/WAV 形式ではありません/);
  });
});

describe('評価シートと集計', () => {
  const events: RawEvent[] = [
    { event: 'stt.final', t_monotonic_ms: 0, text: '全文' },
    { event: 'llm.request', t_monotonic_ms: 100, request_id: 'r1', sent_at: 100, input: { segments: [{ asr_segment_id: 0, stable_text: '予算' }] } },
    { event: 'llm.response', t_monotonic_ms: 900, request_id: 'r1', received_at: 900, output: { source: 'model_output', value: { decision: 'NEW', evidence_span: '予算', reason: '理由"あり' } } },
    { event: 'initiative.decision', t_monotonic_ms: 900, request_id: 'r1', decision: 'NEW', candidate_id: 'c_1' },
    { event: 'llm.request', t_monotonic_ms: 1000, request_id: 'r2', sent_at: 1000, input: { segments: [] } },
    { event: 'llm.response', t_monotonic_ms: 2000, request_id: 'r2', received_at: 2000, output: { source: 'model_output', value: { decision: 'NEW', evidence_span: '無' } } },
    { event: 'initiative.discarded', t_monotonic_ms: 2000, reason: 'evidence_too_short' },
    { event: 'llm.request', t_monotonic_ms: 2100, request_id: 'r3', sent_at: 2100, input: { segments: [] } },
    { event: 'llm.response', t_monotonic_ms: 3000, request_id: 'r3', received_at: 3000, output: { source: 'model_output', value: { decision: 'WITHDRAW', target_candidate_id: 'c_1' } } },
    { event: 'initiative.decision', t_monotonic_ms: 3000, request_id: 'r3', decision: 'WITHDRAW', candidate_id: 'c_1' },
  ];
  const summary = summarizeRun(events, 2500);

  it('モデルの NEW、ゲートの棄却、撤回を分けて数える', () => {
    expect(summary).toMatchObject({ llm_requests: 3, model_new: 2, gate_rejected_new: 1, new_during_speech: 1, withdrawn_by_model: 1, active_at_end: 0 });
    expect(summary.latency_ms).toEqual([800, 1000, 900]);
    expect(summary.rows[2]?.after_speech_end).toBe(true);
  });

  it('持続の確認を入れた場合の事後計算', () => {
    expect(summary.hold[0]).toMatchObject({ next_decision: 'WITHDRAW', cue_avoided: true, added_delay_ms: null });
  });

  it('仮説との一致を機械的に比べる', () => {
    expect(matchesHypothesis('no_candidate_or_withdrawn', summary)).toBe(true);
    expect(matchesHypothesis('no_candidate', summary)).toBe(false);
    expect(matchesHypothesis('not_applicable_until_g3', summary)).toBeNull();
  });

  it('評価シートは3つの評価欄を別の列にして空で出す', () => {
    const csv = buildEvalCsv([{ scenario: 'C2', asr_origin: '実ASR', model: 'm', prompt_version: 'v', summary, full_text: '全文' }]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const [header, first] = csv.slice(1).split('\r\n');
    expect(header).toContain('"【評価】内容の妥当性","【評価】今申し出る必要性","【評価】待機・撤回の妥当性"');
    expect(first?.endsWith('"","","",""')).toBe(true);
    expect(first).toContain('理由""あり');
  });
});

describe('呼び出し回数の上限', () => {
  it('上限に達したら例外で止め、回をまたいで数える', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'budget-')), 'ledger.json');
    const a = new CallBudget(path, 2);
    a.consume('x');
    expect(new CallBudget(path, 2).used()).toBe(1);
    a.consume('x');
    expect(() => new CallBudget(path, 2).consume('x')).toThrow(CallBudgetExceeded);
  });
});

describe('Gemini の応答の取り出し', () => {
  it('step.delta の text だけを連結対象にする', () => {
    expect(textFromEvent({ event_type: 'step.delta', delta: { type: 'text', text: '{}' } })).toBe('{}');
    expect(textFromEvent({ event_type: 'step.delta', delta: { type: 'thought', text: 'x' } })).toBe('');
    expect(textFromEvent({ event_type: 'interaction.completed' })).toBe('');
  });
});

describe('設定', () => {
  it('policy.ja.json の initiative 節はスキーマに合い、スパイクが読む値は未校正でない', () => {
    const { initiative } = loadPolicy();
    expect(initiative.max_new_stable_chars_since_input).not.toBeNull();
    expect(initiative.max_result_age_ms).not.toBeNull();
    expect(initiative.min_stability).toBe(0.8);
    expect(scenarioText(loadScenarios().find((s) => s.id === 'C3a')!, loadScenarios())).toContain('五十万円');
  });
});

describe('二段判定の集計', () => {
  const model = (value: unknown) => ({ source: 'model_output', value });
  const req = (id: string, t: number) => ({ event: 'llm.request', t_monotonic_ms: t, request_id: id, purpose: 'initiative', sent_at: t, input: { messages: [{ text: '#0（確定）: 入力の文' }] } });
  const res = (id: string, t: number, o: Record<string, unknown>) => ({ event: 'llm.response', t_monotonic_ms: t, request_id: id, purpose: 'initiative', received_at: t, output: model({ text: JSON.stringify(o) }) });
  const stage = (event: string, id: string, t: number, fields: Record<string, unknown>) => ({ event, t_monotonic_ms: t, request_id: id, gate: { source: 'verified', value: { passed: true, reasons: [] } }, ledger_reason: { value: null }, ...fields });
  const events = [
    req('ini_0001', 100),
    res('ini_0001', 500, { desire: 'NEW', proposed_utterance: '発話案' }),
    stage('initiative.desire', 'ini_0001', 501, { desire: 'NEW', outcome: 'registered', candidate_id: { value: 'c_0001' } }),
    req('ini_0001_timing', 501),
    res('ini_0001_timing', 900, { timing: 'WAIT_FOR_TURN_END', why_now: '' }),
    stage('initiative.timing', 'ini_0001_timing', 901, { timing_strategy: 'llm', timing: 'WAIT_FOR_TURN_END', outcome: 'kept', candidate_id: 'c_0001' }),
    req('ini_0002', 1000),
    res('ini_0002', 1400, { desire: 'NEW', proposed_utterance: '棄却の案' }),
    stage('initiative.desire', 'ini_0002', 1401, { desire: 'NEW', outcome: 'gate_rejected', candidate_id: { value: null }, gate: { source: 'verified', value: { passed: false, reasons: ['evidence_not_found'] } } }),
    req('ini_0002_timing', 1500),
    res('ini_0002_timing', 1800, { timing: 'WITHDRAW' }),
    stage('initiative.timing', 'ini_0002_timing', 1801, { timing_strategy: 'llm', timing: 'WITHDRAW', outcome: 'withdrawn', candidate_id: 'c_0001' }),
  ];
  const summary = summarizeRun(events, 10_000);

  it('生成段とタイミング段を別の行にして、判定の値と受け付けの結果を読む', () => {
    expect(summary.rows.map((r) => [r.request_id, r.stage, r.decision, r.gate])).toEqual([
      ['ini_0001', 'desire', 'NEW', 'passed'],
      ['ini_0001_timing', 'timing', 'WAIT_FOR_TURN_END', 'passed'],
      ['ini_0002', 'desire', 'NEW', 'rejected'],
      ['ini_0002_timing', 'timing', 'WITHDRAW', 'passed'],
    ]);
    expect(summary.rows[2]?.gate_reasons).toContain('evidence_not_found');
    expect(summary.model_new).toBe(2);
    expect(summary.gate_rejected_new).toBe(1);
    expect(summary.withdrawn_by_model).toBe(1);
    expect(summary.active_at_end).toBe(0);
  });

  it('評価シートのタイミング段の行に同じ起動の発話案と段を出す', () => {
    const csv = buildEvalCsv([{ scenario: 'C2', asr_origin: 'a', model: 'm', prompt_version: 'v', summary, full_text: '全文' }]);
    const line = csv.split('\r\n').find((l) => l.includes('"ini_0001_timing"'));
    expect(line).toContain('"timing"');
    expect(line).toContain('"発話案"');
  });
});
