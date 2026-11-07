import { absent, modelOutput, modelOutputAbsent, present, verified, type ResearchEvent } from '@llm-vap/contracts';
import { describe, expect, it } from 'vitest';
import {
  candidateTimeline,
  computeLatencyReport,
  latencyStat,
  quantile,
  type LatencyRow,
} from '../../src/logging';
import { BROWSER, envelope } from './helpers';

function row(rows: LatencyRow[], id: string, breakdown: string | null = null): LatencyRow {
  const found = rows.find((r) => r.id === id && r.breakdown === breakdown);
  if (found === undefined) throw new Error(`no row ${id} ${breakdown}`);
  return found;
}

function health(frame: number, t: number, basis = BROWSER): ResearchEvent {
  const missing = absent('x');
  return envelope(
    {
      event: 'audio.health',
      reporter: 'browser',
      audio_frame: frame,
      frames_lost: 0,
      underrun_count: 0,
      underrun_total_ms: 0,
      stale_pcm_frames_dropped: 0,
      latency: {
        base_latency_ms: missing,
        output_latency_ms: missing,
        output_timestamp_context_ms: missing,
        output_timestamp_performance_ms: missing,
      },
      track_settings: {
        echoCancellation: missing,
        noiseSuppression: missing,
        autoGainControl: missing,
        sampleRate: missing,
        channelCount: missing,
        deviceId: missing,
      },
      system_ch_source: 'written',
      audio_context_state: 'running',
      visibility: 'visible',
    },
    t,
    basis,
  );
}

function stt(
  t: number,
  text: string,
  frameEnd: number,
  options: { asr?: number; event?: string; precision?: string } = {},
): ResearchEvent {
  return envelope(
    {
      event: options.event ?? 'stt.interim',
      text,
      stable_text: text,
      unstable_text: '',
      parts: [{ text, stability: present(0.9) }],
      segment_id: 1,
      asr_segment_id: options.asr ?? 1,
      asr_segment_frame_start: 0,
      transcript_revision: 1,
      stability: present(0.9),
      stability_source: 'provider',
      audio_frame_end: frameEnd,
      timing_precision: options.precision ?? 'result_end_offset',
      words: absent('x'),
      stream_id: 's',
      provider: 'p',
      model_version: 'm',
    },
    t,
  );
}

function decision(
  candidate: string,
  span: string,
  sentAt: number,
  decidedAt: number,
  options: { valid?: boolean; ids?: number[] } = {},
): ResearchEvent {
  return envelope(
    {
      event: 'initiative.decision',
      decision: 'NEW',
      segment_id: 1,
      transcript_revision: 1,
      request_id: 'r',
      sent_at: sentAt,
      received_at: decidedAt,
      model_version: 'm',
      candidate_id: candidate,
      candidate_version: 1,
      intent_type: modelOutput('x'),
      evidence_span: modelOutput(span),
      reason: modelOutput('x'),
      why_now: modelOutputAbsent('x'),
      cost_of_waiting: modelOutputAbsent('x'),
      proposed_utterance: modelOutput('x'),
      expiry_policy: modelOutput('x'),
      urgency: modelOutput('x'),
      evidence_valid: verified(options.valid ?? true, 'm'),
      evidence_segment_ids: verified(options.ids ?? [1], 'm'),
      decided_at: decidedAt,
    },
    decidedAt,
  );
}

function signalStarted(candidate: string, startedAt: number | null, basis = BROWSER, phase = 'inhale'): ResearchEvent {
  const common = { event: 'signal.started', candidate_id: candidate, phase, parameters: {} };
  return startedAt === null
    ? envelope({ ...common, visible: false, started_at: null, null_reason: 'tab_not_visible' }, 0, basis)
    : envelope({ ...common, visible: true, started_at: startedAt }, startedAt, basis);
}

function speechStarted(candidate: string, startedAt: number, basis = BROWSER, outputLatency: number | null = 30): ResearchEvent {
  return envelope(
    {
      event: 'speech.started',
      origin: 'candidate',
      candidate_id: candidate,
      candidate_version: 1,
      audio_playback_id: 1,
      audio_frame: 0,
      started_at: startedAt,
      first_pcm_written_at: startedAt - 30,
      output_latency_ms: outputLatency === null ? absent('unknown') : present(outputLatency),
    },
    startedAt,
    basis,
  );
}

function fullChain(candidate = 'c1'): ResearchEvent[] {
  return [
    health(16000, 1000), // frame 16000 = 1000ms
    stt(1300, '話の', 18000),
    stt(1500, '話の根拠です', 20000), // frame 20000 = 1250ms
    decision(candidate, '根拠', 1600, 2400),
    signalStarted(candidate, 2600),
    speechStarted(candidate, 4000),
  ];
}

describe('quantile', () => {
  it('線形補間（numpy の既定と同じ）', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 10);
    expect(quantile([10], 0.95)).toBe(10);
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe('latencyStat', () => {
  it('標本がなければ 0 でなく unmeasured', () => {
    const stat = latencyStat([]);
    expect(stat).toEqual({ status: 'unmeasured', n: 0, reason: 'no_samples_in_log', excluded: {} });
    expect('p50' in stat).toBe(false);
  });

  it('全件除外なら理由を残す', () => {
    const stat = latencyStat([], { endpoint_clock_uncorrected: 2 });
    expect(stat.status).toBe('unmeasured');
    expect(stat).toMatchObject({ reason: 'all_excluded:endpoint_clock_uncorrected' });
  });

  it('負の値を捨てずに数える', () => {
    const stat = latencyStat([
      { ms: -5, uncertainty_ms: 1 },
      { ms: 10, uncertainty_ms: 2 },
    ]);
    expect(stat).toMatchObject({ status: 'measured', n: 2, min: -5, negative_count: 1, uncertainty_ms_max: 2 });
  });

  it('誤差が不明な標本があれば誤差の最大を null にする', () => {
    const stat = latencyStat([
      { ms: 1, uncertainty_ms: null },
      { ms: 2, uncertainty_ms: 2 },
    ]);
    expect(stat).toMatchObject({ uncertainty_ms_max: null });
  });
});

describe('computeLatencyReport', () => {
  it('イベントが何もなくても §3.6 の全区間を未計測として出す', () => {
    const { rows } = computeLatencyReport([]);
    for (const id of [
      'content_evidence_to_transcript',
      'content_evidence_to_decision',
      'content_evidence_to_speech',
      'transcript_to_decision',
      'decision_to_breath',
      'breath_to_speech',
      'decision_to_speech',
    ]) {
      expect(rows.some((r) => r.id === id)).toBe(true);
    }
    for (const r of rows) expect(r.stat.status).toBe('unmeasured');
    expect(rows.filter((r) => r.breakdown === 'official:posthoc_alignment')).toHaveLength(3);
  });

  it('連鎖のすべてを別々の実測時刻から計算する', () => {
    const { rows, timeline } = computeLatencyReport(fullChain());
    expect(timeline[0]).toMatchObject({
      candidate_id: 'c1',
      content_evidence_precision: 'result_end_offset',
      transcript: { status: 'measured', t_ms: 1500 },
      decision_at: { status: 'measured', t_ms: 2400 },
      cue_at: { status: 'measured', t_ms: 2600 },
      speech_at: { status: 'measured', t_ms: 4000 },
    });
    expect(timeline[0]?.content_evidence_online).toMatchObject({ t_ms: 1250 });
    const online = 'online:result_end_offset';
    expect(row(rows, 'content_evidence_to_transcript', online).stat).toMatchObject({ status: 'measured', p50: 250 });
    expect(row(rows, 'content_evidence_to_decision', online).stat).toMatchObject({ p50: 1150 });
    expect(row(rows, 'content_evidence_to_speech', online).stat).toMatchObject({ p50: 2750 });
    expect(row(rows, 'transcript_to_decision').stat).toMatchObject({ p50: 900 });
    expect(row(rows, 'decision_to_breath').stat).toMatchObject({ p50: 200 });
    expect(row(rows, 'breath_to_speech').stat).toMatchObject({ p50: 1400 });
    expect(row(rows, 'decision_to_speech').stat).toMatchObject({ p50: 1600 });
  });

  it('正式な t_content_evidence はオンラインの近似と混ぜず、事後整列がなければ未計測', () => {
    const { rows } = computeLatencyReport(fullChain());
    expect(row(rows, 'content_evidence_to_decision', 'official:posthoc_alignment').stat).toMatchObject({
      status: 'unmeasured',
      reason: 'posthoc_alignment_not_in_log',
    });
  });

  it('精度の区分を分けて集計する', () => {
    const events = [
      health(16000, 1000),
      stt(1500, 'aaa', 20000, { asr: 1, precision: 'result_end_offset' }),
      decision('c1', 'aaa', 1600, 2000, { ids: [1] }),
      stt(1700, 'bbb', 20000, { asr: 2, precision: 'word_offset', event: 'stt.final' }),
      decision('c2', 'bbb', 1800, 2000, { ids: [2] }),
    ];
    const { rows } = computeLatencyReport(events);
    expect(row(rows, 'content_evidence_to_decision', 'online:result_end_offset').stat).toMatchObject({ n: 1, p50: 750 });
    expect(row(rows, 'content_evidence_to_decision', 'online:word_offset').stat).toMatchObject({ n: 1, p50: 750 });
  });

  it('補正されていないブラウザの時刻を区間に入れない（追補2）', () => {
    const orchestrator = { source: 'orchestrator' as const, uncertainty_ms: present(0) };
    const events = [
      ...fullChain().slice(0, 4),
      signalStarted('c1', 2600, orchestrator),
      speechStarted('c1', 4000, orchestrator),
    ];
    const { rows } = computeLatencyReport(events);
    expect(row(rows, 'decision_to_breath').stat).toMatchObject({
      status: 'unmeasured',
      excluded: { endpoint_clock_uncorrected: 1 },
    });
    expect(row(rows, 'decision_to_speech').stat.status).toBe('unmeasured');
    // 補正のいらない区間は残る
    expect(row(rows, 'transcript_to_decision').stat.status).toBe('measured');
  });

  it('補正の誤差を両端の和で出す', () => {
    const { rows } = computeLatencyReport(fullChain());
    expect(row(rows, 'decision_to_breath').stat).toMatchObject({ uncertainty_ms_max: 2 });
    expect(row(rows, 'breath_to_speech').stat).toMatchObject({ uncertainty_ms_max: 4 });
  });

  it('音声位置の基準点がなければ t_content_evidence は未計測で、他は残る', () => {
    const { rows } = computeLatencyReport(fullChain().slice(1));
    expect(row(rows, 'content_evidence_to_transcript', 'online:result_end_offset').stat).toMatchObject({
      status: 'unmeasured',
      excluded: { no_audio_frame_time_anchor: 1 },
    });
    expect(row(rows, 'transcript_to_decision').stat.status).toBe('measured');
  });

  it('補正のない audio.health を基準点にしない', () => {
    const orchestrator = { source: 'orchestrator' as const, uncertainty_ms: present(0) };
    const events = [health(16000, 1000, orchestrator), ...fullChain().slice(1)];
    const { timeline } = computeLatencyReport(events);
    expect(timeline[0]?.content_evidence_online).toMatchObject({ reason: 'no_audio_frame_time_anchor' });
  });

  it('遠すぎる基準点を使わない', () => {
    const { timeline } = computeLatencyReport([health(16000 * 100, 1000), ...fullChain().slice(1)]);
    expect(timeline[0]?.content_evidence_online).toMatchObject({ reason: 'audio_frame_anchor_too_far' });
  });

  it('句読点の違いを無視して span を探す', () => {
    const events = [health(16000, 1000), stt(1500, '話の、根拠。です', 20000), decision('c1', '根拠です', 1600, 2000)];
    expect(candidateTimeline(events)[0]?.transcript).toMatchObject({ t_ms: 1500 });
  });

  it('根拠の区間以外の同じ語に当たらない', () => {
    const events = [
      health(16000, 1000),
      stt(1100, '根拠', 17000, { asr: 1 }),
      stt(1500, '根拠', 20000, { asr: 2 }),
      decision('c1', '根拠', 1600, 2000, { ids: [2] }),
    ];
    expect(candidateTimeline(events)[0]?.transcript).toMatchObject({ t_ms: 1500 });
  });

  it('区間をまたぐ span を見つける', () => {
    const events = [
      health(16000, 1000),
      stt(1100, '前半の', 17000, { asr: 1, event: 'stt.final' }),
      stt(1500, '後半の話', 20000, { asr: 2 }),
      decision('c1', 'の後半', 1600, 2000, { ids: [1, 2] }),
    ];
    expect(candidateTimeline(events)[0]?.transcript).toMatchObject({ t_ms: 1500 });
  });

  it('LLM に送ったあとの revision を根拠の時刻にしない', () => {
    const events = [health(16000, 1000), stt(1700, '根拠', 20000), decision('c1', '根拠', 1600, 2000)];
    expect(candidateTimeline(events)[0]?.transcript).toMatchObject({
      status: 'unmeasured',
      reason: 'evidence_span_not_found_in_stt',
    });
  });

  it('根拠の検証が不合格の候補は根拠の区間に入れず、理由を残す', () => {
    const events = [health(16000, 1000), stt(1500, '根拠', 20000), decision('c1', '根拠', 1600, 2000, { valid: false })];
    const { rows } = computeLatencyReport(events);
    expect(row(rows, 'transcript_to_decision').stat).toMatchObject({
      status: 'unmeasured',
      excluded: { evidence_invalid: 1 },
    });
  });

  it('背景タブの合図は除外し、理由を残す', () => {
    const events = [...fullChain().slice(0, 4), signalStarted('c1', null), speechStarted('c1', 4000)];
    const { rows } = computeLatencyReport(events);
    expect(row(rows, 'decision_to_breath').stat).toMatchObject({
      status: 'unmeasured',
      excluded: { signal_not_visible: 1 },
    });
    expect(row(rows, 'decision_to_speech').stat.status).toBe('measured');
  });

  it('出力遅延が不明な発話は t_speech_start の定義を満たさないので除外する', () => {
    const events = [...fullChain().slice(0, 5), speechStarted('c1', 4000, BROWSER, null)];
    const { rows } = computeLatencyReport(events);
    expect(row(rows, 'decision_to_speech').stat).toMatchObject({
      status: 'unmeasured',
      excluded: { output_latency_unknown: 1 },
    });
  });

  it('撤回されて話さなかった候補は除外に数えない', () => {
    const { rows } = computeLatencyReport(fullChain().slice(0, 4));
    expect(row(rows, 'decision_to_speech').stat).toEqual({
      status: 'unmeasured',
      n: 0,
      reason: 'no_samples_in_log',
      excluded: {},
    });
  });

  it('吸気以外の合図を t_breath_start にしない', () => {
    const events = [
      ...fullChain().slice(0, 4),
      signalStarted('c1', 2500, BROWSER, 'pre_speech'),
      signalStarted('c1', 2700, BROWSER, 'inhale'),
    ];
    expect(candidateTimeline(events)[0]?.cue_at).toMatchObject({ t_ms: 2700 });
  });

  it('部品の遅延: LLM の往復は目的ごと、失敗は入れない', () => {
    const response = (purpose: string, sent: number, received: number, ok = true) =>
      envelope({
        event: 'llm.response',
        request_id: 'r',
        purpose,
        output: ok ? modelOutput('x') : modelOutputAbsent('failed'),
        transcript_revision: 1,
        sent_at: sent,
        received_at: received,
        model_version: 'm',
      });
    const { rows } = computeLatencyReport([
      response('initiative', 100, 400),
      response('initiative', 100, 9999, false),
      response('prefetch', 100, 200),
    ]);
    expect(row(rows, 'llm_roundtrip', 'initiative').stat).toMatchObject({ n: 1, p50: 300 });
    expect(row(rows, 'llm_roundtrip', 'prefetch').stat).toMatchObject({ n: 1, p50: 100 });
    expect(row(rows, 'llm_roundtrip', 'completion').stat.status).toBe('unmeasured');
  });

  it('部品の遅延: 音声位置から STT の受信、合図の指示から描画', () => {
    const sent = envelope({
      event: 'signal.sent',
      candidate_id: 'c1',
      phase: 'inhale',
      parameters: {},
      sent_at: 2500,
    });
    const { rows } = computeLatencyReport([...fullChain(), sent]);
    expect(row(rows, 'audio_to_stt_arrival', 'result_end_offset').stat).toMatchObject({ n: 2 });
    expect(row(rows, 'signal_sent_to_first_render').stat).toMatchObject({ n: 1, p50: 100 });
  });
});
