/** Appendix A の分岐ごとの表形式試験。試験名の L は原著の行、T と I と U は docs/hri2025_mapping.md の ID。 */
import { describe, expect, it } from 'vitest';
import { prepareThresholds } from '@llm-vap/contracts';
import type { Policy } from '@llm-vap/contracts';
import { turnGptTimeout } from '../../src/control';
import { Driver, T0, hri2025, ja, jaAppendixA, kinds, pick, playing, preparing, ready, turnAllowed } from './helpers';

const both: [string, () => Policy][] = [
  ['hri2025', hri2025],
  ['ja', jaAppendixA],
];
const YIELD: [number, number, boolean] = [0.6, 0.6, false];
const FAVOR_USER: [number, number, boolean] = [0.3, 0.3, false];

describe.each(both)('Appendix A の共通の分岐（%s）', (_name, policy) => {
  it('L23-25: 最初の step で時計を初期化する（直後は許可なし）', () => {
    const d = new Driver(policy());
    d.tick(T0, { p: FAVOR_USER });
    expect(d.state.user_speak_end_time).toBe(T0);
    expect(d.state.user_turn_end_time).toBe(T0);
    expect(d.state.last_asr_time).toBe(T0);
    expect(d.state.permitted_to_speak).toBe(false);
  });

  it('L37-42 T1: 新しい ASR 結果で asr_result、turngpt_output、last_asr_time を更新する', () => {
    const d = new Driver(policy());
    d.tick(T0);
    d.tick(T0 + 40, { text: 'こんにちは', p_completion: 0.1 });
    expect(d.state.asr_result).toBe('こんにちは');
    expect(d.state.turngpt_output).toBe(0.1);
    expect(d.state.last_asr_time).toBe(T0 + 40);
    d.tick(T0 + 60, { p_completion: 0.1 });
    expect(d.state.last_asr_time).toBe(T0 + 40); // 新しい revision がなければ更新しない
  });

  it('L45: 両方 none の初期状態では準備しない', () => {
    const d = new Driver(policy());
    d.tick(T0);
    expect(kinds(d.tick(T0 + 5000))).not.toContain('prepare');
  });

  it('L45: 送信済みと同じ文は再び評価しない', () => {
    const d = new Driver(policy());
    d.tick(T0, { text: 'はい' });
    expect(kinds(d.tick(T0 + 200))).toContain('prepare');
    expect(kinds(d.tick(T0 + 400))).not.toContain('prepare');
  });

  it.each([
    ['L46 T2: p=0.2 は偽、199ms も偽（I-3、> の境界）', 0.2, 199, false],
    ['L46: 200ms ちょうどで真（T4）', 0, 200, true],
    ['L46: 199ms は偽', 0, 199, false],
  ])('%s', (_title, p, elapsed, fired) => {
    const d = new Driver(policy());
    d.tick(T0, { text: '明日は', p_completion: p });
    const decisions = d.tick(T0 + elapsed, { p_completion: p, sim: 0.5 });
    expect(pick(decisions, 'prepare').length).toBe(fired ? 1 : 0);
  });

  it('L47-51 T4: 起動すると prepare を出し last_sent を更新する', () => {
    const d = new Driver(policy());
    d.tick(T0, { text: '明日は' });
    const [prepare] = pick(d.tick(T0 + 200, { sim: 0.5 }), 'prepare');
    expect(prepare).toMatchObject({ text: '明日は', trigger: 'asr_timeout', similarity: { value: 0.5 }, segment_id: 0 });
    expect(d.state.last_sent_asr_result).toBe('明日は');
    expect(d.state.last_prepare_at).toBe(T0 + 200);
  });

  it('L48-50 T3: 古い準備があれば cancel_prepare の後に prepare', () => {
    const d = new Driver(policy());
    d.tick(T0, { text: '明日は' });
    d.tick(T0 + 200);
    const decisions = d.tick(T0 + 220, { text: '明日は晴れ', sim: 0.5, prefetch: preparing(), p_completion: 0.9 });
    const relevant = kinds(decisions).filter((k) => k === 'cancel_prepare' || k === 'prepare');
    expect(relevant).toEqual(['cancel_prepare', 'prepare']);
    expect(pick(decisions, 'cancel_prepare')[0]).toMatchObject({ audio_playback_id: 7 });
  });

  it('L48 → L78: 同じ tick で取り消した準備は is_ready ではない', () => {
    const d = new Driver(policy());
    d.tick(T0, { text: '明日は' });
    d.tick(T0 + 200);
    const decisions = d.tick(T0 + 4000, { text: '明日は晴れ', sim: 0.5, prefetch: ready(), p_completion: 0.9, p: YIELD });
    expect(kinds(decisions)).toContain('prepare');
    expect(kinds(decisions)).not.toContain('start_speech');
  });

  it('L56-57: 発話中は user_speak_end_time を毎 tick 更新する', () => {
    const d = new Driver(policy());
    d.tick(T0, { p: [0.45, 0.45, true] });
    d.tick(T0 + 40, { p: [0.45, 0.45, true] });
    expect(d.state.user_speak_end_time).toBe(T0 + 40);
    expect(d.state.user_speaking).toBe(true);
    d.tick(T0 + 60, { p: [0.45, 0.45, false] });
    expect(d.state.user_speak_end_time).toBe(T0 + 40);
  });

  it.each([
    ['L59 T6: 両方 0.39、AI 発話中で停止', 0.39, 0.39, true, true],
    ['L59 T7: p_fut=0.4 は停止しない（相槌の形）', 0.39, 0.4, true, false],
    ['L59: p_now=0.4 も停止しない', 0.4, 0.39, true, false],
    ['L59 T8: AI が無音なら停止命令なし', 0.39, 0.39, false, false],
  ])('%s', (_title, pNow, pFut, aiPlaying, stopped) => {
    const d = new Driver(policy());
    const decisions = d.tick(T0, {
      p: [pNow, pFut, true],
      playback: aiPlaying ? playing(9) : { state: 'idle' },
    });
    const interrupts = pick(decisions, 'interrupt_speech');
    expect(interrupts.length).toBe(stopped ? 1 : 0);
    if (stopped) expect(interrupts[0]).toMatchObject({ audio_playback_id: 9, decision_source: 'vap' });
  });

  it('L59: 非発話の分岐では停止しない', () => {
    const d = new Driver(policy());
    expect(kinds(d.tick(T0, { p: [0.1, 0.1, false], playback: playing() }))).not.toContain('interrupt_speech');
  });

  it.each([
    ['L66 T10: 0.5/0.6 は偽で L71 が走る', 0.5, 0.6],
    ['L66 T10: 0.6/0.5 も偽で L71 が走る', 0.6, 0.5],
  ])('%s', (_title, pNow, pFut) => {
    const d = new Driver(policy());
    d.tick(T0, { p: YIELD });
    d.tick(T0 + 1000, { p: [pNow, pFut, false] });
    expect(d.state.user_turn_end_time).toBe(T0 + 1000);
  });

  it.each([
    ['L67 T11: 499ms 継続は許可なし', 499, false],
    ['L67 T12: 500ms ちょうどで許可', 500, true],
  ])('%s', (_title, elapsed, allowed) => {
    const d = new Driver(policy());
    d.tick(T0, { p: FAVOR_USER });
    d.tick(T0 + elapsed, { p: [0.51, 0.51, false] });
    expect(d.state.permitted_to_speak).toBe(allowed);
  });

  it('L64: turn_shift_allowed は tick をまたいで保持しない', () => {
    const d = new Driver(policy());
    d.tick(T0, { p: FAVOR_USER });
    d.tick(T0 + 500, { p: YIELD });
    expect(d.state.permitted_to_speak).toBe(true);
    d.tick(T0 + 520, { p: FAVOR_USER });
    expect(d.state.permitted_to_speak).toBe(false);
  });

  it.each([
    ['L74 T13: p=0 は 2999ms で許可なし', 0, 2999, false],
    ['L74 T13: p=0 は 3000ms で許可（VAP は利用者を支持のまま）', 0, 3000, true],
    ['L74 T14: p=0.72 は 499ms で許可なし', 0.72, 499, false],
    ['L74 T14: p=0.72 は 500ms で許可', 0.72, 500, true],
    ['L74 L88: p=0.2999 は 1000ms', 0.2999, 1000, true],
    ['L74 L88: p=0.2999 は 999ms で許可なし', 0.2999, 999, false],
  ])('%s', (_title, p, elapsed, allowed) => {
    const d = new Driver(policy());
    d.tick(T0, { p: [0.3, 0.3, true], p_completion: p });
    const decisions = d.tick(T0 + elapsed, { p: FAVOR_USER, p_completion: p });
    expect(d.state.permitted_to_speak).toBe(allowed);
    if (allowed) expect(turnAllowed(decisions)?.decision_source).toBe('completion_timeout');
  });

  it('L79: 許可が前の tick から続いていても、開始の tick には turn_allowed を残す', () => {
    const d = new Driver(policy());
    d.tick(T0, { p: FAVOR_USER });
    expect(turnAllowed(d.tick(T0 + 500, { p: YIELD }))?.turn_allowed).toBe(true);
    expect(turnAllowed(d.tick(T0 + 520, { p: YIELD }))).toBeUndefined();
    expect(turnAllowed(d.tick(T0 + 540, { p: YIELD, prefetch: ready() }))?.turn_allowed).toBe(true);
  });

  it('L78 T15: 許可があっても準備ができていなければ開始しない。次の tick で計算し直す', () => {
    const d = new Driver(policy());
    d.tick(T0, { p: FAVOR_USER });
    const decisions = d.tick(T0 + 500, { p: YIELD, prefetch: preparing() });
    expect(d.state.permitted_to_speak).toBe(true);
    expect(kinds(decisions)).not.toContain('start_speech');
    expect(kinds(d.tick(T0 + 520, { p: YIELD, prefetch: ready() }))).toContain('start_speech');
  });

  it('L79-80 T16: start_speech の後に advance_segment（ASR.reset の定義）', () => {
    const d = new Driver(policy());
    d.tick(T0, { p: FAVOR_USER });
    const decisions = d.tick(T0 + 500, { p: YIELD, prefetch: ready(7), received_audio_frame: 16000 });
    const order = kinds(decisions).filter((k) => k === 'start_speech' || k === 'advance_segment');
    expect(order).toEqual(['start_speech', 'advance_segment']);
    expect(pick(decisions, 'start_speech')[0]).toMatchObject({ audio_playback_id: 7 });
    expect(pick(decisions, 'advance_segment')[0]).toMatchObject({ new_segment_id: 1, at_audio_frame: 16000 });
    expect(d.state.segment_id).toBe(1);
    expect(d.state.mode).toBe('ai_speaking');
  });

  it('L78 T17: 利用者が発話中なら ready でも開始しない', () => {
    const d = new Driver(policy());
    d.tick(T0, { p: [0.9, 0.9, true] });
    expect(kinds(d.tick(T0 + 5000, { p: [0.9, 0.9, true], prefetch: ready() }))).not.toContain('start_speech');
  });

  it('turn_allowed は変化時と開始時だけ出し、判定の全入力を残す', () => {
    const d = new Driver(policy());
    d.tick(T0, { p: FAVOR_USER });
    expect(turnAllowed(d.tick(T0 + 20, { p: FAVOR_USER }))).toBeUndefined();
    const payload = turnAllowed(d.tick(T0 + 520, { p: YIELD, prefetch: ready(), p_completion: 0.1 }));
    expect(payload).toMatchObject({
      turn_allowed: true,
      decision_source: 'vap',
      p_now: { value: 0.6 },
      p_future: { value: 0.6 },
      completion_p: { value: 0.1 },
      gap_ms: { value: 520 },
      vap_freshness: 'fresh',
      invitation: { detected: false },
      reason: 'L67_vap_yield',
    });
  });
});

describe('L86-92: TurnGPT_Timeout の表（§1.2）', () => {
  const table = [
    { threshold: 0.3, timeout_ms: 500 },
    { threshold: 0.2, timeout_ms: 1000 },
    { threshold: 0.1, timeout_ms: 2000 },
    { threshold: 0, timeout_ms: 3000 },
  ];
  it.each([
    [0.3, 500],
    [0.2999, 1000],
    [0.2, 1000],
    [0.1999, 2000],
    [0.1, 2000],
    [0.0999, 3000],
    [0, 3000],
  ])('L88: p=%f → %ims', (p, ms) => {
    expect(turnGptTimeout(p, table)).toBe(ms);
  });

  it('L15-20: 方策の表を降順で読む', () => {
    expect(new Driver(hri2025()).manager.settings.yield_timeouts).toEqual(table);
    expect(new Driver(jaAppendixA()).manager.settings.yield_timeouts).toEqual(table);
  });
});

describe('原著の値を変えていない', () => {
  it('L2、L4: hri2025 の prepareThresholds は 0.2 と 0.8', () => {
    expect(prepareThresholds(hri2025())).toEqual({
      completion_prepare_threshold: 0.2,
      similarity_prepare_threshold: 0.8,
    });
  });
});

describe('解釈の差（計画 §4.1）: 方策ごとの期待', () => {
  function afterLongSpeech(policy: Policy) {
    const d = new Driver(policy);
    for (let t = 0; t <= 5000; t += 20) d.tick(T0 + t, { p: [0.45, 0.45, true] });
    return d;
  }

  it('T9 I-4 hri2025: 話し終えた最初の tick で L67 が真（0ms 許可）', () => {
    const d = afterLongSpeech(hri2025());
    const end = d.state.user_speak_end_time as number;
    d.tick(end + 20, { p: YIELD });
    expect(d.state.permitted_to_speak).toBe(true);
  });

  it('T9 I-4 ja: 最後の発話 tick から 500ms 経つまで許可しない', () => {
    const d = afterLongSpeech(jaAppendixA());
    const end = d.state.user_speak_end_time as number;
    d.tick(end + 20, { p: YIELD });
    expect(d.state.permitted_to_speak).toBe(false);
    d.tick(end + 499, { p: YIELD });
    expect(d.state.permitted_to_speak).toBe(false);
    d.tick(end + 500, { p: YIELD });
    expect(d.state.permitted_to_speak).toBe(true);
  });

  it('ja の不変条件: 発話終了から 500ms 未満では許可が出ない（固定の乱数列で全経路）', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32;
      return seed / 2 ** 32;
    };
    const d = new Driver(jaAppendixA());
    let lastSpeech = T0;
    for (let i = 0; i < 20000; i++) {
      const now = T0 + i * 20;
      const speaking = rand() < 0.1;
      const text = rand() < 0.05 ? (rand() < 0.3 ? 'どうぞ' : `文${i}`) : undefined;
      if (speaking) lastSpeech = now;
      d.tick(now, { p: [rand(), rand(), speaking], p_completion: rand(), text });
      if (d.state.permitted_to_speak) expect(now - lastSpeech).toBeGreaterThanOrEqual(500);
    }
  });

  it('I-2 hri2025: stop_point は immediate、max_wait 0', () => {
    const [stop] = pick(new Driver(hri2025()).tick(T0, { p: [0.1, 0.1, true], playback: playing() }), 'interrupt_speech');
    expect(stop).toMatchObject({ stop_point: 'immediate', max_wait_ms: 0 });
  });

  it('I-2 ja: stop_point は word_boundary、上限 200ms（暫定）', () => {
    const [stop] = pick(new Driver(jaAppendixA()).tick(T0, { p: [0.1, 0.1, true], playback: playing() }), 'interrupt_speech');
    expect(stop).toMatchObject({ stop_point: 'word_boundary', max_wait_ms: 200 });
  });
});

describe('U 項目: 補正あり（ja）と擬似コードどおり（hri2025）', () => {
  const yielded = (policy: Policy) => {
    const d = new Driver(policy);
    d.tick(T0, { p: FAVOR_USER });
    return d;
  };

  it('U-1 ja: AI 発話中は別の応答が ready でも開始しない', () => {
    const decisions = yielded(jaAppendixA()).tick(T0 + 500, { p: YIELD, prefetch: ready(), playback: playing() });
    expect(kinds(decisions)).not.toContain('start_speech');
  });
  it('U-1 hri2025: L78 のとおり is_speaking を見ない', () => {
    const decisions = yielded(hri2025()).tick(T0 + 500, { p: YIELD, prefetch: ready(), playback: playing() });
    expect(kinds(decisions)).toContain('start_speech');
  });
  it('U-1 ja: start_speech の直後は再生の報告が来る前でも話し中として扱う', () => {
    const d = yielded(jaAppendixA());
    d.tick(T0 + 500, { p: YIELD, prefetch: ready(7) });
    expect(d.state.speaking).toMatchObject({ phase: 'starting', audio_playback_id: 7 });
    expect(kinds(d.tick(T0 + 520, { p: YIELD, prefetch: ready(8, 1) }))).not.toContain('start_speech');
  });
  it('U-1 ja: 再生の報告が来なければ上限の後に話し中を解く（暫定 1000ms）', () => {
    const d = yielded(jaAppendixA());
    d.tick(T0 + 500, { p: YIELD, prefetch: ready(7) });
    d.tick(T0 + 1499, { p: YIELD });
    expect(d.state.speaking.phase).toBe('starting');
    d.tick(T0 + 1500, { p: YIELD });
    expect(d.state.speaking.phase).toBe('silent');
    expect(d.state.mode).toBe('listening');
  });

  it('U-2 ja: AI 発話中の準備は抑止する', () => {
    const d = new Driver(jaAppendixA());
    expect(kinds(d.tick(T0, { text: 'うん', p_completion: 0.9, sim: 0.1, playback: playing() }))).not.toContain('prepare');
  });
  it('U-2 hri2025: L45-54 は AI 発話中も走る', () => {
    const d = new Driver(hri2025());
    expect(kinds(d.tick(T0, { text: 'うん', p_completion: 0.9, sim: 0.1, playback: playing() }))).toContain('prepare');
  });
  it('U-2 ja: 割り込みを出した後は準備を再開する', () => {
    const d = new Driver(jaAppendixA());
    d.tick(T0, { text: '待って', p_completion: 0.9, sim: 0.1, playback: playing(), p: [0.45, 0.45, true] });
    const decisions = d.tick(T0 + 20, { p_completion: 0.9, sim: 0.1, playback: playing(), p: [0.1, 0.1, true] });
    expect(kinds(decisions)).toEqual(expect.arrayContaining(['interrupt_speech']));
    expect(kinds(decisions)).not.toContain('prepare'); // L45 は割り込みの判定より前
    expect(kinds(d.tick(T0 + 40, { p_completion: 0.9, sim: 0.1, playback: playing(), p: [0.1, 0.1, true] }))).toContain('prepare');
  });
  it('U-2 ja: 前の segment の準備は取り消すが、再生中の音声は対象にしない', () => {
    const d = yielded(jaAppendixA());
    d.tick(T0 + 500, { p: YIELD, prefetch: ready(7) }); // segment 1 へ
    const onAir = d.tick(T0 + 520, { prefetch: ready(7, 0), playback: playing(7) });
    expect(kinds(onAir)).not.toContain('cancel_prepare');
    const leftover = d.tick(T0 + 540, { prefetch: preparing(8, 0), playback: playing(7) });
    expect(pick(leftover, 'cancel_prepare')[0]).toMatchObject({ audio_playback_id: 8, reason: 'prepared_for_previous_segment' });
    expect(kinds(d.tick(T0 + 560, { prefetch: preparing(8, 0), playback: playing(7) }))).not.toContain('cancel_prepare');
  });

  function sameTextAfterTurn(policy: Policy) {
    const d = new Driver(policy);
    d.tick(T0, { text: 'はい', p: FAVOR_USER });
    d.tick(T0 + 200, { p: FAVOR_USER });
    d.tick(T0 + 900, { p: YIELD, prefetch: ready(7) });
    d.tick(T0 + 920, { playback: playing(7) });
    d.tick(T0 + 940); // 再生が終わった
    d.tick(T0 + 960, { text: 'はい' });
    return d.tick(T0 + 1160);
  }
  it('U-4 ja: 「はい」→「はい」でも次のターンで準備する', () => {
    expect(kinds(sameTextAfterTurn(jaAppendixA()))).toContain('prepare');
  });
  it('U-4 hri2025: 「はい」→「はい」は L45 が偽で準備しない（原文の不具合を再現）', () => {
    expect(kinds(sameTextAfterTurn(hri2025()))).not.toContain('prepare');
  });
  it('U-4 ja: segment が変わると turngpt_output を 0 に戻し、前の segment の p を読まない', () => {
    const d = yielded(jaAppendixA());
    d.tick(T0 + 20, { text: '明日は', p: FAVOR_USER, p_completion: 0.9 });
    d.tick(T0 + 520, { p: YIELD, p_completion: 0.9, prefetch: ready(7) });
    expect(d.state.segment_id).toBe(1);
    expect(d.state.turngpt_output).toBe(0);
    const old = d.state.asr_revision as number;
    d.tick(T0 + 540, { completion_p: { value: 0.9 }, completion_revision: { value: old }, playback: playing(7) });
    expect(d.state.turngpt_output).toBe(0);
    d.tick(T0 + 560, { completion_p: { value: 0.9 }, completion_revision: { value: old + 1 }, playback: playing(7) });
    expect(d.state.turngpt_output).toBe(0.9);
  });
  it('U-4 hri2025: segment が変わっても asr_result と turngpt_output は残る', () => {
    const d = yielded(hri2025());
    d.tick(T0 + 20, { text: '明日は', p: FAVOR_USER, p_completion: 0.9 });
    d.tick(T0 + 520, { p: YIELD, p_completion: 0.9, prefetch: ready(7) });
    expect(d.state.asr_result).toBe('明日は');
    expect(d.state.turngpt_output).toBe(0.9);
  });
  it('U-4 ja: 前の segment の準備が ready でも話さない', () => {
    const d = yielded(jaAppendixA());
    d.tick(T0 + 500, { p: YIELD, prefetch: ready(7) });
    d.tick(T0 + 520, { playback: playing(7) });
    d.tick(T0 + 540);
    const decisions = d.tick(T0 + 2000, { p: YIELD, prefetch: ready(8, 0) });
    expect(kinds(decisions)).not.toContain('start_speech');
  });

  it('U-5: 比較対象がないとき（null と理由）は 0 として初回は起動し、理由を残す', () => {
    for (const policy of [hri2025(), jaAppendixA()]) {
      const d = new Driver(policy);
      d.tick(T0, { text: '初回' });
      const [prepare] = pick(d.tick(T0 + 200), 'prepare');
      expect(prepare?.similarity).toEqual({ value: null, null_reason: 'no_previous_prepare' });
    }
  });

  it('U-7 null（既定）: 1フレームの欠けで発話終了になる', () => {
    const d = new Driver(jaAppendixA());
    d.tick(T0, { p: [0.45, 0.45, true] });
    d.tick(T0 + 20, { p: [0.45, 0.45, false] });
    expect(d.state.user_speaking).toBe(false);
  });
  it('U-7 設定あり: 最短継続より短い欠けと短い雑音を無視し、発話終了は最後の発話時刻のまま', () => {
    const d = new Driver(jaAppendixA((p) => { p.turn.user_speaking_min_ms = 100; }));
    d.tick(T0, { p: [0.45, 0.45, false] });
    d.tick(T0 + 20, { p: [0.45, 0.45, true] });
    expect(d.state.user_speaking).toBe(false); // 短い雑音
    d.tick(T0 + 120, { p: [0.45, 0.45, true] });
    expect(d.state.user_speaking).toBe(true);
    d.tick(T0 + 140, { p: [0.45, 0.45, false] });
    expect(d.state.user_speaking).toBe(true); // 短い欠け
    expect(d.state.user_speak_end_time).toBe(T0 + 120);
    d.tick(T0 + 240, { p: [0.45, 0.45, false] });
    expect(d.state.user_speaking).toBe(false);
  });

  it('U-8 ja: 語境界待ちの間に重複の停止命令を出さない', () => {
    const d = new Driver(jaAppendixA());
    const speak = { p: [0.1, 0.1, true] as [number, number, boolean], playback: playing(9) };
    expect(pick(d.tick(T0, speak), 'interrupt_speech').length).toBe(1);
    expect(d.state.speaking.phase).toBe('stopping');
    expect(pick(d.tick(T0 + 20, speak), 'interrupt_speech').length).toBe(0);
  });
  it('U-8 hri2025: L59 が真の間は毎 tick 出る', () => {
    const d = new Driver(hri2025());
    const speak = { p: [0.1, 0.1, true] as [number, number, boolean], playback: playing(9) };
    expect(pick(d.tick(T0, speak), 'interrupt_speech').length).toBe(1);
    expect(pick(d.tick(T0 + 20, speak), 'interrupt_speech').length).toBe(1);
  });

  it('U-9: turn.allowed に p の revision を残す', () => {
    const d = new Driver(jaAppendixA());
    d.tick(T0, { text: '明日', p: FAVOR_USER, p_completion: 0.1 });
    const payload = turnAllowed(d.tick(T0 + 500, { p: YIELD, p_completion: 0.1 }));
    expect(payload?.completion_revision).toEqual({ value: 1 });
  });

  it('U-3: 旧 segment の結果は今のターンの入力にしない', () => {
    const d = yielded(jaAppendixA());
    d.tick(T0 + 500, { p: YIELD, prefetch: ready(7) });
    const late = { value: { ...lateTranscript, segment_id: 0, transcript_revision: 5, text: '語尾' } };
    d.tick(T0 + 520, { transcript: late, playback: playing(7) });
    expect(d.state.asr_result).toBeNull();
    expect(d.state.asr_revision).toBeNull();
  });
});

const lateTranscript = {
  asr_segment_id: 0,
  asr_segment_frame_start: 0,
  stable_text: '',
  unstable_text: '語尾',
  is_final: false,
  stability: { value: null, null_reason: 'test' },
  stability_source: 'derived' as const,
  audio_frame_end: 0,
  timing_precision: 'result_end_offset' as const,
  words: { value: null, null_reason: 'test' },
  received_at: 0,
};
