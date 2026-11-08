/**
 * 発話希望の遅延の段の集計。イベントは手で作ったもので、実際のセッションの値ではない。
 */
import { describe, expect, it } from 'vitest';
import { present, type ResearchEvent } from '@llm-vap/contracts';
import { computeInitiativeChain } from '../src/initiative_chain';

const basis = { source: 'orchestrator', uncertainty_ms: { value: 0 } };
const browser = { source: 'browser_rtt', uncertainty_ms: { value: 5 } };
const base = (t: number, event: string, extra: Record<string, unknown> = {}, time_basis: unknown = basis) =>
  ({ schema_version: 1, t_monotonic_ms: t, wall_clock: 'x', session_id: 's', condition: 'initiative_inhale', time_basis, event, ...extra }) as unknown as ResearchEvent;

// 16 kHz 枠。audio_frame 1600（100ms）が t=1000 に対応する基準点。
const health = base(1000, 'audio.health', { reporter: 'browser', audio_frame: 16000 }, browser);
const stt = (t: number, rev: number, text: string, stable: string, final = false) =>
  base(t, final ? 'stt.final' : 'stt.interim', { transcript_revision: rev, asr_segment_id: 0, segment_id: 0, text, stable_text: stable, audio_frame_end: 16000 + Math.round((t - 1500 - 1000) * 16) });
const row = (rows: ReturnType<typeof computeInitiativeChain>['rows'], id: string, breakdown: string | null = null) => rows.find((r) => r.id === id && r.breakdown === breakdown);

const events: ResearchEvent[] = [
  health,
  stt(2400, 3, '五十万円', ''),
  stt(2600, 4, '五十万円のまま', '五十万円'),
  base(2605, 'llm.request', { request_id: 'ini_1', purpose: 'initiative', transcript_revision: 4, sent_at: 2605 }),
  base(3800, 'llm.response', { request_id: 'ini_1', purpose: 'initiative', transcript_revision: 4, sent_at: 2605, received_at: 3800, output: { value: '{}', source: 'model' } }),
  base(3801, 'candidate.state_changed', { candidate_id: 'c_0001', candidate_version: 1, from: null, to: 'INTENT_READY', cause_source: 'model_decision', decision: 'NEW', request_id: 'ini_1' }),
  base(3801, 'initiative.decision', { decision: 'NEW', request_id: 'ini_1', decided_at: 3801 }),
  base(3820, 'negotiation.decision', { stage: 'candidate_audio', outcome: 'audio_preparing', candidate_id: present('c_0001'), candidate_version: present(1), reasons: [] }),
  base(3820, 'signal.sent', { candidate_id: 'c_0001', phase: 'inhale', sent_at: 3820, parameters: {} }),
  base(4000, 'negotiation.decision', { stage: 'candidate_audio', outcome: 'audio_ready', candidate_id: present('c_0001'), candidate_version: present(1), reasons: [] }),
  base(3870, 'signal.started', { candidate_id: 'c_0001', phase: 'inhale', visible: true, started_at: 3870, parameters: {} }, browser),
  // NONE の判定（final で起動。AI の開始の後に LLM が返った）。
  stt(5000, 5, '次の文', '次の文', true),
  base(5001, 'llm.request', { request_id: 'ini_2', purpose: 'initiative', transcript_revision: 5, sent_at: 5001 }),
  base(6000, 'llm.response', { request_id: 'ini_2', purpose: 'initiative', transcript_revision: 5, sent_at: 5001, received_at: 6000, output: { value: '{}', source: 'model' } }),
  base(6000, 'initiative.decision', { decision: 'NONE', request_id: 'ini_2' }),
];

describe('initiative chain', () => {
  const report = computeInitiativeChain(events);

  it('全判定を起動の種類と結果つきで数える', () => {
    expect(report.judgements).toEqual({ total: 2, by_trigger: { final: 1, interim: 1, unknown: 0 }, outcomes: { NEW: 1, NONE: 1 } });
  });

  it('各段の値（n つき）。起動ごとの内訳も出す', () => {
    expect(row(report.rows, 'trigger_to_response')?.stat).toMatchObject({ status: 'measured', n: 2, max: 1195 });
    expect(row(report.rows, 'trigger_to_response', 'trigger:final')?.stat).toMatchObject({ status: 'measured', n: 1, max: 999 });
    expect(row(report.rows, 'asr_to_trigger')?.stat).toMatchObject({ status: 'measured', n: 2 });
    // 起動の revision の audio_frame_end の時刻（フレーム 16000+1600 → 2500+…）から受信まで: 手で作った値で 1500ms 遅れに固定。
    expect(row(report.rows, 'audio_to_asr')?.stat).toMatchObject({ status: 'measured', p50: 1500 });
    expect(row(report.rows, 'asr_stable_wait')?.stat).toMatchObject({ status: 'measured', max: 200 });
    expect(row(report.rows, 'response_to_record')?.stat).toMatchObject({ status: 'measured', n: 1, p50: 1 });
    expect(row(report.rows, 'record_to_cue_sent')?.stat).toMatchObject({ status: 'measured', p50: 19 });
    expect(row(report.rows, 'cue_sent_to_render')?.stat).toMatchObject({ status: 'measured', p50: 50 });
    expect(row(report.rows, 'tts_prepare')?.stat).toMatchObject({ status: 'measured', p50: 180 });
    expect(row(report.rows, 'cue_sent_to_audio_ready')?.stat).toMatchObject({ status: 'measured', p50: 180 });
    expect(row(report.rows, 'audio_to_render')?.stat).toMatchObject({ status: 'measured', n: 1 });
  });

  it('測れない段は 0 にせず理由を返す（候補も合図もないログ）', () => {
    const none = computeInitiativeChain(events.filter((e) => e.event !== 'candidate.state_changed' && e.event !== 'signal.sent'));
    expect(row(none.rows, 'record_to_cue_sent')?.stat).toMatchObject({ status: 'unmeasured', n: 0, reason: 'no_samples_in_log' });
    expect(row(none.rows, 'tts_prepare')?.stat).toMatchObject({ status: 'measured' }); // 音声は別の経路で測れる
  });

  it('時計が補正されていない描画の報告は標本に入れない（負値を作らない）', () => {
    const uncorrected = computeInitiativeChain(
      events.map((e) => (e.event === 'signal.started' ? ({ ...e, time_basis: basis } as ResearchEvent) : e)),
    );
    expect(row(uncorrected.rows, 'cue_sent_to_render')?.stat).toMatchObject({ status: 'unmeasured', excluded: { endpoint_clock_uncorrected: 1 } });
  });

  it('二段判定: 生成段を判定1回に数え、タイミング段の LLM は判定に数えない。未知の項目があっても読む', () => {
    const staged: ResearchEvent[] = [
      base(1000, 'audio.health', { reporter: 'browser', audio_frame: 16000 }, browser),
      stt(2600, 7, '話の続き', ''),
      base(2605, 'llm.request', { request_id: 'desire_1', purpose: 'initiative', transcript_revision: 7, sent_at: 2605 }),
      base(3000, 'llm.response', { request_id: 'desire_1', purpose: 'initiative', transcript_revision: 7, sent_at: 2605, received_at: 3000, output: { value: '{}', source: 'model' } }),
      base(3001, 'initiative.desire', { request_id: 'desire_1', desire: 'NEW', outcome: 'registered', received_at: 3001, future_field: 1 }),
      base(3002, 'llm.request', { request_id: 'timing_1', purpose: 'initiative', transcript_revision: 7, sent_at: 3002 }),
      base(3200, 'initiative.timing', { request_id: 'timing_1', desire_request_id: 'desire_1', timing_strategy: 'llm', timing: 'OFFER_NOW', received_at: 3200, outcome: 'kept', future_field: 2 }),
    ];
    const report = computeInitiativeChain(staged);
    expect(report.judgements.total).toBe(1);
    expect(report.judgements.outcomes).toEqual({ NEW: 1, 'timing:OFFER_NOW': 1 });
  });
});
