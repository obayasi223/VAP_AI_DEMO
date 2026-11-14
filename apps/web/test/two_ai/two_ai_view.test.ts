import { describe, expect, it } from 'vitest';
import {
  createTwoAiFakeEventScript,
  FAKE_TWO_AI_RESEARCH_CONFIG,
  fakeTwoAiBoard,
  fakeTwoAiInterjection,
  fakeTwoAiPoint,
  fakeTwoAiSuggestion,
  wrapTwoAiEvent as e,
} from '../../src/research/fake_events';
import { createJsonlFeed, type FeedSink } from '../../src/research/feed';
import { ResearchViewStore } from '../../src/research/view_store';

const present = (value: number) => ({ value });

function storeWith(events: unknown[], now = () => 0): ResearchViewStore {
  const store = new ResearchViewStore({ kind: 'ws', label: 'ws', synthetic: false, send: () => true }, { now });
  for (const event of events) store.event(event);
  return store;
}

function twoAi(store: ResearchViewStore) {
  const snap = store.snapshot();
  expect(snap.invalid, snap.last_invalid ?? '').toBe(0);
  const view = snap.two_ai;
  if (view === null) throw new Error('two_ai view missing');
  return view;
}

describe('two_ai_view', () => {
  it('1 対 1 のイベントだけなら null', () => {
    const store = new ResearchViewStore({ kind: 'ws', label: 'ws', synthetic: false });
    store.event({ type: 'research.config', policy_id: 'p', p_ai_index: 1, direction_status: 'measured', condition: 'reactive' });
    expect(store.snapshot().two_ai).toBeNull();
  });

  it('research.config の mode だけでも出る（設定の欄を使える）', () => {
    const view = twoAi(storeWith([FAKE_TWO_AI_RESEARCH_CONFIG]));
    expect(view.session_id).toBeNull();
    expect(view.session_running).toBe(false);
  });

  it('点の状態の遷移と接触秒数（イベントの値のまま）', () => {
    const base = [e(0, fakeTwoAiPoint('scheduled'))];
    expect(twoAi(storeWith(base)).points[0]?.state).toBe('予定');
    const started = [...base, e(10, fakeTwoAiPoint('started'))];
    expect(twoAi(storeWith(started)).points[0]?.state).toBe('話し中');
    const elab = [...started, e(20, fakeTwoAiPoint('elaboration', { elaborated_turns: 1 }))];
    expect(twoAi(storeWith(elab)).points[0]).toMatchObject({ state: '展開中', elaborated_turns: 1 });
    const done = [
      ...elab,
      e(30, fakeTwoAiPoint('completed', { exposure_total_ms: present(12345), exposure_new_ms: present(11111), elaborated_turns: 2 })),
    ];
    expect(twoAi(storeWith(done)).points[0]).toMatchObject({ state: '済み', exposure_total_ms: 12345, exposure_new_ms: 11111 });
    const switched = [
      ...elab,
      e(40, {
        event: 'two_ai.script', stage: 'switched', point_id: 'f1', trigger: 'woz_researcher', reason: 'researcher_confirmed', decided_at: 40,
        timing: 'in_window', asr_segment_ids: [], invalidated_turn_ids: [], replaced_point_turn_ids: [], resume_dropped: true, uptake_turn_id: null,
      }),
    ];
    expect(twoAi(storeWith(switched)).points[0]).toMatchObject({ state: '訂正後の台本へ切り替え', switched: true });
  });

  it('割り込みの行：① は止めた遅れと結果、② は記録のみ', () => {
    const on = twoAi(
      storeWith([
        e(100, fakeTwoAiInterjection('ij_1', 'onset')),
        e(400, fakeTwoAiInterjection('ij_1', 'stopped', { latency_ms: present(300) })),
      ]),
    );
    expect(on.interjections[0]).toMatchObject({ interjection_id: 'ij_1', stop_latency_ms: 300, logged_only: false, interrupted_ai: 'B' });
    expect(on.counts.stopped).toBe(1);
    const at = twoAi(
      storeWith([
        e(100, fakeTwoAiInterjection('ij_2', 'onset'), { condition: 'respond_at_end' }),
        e(150, fakeTwoAiInterjection('ij_2', 'ignored_by_condition'), { condition: 'respond_at_end' }),
      ]),
    );
    expect(at.interjections[0]?.logged_only).toBe(true);
    expect(at.counts).toMatchObject({ stopped: 0, logged_only: 1 });
  });

  it('設定済みの条件と使った条件が違えば警告', () => {
    const store = storeWith([
      { ...FAKE_TWO_AI_RESEARCH_CONFIG, two_ai_armed: { arm_id: 'arm_1', condition: 'respond_at_end', script_id: 's1', interjection_feeds_generation: null } },
      e(0, fakeTwoAiPoint('scheduled'), { condition: 'respond_on_spot' }),
    ]);
    const view = twoAi(store);
    expect(view.armed?.condition).toBe('respond_at_end');
    expect(view.condition_used).toBe('respond_on_spot');
    expect(view.warnings.join()).toContain('違います');
  });

  it('段の行、板（伏せ字は空のまま）、印の件数', () => {
    const view = twoAi(
      storeWith([
        e(100, { event: 'two_ai.stage', discussion_stage: 1, edge: 'started', heading: '見出し1', turn_id: 't1', content_elapsed_ms: 0, discussion_elapsed_ms: 100 }),
        e(900, { event: 'two_ai.stage', discussion_stage: 1, edge: 'ended', heading: '見出し1', turn_id: null, content_elapsed_ms: 800, discussion_elapsed_ms: 900 }),
        e(200, fakeTwoAiBoard(1, 'building', [{ id: 'c1', text: '', ended: false }])),
        e(300, fakeTwoAiBoard(2, 'building', [{ id: 'c1', text: '見えるカード', ended: true }, { id: 'c2', text: '', ended: false }], 'revealed')),
        ...[1, 2, 3].map((i) =>
          e(400 + i, { event: 'two_ai.marker', marker_id: `mk_${i}`, client_t_ms: 400, discussion_stage: 1, ai_speaking: 'A', turn_id: null, turn_kind: null, during_point_id: null, played_ms_in_turn: { value: null, null_reason: 'x' }, content_elapsed_ms: { value: null, null_reason: 'x' }, user_speaking: false, interjection_id: null, counted: i !== 3, handling: 'recorded_only' }),
        ),
      ]),
    );
    expect(view.stages[0]).toMatchObject({ heading: '見出し1', started_at_ms: 100, ended_at_ms: 900, content_end_ms: 800 });
    expect(view.board?.version).toBe(2);
    expect(view.board?.cards.map((c) => [c.text, c.redacted])).toEqual([['見えるカード', false], ['', true]]);
    expect(view.markers).toMatchObject({ total: 3, counted: 2, by_stage: { '段 1': 2 } });
  });

  it('判定の保留の行：残り時間（推定）と補助の判定の 4 状態', () => {
    const hold = [
      e(1000, fakeTwoAiInterjection('ij_1', 'onset')),
      e(2000, fakeTwoAiInterjection('ij_1', 'correction_wait')),
      e(3500, fakeTwoAiPoint('started')),
    ];
    const pending = twoAi(storeWith(hold)).hold;
    expect(pending).toMatchObject({ point_id: 'f1', remaining_ms: 4500, assist: 'pending' });
    expect(twoAi(storeWith([...hold, e(3600, fakeTwoAiSuggestion('done', true))])).hold?.assist).toBe('yes');
    expect(twoAi(storeWith([...hold, e(3600, fakeTwoAiSuggestion('done', false))])).hold?.assist).toBe('no');
    expect(twoAi(storeWith([...hold, e(3600, fakeTwoAiSuggestion('failed', null))])).hold?.assist).toBe('failed');
    // 前の割り込みの提案は使わない
    expect(twoAi(storeWith([e(500, fakeTwoAiSuggestion('done', true)), ...hold])).hold?.assist).toBe('pending');
    // 研究者の「訂正でない」で resume → 行が消える
    expect(twoAi(storeWith([...hold, e(4000, fakeTwoAiInterjection('ij_1', 'resumed'))])).hold).toBeNull();
    // 上限を過ぎても 0 で止まる
    expect(twoAi(storeWith([...hold, e(20000, fakeTwoAiPoint('started'))])).hold?.remaining_ms).toBe(0);
  });

  it('WoZ の ack で行が更新され、3 秒で応答なし', () => {
    let now = 0;
    const store = storeWith([FAKE_TWO_AI_RESEARCH_CONFIG], () => now);
    const woz = (id: string) => ({ type: 'research.woz' as const, woz_id: id, action: 'stop' as const, point_id: null, operator: 'r', client_wall_clock: '2026-01-01T00:00:00.000Z' });
    store.wozSubmitted(woz('w1'), true);
    store.wozSubmitted(woz('w2'), true);
    store.event({ type: 'research.woz.ack', woz_id: 'w1', status: 'applied', detail: 'ok', phase: 'discussion' });
    now = 3500;
    const rows = twoAi(store).woz;
    expect(rows.find((r) => r.woz_id === 'w1')?.status).toBe('applied');
    expect(rows.find((r) => r.woz_id === 'w2')?.status).toBe('no_response');
  });

  it('JSONL と WS で同じ結果', () => {
    const script = createTwoAiFakeEventScript();
    const ws = storeWith(script);
    const jsonlStore = new ResearchViewStore({ kind: 'ws', label: 'ws', synthetic: false, send: () => true }, { now: () => 0 });
    createJsonlFeed(script.map((v) => JSON.stringify(v)).join('\n'), 'x.jsonl').start(jsonlStore as FeedSink);
    expect(twoAi(jsonlStore)).toEqual(twoAi(ws));
    expect(twoAi(ws).hold?.assist).toBe('pending');
  });
});
