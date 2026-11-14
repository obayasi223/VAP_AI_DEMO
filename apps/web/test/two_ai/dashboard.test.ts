// vitest の include は *.test.ts だけなので、JSX を使わずこの拡張子にしている。
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  createTwoAiFakeEventScript,
  FAKE_TWO_AI_RESEARCH_CONFIG,
  fakeTwoAiBoard,
  fakeTwoAiInterjection,
  fakeTwoAiPoint,
  wrapTwoAiEvent as e,
} from '../../src/research/fake_events';
import { ResearchDashboard } from '../../src/research/ResearchDashboard';
import { ResearchViewStore } from '../../src/research/view_store';

const present = (value: number) => ({ value });

function store(options: { connected: boolean; events?: unknown[] }): ResearchViewStore {
  const s = new ResearchViewStore({ kind: 'ws', label: 'ws', synthetic: false, send: () => true }, { now: () => 0 });
  if (options.connected) s.connection('open', 'ws://x');
  s.event(FAKE_TWO_AI_RESEARCH_CONFIG);
  for (const event of options.events ?? []) s.event(event);
  return s;
}

function render(s: ResearchViewStore): string {
  return renderToStaticMarkup(
    createElement(ResearchDashboard, {
      snapshot: s.snapshot(),
      onSendWoz: () => ({ ok: true }),
      onArmTwoAi: () => ({ ok: true }),
    }),
  );
}

const disabledButton = (html: string, testId: string) => new RegExp(`<button[^>]*disabled=""[^>]*data-testid="${testId}"`).test(html);
const hasButton = (html: string, testId: string) => html.includes(`data-testid="${testId}"`);

function woz(id: string, action: 'stop' | 'correction') {
  return { type: 'research.woz' as const, woz_id: id, action, point_id: action === 'correction' ? 'f1' : null, operator: 'r', client_wall_clock: '2026-01-01T00:00:00.000Z' };
}

describe('研究画面の two_ai', () => {
  it('2 体のモードでは TwoAiPanel が出て置き場が消える', () => {
    const html = render(store({ connected: true, events: createTwoAiFakeEventScript() }));
    expect(html).toContain('data-testid="two-ai-panel"');
    expect(html).not.toContain('wave4-placeholder');
  });

  it('1 対 1 では従来の置き場のまま', () => {
    const s = new ResearchViewStore({ kind: 'ws', label: 'ws', synthetic: false });
    s.event({ type: 'research.config', policy_id: 'p', p_ai_index: 1, direction_status: 'measured', condition: 'reactive', mode: 'one_to_one' });
    const html = renderToStaticMarkup(createElement(ResearchDashboard, { snapshot: s.snapshot() }));
    expect(html).toContain('wave4-placeholder');
    expect(html).not.toContain('two-ai-panel');
  });

  it('WoZ の 7 ボタンは未接続で無効、接続とセッションで有効', () => {
    const events = createTwoAiFakeEventScript();
    const off = render(store({ connected: false, events }));
    for (const id of ['woz-stop', 'woz-face_user', 'woz-yield', 'woz-resume', 'woz-correction', 'woz-advance_phase', 'woz-abort']) {
      expect(disabledButton(off, id), id).toBe(true);
    }
    const noSession = render(store({ connected: true }));
    expect(disabledButton(noSession, 'woz-stop')).toBe(true);
    const on = render(store({ connected: true, events }));
    expect(hasButton(on, 'woz-stop')).toBe(true);
    expect(disabledButton(on, 'woz-stop')).toBe(false);
    expect(disabledButton(on, 'woz-abort')).toBe(false);
  });

  it('ack で行が更新される（適用、② の訂正は拒否、応答の段の訂正は記録だけ）', () => {
    const s = store({ connected: true, events: createTwoAiFakeEventScript() });
    s.wozSubmitted(woz('w1', 'stop'), true);
    expect(render(s)).toContain('送信中');
    s.event({ type: 'research.woz.ack', woz_id: 'w1', status: 'applied', detail: 'ok', phase: 'discussion' });
    s.wozSubmitted(woz('w2', 'correction'), true);
    s.event({ type: 'research.woz.ack', woz_id: 'w2', status: 'rejected', detail: 'condition_respond_at_end', phase: 'discussion' });
    s.wozSubmitted(woz('w3', 'correction'), true);
    s.event({ type: 'research.woz.ack', woz_id: 'w3', status: 'recorded', detail: 'response_phase', phase: 'response' });
    const html = render(s);
    expect(html).toContain('適用');
    expect(html).toContain('拒否（condition_respond_at_end）');
    expect(html).toContain('記録だけ');
    expect(html).not.toContain('送信中');
  });

  it('旗のチェックは ② で無効', () => {
    const armed = (condition: string) =>
      render(store({ connected: true, events: [{ ...FAKE_TWO_AI_RESEARCH_CONFIG, two_ai_armed: { arm_id: 'a1', condition, script_id: 's', interjection_feeds_generation: null } }] }));
    expect(/<input[^>]*disabled=""[^>]*data-testid="arm-feeds-flag"|<input[^>]*data-testid="arm-feeds-flag"[^>]*disabled=""/.test(armed('respond_at_end'))).toBe(true);
    expect(/<input[^>]*disabled=""[^>]*data-testid="arm-feeds-flag"|<input[^>]*data-testid="arm-feeds-flag"[^>]*disabled=""/.test(armed('respond_on_spot'))).toBe(false);
  });

  it('セッション中は条件の設定を押せない', () => {
    const html = render(store({ connected: true, events: createTwoAiFakeEventScript() }));
    expect(disabledButton(html, 'arm-submit')).toBe(true);
  });

  it('計画の本文、LLM の計画の出力、点のターンの文、伏せ字のカードは DOM のどこにも出ない', () => {
    const PLAN = '計画の本文ひみつ';
    const LLM = 'LLMの出力ひみつ';
    const SPOKEN = '点のターンの文ひみつ';
    const events = [
      ...createTwoAiFakeEventScript(),
      e(40000, {
        event: 'two_ai.plan', stage: 'frozen', trigger: 'early', plan_id: 'p1', plan_hash: 'h', source: 'generated', plan: null,
        fact_slip_source: 'prior', schedule_check: null, prompt_versions: {}, models: {}, latency_ms: present(1), reason: PLAN,
      }),
      e(40100, {
        event: 'llm.response', request_id: 'r1', purpose: 'discussion_turn', output: { source: 'model_output', value: LLM },
        transcript_revision: 1, sent_at: 40000, received_at: 40100, model_version: 'm',
      }),
      e(40200, {
        event: 'speech.ended', audio_playback_id: 31, audio_frame: 1000, started_at: 39000, first_pcm_written_at: 39000, output_latency_ms: present(10),
        spoken_text: SPOKEN, spoken_text_precision: 'alignment_char', samples_written: 1600, ended_at: 40200,
        origin: 'two_ai_turn', ai_id: 'B', turn_id: 't_0012', turn_kind: 'point', point_id: 'f1',
      }, { ai_id: 'B', point_id: 'f1' }),
      e(40300, fakeTwoAiBoard(2, 'building', [{ id: 'card_1', text: '', ended: false }])),
    ];
    const s = store({ connected: true, events });
    expect(s.snapshot().invalid, s.snapshot().last_invalid ?? '').toBe(0);
    const html = render(s);
    expect(html).toContain('two-ai-panel');
    for (const secret of [PLAN, LLM, SPOKEN, 'redacted']) expect(html).not.toContain(secret);
    expect(html).toContain('伏せ字：再生の後に表示');
  });

  it('判定の保留の行に残り時間、補助の判定、「訂正」と「訂正でない」が出る', () => {
    const html = render(
      store({
        connected: true,
        events: [
          e(1000, fakeTwoAiPoint('started')),
          e(1000, fakeTwoAiInterjection('ij_1', 'onset')),
          e(2000, fakeTwoAiInterjection('ij_1', 'correction_wait')),
        ],
      }),
    );
    expect(html).toContain('data-testid="two-ai-hold"');
    expect(html).toContain('残り 約 6.0 秒（推定）');
    expect(html).toContain('pending');
    expect(html).toMatch(/data-testid="hold-correction"[^>]*>訂正<\/button>/);
    expect(html).toMatch(/data-testid="hold-resume"[^>]*>訂正でない<\/button>/);
  });
});
