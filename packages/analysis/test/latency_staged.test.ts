/**
 * 二段判定の生成段（initiative.desire）を候補の連鎖の起点に読む試験。値は合成で、実測ではない。
 */
import { describe, expect, it } from 'vitest';
import type { ResearchEvent } from '@llm-vap/contracts';
import { candidateTimeline, isLatencyRelevant } from '../src/latency';

const event = (name: string, t: number, fields: Record<string, unknown>) =>
  ({ event: name, t_monotonic_ms: t, time_basis: { source: 'orchestrator', uncertainty_ms: { value: 0 } }, ...fields }) as unknown as ResearchEvent;

const stt = event('stt.final', 100, { asr_segment_id: 1, text: '予算は五十万円です', audio_frame_end: 1600, timing_precision: 'result_end_offset' });
const desire = (outcome: string, t: number, candidate: string | null = 'c_0001') =>
  event('initiative.desire', t, {
    desire: 'NEW',
    outcome,
    candidate_id: { value: candidate },
    evidence_span: { source: 'model_output', value: '五十万円' },
    evidence_segment_ids: { value: { source: 'verified', value: [1], method: 'm' } },
    gate: { source: 'verified', value: { passed: true, reasons: [] }, method: 'm' },
    sent_at: 200,
    received_at: 600,
  });

describe('candidateTimeline と二段判定', () => {
  it('registered を候補の起点にし、判定の時刻は応答の受信', () => {
    const [row] = candidateTimeline([stt, desire('registered', 601)]);
    expect(row).toMatchObject({ candidate_id: 'c_0001', decision_at: { status: 'measured', t_ms: 600 }, transcript: { status: 'measured', t_ms: 100 } });
  });

  it('held_promoted の判定の時刻は候補にした時刻', () => {
    expect(candidateTimeline([stt, desire('held_promoted', 900)])[0]).toMatchObject({ decision_at: { status: 'measured', t_ms: 900 } });
  });

  it('候補にならなかった生成段は起点にしない', () => {
    expect(candidateTimeline([stt, desire('gate_rejected', 601, null), desire('rejected', 700, null), desire('revised', 800)])).toEqual([]);
  });

  it('生成段のイベントを分析の対象に数える', () => {
    expect(isLatencyRelevant(desire('registered', 1))).toBe(true);
  });
});
