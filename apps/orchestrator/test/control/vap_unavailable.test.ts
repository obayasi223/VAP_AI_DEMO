/**
 * VAP が使えない、信用できないときの判断（ja の turn.vap_unavailable、原著にない。docs/known_gaps.md §12）。
 * 値は config の暫定値のまま見る。状況の表の各行に同じ振る舞いの試験を当て、配線を1本外すと赤になることを確かめる。
 * hri2025 は原著どおりで変わらないことも固定する（節の末尾）。
 */
import { describe, expect, it } from 'vitest';
import { TurnInputs, absent, present } from '@llm-vap/contracts';
import type { Policy, PolicyJa, TranscriptSnapshot, TurnDecision } from '@llm-vap/contracts';
import { assessVapFreshness, controlSettings, createTurnManager, vapUnavailableInvitationWaitMs, vapUnavailableStartWaitMs } from '../../src/control';
import type { TurnState } from '../../src/control';
import { T0, hri2025, ja, kinds, pick, playing, ready, transcript, turnAllowed, vapAt } from './helpers';

const THRESHOLD_DBFS = -45;
const VOICED = -20;
const QUIET = -70;
const options = { fallback_energy_silence_threshold: THRESHOLD_DBFS };
const frameAt = (now: number) => (now - T0 + 1000) * 16;

interface Condition {
  name: string;
  freshness: 'stale' | 'warming_up' | 'down';
  reason: string;
  patch?: (p: PolicyJa) => void;
  /** vitest の値の検証を通らない入力（TurnInputs.parse にかけない）。 */
  unparsed?: boolean;
  inputs: (now: number, frame: number) => Partial<TurnInputs>;
}

/** VAP の値は常に「AI に譲渡」（p=0.9）。使っていたら話し始めてしまう。 */
const yielding = (frame: number) => present(vapAt(0.9, 0.9, false, frame));
const vapWith = (frame: number, override: Partial<ReturnType<typeof vapAt>>) => present({ ...vapAt(0.9, 0.9, false, frame), ...override });

/** 助走の起点を固定する（助走が T0 + 6000ms まで続くので、下の場面は全部その前に終わる）。 */
const warmingFrom = T0 - 4000;

const CONDITIONS: Condition[] = [
  { name: '助走中（モデルの窓が埋まるまで）', freshness: 'warming_up', reason: 'rewarm', inputs: () => ({ vap_worker_started_at: present(warmingFrom) }) },
  { name: 'ワーカー再起動の直後（値があっても助走）', freshness: 'warming_up', reason: 'rewarm', inputs: (now) => ({ vap_worker_started_at: present(now - 1) }) },
  { name: '鮮度切れ（受信の遅れ）', freshness: 'stale', reason: 'arrival_lag', inputs: (now) => ({ vap_received_at: present(now - 1000) }) },
  { name: '鮮度切れ（音声位置の遅れ）', freshness: 'stale', reason: 'audio_frame_lag', inputs: (_now, frame) => ({ vap: yielding(frame - 16000) }) },
  { name: 'ワーカーの停止（未起動）', freshness: 'down', reason: 'worker_not_started', inputs: () => ({ vap_worker_started_at: absent('maai_disabled'), vap: absent('none'), vap_received_at: absent('none') }) },
  { name: 'CONFIGURE のやり直し中（READY 待ち）', freshness: 'down', reason: 'worker_not_ready', inputs: () => ({ vap_worker_started_at: absent('worker_not_ready'), vap: absent('none'), vap_received_at: absent('none') }) },
  { name: 'READY の後、値が未着', freshness: 'down', reason: 'no_vap_state', inputs: () => ({ vap: absent('no_vap_state_since_ready'), vap_received_at: absent('no_vap_state_since_ready') }) },
  { name: '方向が未確定（direction_status=provisional）', freshness: 'stale', reason: 'direction_provisional', patch: (p) => { p.vap.direction_status = 'provisional'; }, inputs: () => ({}) },
  { name: '値の異常（p_now が NaN）', freshness: 'stale', reason: 'invalid_vap_value:p_now', unparsed: true, inputs: (_now, frame) => ({ vap: vapWith(frame, { p_now: [NaN, 0.9] }) }) },
  { name: '値の異常（p_future が範囲外）', freshness: 'stale', reason: 'invalid_vap_value:p_future', unparsed: true, inputs: (_now, frame) => ({ vap: vapWith(frame, { p_future: [0.1, 1.5] }) }) },
  { name: '値の異常（vad が NaN）', freshness: 'stale', reason: 'invalid_vap_value:vad', unparsed: true, inputs: (_now, frame) => ({ vap: vapWith(frame, { vad: [NaN, 0.1] }) }) },
  { name: '値の異常（受信より先の音声位置）', freshness: 'stale', reason: 'audio_frame_ahead', unparsed: true, inputs: (_now, frame) => ({ vap: yielding(frame + 3200) }) },
];

interface SceneInput {
  energy?: number | null;
  text?: string;
  final?: boolean;
  prefetch?: TurnInputs['prefetch'];
  playback?: TurnInputs['playback'];
  /** 上りを止める（受信済み音声の先頭を進めない）。 */
  frozenFrame?: number;
}

class Scene {
  readonly manager;
  state: TurnState;
  decisions: TurnDecision[] = [];
  private revision = 0;
  private last: TurnInputs['transcript'] = absent('no_speech_yet');

  constructor(
    private readonly condition: Condition,
    policy: Policy,
  ) {
    this.manager = createTurnManager(policy, options);
    this.state = this.manager.initialState();
  }

  tick(now: number, input: SceneInput = {}): TurnDecision[] {
    if (input.text !== undefined) {
      this.revision += 1;
      const snapshot: TranscriptSnapshot = transcript(input.text, this.revision, {
        segment_id: this.state.segment_id,
        is_final: input.final ?? false,
      });
      this.last = present(snapshot);
    }
    const frame = input.frozenFrame ?? frameAt(now);
    const energy = input.energy === undefined ? QUIET : input.energy;
    const raw: TurnInputs = {
      vap: yielding(frame),
      vap_received_at: present(now),
      received_audio_frame: frame,
      vap_worker_started_at: present(0),
      fallback_energy: energy === null ? absent('no_uplink_audio_yet') : present(energy),
      transcript: this.last,
      completion_p: absent('no_estimator'),
      completion_revision: absent('no_estimator'),
      similarity_to_prepared: absent('no_previous_prepare'),
      prefetch: input.prefetch ?? ready(),
      playback: input.playback ?? { state: 'idle' },
      woz: [],
      ...this.condition.inputs(now, frame),
    };
    const inputs = this.condition.unparsed ? raw : TurnInputs.parse(raw);
    const out = this.manager.step(this.state, inputs, now);
    this.state = out.state;
    this.decisions = out.decisions;
    return out.decisions;
  }

  /** 毎 tick の値を変えない区間を 20ms で進める。途中で開始と割り込みが出ていないことを返す。 */
  run(from: number, to: number, input: SceneInput = {}): { started: boolean; interrupted: boolean; permitted: boolean } {
    let started = false;
    let interrupted = false;
    let permitted = false;
    for (let t = from; t <= to; t += 20) {
      const k = kinds(this.tick(t, input));
      started ||= k.includes('start_speech');
      interrupted ||= k.includes('interrupt_speech');
      permitted ||= this.state.permitted_to_speak;
    }
    return { started, interrupted, permitted };
  }
}

const scene = (condition: Condition) => new Scene(condition, ja(condition.patch));

describe('config の暫定値', () => {
  it('turn.vap_unavailable の値（暫定、docs/known_gaps.md §12）', () => {
    expect(ja().turn.vap_unavailable).toEqual({
      asr_quiet_after_final_ms: 300,
      asr_quiet_without_final_ms: 1200,
      interrupt_asr_recent_ms: 1000,
      ai_reference_missing_ms: null,
    });
  });
  it('開始の待ちは start_guard 以上。招待も VAP ありと同じ最小の間以上', () => {
    const settings = controlSettings(ja(), options);
    const guard = settings.start_guard!;
    expect(vapUnavailableStartWaitMs(settings)).toBe(1500);
    expect(vapUnavailableStartWaitMs(settings)).toBeGreaterThanOrEqual(guard.min_gap_ms);
    expect(vapUnavailableStartWaitMs(settings)).toBeGreaterThanOrEqual(guard.completion_timeout_low_p_min_ms);
    expect(vapUnavailableInvitationWaitMs(settings)).toBe(900);
    expect(vapUnavailableInvitationWaitMs(settings)).toBeGreaterThanOrEqual(guard.min_gap_ms);
  });
  it('fallback の上限を start_guard より短くしても、開始の待ちは start_guard を下回らない', () => {
    const settings = controlSettings(ja((p) => { p.turn.fallback_silence_max_ms = 300; }), options);
    expect(vapUnavailableStartWaitMs(settings)).toBeGreaterThanOrEqual(settings.start_guard!.completion_timeout_low_p_min_ms);
  });
});

describe.each(CONDITIONS)('$name', (condition) => {
  it('状況の判定と理由を残す', () => {
    const s = scene(condition);
    s.tick(T0);
    expect(s.state.vap_freshness).toBe(condition.freshness);
    expect(s.state.degraded).toBe(true);
    const payload = turnAllowed(s.decisions);
    expect(payload).toMatchObject({ turn_allowed: false, decision_source: 'fallback', vap_freshness: condition.freshness, p_now: { value: null } });
    expect(payload?.reason).toContain(condition.reason);
  });

  it('声のエネルギーが続く間は、VAP が譲渡を示していても話し始めない', () => {
    const s = scene(condition);
    s.tick(T0, { text: 'あしたの会議は', energy: VOICED });
    expect(s.run(T0 + 20, T0 + 4000, { energy: VOICED }).permitted).toBe(false);
  });

  it('声と ASR の両方が止まって初めて開始する（待ちの境界）', () => {
    const s = scene(condition);
    s.tick(T0, { text: 'あしたの', energy: VOICED });
    s.tick(T0 + 200, { energy: VOICED });
    s.tick(T0 + 400, { text: 'あしたの会議は', final: true });
    // 声の最後 T0+200 から 1500ms。ASR は final の後 300ms（T0+700）で満ちている。
    expect(s.run(T0 + 420, T0 + 1680).permitted).toBe(false);
    expect(s.tick(T0 + 1699).filter((d) => d.kind === 'start_speech')).toEqual([]);
    const decisions = s.tick(T0 + 1700);
    expect(kinds(decisions)).toContain('start_speech');
    const payload = turnAllowed(decisions);
    expect(payload).toMatchObject({ turn_allowed: true, decision_source: 'fallback' });
    expect(payload?.reason).toContain('fallback_silence_max+wait=1500ms+asr_final');
    expect(payload?.reason).toContain(condition.reason);
  });

  it('final がなければ ASR の更新が長く止まるまで開始しない', () => {
    const s = scene(condition);
    s.tick(T0, { text: 'あしたの会議は', energy: VOICED });
    // 声は最初の tick だけ（T0 + 1500 で無音の条件は満ちる）。ASR は T0 + 1000 まで更新が続く。
    for (let t = T0 + 500; t <= T0 + 1000; t += 500) s.tick(t, { text: `あしたの会議は${t}` });
    expect(s.run(T0 + 1020, T0 + 2180).permitted).toBe(false);
    expect(s.tick(T0 + 2199).filter((d) => d.kind === 'start_speech')).toEqual([]);
    const decisions = s.tick(T0 + 2200);
    expect(kinds(decisions)).toContain('start_speech');
    expect(turnAllowed(decisions)?.reason).toContain('asr_quiet');
  });

  it('ASR の更新が続く間（小さい声）はエネルギーが無音でも話し始めない', () => {
    const s = scene(condition);
    s.tick(T0, { text: 'あ', energy: VOICED });
    for (let t = T0 + 100; t <= T0 + 4000; t += 100) {
      s.tick(t, { text: `あしたの${t}` });
      expect(s.state.permitted_to_speak).toBe(false);
    }
  });

  it('発話の文がなければ、無音が続いても許可しない（人の声が無いのに話さない）', () => {
    const s = scene(condition);
    // エネルギーの瞬間的な立ち上がり（音）があり、その後は無音。ASR の文は来ない。
    s.tick(T0, { energy: VOICED });
    expect(s.state.voice_evidence_segment).toBe(0);
    expect(s.run(T0 + 20, T0 + 4000).permitted).toBe(false);
    expect(s.state.asr_result).toBeNull();
  });

  it('声の裏付けのない ASR の文には許可しない（環境音からの ASR の誤認）', () => {
    const s = scene(condition);
    s.tick(T0, { text: 'ふぁ', final: true, energy: QUIET });
    expect(s.run(T0 + 20, T0 + 4000).permitted).toBe(false);
    expect(s.state.voice_evidence_segment).toBeNull();
    const block = s.tick(T0 + 4020);
    expect(turnAllowed(block) ?? null).toBeNull(); // 判断の種類が変わらなければ出し直さない
    expect(s.state.permitted_to_speak).toBe(false);
  });

  it('上りの音声が止まったら、最後のエネルギーを無音の根拠にしない', () => {
    const s = scene(condition);
    const frozenFrame = frameAt(T0 + 200);
    s.tick(T0, { text: 'あしたの会議は', final: true, energy: VOICED });
    s.tick(T0 + 200, { energy: QUIET, frozenFrame });
    expect(s.run(T0 + 220, T0 + 4000, { energy: QUIET, frozenFrame }).permitted).toBe(false);
    // 上りが戻ったら、無音は戻った時点から数え直す（止まっていた間を無音に数えない）。
    s.tick(T0 + 4020, { energy: QUIET });
    expect(s.state.permitted_to_speak).toBe(false);
    expect(s.run(T0 + 4040, T0 + 5480).permitted).toBe(false);
    expect(s.tick(T0 + 5520).filter((d) => d.kind === 'start_speech').length).toBe(1);
  });

  it('招待は声の無音と ASR の静止のあと、start_guard の最小の間で許可する（声のあるうちは許可しない）', () => {
    const s = scene(condition);
    s.tick(T0, { text: 'お先にどうぞ', final: true, energy: VOICED });
    expect(s.state.invitation.detected).toBe(true);
    expect(s.run(T0 + 20, T0 + 800, { energy: VOICED }).permitted).toBe(false);
    // 声の最後 T0+800 から 900ms。
    s.tick(T0 + 820, { energy: QUIET });
    expect(s.tick(T0 + 1699).filter((d) => d.kind === 'start_speech')).toEqual([]);
    const decisions = s.tick(T0 + 1700);
    expect(kinds(decisions)).toContain('start_speech');
    expect(turnAllowed(decisions)).toMatchObject({ decision_source: 'invitation', turn_allowed: true });
    expect(turnAllowed(decisions)?.reason).toContain('wait=900ms');
  });

  it('準備は VAP に依存せず続く（費用だけで発話はしない）', () => {
    const s = scene(condition);
    s.tick(T0, { text: 'あしたの会議は', energy: VOICED, prefetch: { state: 'idle' } });
    expect(kinds(s.tick(T0 + 220, { energy: VOICED, prefetch: { state: 'idle' } }))).toContain('prepare');
  });

  describe('AI の発話中', () => {
    const during = (extra: SceneInput = {}): SceneInput => ({ playback: playing(9, 200), prefetch: { state: 'idle' }, ...extra });

    it('エネルギーと新しい語数があれば fallback として止める（理由に縮退を残す）', () => {
      const s = scene(condition);
      const decisions = s.tick(T0, during({ text: '明日の会議は三時です', energy: VOICED }));
      const [stop] = pick(decisions, 'interrupt_speech');
      expect(stop).toMatchObject({ decision_source: 'fallback', audio_playback_id: 9 });
      expect(stop?.reason).toContain('fallback_energy_with_new_interim');
      expect(stop?.reason).toContain('vap_unavailable:');
    });

    it('ASR の更新が古いときはエネルギーがあっても止めない（環境音や咳を割り込みと誤認しない）', () => {
      const s = scene(condition);
      s.tick(T0, during({ text: '明日の会議は三時です', energy: QUIET }));
      expect(s.run(T0 + 20, T0 + 1000, during({ energy: QUIET })).interrupted).toBe(false);
      const late = s.tick(T0 + 1020, during({ energy: VOICED }));
      expect(kinds(late)).not.toContain('interrupt_speech');
      const payload = turnAllowed(late);
      expect(payload?.reason).toContain('interrupt_held:asr_not_recent');
      expect(payload?.reason).toContain(condition.reason);
    });

    it('ASR の更新が 1000ms ちょうどなら止める（境界）', () => {
      const s = scene(condition);
      s.tick(T0, during({ text: '明日の会議は三時です', energy: QUIET }));
      expect(kinds(s.tick(T0 + 1000, during({ energy: VOICED })))).toContain('interrupt_speech');
    });

    it('相槌だけでは止めない', () => {
      const s = scene(condition);
      expect(kinds(s.tick(T0, during({ text: 'はい、うん、そうですね、はい', energy: VOICED })))).not.toContain('interrupt_speech');
    });

    it('声のエネルギーがなければ語数があっても止めない', () => {
      const s = scene(condition);
      expect(kinds(s.tick(T0, during({ text: '明日の会議は三時です', energy: QUIET })))).not.toContain('interrupt_speech');
    });
  });
});

describe('AI の音声の参照が来ていない（config は null で検査しない。値を入れたときの配線を見る）', () => {
  const withReferenceCheck = () => ja((p) => { p.turn.vap_unavailable!.ai_reference_missing_ms = 1000; });

  const baseInputs = (now: number): Pick<TurnInputs, 'vap' | 'vap_received_at' | 'received_audio_frame' | 'vap_worker_started_at'> => ({
    vap: yielding(frameAt(now)),
    vap_received_at: present(now),
    received_audio_frame: frameAt(now),
    vap_worker_started_at: present(0),
  });
  const limits = { vap_stale_ms: 500, vap_rewarm_ms: 10000 };
  const trust = { direction_status: 'measured' as const, ai_reference_missing_ms: 1000 };

  it.each([
    ['再生中で sys の無音が閾値未満は fresh', playing(9, 999), 'fresh'],
    ['再生中で sys の無音が閾値以上は stale', playing(9, 1000), 'stale'],
    ['再生していなければ fresh', { state: 'idle' } as const, 'fresh'],
  ] as const)('%s', (_title, playback, expected) => {
    const inputs = { ...baseInputs(T0), playback };
    expect(assessVapFreshness(inputs, T0, limits, trust).freshness).toBe(expected);
  });

  const missing: Condition = { name: 'sys の無音', freshness: 'stale', reason: 'ai_reference_missing', inputs: () => ({}) };
  const fresh: Condition = { name: 'fresh', freshness: 'stale', reason: '', inputs: (_n, frame) => ({ vap: present(vapAt(0.1, 0.1, true, frame)) }) };

  it('参照が来ているなら VAP の L59 で止める（比較のための確認）', () => {
    const s = new Scene(fresh, withReferenceCheck());
    const [stop] = pick(s.tick(T0, { playback: playing(9, 999), prefetch: { state: 'idle' }, energy: VOICED }), 'interrupt_speech');
    expect(stop).toMatchObject({ decision_source: 'vap' });
  });

  it('config の null では sys の無音を見ず、今までどおり VAP の割り込みで止める', () => {
    const s = new Scene(fresh, ja());
    const [stop] = pick(s.tick(T0, { playback: playing(9, 5000), prefetch: { state: 'idle' }, energy: VOICED }), 'interrupt_speech');
    expect(stop).toMatchObject({ decision_source: 'vap' });
    expect(s.state.vap_freshness).toBe('fresh');
  });

  it('参照が来ていないときは VAP の割り込みを信用せず、エネルギーと ASR の語数だけで判断する（誤って止まらない）', () => {
    // vad は発話中、p は低い（VAP は割り込みと判定する状況）。sys の無音は 1000ms 以上。
    const s = new Scene({ ...missing, inputs: (_n, frame) => ({ vap: present(vapAt(0.1, 0.1, true, frame)) }) }, withReferenceCheck());
    const decisions = s.tick(T0, { playback: playing(9, 2000), prefetch: { state: 'idle' }, energy: VOICED, text: 'うん' });
    expect(kinds(decisions)).not.toContain('interrupt_speech');
    expect(s.state.vap_freshness).toBe('stale');
    expect(turnAllowed(decisions)?.reason).toContain('ai_reference_missing');
  });

  it('参照が戻ったら（再生中のまま）VAP に戻る', () => {
    const s = new Scene(fresh, withReferenceCheck());
    s.tick(T0, { playback: playing(9, 2000), prefetch: { state: 'idle' } });
    expect(s.state.vap_freshness).toBe('stale');
    s.tick(T0 + 20, { playback: playing(9, 0), prefetch: { state: 'idle' } });
    expect(s.state.vap_freshness).toBe('fresh');
  });
});

describe('声の裏付け', () => {
  it('VAP が新鮮な間に観測した声も裏付けに数える（鮮度切れの前に話し終えた発話に応答できる）', () => {
    const s = new Scene(
      {
        name: '発話の後に鮮度切れ',
        freshness: 'stale',
        reason: 'arrival_lag',
        inputs: (now, frame) => (now < T0 + 200 ? { vap: present(vapAt(0.1, 0.1, true, frame)) } : { vap_received_at: present(now - 1000) }),
      },
      ja(),
    );
    s.tick(T0, { text: 'あしたの会議は', final: true, energy: QUIET });
    expect(s.state.voice_evidence_segment).toBe(0);
    s.tick(T0 + 220);
    expect(s.state.degraded).toBe(true);
    expect(s.run(T0 + 240, T0 + 1700).permitted).toBe(false);
    expect(kinds(s.tick(T0 + 1720))).toContain('start_speech');
  });
});

describe('判断の記録（turn.allowed の理由）', () => {
  const stale: Condition = { name: '鮮度切れ', freshness: 'stale', reason: 'arrival_lag', inputs: (now) => ({ vap_received_at: present(now - 1000) }) };

  it('待ちの理由の種類が変わるたびに残す（値の変化だけでは増えない）', () => {
    const s = scene(stale);
    const reasons: string[] = [];
    const push = (d: TurnDecision[]) => { const p = turnAllowed(d); if (p) reasons.push(p.reason); };
    push(s.tick(T0, { text: 'あした', energy: VOICED }));
    for (let t = T0 + 20; t <= T0 + 1700; t += 20) push(s.tick(t, { energy: t <= T0 + 100 ? VOICED : QUIET, ...(t === T0 + 1000 ? { text: 'あしたの会議は' } : {}) }));
    // 無音の待ち → ASR の待ち → 開始の順。ms の増加では増えない。
    expect(reasons.length).toBeLessThanOrEqual(3);
    expect(reasons.some((r) => r.includes('wait_silence'))).toBe(true);
  });

  it('最初の判定に縮退の理由を残す', () => {
    const s = scene(stale);
    expect(turnAllowed(s.tick(T0))?.reason).toContain('arrival_lag');
  });
});

describe('VAP の回復', () => {
  const outage = (now: number) => ({ vap_received_at: present(now - 1000) });
  const stale: Condition = { name: 'stale', freshness: 'stale', reason: 'arrival_lag', inputs: outage };

  it('回復した最初の tick では許可せず、計時をやり直して通常の分岐に戻る（L67、start_guard）', () => {
    const s = new Scene(
      { ...stale, inputs: (now, frame) => (now < T0 + 5000 ? outage(now) : { vap: present(vapAt(0.9, 0.9, false, frame)) }) },
      ja(),
    );
    s.tick(T0, { text: 'あした', energy: VOICED, final: true });
    s.run(T0 + 20, T0 + 4980, { energy: VOICED });
    expect(s.state.degraded).toBe(true);
    const back = s.tick(T0 + 5000);
    expect(s.state.degraded).toBe(false);
    expect(pick(back, 'set_degraded')[0]).toMatchObject({ degraded: false });
    expect(s.state.permitted_to_speak).toBe(false);
    expect(s.state.user_speak_end_time).toBe(T0 + 5000);
    expect(s.state.user_turn_end_time).toBe(T0 + 5000);
    expect(s.tick(T0 + 5899).filter((d) => d.kind === 'start_speech')).toEqual([]);
    const decisions = s.tick(T0 + 5900);
    expect(kinds(decisions)).toContain('start_speech');
    expect(turnAllowed(decisions)).toMatchObject({ decision_source: 'vap', vap_freshness: 'fresh', p_now: { value: 0.9 } });
    expect(turnAllowed(decisions)?.reason).toContain('L67_vap_yield');
    expect(turnAllowed(decisions)?.reason).not.toContain('vap_unavailable');
  });

  it('回復後は fallback の無音や ASR の待ちを見ない（VAP が発話中と言えば L56）', () => {
    const s = new Scene(
      { ...stale, inputs: (now, frame) => (now < T0 + 5000 ? outage(now) : { vap: present(vapAt(0.1, 0.1, true, frame)) }) },
      ja(),
    );
    s.tick(T0, { text: 'あした', energy: VOICED, final: true });
    s.run(T0 + 20, T0 + 4980, { energy: VOICED });
    const back = s.tick(T0 + 5020, { energy: QUIET });
    expect(s.state.user_speaking).toBe(true);
    expect(turnAllowed(back)).toMatchObject({ turn_allowed: false, decision_source: 'vap', reason: 'user_speaking' });
  });

  it('縮退に戻ったら無音はそこから数え直す（flap で過去の無音を使わない）', () => {
    const s = new Scene(
      { ...stale, inputs: (now, frame) => (now >= T0 + 3000 && now < T0 + 3100 ? { vap: present(vapAt(0.45, 0.45, false, frame)) } : outage(now)) },
      ja(),
    );
    s.tick(T0, { text: 'あした', energy: VOICED, final: true });
    s.run(T0 + 20, T0 + 2980, { energy: VOICED });
    expect(s.state.degraded).toBe(true);
    s.tick(T0 + 3000); // 回復
    expect(s.state.degraded).toBe(false);
    s.tick(T0 + 3120); // 再び縮退
    expect(s.state.degraded).toBe(true);
    expect(s.state.fallback_last_voiced_at).toBe(T0 + 3120);
    expect(s.tick(T0 + 4600).filter((d) => d.kind === 'start_speech')).toEqual([]);
  });
});

describe('hri2025 は原著どおり（回帰）', () => {
  const hri = () => new Scene({ name: '', freshness: 'stale', reason: '', inputs: (now) => ({ vap_received_at: present(now - 1000) }) }, hri2025());

  it('方策に項目がなく、safe な判断を持たない', () => {
    expect(controlSettings(hri2025()).vap_unavailable).toBeNull();
    expect(controlSettings(hri2025()).start_guard).toBeNull();
  });

  it('鮮度切れの間は無音でも招待でも開始せず、割り込みもしない（原著に VAP の縮退はない）', () => {
    const s = hri();
    s.tick(T0, { text: 'あしたの会議は', final: true, energy: VOICED });
    expect(s.run(T0 + 20, T0 + 10000).permitted).toBe(false);
    const invite = hri();
    invite.tick(T0, { text: 'お先にどうぞ', final: true, energy: VOICED });
    expect(invite.run(T0 + 20, T0 + 5000).permitted).toBe(false);
    const ai = hri();
    expect(ai.run(T0, T0 + 500, { playback: playing(9, 2000), energy: VOICED, text: '明日の会議は三時です' }).interrupted).toBe(false);
  });

  it('理由と状態は以前のまま（理由に safe の語を足さず、裏付けの状態も書かない）', () => {
    const s = hri();
    const decisions = s.tick(T0, { text: 'あしたの会議は', final: true, energy: VOICED });
    const payload = turnAllowed(decisions);
    expect(payload?.reason).toMatch(/^degraded:arrival_lag:/);
    expect(payload?.reason).not.toContain('vap_unavailable');
    expect(payload?.reason).not.toContain('wait_');
    expect(s.state.voice_evidence_segment).toBeNull();
    // 入力の異常の検査も hri2025 には入れない（入力は契約の検証の後）。
    expect(
      assessVapFreshness(
        { vap: present({ ...vapAt(0.9, 0.9, false, 100), p_now: [Number.NaN, 0.9] as [number, number] }), vap_received_at: present(T0), received_audio_frame: 100, vap_worker_started_at: present(0) },
        T0,
        { vap_stale_ms: 500, vap_rewarm_ms: 10000 },
      ).freshness,
    ).toBe('fresh');
  });
});
