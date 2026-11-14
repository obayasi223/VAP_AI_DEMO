/** WoZ の受け付け（05 §2.2）と、出た量の数え方（06 §6.0、§9）。純粋関数。 */
import { describe, expect, it } from 'vitest';
import { contentMsOf, countsForPoint, playedMsOf, repeatShare } from '../../../src/two_ai/exposure';
import { admitWoz, resolveCorrectionPoint } from '../../../src/two_ai/woz';
import type { WozInputTwoAi, WozView } from '../../../src/two_ai/woz';

const known = (over: Partial<{ started: boolean; switched: boolean }> = {}): WozView['known_points'] =>
  new Map([
    ['f1', { kind: 'fact_slip' as const, started: true, switched: false, ...over }],
    ['k1', { kind: 'framing_K' as never, started: true, switched: false }],
  ]);
const view = (over: Partial<WozView> = {}): WozView => ({
  condition: 'respond_on_spot',
  phase: 'discussion',
  floor: { ai_id: 'A' } as never,
  woz_paused: false,
  user_floor: false,
  correction_hold: null,
  known_points: known(),
  ...over,
});
const cmd = (action: WozInputTwoAi['action'], point_id: string | null = null): WozInputTwoAi => ({ woz_id: 'w', action, point_id, operator: 'r', received_at: 0 });

describe('admitWoz', () => {
  it.each([
    ['stop', view(), 'applied', null],
    ['stop', view({ floor: null }), 'rejected', null],
    ['stop', view({ condition: 'respond_at_end' }), 'applied', 'protocol_deviation'],
    ['yield', view({ condition: 'respond_at_end' }), 'rejected', null],
    ['yield', view({ phase: 'response' }), 'rejected', null],
    ['resume', view(), 'rejected', null],
    ['resume', view({ woz_paused: true }), 'applied', null],
    ['resume', view({ correction_hold: { interjection_id: 'ij1', hold_until: 1 } }), 'applied', null],
    ['correction', view({ phase: 'response' }), 'recorded', null],
    ['correction', view({ condition: 'respond_at_end' }), 'rejected', null],
    ['correction', view({ phase: 'intake' }), 'rejected', null],
    ['correction', view(), 'applied', null],
    ['correction', view({ known_points: known({ switched: true }) }), 'rejected', null],
    ['correction', view({ known_points: known({ started: false }) }), 'rejected', null],
    ['advance_phase', view({ phase: 'end' }), 'rejected', null],
    ['abort', view(), 'applied', null],
  ] as const)('%s → %s', (action, v, status, note) => {
    const r = admitWoz(cmd(action), v);
    expect(r.status).toBe(status);
    expect(r.condition_note).toBe(note);
  });

  it('保留の間の resume の理由は not_correction', () => {
    expect(admitWoz(cmd('resume'), view({ correction_hold: { interjection_id: 'ij1', hold_until: 1 } })).reason).toBe('not_correction');
  });

  it('切り替え済みは already_switched、fact_slip でない点は unknown_point', () => {
    expect(admitWoz(cmd('correction'), view({ known_points: known({ switched: true }) })).reason).toBe('already_switched');
    expect(admitWoz(cmd('correction', 'k1'), view()).reason).toBe('unknown_point');
    expect(admitWoz(cmd('correction', 'zz'), view()).reason).toBe('unknown_point');
  });

  it('point_id が null なら fact_slip の点（1 つだけのとき）', () => {
    expect(resolveCorrectionPoint(null, known())).toBe('f1');
    const two = new Map([...known(), ['f2', { kind: 'fact_slip' as const, started: true, switched: false }]]);
    expect(resolveCorrectionPoint(null, two)).toBeNull();
  });
});

describe('exposure', () => {
  it('playedMsOf：16 kHz の書き込みの数から ms', () => {
    expect(playedMsOf(16000)).toBe(1000);
    expect(playedMsOf(-5)).toBe(0);
  });

  it('repeatShare：語の時刻があればそれで、なければ文字数の比で戻りの句と言い直しを分ける', () => {
    const a = repeatShare({ played_ms: 3000, repeat: { bridge_chars: 2, restated_chars: 3 }, total_chars: 10, alignment_end_ms: [100, 200, 300, 400, 500, 600] });
    expect(a).toEqual({ bridge_ms: 200, repeated_ms: 300, new_ms: 2500, source: 'alignment' });
    const c = repeatShare({ played_ms: 2000, repeat: { bridge_chars: 2, restated_chars: 3 }, total_chars: 10, alignment_end_ms: null });
    expect(c).toEqual({ bridge_ms: 400, repeated_ms: 600, new_ms: 1000, source: 'char_ratio' });
    expect(repeatShare({ played_ms: 900, repeat: null, total_chars: 5, alignment_end_ms: null })).toEqual({ bridge_ms: 0, repeated_ms: 0, new_ms: 900, source: 'none' });
  });

  it('repeatShare：途中で止まった発話は played_ms で切る', () => {
    const r = repeatShare({ played_ms: 250, repeat: { bridge_chars: 2, restated_chars: 3 }, total_chars: 10, alignment_end_ms: [100, 200, 300] });
    expect(r.bridge_ms + r.repeated_ms + r.new_ms).toBe(250);
    expect(r.new_ms).toBe(0);
  });

  it('中身の時計に足すのは中身のターンだけ（resume は new_ms）', () => {
    expect(contentMsOf('discussion', 3000, 3000)).toBe(3000);
    expect(contentMsOf('point_elaboration', 3000, 3000)).toBe(3000);
    expect(contentMsOf('resume', 3000, 1200)).toBe(1200);
    for (const k of ['ack', 'uptake', 'bridge', 'filler', 'phase_line'] as const) expect(contentMsOf(k, 3000, 3000)).toBe(0);
    expect(countsForPoint('point', 'f1')).toBe(true);
    expect(countsForPoint('discussion', null)).toBe(false);
  });
});
