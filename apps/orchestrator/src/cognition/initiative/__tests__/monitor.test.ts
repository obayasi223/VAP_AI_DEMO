/**
 * コードの層の試験。LLM の返答は台本どおりの test double で、モデルの判断は何も試していない。
 * 「ASR 誤認で抑止できる」はコードのゲートの性質であって、LLM の性能ではない（計画 §4.5a）。
 */
import { describe, expect, it } from 'vitest';
import { ManualTimeSource } from '@llm-vap/contracts';
import { InitiativeMonitor } from '../monitor';
import { LIMITS, PERSONA, deferred, final, interim, makeMonitor, output } from './helpers';

const STABLE = '予算は五十万円のままで進めます';
const newOutput = (partial = {}) =>
  output({ decision: 'NEW', evidence_span: '五十万円', evidence_segment_ids: [0], proposed_utterance: '確認です', reason: 'r', ...partial });

const decisions = (sink: { ofType: (n: 'initiative.decision') => { decision: string }[] }) =>
  sink.ofType('initiative.decision').map((e) => e.decision);
const discards = (sink: { ofType: (n: 'initiative.discarded') => { reason: string }[] }) =>
  sink.ofType('initiative.discarded').map((e) => e.reason);

describe('実行方式', () => {
  it('未安定の文字では起動せず、安定の増分で起動する', async () => {
    const { monitor, llm } = makeMonitor(() => output({}));
    monitor.onStt(interim('', 'あいうえおかきくけこさしすせそ'));
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(0);
    monitor.onStt(interim('あいうえおかきくけこさ', 'しすせそ'));
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(1);
  });

  it('増分が閾値未満なら起動しない。final なら小さくても起動する', async () => {
    const { monitor, llm } = makeMonitor(() => output({}));
    monitor.onStt(interim('あいうえお'));
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(0);
    monitor.onStt(final('あいうえお。'));
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(1);
  });

  it('interim の末尾の仮の句点では起動しない', async () => {
    const { monitor, llm } = makeMonitor(() => output({}));
    monitor.onStt(interim('あいうえお。'));
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(0);
  });

  it('実行中は中断せず最後まで走らせ、完了後に最新の入力で1回だけ実行する', async () => {
    const gates = [deferred<string>(), deferred<string>()];
    const { monitor, llm } = makeMonitor((_r, i) => gates[i]!.promise);
    monitor.onStt(interim('あいうえおかきくけこ'));
    monitor.onStt(interim('あいうえおかきくけこさしすせそたちつてとな'));
    monitor.onStt(interim('あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみ'));
    await new Promise((r) => setTimeout(r, 0));
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.signal).toBeUndefined();
    gates[0]!.resolve(output({}));
    await new Promise((r) => setTimeout(r, 0));
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.messages[0]!.text).toContain('あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみ');
    gates[1]!.resolve(output({}));
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(2);
  });

  it('完了までに増分がなければ次を実行しない', async () => {
    const { monitor, llm } = makeMonitor(() => output({}));
    monitor.onStt(interim('あいうえおかきくけこ'));
    await monitor.whenIdle();
    await monitor.finishInput();
    expect(llm.requests).toHaveLength(1);
  });

  it('入力の終わりで残りの増分を1回判定する', async () => {
    const { monitor, llm } = makeMonitor(() => output({}));
    monitor.onStt(interim('あいうえおかきくけこ'));
    await monitor.whenIdle();
    monitor.onStt(interim('あいうえおかきくけこさ'));
    await monitor.finishInput();
    expect(llm.requests).toHaveLength(2);
  });

  it('要求の上限に達したら止めて状態を報告する', async () => {
    const { monitor, llm, sink } = makeMonitor(() => output({}), { limits: { ...LIMITS, max_requests_per_session: 1 } });
    monitor.onStt(interim('あいうえおかきくけこ'));
    await monitor.whenIdle();
    monitor.onStt(interim('あいうえおかきくけこさしすせそたちつてと'));
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(1);
    expect(sink.ofType('provider.status')[0]).toMatchObject({ status: 'degraded' });
  });

  it('プロンプトに渡すのは安定テキストだけで、未安定の語は渡さない', async () => {
    const { monitor, llm } = makeMonitor(() => output({}));
    monitor.onStt(interim('あいうえおかきくけこ', '五千万円'));
    await monitor.whenIdle();
    expect(llm.requests[0]!.messages[0]!.text).not.toContain('五千万円');
  });

  it('未校正（null）の上限では起動しない', () => {
    expect(
      () =>
        new InitiativeMonitor({
          llm: makeMonitor(() => '').llm,
          store: makeMonitor(() => '').store,
          emitter: { emit: () => ({}) as never },
          time: new ManualTimeSource(),
          persona: PERSONA,
          limits: { ...LIMITS, max_result_age_ms: null },
        }),
    ).toThrow(/uncalibrated/);
  });
});

describe('起動の条件は policy から読む', () => {
  const text = 'あいうえおかきくけこさしすせそ';

  it('policy の値で起動する', async () => {
    const low = makeMonitor(() => output({}), {
      limits: { ...LIMITS, trigger: { min_new_stable_chars: 5, min_new_chars_at_boundary: null } },
      trigger: undefined,
    });
    low.monitor.onStt(interim(text));
    await low.monitor.whenIdle();
    expect(low.llm.requests).toHaveLength(1);

    const high = makeMonitor(() => output({}), {
      limits: { ...LIMITS, trigger: { min_new_stable_chars: 500, min_new_chars_at_boundary: null } },
      trigger: undefined,
    });
    high.monitor.onStt(interim(text));
    await high.monitor.whenIdle();
    expect(high.llm.requests).toHaveLength(0);
  });

  it('policy に起動の条件がなければ起動しない', () => {
    expect(() => makeMonitor(() => output({}), { limits: LIMITS, trigger: undefined })).toThrow(/trigger is not set/);
  });
});

describe('反例「ASR の誤認だけで矛盾が見える」のコードの層', () => {
  it('未安定にしかない語を根拠にした NEW は棄却し、候補を作らない', async () => {
    const { monitor, store, sink, llm } = makeMonitor(() =>
      newOutput({ evidence_span: '五千万円', reason: 'とても説得力のある理由' }),
    );
    monitor.onStt(interim(STABLE.slice(0, 11), '五千万円'));
    await monitor.whenIdle();
    expect(llm.provider_class).toBe('test_double');
    expect(store.list()).toHaveLength(0);
    expect(decisions(sink)).toEqual([]);
    expect(discards(sink)[0]).toContain('evidence_not_in_input_stable_text');
  });

  it('応答を待つ間に根拠が書き換わった NEW は棄却する', async () => {
    const gate = deferred<string>();
    const { monitor, store, sink } = makeMonitor(() => gate.promise);
    monitor.onStt(interim('出展料は五千万円です。'));
    await new Promise((r) => setTimeout(r, 0));
    monitor.onStt(interim('', '出展料は五十万円です'));
    gate.resolve(newOutput({ evidence_span: '五千万円' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(store.list()).toHaveLength(0);
    expect(discards(sink)[0]).toContain('evidence_not_in_latest_stable_text');
  });

  it('候補の登録後に根拠が書き換わったら、モデルを待たずコード由来で撤回し音声を破棄する', async () => {
    const cancelled: [number, string][] = [];
    const { monitor, store, sink } = makeMonitor(() => newOutput({ evidence_span: '五千万円' }), {
      speech: {
        prepare: () => ({ audio_playback_id: 7, generation: 1 }),
        cancel: (id, reason) => cancelled.push([id, reason]),
      },
    });
    monitor.onStt(interim('出展料は五千万円です。'));
    await monitor.whenIdle();
    expect(store.list()).toHaveLength(1);
    monitor.onStt(interim('', '出展料は五十万円です'));
    expect(store.list()).toHaveLength(0);
    expect(sink.ofType('candidate.state_changed')[0]).toMatchObject({ cause_source: 'code', cause: 'evidence_lost', to: 'WITHDRAWN' });
    expect(cancelled).toEqual([[7, 'evidence_lost']]);
  });
});

describe('ゲートとモデルの説明文', () => {
  it('reason、why_now、cost_of_waiting が空でも根拠が正しければ通る', async () => {
    const { monitor, store } = makeMonitor(() => newOutput({ reason: '', why_now: '', cost_of_waiting: '' }));
    monitor.onStt(interim(STABLE));
    await monitor.whenIdle();
    expect(store.list()).toHaveLength(1);
  });

  it('説明文がどれほどもっともらしくても、根拠がなければ棄却する', async () => {
    const { monitor, store } = makeMonitor(() =>
      newOutput({ evidence_span: '存在しない語句', why_now: '今すぐ必要', cost_of_waiting: '重大な損失', urgency: 'HIGH' }),
    );
    monitor.onStt(interim(STABLE));
    await monitor.whenIdle();
    expect(store.list()).toHaveLength(0);
  });

  it('区間番号が実在しなければ棄却する', async () => {
    const { monitor, sink } = makeMonitor(() => newOutput({ evidence_segment_ids: [42] }));
    monitor.onStt(interim(STABLE));
    await monitor.whenIdle();
    expect(discards(sink)[0]).toContain('evidence_segment_id_unknown');
  });

  it('モデル出力は ModelOutput、検証結果は Verified で記録する', async () => {
    const { monitor, sink } = makeMonitor(() => newOutput({ why_now: 'w' }));
    monitor.onStt(interim(STABLE));
    await monitor.whenIdle();
    expect(sink.ofType('initiative.decision')[0]).toMatchObject({
      decision: 'NEW',
      candidate_id: 'c_0001',
      candidate_version: 1,
      why_now: { source: 'model_output', value: 'w' },
      evidence_valid: { source: 'verified', value: true },
    });
  });
});

describe('鮮度の上限', () => {
  it('新規の安定文字が上限を超えた NEW は棄却し、最新の入力で再判定する', async () => {
    const gates = [deferred<string>(), deferred<string>()];
    const { monitor, store, sink, llm } = makeMonitor((_r, i) => gates[i]!.promise, {
      limits: { ...LIMITS, max_new_stable_chars_since_input: 5 },
    });
    monitor.onStt(interim(STABLE));
    await new Promise((r) => setTimeout(r, 0));
    monitor.onStt(interim(`${STABLE}あいうえおかき`));
    gates[0]!.resolve(newOutput());
    await new Promise((r) => setTimeout(r, 0));
    expect(store.list()).toHaveLength(0);
    expect(discards(sink)[0]).toContain('stale_too_many_new_stable_chars');
    expect(llm.requests).toHaveLength(2);
    gates[1]!.resolve(output({}));
    await monitor.whenIdle();
  });

  it('経過時間が上限を超えた NEW は棄却する', async () => {
    const gate = deferred<string>();
    const { monitor, store, sink, time } = makeMonitor(() => gate.promise);
    monitor.onStt(interim(STABLE));
    await new Promise((r) => setTimeout(r, 0));
    time.advance(LIMITS.max_result_age_ms! + 1);
    gate.resolve(newOutput());
    await monitor.whenIdle();
    expect(store.list()).toHaveLength(0);
    expect(discards(sink)[0]).toContain('stale_result_too_old');
  });
});

describe('候補の更新', () => {
  const later = `${STABLE}。部長に相談して追加で出してもらえることになりました`;

  async function withCandidate(second: string, speech?: { prepare: () => { audio_playback_id: number; generation: number }; cancel: (id: number, r: string) => void }) {
    const parts = makeMonitor((_r, i) => (i === 0 ? newOutput() : second), speech ? { speech } : {});
    parts.monitor.onStt(interim(STABLE));
    await parts.monitor.whenIdle();
    parts.monitor.onStt(interim(later));
    await parts.monitor.whenIdle();
    return parts;
  }

  it('WITHDRAW で候補を閉じ、対応する未再生の音声を破棄する（反例「本人が解消」のコードの層）', async () => {
    const cancelled: string[] = [];
    const { store, sink } = await withCandidate(
      output({ decision: 'WITHDRAW', target_candidate_id: 'c_0001', withdraw_reason: '解消', withdraw_evidence_span: '追加で出してもらえる', withdraw_evidence_segment_ids: [0] }),
      { prepare: () => ({ audio_playback_id: 3, generation: 1 }), cancel: (_id, r) => cancelled.push(r) },
    );
    expect(store.list()).toHaveLength(0);
    expect(decisions(sink)).toEqual(['NEW', 'WITHDRAW']);
    expect(sink.ofType('initiative.decision')[1]).toMatchObject({ withdraw_evidence_segment_ids: { value: [0], source: 'verified' } });
    expect(cancelled).toEqual(['candidate_withdrawn']);
  });

  it('入力にない根拠の WITHDRAW は棄却し、候補を残す', async () => {
    const { store, sink } = await withCandidate(
      output({ decision: 'WITHDRAW', target_candidate_id: 'c_0001', withdraw_evidence_span: '言っていない内容', withdraw_evidence_segment_ids: [0] }),
    );
    expect(store.list()).toHaveLength(1);
    expect(discards(sink)[0]).toContain('withdraw_rejected');
  });

  it('LLM が作った候補 ID の KEEP は棄却する', async () => {
    const { sink } = await withCandidate(output({ decision: 'KEEP', target_candidate_id: 'c_made_up' }));
    expect(decisions(sink)).toEqual(['NEW']);
    expect(discards(sink)[0]).toContain('target_candidate_not_in_input');
  });

  it('KEEP は版を変えず、根拠の残存を検証結果として記録する', async () => {
    const { store, sink } = await withCandidate(output({ decision: 'KEEP', target_candidate_id: 'c_0001' }));
    expect(store.get('c_0001')?.candidate_version).toBe(1);
    expect(sink.ofType('initiative.decision')[1]).toMatchObject({ decision: 'KEEP', evidence_valid: { value: true } });
  });

  it('REVISE は版を上げ、古い音声を破棄して作り直す', async () => {
    const cancelled: number[] = [];
    let next = 10;
    const { store } = await withCandidate(
      output({ decision: 'REVISE', target_candidate_id: 'c_0001', evidence_span: '部長に相談', evidence_segment_ids: [0], proposed_utterance: '新しい案' }),
      { prepare: () => ({ audio_playback_id: next++, generation: 1 }), cancel: (id) => cancelled.push(id) },
    );
    expect(store.get('c_0001')).toMatchObject({ candidate_version: 2, proposed_utterance: '新しい案' });
    expect(cancelled).toEqual([10]);
  });

  it('応答待ちの間に版が変わった REVISE は棄却する', async () => {
    const gates = [deferred<string>()];
    const parts = makeMonitor((_r, i) => (i === 0 ? newOutput() : gates[0]!.promise));
    parts.monitor.onStt(interim(STABLE));
    await parts.monitor.whenIdle();
    parts.monitor.onStt(interim(later));
    await new Promise((r) => setTimeout(r, 0));
    parts.store.update('c_0001', 1, { proposed_utterance: '別経路の更新' }, 0);
    gates[0]!.resolve(output({ decision: 'REVISE', target_candidate_id: 'c_0001', evidence_span: '部長に相談', evidence_segment_ids: [0], proposed_utterance: 'x' }));
    await parts.monitor.whenIdle();
    expect(discards(parts.sink)[0]).toContain('target_candidate_version_changed');
    expect(parts.store.get('c_0001')?.proposed_utterance).toBe('別経路の更新');
  });

  it('活動中の候補があるときの別の NEW は棄却する', async () => {
    const { store, sink } = await withCandidate(newOutput({ evidence_span: '部長に相談' }));
    expect(store.list()).toHaveLength(1);
    expect(discards(sink)[0]).toContain('active_candidate_exists');
  });
});

describe('失敗の扱い', () => {
  it('プロバイダの失敗で止まらず、理由を残して次の増分で再度実行する', async () => {
    const { monitor, sink, llm } = makeMonitor((_r, i) => {
      if (i === 0) throw new Error('HTTP 503');
      return output({});
    });
    monitor.onStt(interim('あいうえおかきくけこ'));
    await monitor.whenIdle();
    expect(discards(sink)).toEqual(['provider_error']);
    monitor.onStt(interim('あいうえおかきくけこさしすせそたちつてと'));
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(2);
  });

  it('未知の列挙値は棄却する', async () => {
    const { monitor, sink, store } = makeMonitor(() => JSON.stringify({ decision: 'CLARIFY' }));
    monitor.onStt(interim(STABLE));
    await monitor.whenIdle();
    expect(store.list()).toHaveLength(0);
    expect(discards(sink)).toEqual(['model_output_unknown_decision']);
  });
});
