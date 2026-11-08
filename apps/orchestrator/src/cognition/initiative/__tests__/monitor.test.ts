/**
 * コードの層の試験。LLM の返答は台本どおりの test double で、モデルの判断は何も試していない。
 * 「ASR 誤認で抑止できる」はコードのゲートの性質であって、LLM の性能ではない（計画 §4.5a）。
 */
import { describe, expect, it } from 'vitest';
import { ManualTimeSource, modelOutput } from '@llm-vap/contracts';
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
    // 新しい増分では中断しない（中断は stop() だけ）。
    expect(llm.requests[0]!.signal?.aborted).toBe(false);
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

  it('final を受けたら増分が起動の文字数に満たなくても1回判定する（ターンの終わりを抜かさない）', async () => {
    // policy.ja.json と同じ 24／12 文字。final で足された増分は 12 文字未満。
    const { monitor, llm } = makeMonitor(() => output({}), { trigger: { min_new_stable_chars: 24, min_new_chars_at_boundary: 12 } });
    const first = 'あいうえおかきくけこさしすせそたちつてとなにぬね';
    monitor.onStt(interim(first));
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(1);
    monitor.onStt(final(`${first}のはひ。`));
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.messages[0]!.text).toContain('のはひ');
  });

  it('final で増分がなければ判定しない', async () => {
    const { monitor, llm } = makeMonitor(() => output({}));
    monitor.onStt(interim('あいうえおかきくけこ'));
    await monitor.whenIdle();
    monitor.onStt(final('あいうえおかきくけこ'));
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(1);
  });

  it('stop() は実行中の要求を中断する', async () => {
    const gate = deferred<string>();
    const { monitor, llm, sink } = makeMonitor(() => gate.promise);
    monitor.onStt(interim('あいうえおかきくけこ'));
    await new Promise((r) => setTimeout(r, 0));
    expect(llm.requests[0]!.signal?.aborted).toBe(false);
    monitor.stop();
    expect(llm.requests[0]!.signal?.aborted).toBe(true);
    gate.resolve(output({}));
    await monitor.whenIdle();
    expect(sink.ofType('initiative.decision')).toHaveLength(0);
    expect(sink.ofType('initiative.discarded')).toHaveLength(0);
  });

  it('判定の外の例外（E2a など）で止まらず、理由を initiative.discarded に残す', async () => {
    const parts = makeMonitor(() => output({}));
    let calls = 0;
    const original = parts.ledger.applyModelDecision.bind(parts.ledger);
    parts.ledger.applyModelDecision = (d) => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return original(d);
    };
    parts.monitor.onStt(interim('あいうえおかきくけこ'));
    await parts.monitor.whenIdle();
    expect(discards(parts.sink)).toEqual(['internal_error:Error: boom']);
    parts.monitor.onStt(interim('あいうえおかきくけこさしすせそたちつてと'));
    await parts.monitor.whenIdle();
    expect(decisions(parts.sink)).toEqual(['NONE']);
  });

  it('入力を区間の上限で切るときも、未解決の候補の根拠の区間は落とさない', async () => {
    const parts = makeMonitor(
      (_r, i) => (i === 0 ? newOutput() : output({})),
      { max_input_chars: 30 },
    );
    parts.monitor.onStt(final(`${STABLE}。`, 0));
    await parts.monitor.whenIdle();
    expect(parts.store.list()).toHaveLength(1);
    parts.monitor.onStt(final('あいうえおかきくけこさしすせそ。', 1));
    await parts.monitor.whenIdle();
    parts.monitor.onStt(final('たちつてとなにぬねのはひふへほ。', 2));
    await parts.monitor.whenIdle();
    const last = parts.llm.requests.at(-1)!.messages[0]!.text;
    // 候補の欄にも根拠の断片（五十万円）は出るので、区間の行にだけある語で確かめる。
    expect(last).toContain('予算は五十万円のままで進めます');
    expect(last).toContain('たちつてと');
    expect(last).not.toContain('あいうえお');
  });

  it('要求の上限に達したら止めて状態を報告する', async () => {
    const { monitor, llm, sink } = makeMonitor(() => output({}), { limits: { ...LIMITS, max_requests_per_session: 1 } });
    monitor.onStt(interim('あいうえおかきくけこ'));
    await monitor.whenIdle();
    monitor.onStt(interim('あいうえおかきくけこさしすせそたちつてと'));
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(1);
    // 判定用の LLM の行（応答用と同じ名前になりうる）でなく、監視の行へ出す。
    expect(sink.ofType('provider.status')[0]).toMatchObject({ status: 'degraded', provider: 'initiative_monitor' });
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
          ledger: makeMonitor(() => '').ledger,
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

  it('候補の登録後に根拠が書き換わったら、モデルを待たず E2a がコード由来で撤回し音声を破棄する', async () => {
    const { monitor, store, sink, speech } = makeMonitor(() => newOutput({ evidence_span: '五千万円' }));
    monitor.onStt(interim('出展料は五千万円です。'));
    await monitor.whenIdle();
    expect(store.list()).toHaveLength(1);
    monitor.onStt(interim('', '出展料は五十万円です'));
    expect(store.list()).toHaveLength(0);
    expect(sink.ofType('candidate.state_changed').map((e) => [e.cause_source, e.to])).toEqual([
      ['model_decision', 'INTENT_READY'],
      ['code', 'WITHDRAWN'],
    ]);
    expect(sink.ofType('candidate.state_changed')[1]).toMatchObject({ cause: 'evidence_lost' });
    expect(speech.discards).toEqual([{ candidate_id: 'c_0001', reason: 'evidence_lost', keep_version: undefined }]);
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

  it('空の reason はコードの値で埋めず、モデルが書かなかったと記録する', async () => {
    const { monitor, sink } = makeMonitor(() => newOutput({ reason: '' }));
    monitor.onStt(interim(STABLE));
    await monitor.whenIdle();
    expect(sink.ofType('initiative.decision')[0]).toMatchObject({
      decision: 'NEW',
      reason: { source: 'model_output', value: null, null_reason: 'model_left_empty' },
    });
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

  async function withCandidate(second: string) {
    const parts = makeMonitor((_r, i) => (i === 0 ? newOutput() : second));
    parts.monitor.onStt(interim(STABLE));
    await parts.monitor.whenIdle();
    parts.monitor.onStt(interim(later));
    await parts.monitor.whenIdle();
    return parts;
  }

  it('WITHDRAW で候補を閉じ、対応する未再生の音声を破棄する（反例「本人が解消」のコードの層）', async () => {
    const { store, sink, speech } = await withCandidate(
      output({ decision: 'WITHDRAW', target_candidate_id: 'c_0001', withdraw_reason: '解消', withdraw_evidence_span: '追加で出してもらえる', withdraw_evidence_segment_ids: [0] }),
    );
    expect(store.list()).toHaveLength(0);
    expect(decisions(sink)).toEqual(['NEW', 'WITHDRAW']);
    expect(sink.ofType('initiative.decision')[1]).toMatchObject({ withdraw_evidence_segment_ids: { value: [0], source: 'verified' } });
    // 遷移は E2a が1件だけ出す（monitor は出さない）。
    expect(sink.ofType('candidate.state_changed').map((e) => e.to)).toEqual(['INTENT_READY', 'WITHDRAWN']);
    expect(speech.discards.map((d) => d.reason)).toEqual(['candidate_withdrawn']);
  });

  it('空の withdraw_reason は reason で埋めず、reason は別の項目に残す', async () => {
    const { sink, ledger } = await withCandidate(
      output({ decision: 'WITHDRAW', target_candidate_id: 'c_0001', reason: '本人が補った', withdraw_reason: '', withdraw_evidence_span: '追加で出してもらえる', withdraw_evidence_segment_ids: [0] }),
    );
    expect(sink.ofType('initiative.decision')[1]).toMatchObject({
      decision: 'WITHDRAW',
      withdraw_reason: { source: 'model_output', value: null, null_reason: 'model_left_empty' },
      reason: { source: 'model_output', value: '本人が補った' },
    });
    expect(ledger.getRecord('c_0001')?.withdraw).toMatchObject({ withdraw_reason: { value: null, null_reason: 'model_left_empty' } });
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

  it('REVISE は版を上げ、旧い版の音声を E2a が破棄する', async () => {
    const { store, sink, speech } = await withCandidate(
      output({ decision: 'REVISE', target_candidate_id: 'c_0001', evidence_span: '部長に相談', evidence_segment_ids: [0], proposed_utterance: '新しい案' }),
    );
    expect(store.get('c_0001')).toMatchObject({ candidate_version: 2, proposed_utterance: '新しい案' });
    expect(sink.ofType('initiative.decision')[1]).toMatchObject({ decision: 'REVISE', candidate_version: 2 });
    expect(speech.discards).toEqual([{ candidate_id: 'c_0001', reason: 'candidate_revised', keep_version: 2 }]);
  });

  it('応答待ちの間に版が変わった REVISE は棄却する', async () => {
    const gates = [deferred<string>()];
    const parts = makeMonitor((_r, i) => (i === 0 ? newOutput() : gates[0]!.promise));
    parts.monitor.onStt(interim(STABLE));
    await parts.monitor.whenIdle();
    parts.monitor.onStt(interim(later));
    await new Promise((r) => setTimeout(r, 0));
    // 応答待ちの間に別の経路で版が進む（E2a へ直接 REVISE）。
    const other = parts.ledger.applyModelDecision({
      decision: 'REVISE',
      request_id: 'other',
      transcript_revision: parts.ledger.appliedTranscriptRevision() ?? 0,
      segment_id: 0,
      received_at: 0,
      input_segments: parts.monitor.stableSnapshot(),
      target: { candidate_id: 'c_0001', candidate_version: 1 },
      content: {
        intent_type: 'X',
        evidence_span: '五十万円',
        evidence_segment_ids: [0],
        proposed_utterance: '別経路の更新',
        expiry_policy: 'p',
        urgency: 'NORMAL',
      },
      notes: { reason: modelOutput('r'), why_now: modelOutput('w'), cost_of_waiting: modelOutput('c') },
    });
    expect(other.ok).toBe(true);
    gates[0]!.resolve(output({ decision: 'REVISE', target_candidate_id: 'c_0001', evidence_span: '部長に相談', evidence_segment_ids: [0], proposed_utterance: 'x' }));
    await parts.monitor.whenIdle();
    expect(discards(parts.sink)[0]).toBe('e2a_rejected:version_mismatch');
    expect(parts.sink.ofType('candidate.rejected').at(-1)).toMatchObject({ source: 'model_decision', operation: 'REVISE' });
    expect(parts.store.get('c_0001')?.proposed_utterance).toBe('別経路の更新');
  });

  it('活動中の候補があるときの別の NEW は E2a が棄却し、番号つきで initiative.discarded に残す', async () => {
    const { store, sink } = await withCandidate(newOutput({ evidence_span: '部長に相談' }));
    expect(store.list()).toHaveLength(1);
    expect(discards(sink)[0]).toBe('e2a_rejected:active_candidate_exists');
    expect(sink.ofType('initiative.discarded')[0]!.candidate_id).toEqual({ value: 'c_0002' });
    expect(sink.ofType('candidate.state_changed').at(-1)).toMatchObject({ candidate_id: 'c_0002', from: null, to: 'WITHDRAWN', cause: 'active_candidate_exists' });
    expect(decisions(sink)).toEqual(['NEW']);
  });
});

describe('失敗の扱い', () => {
  it('プロバイダの失敗で止まらず、理由を残し、待ちが明けてから次の増分で再度実行する（連打しない）', async () => {
    const { monitor, sink, llm, time, store } = makeMonitor((_r, i) => {
      if (i === 0) throw new Error('HTTP 503');
      return output({});
    });
    monitor.onStt(interim('あいうえおかきくけこ'));
    await monitor.whenIdle();
    expect(discards(sink)).toEqual(['provider_error:Error: HTTP 503;backoff_ms=2000']);
    expect(store.list()).toHaveLength(0);
    monitor.onStt(interim('あいうえおかきくけこさしすせそたちつてと'));
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(1);
    time.advance(1999);
    monitor.poll();
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(1);
    time.advance(1);
    monitor.poll();
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(2);
    expect(monitor.retryAfterMs()).toBeNull();
  });

  it('失敗した入力は判定済みにせず、増分がなくても待ちが明けたら poll で同じ入力から判定し直す', async () => {
    const { monitor, sink, llm, time } = makeMonitor((_r, i) => (i === 0 ? 'not json' : output({})));
    monitor.onStt(interim('あいうえおかきくけこ'));
    await monitor.whenIdle();
    expect(discards(sink)).toEqual(['model_output_not_json;backoff_ms=2000']);
    time.advance(2000);
    monitor.poll();
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.messages[0]!.text).toContain('あいうえおかきくけこ');
    expect(decisions(sink)).toEqual(['NONE']);
    // 判定できたら、増分のないまま poll しても再実行しない。
    time.advance(10_000);
    monitor.poll();
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(2);
  });

  it('final の判定が失敗しても、待ちが明けたらその final の入力を判定し直す', async () => {
    const { monitor, llm, time, sink } = makeMonitor((_r, i) => (i === 1 ? 'not json' : output({})), {
      trigger: { min_new_stable_chars: 24, min_new_chars_at_boundary: 12 },
    });
    const first = 'あいうえおかきくけこさしすせそたちつてとなにぬね';
    monitor.onStt(interim(first));
    await monitor.whenIdle();
    monitor.onStt(final(`${first}のはひ。`));
    await monitor.whenIdle();
    expect(discards(sink)).toEqual(['model_output_not_json;backoff_ms=2000']);
    time.advance(2000);
    monitor.poll();
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(3);
    expect(decisions(sink)).toEqual(['NONE', 'NONE']);
  });

  it('続けて失敗すると待ちを倍にし、成功で戻す', async () => {
    const { monitor, sink, time } = makeMonitor((_r, i) => (i < 2 ? 'not json' : output({})));
    let text = 'あいうえおかきくけこ';
    const more = () => {
      text += 'さしすせそたちつてと';
      monitor.onStt(interim(text));
    };
    monitor.onStt(interim(text));
    await monitor.whenIdle();
    time.advance(2000);
    more();
    await monitor.whenIdle();
    time.advance(4000);
    more();
    await monitor.whenIdle();
    expect(discards(sink)).toEqual(['model_output_not_json;backoff_ms=2000', 'model_output_not_json;backoff_ms=4000']);
    expect(decisions(sink)).toEqual(['NONE']);
    more();
    await monitor.whenIdle();
    expect(decisions(sink)).toEqual(['NONE', 'NONE']);
  });

  it('未知の列挙値は棄却する', async () => {
    const { monitor, sink, store } = makeMonitor(() => JSON.stringify({ decision: 'CLARIFY' }));
    monitor.onStt(interim(STABLE));
    await monitor.whenIdle();
    expect(store.list()).toHaveLength(0);
    expect(discards(sink)).toEqual(['model_output_unknown_decision;backoff_ms=2000']);
  });
});

describe('AI の開始の後に届いた文（noteAiStarted）', () => {
  const inSegment = <T extends { segment_id?: number }>(event: T, segment_id: number): T => ({ ...event, segment_id });

  it('前の segment の final と interim では起動しない', async () => {
    const { monitor, llm } = makeMonitor(() => output({}));
    monitor.noteAiStarted(1);
    monitor.onStt(inSegment(final('あいうえお。'), 0));
    monitor.onStt(inSegment(interim('あいうえおかきくけこさしすせそたちつてと'), 0));
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(0);
  });

  it('AI の開始の前に受けた final の「話し終わり」も、開始の後の segment へ持ち越さない', async () => {
    const gate = deferred<string>();
    const { monitor, llm } = makeMonitor(() => gate.promise);
    monitor.onStt(inSegment(final('あいうえお。'), 0));
    // 実行中に次の final（完了後に1回判定する印が立つ）。ここで AI が話し始める。
    monitor.onStt(inSegment(final('かきくけこ。', 1), 0));
    monitor.noteAiStarted(1);
    gate.resolve(output({}));
    await monitor.whenIdle();
    monitor.onStt(inSegment(interim('さしす', '', 2), 1));
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(1);
  });

  it('AI の開始の後の segment の文は起動する。前の segment の final の「話し終わり」は持ち越さない', async () => {
    const { monitor, llm } = makeMonitor(() => output({}));
    monitor.onStt(inSegment(final('あいうえお。'), 0));
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(1);
    monitor.noteAiStarted(1);
    monitor.onStt(inSegment(final('かきくけこ。', 1), 0));
    // 新しい segment の短い interim。final 扱いが残っていれば起動してしまう。
    monitor.onStt(inSegment(interim('さしす', '', 2), 1));
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(1);
    monitor.onStt(inSegment(final('さしすせそ。', 2), 1));
    await monitor.whenIdle();
    expect(llm.requests).toHaveLength(2);
  });
});
