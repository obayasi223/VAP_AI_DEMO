/**
 * 申し出の状況が研究条件の名前ではなく、実際の送信の経路で決まることの試験（台帳、監視、音声は最小の偽物）。
 */
import { describe, expect, it } from 'vitest';
import { ManualTimeSource, MemoryEventSink, absent, createEventEmitter, present } from '@llm-vap/contracts';
import type { Condition, NodeToBrowser, SignalReport } from '@llm-vap/contracts';
import { OfferObservations } from '../../src/cognition/initiative';
import { NegotiationWiring } from '../../src/session/negotiation_wiring';
import type { InitiativeWiring } from '../../src/session/initiative_wiring';

function rig(condition: Condition, send: (message: NodeToBrowser) => boolean) {
  const offers = new OfferObservations();
  const time = new ManualTimeSource(1000);
  const record = { candidate_id: 'c_0001', candidate_version: 1, state: 'INTENT_READY', received_at: 990, decided_at: 990, last_request_id: 'ini_0001', evidence_segment_ids: [0], segment_id: 0, transcript_revision: 1, proposed_utterance: 'x' };
  const ledger = {
    list: () => [record],
    get: () => record,
    getRecord: () => record,
    transition: (_id: string, to: string) => {
      const from = record.state;
      record.state = to;
      return { ok: true, from, to };
    },
    noteCueStarted: () => undefined,
  };
  const monitor = { latestTiming: () => ({ timing: 'OFFER_NOW' }), stableCharsSinceInput: () => 0 };
  const wiring = new NegotiationWiring({
    settings: { condition, inhale_ms: 700, hold_max_ms: 800, signal_cooldown_ms: 0, max_active_candidates: 1, max_new_stable_chars_since_judgement: 60, cue_max_judgement_age_ms: 6000, timing_gate: true },
    initiative: { ledger, monitor, offers } as unknown as InitiativeWiring,
    emitter: createEventEmitter({ time, session_id: 's', condition: () => condition, sink: new MemoryEventSink() }),
    speech: () => ({ prepare: () => ({ audio_playback_id: 1 }), stateOf: () => 'ready' }) as never,
    send,
    now: () => time.monotonicMs(),
  });
  const step = (now: number, user_speaking = true) => wiring.beforeStep({ now, ai_speaking: false, avatar_available: true, user_speaking });
  return { wiring, offers, step };
}

const report = (visible: boolean): SignalReport => ({
  type: 'signal.report',
  candidate_id: 'c_0001',
  phase: 'inhale',
  state: 'started',
  visible,
  client_t_ms: visible ? present(1100) : absent('not_visible'),
});
const mapping = { toServerMs: (t: number) => t } as never;

describe('申し出の状況と送信の経路', () => {
  it.each(['reactive', 'initiative_no_cue'] as const)('%s は合図を送らないので not_presented', (condition) => {
    const sent: NodeToBrowser[] = [];
    const { offers, step } = rig(condition, (m) => {
      sent.push(m);
      return true;
    });
    step(1000);
    step(1100);
    expect(sent).toHaveLength(0);
    expect(offers.view('c_0001', 1200)).toMatchObject({ presentation: 'not_presented', follow_up: 'unknown' });
  });

  it('initiative_inhale でも送れなかった合図は not_presented（候補の状態は吸気に進んでいても）', () => {
    const { offers, step } = rig('initiative_inhale', () => false);
    step(1000);
    expect(offers.view('c_0001', 1200).presentation).toBe('not_presented');
  });

  it('送れたら sent_unconfirmed、描いた報告で presented、振る舞いは次の tick から', () => {
    const { wiring, offers, step } = rig('initiative_inhale', () => true);
    step(1000);
    expect(offers.view('c_0001', 1000)).toMatchObject({ presentation: 'sent_unconfirmed', follow_up: 'unknown', cue_id: { value: 'cue_0001' } });
    wiring.onSignalReport(report(true), mapping);
    expect(offers.view('c_0001', 1100).presentation).toBe('presented');
    step(1200, false);
    expect(offers.view('c_0001', 1300)).toMatchObject({ presentation: 'presented', follow_up: 'stopped', elapsed_s: { value: 0.2 } });
  });

  it('描かれなかった報告（背景タブなど）は not_presented', () => {
    const { wiring, offers, step } = rig('initiative_inhale', () => true);
    step(1000);
    wiring.onSignalReport(report(false), mapping);
    expect(offers.view('c_0001', 1100).presentation).toBe('not_presented');
  });
});
