// I2 の純関数とバッファ（時系列、添字の向き、取消・空振り率、候補、メモ、制御メッセージ）。
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Policy, ResearchEvent, type EventDraft, type EventEmitter } from '@llm-vap/contracts';
import { handleResearchMessage, researchConfigMessage } from '../../../orchestrator/src/ws/research_channel';
import { CandidateTracker } from '../../src/research/candidates_view';
import { createFakeEventScript } from '../../src/research/fake_events';
import { createFakeFeed, type FeedSink } from '../../src/research/feed';
import { OutcomeTracker } from '../../src/research/rates';
import { ResearchDashboard } from '../../src/research/ResearchDashboard';
import { splitByAiIndex, splitVad, TimelineBuffer } from '../../src/research/timeline';
import { ResearchViewStore } from '../../src/research/view_store';

const WS = { kind: 'ws', label: 'ws', synthetic: false } as const;

function ev(t: number, draft: Record<string, unknown>, session = 's1'): ResearchEvent {
  return ResearchEvent.parse({
    schema_version: 1,
    t_monotonic_ms: t,
    wall_clock: '2026-11-08T00:00:00.000Z',
    session_id: session,
    condition: 'reactive',
    time_basis: { source: 'orchestrator', uncertainty_ms: { value: 0 } },
    ...draft,
  });
}

function vap(t: number, aiNow: number, user: boolean, session = 's1'): ResearchEvent {
  return ev(
    t,
    {
      event: 'vap.state',
      t,
      audio_frame: t * 16,
      model_variant: 'jp_kyoto',
      inference_ms: 10,
      raw: {},
      channel_layout: '2ch',
      p_now: [1 - aiNow, aiNow],
      p_future: [0.4, 0.6],
      vad: [user ? 0.9 : 0.1, 0.2],
      user_speaking: user,
      system_speaking: false,
    },
    session,
  );
}

function speech(kind: 'speech.started' | 'speech.ended' | 'speech.interrupted', id: number, start: number, end: number, origin: 'response' = 'response') {
  const base = { audio_playback_id: id, audio_frame: 0, started_at: start, first_pcm_written_at: start, output_latency_ms: { value: 0 }, origin };
  if (kind === 'speech.started') return ev(start, { event: kind, ...base });
  const fin = { ...base, spoken_text: 'x', spoken_text_precision: 'time_proportional', samples_written: 1 };
  if (kind === 'speech.ended') return ev(end, { event: kind, ...fin, ended_at: end });
  return ev(end, { event: kind, ...fin, interrupted_at: end, stop_point: 'immediate', decision_source: 'vap' });
}

function prefetch(kind: 'prefetch.started' | 'prefetch.ready' | 'prefetch.cancelled', id: number, t: number) {
  return ev(t, {
    event: kind,
    segment_id: 1,
    transcript_revision: 1,
    audio_playback_id: id,
    similarity: { value: null, null_reason: 'first' },
    similarity_method: 'x',
    model_version: 'm',
    ...(kind === 'prefetch.cancelled' ? { cancel_reason: 'superseded' } : {}),
  });
}

function fakeStore(): ResearchViewStore {
  const store = new ResearchViewStore({ kind: 'fake', label: 'fake', synthetic: true });
  for (const e of createFakeEventScript()) store.event(e);
  return store;
}

afterEach(() => vi.useRealTimers());

describe('p の添字の向き', () => {
  it('p_ai_index に従って AI と利用者を選ぶ', () => {
    expect(splitByAiIndex([0.2, 0.8], 1)).toEqual({ ai: 0.8, user: 0.2 });
    expect(splitByAiIndex([0.2, 0.8], 0)).toEqual({ ai: 0.2, user: 0.8 });
  });

  it('vad は p_ai_index に関係なく [0]=利用者（mic）、[1]=AI（sys）', () => {
    expect(splitVad([0.9, 0.1])).toEqual({ ai: 0.1, user: 0.9 });
  });

  it('orchestrator の向きは方策から作り、ja も hri2025 も実測の 1', () => {
    for (const file of ['config/policy.ja.json', 'config/policy.hri2025.json']) {
      const policy = Policy.parse(JSON.parse(readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8')));
      expect(researchConfigMessage(policy, 'reactive')).toMatchObject({ type: 'research.config', p_ai_index: 1, direction_status: 'measured' });
    }
  });

  it('向きを受けるまでは仮定と表示し、受けたら orchestrator の値を使う', () => {
    const store = new ResearchViewStore(WS);
    expect(store.snapshot().direction).toMatchObject({ p_ai_index: 1, source: 'assumed' });
    const html = renderToStaticMarkup(createElement(ResearchDashboard, { snapshot: store.snapshot() }));
    expect(html).toContain('向きを受けていないので');
    store.event({ type: 'research.config', policy_id: 'ja', p_ai_index: 0, direction_status: 'provisional', condition: 'reactive' });
    expect(store.snapshot().direction).toEqual({ p_ai_index: 0, source: 'orchestrator', policy_id: 'ja', direction_status: 'provisional' });
    expect(renderToStaticMarkup(createElement(ResearchDashboard, { snapshot: store.snapshot() }))).toContain('AI = p[0]（ch1）');
  });

  it('契約に合わない制御メッセージは数えて適用しない', () => {
    const store = new ResearchViewStore(WS);
    store.event({ type: 'research.config', p_ai_index: 2 });
    expect(store.snapshot().invalid).toBe(1);
    expect(store.snapshot().direction.source).toBe('assumed');
  });
});

describe('TimelineBuffer', () => {
  it('窓より古いものを捨て、右端は最新の時刻', () => {
    const buffer = new TimelineBuffer(10_000);
    for (let t = 0; t <= 30_000; t += 80) buffer.add(vap(t, 0.5, false));
    const view = buffer.view();
    expect(view.now_ms).toBe(30_000);
    expect(view.vap[0]!.t).toBeGreaterThanOrEqual(20_000);
    expect(view.vap.every((s, i, a) => i === 0 || a[i - 1]!.t <= s.t)).toBe(true);
  });

  it('遅れて届いた値も時刻順に入る', () => {
    const buffer = new TimelineBuffer();
    buffer.add(vap(1000, 0.5, false));
    buffer.add(vap(1160, 0.5, false));
    buffer.add(vap(1080, 0.5, false));
    expect(buffer.view().vap.map((s) => s.t)).toEqual([1000, 1080, 1160]);
  });

  it('利用者の発話は user_speaking の連続、AI の発話は speech の開始から終わり', () => {
    const buffer = new TimelineBuffer();
    buffer.add(vap(0, 0.2, false));
    buffer.add(vap(100, 0.2, true));
    buffer.add(vap(200, 0.2, true));
    buffer.add(vap(300, 0.8, false));
    buffer.add(speech('speech.started', 7, 400, 0));
    buffer.add(vap(500, 0.8, true));
    let view = buffer.view();
    expect(view.user_speech).toEqual([{ start: 100, end: 300 }, { start: 500, end: null }]);
    expect(view.ai_speech).toEqual([{ start: 400, end: null, audio_playback_id: 7, origin: 'response', outcome: 'speaking' }]);
    buffer.add(speech('speech.interrupted', 7, 400, 650));
    view = buffer.view();
    expect(view.ai_speech[0]).toMatchObject({ end: 650, outcome: 'interrupted' });
    expect(view.marks).toEqual([{ t: 650, kind: 'interrupt', label: '割り込みで停止（vap）' }]);
  });

  it('開始を受けずに終わりだけ届いたら、終わりのイベントの started_at から描く', () => {
    const buffer = new TimelineBuffer();
    buffer.add(speech('speech.ended', 3, 100, 900));
    expect(buffer.view().ai_speech).toEqual([{ start: 100, end: 900, audio_playback_id: 3, origin: 'response', outcome: 'ended' }]);
  });

  it('turn.allowed は次の判定までの段差で、古い区間を捨ててもいまの状態は残す', () => {
    const buffer = new TimelineBuffer(1000);
    const allowed = (t: number, v: boolean) =>
      ev(t, {
        event: 'turn.allowed', turn_allowed: v, invitation: { detected: false }, user_speaking: false,
        p_now: { value: 0.6 }, p_future: { value: 0.6 }, completion_p: { value: null, null_reason: 'x' },
        completion_revision: { value: null, null_reason: 'x' }, gap_ms: { value: 1 }, priority: { value: null, null_reason: 'x' },
        policy_id: 'ja', decision_source: 'vap', vap_freshness: 'fresh', fallback_energy: { value: null, null_reason: 'x' }, reason: 'r',
      });
    buffer.add(allowed(0, true));
    buffer.add(allowed(100, false));
    buffer.add(vap(5000, 0.5, false));
    const view = buffer.view();
    expect(view.turn_allowed).toEqual([{ start: 100, end: null, allowed: false, source: 'vap' }]);
  });

  it('偽の列から 60 秒窓の図の素材ができる', () => {
    const view = fakeStore().snapshot().live.timeline;
    expect(view.window_ms).toBe(60_000);
    expect(view.vap.length).toBeGreaterThan(400);
    expect(view.ai_speech.map((s) => s.outcome)).toEqual(['ended', 'ended', 'interrupted', 'ended']);
    // I1 の素材の 1100〜6200 と、I2 の 4 区間
    expect(view.user_speech).toHaveLength(5);
    expect(view.marks.filter((m) => m.kind === 'interrupt')).toHaveLength(1);
    expect(view.marks.filter((m) => m.kind === 'gaze')).toHaveLength(5);
  });
});

describe('OutcomeTracker', () => {
  it('何もなければ未計測と理由（0% にしない）', () => {
    const t = new OutcomeTracker();
    expect(t.prepareStats().cancel_rate).toEqual({ status: 'unmeasured', reason: 'no_prefetch' });
    expect(t.prepareStats().miss_rate).toEqual({ status: 'unmeasured', reason: 'no_ready_prefetch' });
    expect(t.interruptStats().interrupt_rate).toEqual({ status: 'unmeasured', reason: 'no_ai_speech' });
  });

  it('進行中の準備は分母に入れない', () => {
    const t = new OutcomeTracker();
    t.add(prefetch('prefetch.started', 1, 0));
    t.add(prefetch('prefetch.ready', 1, 10));
    expect(t.prepareStats()).toMatchObject({ started: 1, in_progress: 1, cancel_rate: { status: 'unmeasured', reason: 'no_settled_prefetch' } });
  });

  it('取消率は取消 / 決着、空振り率は合成済みで取消 / 合成済みで決着', () => {
    const t = new OutcomeTracker();
    // 1: 合成して再生、2: 合成して取消（空振り）、3: 合成前に取消
    for (const id of [1, 2, 3]) t.add(prefetch('prefetch.started', id, id));
    t.add(prefetch('prefetch.ready', 1, 10));
    t.add(prefetch('prefetch.ready', 2, 10));
    t.add(speech('speech.started', 1, 20, 0));
    t.add(prefetch('prefetch.cancelled', 2, 30));
    t.add(prefetch('prefetch.cancelled', 3, 30));
    // 開始を受けていない取消は数えない
    t.add(prefetch('prefetch.cancelled', 99, 30));
    const stats = t.prepareStats();
    expect(stats.cancel_rate).toEqual({ status: 'measured', numerator: 2, denominator: 3, rate: 2 / 3 });
    expect(stats.miss_rate).toEqual({ status: 'measured', numerator: 1, denominator: 2, rate: 0.5 });
    expect(stats.unmatched).toBe(1);
    expect(stats.cancel_reasons).toEqual({ superseded: 2 });
  });

  it('偽の列: 取消 2/5、空振り 1/4、割り込み 1/4', () => {
    const live = fakeStore().snapshot().live;
    expect(live.prepare.cancel_rate).toMatchObject({ numerator: 2, denominator: 5 });
    expect(live.prepare.miss_rate).toMatchObject({ numerator: 1, denominator: 4 });
    expect(live.interrupts).toMatchObject({ ai_speech_started: 4, interrupted: 1, by_decision_source: { vap: 1 } });
  });
});

describe('CandidateTracker', () => {
  it('モデル出力と実測・検証を別の欄にし、新しい順に並べる', () => {
    const summary = fakeStore().snapshot().live.candidates;
    expect(summary.decisions.map((d) => d.decision)).toEqual(['WITHDRAW', 'REVISE', 'NEW', 'NONE', 'NEW']);
    const neu = summary.decisions.find((d) => d.decision === 'NEW' && d.candidate_id === 'fake_candidate_2')!;
    expect(neu.measured).toEqual({ sent_at: 25100, received_at: 25950, llm_ms: 850, decision_time: { name: 'decided_at', t_ms: 26000 } });
    expect(neu.model.find((m) => m.label === '理由')?.value).toBe('偽: LLM が書いた理由の例');
    expect(neu.verified.find((v) => v.label === '根拠の検証')?.value).toBe('不合格');
    // 終わった候補は「いま」の欄に出さない
    expect(summary.current).toEqual([]);
    expect(summary.state_changes[0]).toMatchObject({ to: 'WITHDRAWN', cause: { source: 'model_decision', decision: 'WITHDRAW' } });
  });

  it('何もなければ空の表示', () => {
    expect(new CandidateTracker().summary()).toEqual({ decisions: [], state_changes: [], current: [], counts: {}, discarded: 0, aborted: 0 });
    const html = renderToStaticMarkup(createElement(ResearchDashboard, { snapshot: new ResearchViewStore(WS).snapshot() }));
    expect(html).toContain('data-testid="candidates-empty"');
    expect(html).toContain('vap.state 未受信');
    expect(html).toContain('未計測（prefetch.started なし）');
    expect(html).toContain('未計測（AI の発話なし）');
  });

  it('画面では理由文を「LLM 生成」と明示する', () => {
    const html = renderToStaticMarkup(createElement(ResearchDashboard, { snapshot: fakeStore().snapshot() }));
    expect(html.match(/LLM 生成/g)?.length).toBe(5);
    expect(html).toContain('実測（orchestrator の時計, ms）');
    expect(html).toContain('data-testid="wave4-placeholder"');
  });
});

describe('セッション', () => {
  it('セッションが変わったら I2 の表示を作り直す', () => {
    const store = new ResearchViewStore(WS);
    store.event(speech('speech.started', 1, 10, 0));
    store.event(JSON.parse(JSON.stringify(vap(20, 0.5, false, 's2'))));
    const live = store.snapshot().live;
    expect(live.session_id).toBe('s2');
    expect(live.interrupts.ai_speech_started).toBe(0);
  });
});

describe('研究者のメモ', () => {
  const message = { type: 'research.note', note_id: 'n1', text: 'メモ', client_wall_clock: '2026-11-08T00:00:00.000Z' } as const;

  it('Node の受け口: セッションがあれば research.note を emit して logged を返す', () => {
    const drafts: EventDraft[] = [];
    const emitter = { emit: (d: EventDraft) => (drafts.push(d), d) } as unknown as EventEmitter;
    expect(handleResearchMessage(JSON.stringify(message), { session_id: 's1', emitter })).toEqual({
      type: 'research.note.ack', note_id: 'n1', status: 'logged', session_id: 's1',
    });
    expect(drafts).toEqual([{ event: 'research.note', note_id: 'n1', text: 'メモ', client_wall_clock: message.client_wall_clock }]);
  });

  it('Node の受け口: セッションなし、JSON でない、契約に合わないを区別する', () => {
    expect(handleResearchMessage(JSON.stringify(message), null)).toMatchObject({ status: 'no_session', note_id: 'n1' });
    expect(handleResearchMessage('{', null)).toMatchObject({ status: 'invalid', note_id: null, detail: 'not_json' });
    expect(handleResearchMessage(JSON.stringify({ ...message, text: '   ' }), null)).toMatchObject({ status: 'invalid', note_id: 'n1' });
    expect(handleResearchMessage(JSON.stringify({ ...message, extra: 1 }), null)).toMatchObject({ status: 'invalid' });
  });

  it('画面: 送信中 → ack で記録済み、research.note イベントで時刻つき', () => {
    const store = new ResearchViewStore({ ...WS, send: () => true });
    store.noteSubmitted(message, true);
    expect(store.snapshot().notes[0]).toMatchObject({ status: 'sending' });
    store.event({ type: 'research.note.ack', note_id: 'n1', status: 'logged', session_id: 's1' });
    expect(store.snapshot().notes[0]).toMatchObject({ status: 'logged', session_id: 's1', logged_at_ms: null });
    store.event(ev(1234, { event: 'research.note', note_id: 'n1', text: 'メモ', client_wall_clock: message.client_wall_clock }));
    expect(store.snapshot().notes).toEqual([expect.objectContaining({ status: 'logged', logged_at_ms: 1234, detail: null })]);
    expect(store.snapshot().can_send_notes).toBe(true);
  });

  it('画面: 送れなかったメモと、セッションなしの ack は記録されていないと出す', () => {
    const store = new ResearchViewStore({ ...WS, send: () => false });
    store.noteSubmitted(message, false);
    store.noteSubmitted({ ...message, note_id: 'n2' }, true);
    store.event({ type: 'research.note.ack', note_id: 'n2', status: 'no_session', detail: 'no_active_session' });
    const html = renderToStaticMarkup(createElement(ResearchDashboard, { snapshot: store.snapshot(), onSendNote: () => ({ ok: true }) }));
    expect(html).toContain('送れませんでした');
    expect(html).toContain('記録されていません（セッションなし）');
  });

  it('送信口のないデータ源では入力欄を無効にする', () => {
    const html = renderToStaticMarkup(createElement(ResearchDashboard, { snapshot: new ResearchViewStore(WS).snapshot() }));
    expect(html).toContain('data-testid="note-disabled"');
  });

  it('偽の口は research.config を最初に流し、メモは保存せずセッションなしで返す', () => {
    vi.useFakeTimers();
    const values: unknown[] = [];
    const sink: FeedSink = { event: (v) => values.push(v), malformed: () => undefined, connection: () => undefined };
    const feed = createFakeFeed({ stepMs: 10 });
    const stop = feed.start(sink);
    expect(values[0]).toMatchObject({ type: 'research.config', p_ai_index: 1 });
    expect(feed.send?.(message)).toBe(true);
    vi.advanceTimersByTime(5);
    expect(values).toContainEqual(expect.objectContaining({ type: 'research.note.ack', status: 'no_session' }));
    vi.advanceTimersByTime(10_000);
    expect(values.filter((v) => (v as { event?: string }).event === 'vap.state').length).toBeGreaterThan(400);
    stop();
  });
});
