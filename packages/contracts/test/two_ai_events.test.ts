/** two_ai のイベント、封筒、メッセージ（06 §2、§4）。 */
import { describe, expect, it } from 'vitest';
import {
  BrowserToNode,
  EVENT_NAMES,
  EVENT_ROUTES,
  GazeTarget,
  LlmPurpose,
  ManualTimeSource,
  MemoryEventSink,
  NodeToBrowser,
  ResearchEvent,
  TWO_AI_CONTENT_EVENT_NAMES,
  TWO_AI_DIRECTOR_EVENT_NAMES,
  TWO_AI_EVENT_NAMES,
  TWO_AI_EXECUTOR_EVENT_NAMES,
  TwoAiTurnKind,
  createEventEmitter,
  present,
  type EventDraft,
} from '../src/index';
import { OPTIONAL_FIXTURES, VALID_FIXTURES } from '../src/fixtures';

const twoAiFixtures = VALID_FIXTURES.events.filter((f) => (TWO_AI_EVENT_NAMES as readonly string[]).includes((f.value as { event: string }).event));

describe('新しいイベント', () => {
  it('23 種と応答版の 3 種と render.health が EVENT_NAMES、fixture、経路を持つ', () => {
    expect(TWO_AI_EVENT_NAMES).toHaveLength(27);
    for (const name of TWO_AI_EVENT_NAMES) {
      expect(EVENT_NAMES as readonly string[], name).toContain(name);
      expect(twoAiFixtures.some((f) => (f.value as { event: string }).event === name), name).toBe(true);
      expect(EVENT_ROUTES[name], name).toBeDefined();
    }
  });

  it('Browser 由来の時刻を持つ 3 つは browser の経路（第 3 回 m7）', () => {
    expect(EVENT_ROUTES['two_ai.marker']).toEqual({ origin: 'browser', via: ['two_ai.marker'] });
    expect(EVENT_ROUTES['two_ai.board_picked']).toEqual({ origin: 'browser', via: ['two_ai.board_pick'] });
    expect(EVENT_ROUTES['render.health']).toEqual({ origin: 'browser', via: ['render.health'] });
    expect(EVENT_ROUTES['two_ai.turn']).toEqual({ origin: 'node' });
  });

  it.each(twoAiFixtures.map((f) => [f.name, f.value] as const))('%s が JSON の往復で変わらない', (_n, value) => {
    expect(ResearchEvent.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  it('出し手の表（06 §4.5）：進行役 16、executor 1（sync_mark）、02 が 6', () => {
    expect(TWO_AI_DIRECTOR_EVENT_NAMES).toHaveLength(16);
    expect(TWO_AI_EXECUTOR_EVENT_NAMES).toEqual(['two_ai.sync_mark']);
    expect(TWO_AI_CONTENT_EVENT_NAMES).toHaveLength(9);
    expect(new Set(TWO_AI_EVENT_NAMES).size).toBe(27);
  });

  it('sync_mark は seq（1 以上）、trigger（06 §4.7 の 8 行）、t_wall_ms だけを持ち、経路は node', () => {
    expect(EVENT_ROUTES['two_ai.sync_mark']).toEqual({ origin: 'node' });
    const m = twoAiFixtures.find((f) => f.name === 'two_ai.sync_mark')!.value as Record<string, unknown>;
    const triggers = ['intake', 'stage_1', 'stage_2', 'stage_3', 'stage_4', 'response', 'next_step', 'end'];
    for (const trigger of triggers) expect(ResearchEvent.safeParse({ ...m, trigger }).success, trigger).toBe(true);
    expect(ResearchEvent.safeParse({ ...m, trigger: 'discussion' }).success).toBe(false);
    expect(ResearchEvent.safeParse({ ...m, seq: 0 }).success).toBe(false);
    expect(ResearchEvent.safeParse({ ...m, t_wall_ms: 1.5 }).success).toBe(false);
    expect(ResearchEvent.safeParse({ ...m, message: 'two_ai.stage' }).success).toBe(false);
  });

  it('retraction の lines は研究画面の伏せ字で [] になりうる', () => {
    const r = twoAiFixtures.find((f) => f.name === 'two_ai.retraction')!.value as object;
    expect(ResearchEvent.safeParse({ ...r, lines: [] }).success).toBe(true);
  });

  it('marker の handling は recorded_only だけ', () => {
    const m = twoAiFixtures.find((f) => f.name === 'two_ai.marker')!.value as object;
    expect(ResearchEvent.safeParse({ ...m, handling: 'stopped' }).success).toBe(false);
  });
});

describe('封筒の two_ai', () => {
  const withEnvelope = OPTIONAL_FIXTURES.filter((f) => f.optional_keys.includes('two_ai'));

  it('すべての新しいイベントに two_ai つきの形がある', () => {
    for (const name of TWO_AI_EVENT_NAMES) {
      expect(withEnvelope.some((f) => (f.value as { event: string }).event === name), name).toBe(true);
    }
  });

  it('strict で、未知の項目は不合格', () => {
    const v = withEnvelope[0]!.value as { two_ai: object };
    expect(ResearchEvent.safeParse({ ...v, two_ai: { ...v.two_ai, extra: 1 } }).success).toBe(false);
  });

  it('1 対 1 の条件の封筒（two_ai なし）は今のまま通る', () => {
    const old = VALID_FIXTURES.events.find((f) => f.name === 'stt.final')!.value as { condition: string };
    expect(old.condition).toBe('initiative_inhale');
    expect(ResearchEvent.safeParse(old).success).toBe(true);
  });
});

describe('emitter', () => {
  const draft: EventDraft = { event: 'two_ai.anomaly', kind: 'tts_failed', speaker: 'A', detail: 'x' };

  it('two_ai_context なしの出力は今と同じ（two_ai の鍵を持たない）', () => {
    const sink = new MemoryEventSink();
    const emitter = createEventEmitter({ time: new ManualTimeSource(10), session_id: 's', condition: () => 'reactive', sink });
    const event = emitter.emit({ event: 'woz.override', action: 'x', operator: 'r', detail: null } as EventDraft);
    expect(Object.keys(event)).not.toContain('two_ai');
    expect(JSON.stringify(event)).not.toContain('two_ai');
  });

  it('two_ai_context が null を返すときも two_ai を入れない', () => {
    const sink = new MemoryEventSink();
    const emitter = createEventEmitter({
      time: new ManualTimeSource(10),
      session_id: 's',
      condition: () => 'respond_on_spot',
      two_ai_context: () => null,
      sink,
    });
    expect(Object.keys(emitter.emit(draft))).not.toContain('two_ai');
  });

  it('two_ai_context と範囲（ai_id、point_id）から封筒を作る', () => {
    const sink = new MemoryEventSink();
    const emitter = createEventEmitter({
      time: new ManualTimeSource(10),
      session_id: 's',
      condition: () => 'respond_at_end',
      two_ai_context: () => ({ phase: 'discussion', discussion_stage: 2, script_variant: 'corrected' }),
      sink,
    });
    const a = emitter.emit(draft, { two_ai: { ai_id: 'A', point_id: 'k1' } });
    expect(a.two_ai).toEqual({ phase: 'discussion', discussion_stage: 2, ai_id: 'A', point_id: 'k1', script_variant: 'corrected' });
    expect(a.condition).toBe('respond_at_end');
    const b = emitter.emit(draft);
    expect(b.two_ai).toMatchObject({ ai_id: null, point_id: null });
  });

  it('at（Browser 由来の時刻）を封筒に入れる', () => {
    const sink = new MemoryEventSink();
    const emitter = createEventEmitter({
      time: new ManualTimeSource(10),
      session_id: 's',
      condition: () => 'respond_on_spot',
      two_ai_context: () => ({ phase: 'discussion', discussion_stage: 1, script_variant: 'original' }),
      sink,
    });
    const e = emitter.emit(draft, { at: { t_monotonic_ms: 7, time_basis: { source: 'browser_rtt', uncertainty_ms: present(2) } } });
    expect(e.t_monotonic_ms).toBe(7);
    expect(e.time_basis.source).toBe('browser_rtt');
  });
});

describe('列挙と古いメッセージ', () => {
  it('peer、bridge、LlmPurpose の追加', () => {
    expect(GazeTarget.options).toContain('peer');
    expect(TwoAiTurnKind.options).toContain('bridge');
    expect(LlmPurpose.options).toEqual([
      'prefetch', 'initiative', 'completion', 'intake', 'ledger', 'discussion_plan', 'discussion_turn', 'correction_assist', 'next_step',
    ]);
  });

  it('ai_id なしの古いメッセージが通る', () => {
    expect(NodeToBrowser.safeParse({ type: 'gaze.command', target: 'away' }).success).toBe(true);
    expect(NodeToBrowser.safeParse({ type: 'playback.begin', audio_playback_id: 1, generation: 0, sample_rate_hz: 16000 }).success).toBe(true);
    expect(BrowserToNode.safeParse({ type: 'gaze.report', target: 'user', visible: true, client_t_ms: present(1) }).success).toBe(true);
  });

  it('新しいメッセージは条件の値を持てない', () => {
    expect(NodeToBrowser.safeParse({ type: 'two_ai.phase', phase: 'discussion', instruction_key: null, labels: null, condition: 'respond_on_spot' }).success).toBe(false);
    expect(BrowserToNode.safeParse({ type: 'two_ai.marker', marker_id: 'm', client_t_ms: 1, condition: 'respond_on_spot' }).success).toBe(false);
  });

  it('板は 4 枚まで、全体の置き換え', () => {
    const card = { card_id: 'c', order: 1, discussion_stage: 1, text: 't', variant: 'original' };
    const board = { type: 'two_ai.board', board_version: 0, mode: 'building', cards: [card, card, card, card, card], picked_card_id: null };
    expect(NodeToBrowser.safeParse(board).success).toBe(false);
    expect(NodeToBrowser.safeParse({ ...board, cards: [card] }).success).toBe(true);
  });
});

describe('two_ai.board の伏せ字（06 §4.6）', () => {
  const board = VALID_FIXTURES.events.find((f) => (f.value as { event: string }).event === 'two_ai.board')!.value as {
    cards: { text: string; trigger_turn_ended: boolean }[];
  };
  const withCard = (text: string, trigger_turn_ended: boolean) => ({ ...board, cards: [{ ...board.cards[0]!, text, trigger_turn_ended }] });

  it('出したターンが終わる前のカードは text を空にしてよい（研究画面への配信）', () => {
    expect(ResearchEvent.safeParse(withCard('', false)).success).toBe(true);
  });

  it('出したターンが終わった後のカードは空を許さない', () => {
    expect(ResearchEvent.safeParse(withCard('', true)).success).toBe(false);
    expect(ResearchEvent.safeParse(withCard('締切に合わせて申し込む', true)).success).toBe(true);
  });
});
