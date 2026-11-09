// 合成のイベントだけを使う。実会話の sessions/ からは何も写さない。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSession, SUSTAINED_SILENCE_MS, type RawEvent } from '../lib/analyze';
import { analyzePaths, resolveEventFiles } from '../lib/load';
import { formatReport, summarize } from '../lib/report';

const CANDIDATE = 'c_0001';
const CUE = 'cue_0001';
const SPAN = 'てすとのこんきょ';

function base(t: number, event: string, fields: Record<string, unknown> = {}): RawEvent {
  return {
    t_monotonic_ms: t,
    event,
    session_id: 's_synth',
    time_basis: { source: 'orchestrator', uncertainty_ms: { value: 0 } },
    ...fields,
  } as RawEvent;
}

/** 16 frame/ms。t=1000ms が frame 16000 になる等間隔の vap.state。speaking(t) で話者を決める。 */
function vapStates(fromMs: number, toMs: number, speaking: (t: number) => boolean): RawEvent[] {
  const states: RawEvent[] = [];
  for (let t = fromMs; t <= toMs; t += 50) states.push(base(t, 'vap.state', { audio_frame: t * 16, user_speaking: speaking(t) }));
  return states;
}

function chain(overrides: {
  sentAt?: number;
  startedAt?: number;
  started?: Record<string, unknown> | null;
  uncertainty?: number;
  speaking?: (t: number) => boolean;
  timing?: RawEvent[] | null;
  extra?: RawEvent[];
} = {}): RawEvent[] {
  const sentAt = overrides.sentAt ?? 6000;
  const startedAt = overrides.startedAt ?? sentAt + 40;
  const timing =
    overrides.timing === undefined
      ? [
          base(4800, 'initiative.timing', {
            candidate_id: CANDIDATE,
            desire_request_id: 'ini_0001',
            timing_strategy: 'llm',
            timing: 'OFFER_NOW',
            sent_at: 4300,
            received_at: 4800,
            latency_ms: 500,
          }),
        ]
      : (overrides.timing ?? []);
  const started =
    overrides.started === null
      ? []
      : [
          {
            ...base(startedAt, 'signal.started', {
              candidate_id: CANDIDATE,
              phase: 'inhale',
              parameters: { cue_id: CUE },
              visible: true,
              started_at: startedAt,
            }),
            time_basis: { source: 'browser_rtt', uncertainty_ms: { value: overrides.uncertainty ?? 2 } },
            ...(overrides.started ?? {}),
          } as RawEvent,
        ];
  return [
    ...vapStates(0, 8000, overrides.speaking ?? (() => true)),
    // audio_frame_end 40000 = 2500ms。受信 2800ms、発話希望の送信 3000ms。
    base(2800, 'stt.interim', { text: SPAN, stable_text: SPAN, unstable_text: '', segment_id: 0, asr_segment_id: 0, audio_frame_end: 40000 }),
    base(3000, 'initiative.desire', {
      request_id: 'ini_0001',
      desire: 'NEW',
      outcome: 'registered',
      candidate_id: { value: CANDIDATE },
      evidence_span: { value: SPAN },
      evidence_segment_ids: { value: { value: [0] } },
      sent_at: 3000,
      received_at: 4200,
      latency_ms: 1200,
    }),
    ...timing,
    base(sentAt, 'signal.sent', { candidate_id: CANDIDATE, phase: 'inhale', parameters: { cue_id: CUE }, sent_at: sentAt }),
    ...started,
    ...(overrides.extra ?? []),
  ];
}

describe('analyzeSession', () => {
  it('区間ごとの値を出す', () => {
    const [row] = analyzeSession(chain());
    expect(row).toMatchObject({ candidate_id: CANDIDATE, cue_id: CUE, timing_strategy: 'llm' });
    const s = row!.sections;
    expect(s.audio_to_asr_est.value_ms).toBeCloseTo(300);
    expect(s.asr_to_desire_sent.value_ms).toBeCloseTo(200);
    expect(s.desire_llm.value_ms).toBeCloseTo(1200);
    expect(s.timing_llm.value_ms).toBeCloseTo(500);
    expect(s.timing_redecision_wait).toEqual({ value_ms: null, null_reason: 'single_timing_decision' });
    expect(s.decision_to_signal_sent.value_ms).toBeCloseTo(1200);
    expect(s.signal_sent_to_render.value_ms).toBeCloseTo(40);
    expect(s.spoken_to_rendered_est.value_ms).toBeCloseTo(3540);
    expect(row!.render.suspect).toBe(false);
  });

  it('タイミング段のない経路は null と理由を返す', () => {
    const [row] = analyzeSession(chain({ timing: null }));
    expect(row!.timing_strategy).toBe('none');
    expect(row!.sections.timing_llm).toEqual({ value_ms: null, null_reason: 'no_timing_event_one_stage_or_missing' });
    expect(row!.sections.decision_to_signal_sent.value_ms).toBeCloseTo(1800);
  });

  it('immediate はタイミング LLM を持たない', () => {
    const [row] = analyzeSession(
      chain({ timing: [base(4300, 'initiative.timing', { candidate_id: CANDIDATE, desire_request_id: 'ini_0001', timing_strategy: 'immediate' })] }),
    );
    expect(row!.timing_strategy).toBe('immediate');
    expect(row!.sections.timing_llm.null_reason).toBe('timing_strategy_immediate_no_llm');
  });

  it('再判定があれば再判定待ちを出す', () => {
    const [row] = analyzeSession(
      chain({
        timing: [
          base(4800, 'initiative.timing', { candidate_id: CANDIDATE, timing_strategy: 'llm', sent_at: 4300, received_at: 4800, latency_ms: 500 }),
          base(5700, 'initiative.timing', { candidate_id: CANDIDATE, timing_strategy: 'llm', sent_at: 5000, received_at: 5700, latency_ms: 700 }),
        ],
      }),
    );
    expect(row!.sections.timing_redecision_wait.value_ms).toBeCloseTo(900);
    expect(row!.sections.decision_to_signal_sent.value_ms).toBeCloseTo(300);
  });

  it('描画の報告がないときは理由を返す', () => {
    const [row] = analyzeSession(chain({ started: null }));
    expect(row!.sections.signal_sent_to_render).toEqual({ value_ms: null, null_reason: 'signal_started_missing' });
    expect(row!.sections.spoken_to_rendered_est.null_reason).toBe('signal_started_missing');
    expect(row!.cue_landing.reference).toBe('signal_sent');
  });

  it('見えなかった描画は理由つきの null', () => {
    const [row] = analyzeSession(chain({ started: { visible: false, started_at: null, null_reason: 'avatar_did_not_apply' } }));
    expect(row!.sections.signal_sent_to_render.null_reason).toBe('not_visible:avatar_did_not_apply');
  });

  it('報告誤差を超えて送信より前の描画は時間軸の異常とし、中央値に入れない', () => {
    const [row] = analyzeSession(chain({ startedAt: 5900, uncertainty: 5 }));
    expect(row!.render.suspect).toBe(true);
    expect(row!.sections.signal_sent_to_render).toEqual({ value_ms: -100, null_reason: 'time_axis_suspect_started_before_sent' });
    expect(row!.cue_landing.reference).toBe('signal_sent');
    const summary = summarize([row!]);
    expect(summary.n_render_suspect).toBe(1);
    expect(summary.sections.signal_sent_to_render.n).toBe(0);
  });

  it('報告誤差の範囲の負の値は異常にしない（クランプもしない）', () => {
    const [row] = analyzeSession(chain({ startedAt: 5981, uncertainty: 5 }));
    expect(row!.render.suspect).toBe(false);
    expect(row!.sections.signal_sent_to_render.value_ms).toBeCloseTo(-19);
  });

  it('根拠が STT に見つからないときは理由を返す（本文は結果に入らない）', () => {
    const events = chain().map((e) => (e.event === 'stt.interim' ? { ...e, text: 'べつのぶんしょう' } : e));
    const [row] = analyzeSession(events as RawEvent[]);
    expect(row!.sections.audio_to_asr_est.null_reason).toBe('evidence_span_not_found_in_stt');
    expect(JSON.stringify(row)).not.toContain(SPAN);
    expect(formatReport([row!], summarize([row!]))).not.toContain(SPAN);
  });

  it('発話希望のイベントがないときは理由を返す', () => {
    const events = chain().filter((e) => e.event !== 'initiative.desire');
    const [row] = analyzeSession(events);
    expect(row!.sections.desire_llm.null_reason).toBe('no_origin_desire_event');
  });

  it('合図が届かなかった候補は数えない', () => {
    expect(analyzeSession(chain().filter((e) => e.event !== 'signal.sent'))).toEqual([]);
  });

  it('話していないところへの描画は続き 0', () => {
    const [row] = analyzeSession(chain({ speaking: (t) => t < 5000 }));
    expect(row!.cue_landing).toMatchObject({ user_speaking: false, continued_ms: 0, ended_by: 'not_speaking_at_reference' });
  });

  it('短い無音は話し止みにしない。持続した無音で話し止み', () => {
    const render = 6040;
    const [row] = analyzeSession(
      chain({
        speaking: (t) => {
          if (t >= 6200 && t < 6400) return false; // 200ms の短い無音
          return t < 7000;
        },
      }),
    );
    expect(row!.cue_landing.user_speaking).toBe(true);
    expect(row!.cue_landing.brief_dips).toBe(1);
    expect(row!.cue_landing.ended_by).toBe('sustained_silence');
    expect(row!.cue_landing.continued_ms).toBeCloseTo(7000 - render);
  });

  it('短い無音の間に stt.final が届いたら話し止みとする', () => {
    const [row] = analyzeSession(
      chain({
        speaking: (t) => !(t >= 6200 && t < 6400) && t < 7900,
        extra: [base(6300, 'stt.final', { text: '', asr_segment_id: 0, stable_text: '', unstable_text: '', audio_frame_end: 100800 })],
      }),
    );
    expect(row!.cue_landing.ended_by).toBe('stt_final_in_dip');
    expect(row!.cue_landing.continued_ms).toBeCloseTo(6200 - 6040);
  });

  it('ログが先に終わったら話し続けた時間は不明', () => {
    const [row] = analyzeSession(chain({ speaking: () => true }));
    expect(row!.cue_landing.continued_ms).toBeNull();
    expect(row!.cue_landing.continued_null_reason).toBe('log_ended_before_sustained_silence');
    expect(SUSTAINED_SILENCE_MS).toBe(700);
  });

  it('vap.state がなければ話していたかは不明', () => {
    const [row] = analyzeSession(chain().filter((e) => e.event !== 'vap.state'));
    expect(row!.cue_landing.user_speaking).toBeNull();
    expect(row!.cue_landing.user_speaking_null_reason).toBe('no_vap_state_before_reference');
    expect(row!.sections.audio_to_asr_est.null_reason).toBe('no_vap_state_for_audio_time');
  });
});

describe('summarize', () => {
  it('中央値と n と null の内訳', () => {
    const rows = [
      ...analyzeSession(chain()),
      ...analyzeSession(chain({ startedAt: 6100 })),
      ...analyzeSession(chain({ started: null })),
    ];
    const summary = summarize(rows);
    expect(summary.n_candidates).toBe(3);
    expect(summary.sections.signal_sent_to_render.n).toBe(2);
    expect(summary.sections.signal_sent_to_render.median_ms).toBeCloseTo(70);
    expect(summary.sections.signal_sent_to_render.null_reasons).toEqual({ signal_started_missing: 1 });
  });
});

describe('パスの解決', () => {
  function makeSessions(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'latency-initiative-'));
    for (const name of ['s_a', 's_b']) {
      mkdirSync(path.join(root, name));
      writeFileSync(path.join(root, name, 'events.jsonl'), chain().map((e) => JSON.stringify(e)).join('\n'));
    }
    return root;
  }

  it('親、セッション、events.jsonl、glob、複数の引数を受ける', async () => {
    const root = makeSessions();
    expect(await resolveEventFiles(root)).toHaveLength(2);
    expect(await resolveEventFiles(path.join(root, 's_a'))).toHaveLength(1);
    expect(await resolveEventFiles(path.join(root, 's_a', 'events.jsonl'))).toHaveLength(1);
    expect(await resolveEventFiles(path.join(root, 's_*'))).toHaveLength(2);
    const { files, rows } = await analyzePaths([path.join(root, 's_a'), path.join(root, 's_b'), root]);
    expect(files).toHaveLength(2);
    expect(rows).toHaveLength(2);
    expect(await resolveEventFiles(path.join(root, 'missing'))).toEqual([]);
  });
});
