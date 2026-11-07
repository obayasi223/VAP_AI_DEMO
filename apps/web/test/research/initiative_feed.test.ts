/**
 * 本実装の発話希望（orchestrator の InitiativeWiring）が出すイベントが、研究者画面の候補表示（I2）に届くこと。
 * LLM は台本で、モデルの判断は何も試していない。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ManualTimeSource, PolicyJa, createEventEmitter, present, splitInterimParts } from '@llm-vap/contracts';
import type { ResearchEvent, SttPart } from '@llm-vap/contracts';
import { ScriptedLlmProvider } from '@llm-vap/testkit';
import { InitiativeWiring, NO_CANDIDATE_SPEECH } from '../../../orchestrator/src/session/initiative_wiring';
import { CandidateTracker } from '../../src/research/candidates_view';
import { CandidatePanel } from '../../src/research/LivePanels';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const policy = PolicyJa.parse(JSON.parse(readFileSync(join(root, 'config', 'policy.ja.json'), 'utf8')));

const out = (o: Record<string, unknown>) =>
  JSON.stringify({
    reason: 'r', why_now: '', cost_of_waiting: '', resolution_outlook: '', decision: 'NONE', target_candidate_id: '',
    intent_type: '', evidence_span: '', evidence_segment_ids: [], proposed_utterance: '', expiry_policy: '', urgency: '',
    withdraw_reason: '', withdraw_evidence_span: '', withdraw_evidence_segment_ids: [], ...o,
  });

let revision = 0;
function interim(stable: string) {
  const parts: SttPart[] = [{ text: stable, stability: present(0.9) }];
  const split = splitInterimParts(parts, 0.8);
  revision += 1;
  return {
    event: 'stt.interim' as const,
    transcript_revision: revision,
    segment_id: 0,
    asr_segment_id: 0,
    text: split.text,
    stable_text: split.stable_text,
    stability_source: 'provider' as const,
    parts,
    audio_frame_end: 1000,
  };
}

describe('本実装の候補イベントが研究者画面へ届く', () => {
  it('initiative.decision、candidate.state_changed、candidate.rejected、initiative.discarded を表示する', async () => {
    const tracker = new CandidateTracker();
    const time = new ManualTimeSource();
    const emitter = createEventEmitter({
      time,
      session_id: 's',
      condition: () => 'initiative_no_cue',
      sink: { write: (event: ResearchEvent) => tracker.add(event) },
    });
    const script = [
      out({ decision: 'NEW', evidence_span: '五十万円', evidence_segment_ids: [0], proposed_utterance: '確認です' }),
      // 活動中の候補があるので E2a が棄却する（番号つきで state_changed、G は discarded）
      out({ decision: 'NEW', evidence_span: '部長に相談', evidence_segment_ids: [0], proposed_utterance: '別の話です' }),
      // 入力にない候補への KEEP（G の棄却）
      out({ decision: 'KEEP', target_candidate_id: 'c_9999' }),
    ];
    let i = 0;
    const llm = new ScriptedLlmProvider({ responder: () => script[i++] ?? out({}), now: () => time.monotonicMs(), chars_per_delta: 100_000 });
    const wiring = new InitiativeWiring({
      llm,
      persona: { persona_id: 'p', version: 1, role: 'r', interests: ['i'], conversation_purpose: 'c', not_of_interest: ['n'] },
      policy,
      emitter,
      time,
      speech: () => NO_CANDIDATE_SPEECH,
      trigger: { min_new_stable_chars: 10, min_new_chars_at_boundary: null },
    });
    const base = '予算は五十万円のままで進めます';
    for (const text of [base, `${base}。部長に相談して決めます`, `${base}。部長に相談して決めます。来週の月曜日から準備を始めます`]) {
      wiring.onStt(interim(text));
      await wiring.monitor.whenIdle();
    }
    // 人が話し終えた後に、話していない候補の発話の終わりが届く（E2a が candidate.rejected で拒否する）。
    wiring.onSpeechFinished({ audio_playback_id: 1, interrupted: false, origin: { kind: 'candidate', candidate_id: 'c_0001' } }, 1);

    const summary = tracker.summary();
    expect(summary.decisions.map((d) => d.decision)).toEqual(['NEW']);
    expect(summary.state_changes.map((c) => [c.candidate_id, c.to])).toEqual([
      ['c_0002', 'WITHDRAWN'],
      ['c_0001', 'INTENT_READY'],
    ]);
    expect(summary.current).toMatchObject([{ candidate_id: 'c_0001', state: 'INTENT_READY' }]);
    // G の棄却は KEEP の1件だけ。E2a の拒否は candidate.rejected の1件と active_candidate_exists の1件。
    expect(summary.discarded).toBe(1);
    expect(summary.rejected).toBe(2);
    expect(summary.drops.map((d) => [d.source, d.reason])).toEqual([
      ['candidate.rejected', 'invalid_transition'],
      ['initiative.discarded', 'KEEP:target_candidate_not_in_input'],
      ['initiative.discarded', 'e2a_rejected:active_candidate_exists'],
    ]);
    const html = renderToStaticMarkup(createElement(CandidatePanel, { candidates: summary }));
    expect(html).toContain('data-testid="candidate-drops"');
    expect(html).toContain('E2a の拒否（transition）');
    expect(html).toContain('e2a_rejected:active_candidate_exists');
    expect(html).toContain('LLM 生成');
  });

  it('E2a の拒否は candidate.rejected と initiative.discarded の写しで二重に数えず、保留した NEW は人の再開で候補になる', async () => {
    const tracker = new CandidateTracker();
    const time = new ManualTimeSource();
    const emitter = createEventEmitter({
      time,
      session_id: 's',
      condition: () => 'initiative_no_cue',
      sink: { write: (event: ResearchEvent) => tracker.add(event) },
    });
    const llm = new ScriptedLlmProvider({
      responder: () => out({ decision: 'NEW', evidence_span: '五十万円', evidence_segment_ids: [0], proposed_utterance: '確認です' }),
      now: () => time.monotonicMs(),
      chars_per_delta: 100_000,
    });
    const wiring = new InitiativeWiring({
      llm,
      persona: { persona_id: 'p', version: 1, role: 'r', interests: ['i'], conversation_purpose: 'c', not_of_interest: ['n'] },
      policy,
      emitter,
      time,
      speech: () => NO_CANDIDATE_SPEECH,
      trigger: { min_new_stable_chars: 10, min_new_chars_at_boundary: null },
    });
    // 人は黙って間が続く（post_turn_silence_ms を超える）。そこへ NEW が届くと E2a が保留する。
    wiring.tick(time.monotonicMs(), false);
    time.advance(2000);
    wiring.tick(time.monotonicMs(), false);
    wiring.onStt(interim('予算は五十万円のままで進めます'));
    await wiring.monitor.whenIdle();
    let summary = tracker.summary();
    expect(summary.rejected).toBe(1);
    expect(summary.discarded).toBe(0);
    expect(summary.drops.map((d) => [d.source, d.reason])).toEqual([['candidate.rejected', 'post_turn_new_held']]);
    // 人が話を再開した（話の途中の間だった）。保留を棄てずに照合し直して候補にする。
    time.advance(100);
    wiring.tick(time.monotonicMs(), true);
    summary = tracker.summary();
    expect(summary.decisions.map((d) => d.decision)).toEqual(['NEW']);
    expect(summary.current).toMatchObject([{ candidate_id: 'c_0001', state: 'INTENT_READY' }]);
    wiring.close();
  });
});
