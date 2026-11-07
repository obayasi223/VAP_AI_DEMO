/**
 * E2a の候補ストアと状態機械。判定は手で作ったもので、LLM の判断は何も試していない。
 */
import { describe, expect, it } from 'vitest';
import { modelOutput } from '@llm-vap/contracts';
import type { CandidateRef } from '@llm-vap/contracts';
import { FakeSpeech, keepD, newD, noneD, reviseD, rig, seg, STABLE, withdrawD } from './helpers';

const changes = (sink: ReturnType<typeof rig>['sink']) =>
  sink.ofType('candidate.state_changed').map((e) => ({
    id: e.candidate_id,
    v: e.candidate_version,
    from: e.from,
    to: e.to,
    by: e.cause_source === 'code' ? e.cause : e.decision,
  }));
const rejects = (sink: ReturnType<typeof rig>['sink']) => sink.ofType('candidate.rejected');

function created(r: ReturnType<typeof rig>, over: Parameters<typeof newD>[0] = {}): CandidateRef {
  const result = r.ledger.applyModelDecision(newD(over));
  if (!result.ok || !result.ref) throw new Error(`NEW failed: ${JSON.stringify(result)}`);
  return result.ref;
}

describe('採番と作成（NEW）', () => {
  it('E2a が c_0001 版1を振り、INTENT_READY で登録して state_changed を出す', () => {
    const r = rig();
    const result = r.ledger.applyModelDecision(newD({ request_id: 'ini_a' }));
    expect(result).toMatchObject({
      ok: true,
      ref: { candidate_id: 'c_0001', candidate_version: 1 },
      from: null,
      to: 'INTENT_READY',
      evidence_segment_ids: { source: 'verified', value: [1] },
    });
    expect(sink(r)).toEqual([{ id: 'c_0001', v: 1, from: null, to: 'INTENT_READY', by: 'NEW' }]);
    expect(r.sink.ofType('candidate.state_changed')[0]).toMatchObject({ request_id: 'ini_a' });
    expect(r.ledger.want()).toEqual({ kind: 'candidate', candidate_id: 'c_0001', candidate_version: 1, state: 'INTENT_READY' });
  });

  it('活動中の候補があれば、次の NEW は番号を振って登録と同時に撤回する（from=null）', () => {
    const r = rig();
    created(r);
    const second = r.ledger.applyModelDecision(newD({ rev: 11 }));
    expect(second).toMatchObject({ ok: false, reason: 'active_candidate_exists', ref: { candidate_id: 'c_0002' } });
    expect(sink(r)[1]).toEqual({ id: 'c_0002', v: 1, from: null, to: 'WITHDRAWN', by: 'active_candidate_exists' });
    expect(r.ledger.want()).toMatchObject({ candidate_id: 'c_0001' });
    expect(rejects(r.sink)).toHaveLength(0);
  });

  it('上限が2なら2つ目を受け付ける', () => {
    const r = rig({ max_active_candidates: 2 });
    created(r);
    expect(r.ledger.applyModelDecision(newD({ rev: 11 })).ok).toBe(true);
    expect(r.ledger.list()).toHaveLength(2);
  });
});

describe('状態遷移の経路（コードから）', () => {
  it('吸気 → 保持 → DEFERRED → 発話 → 発話済み', () => {
    const r = rig();
    const ref = created(r);
    const speech = r.speech as FakeSpeech;
    const pid = speech.prepare(ref);
    expect(r.ledger.transition(ref.candidate_id, 'BREATH_INHALE', 'signal_gate_allowed', 1100).ok).toBe(true);
    expect(r.ledger.transition(ref.candidate_id, 'BREATH_HOLD_OR_READY', 'inhale_completed', 1500).ok).toBe(true);
    expect(r.ledger.transition(ref.candidate_id, 'DEFERRED', 'user_continued', 1800).ok).toBe(true);
    expect(r.ledger.startSpeech(ref.candidate_id, 1, pid, 'turn_allowed', 2500)).toMatchObject({ ok: true, generation: 1 });
    expect(speech.starts[0]).toEqual({ audio_playback_id: pid, expected: ref });
    expect(r.ledger.finishSpeech(ref.candidate_id, pid, 'speech_finished', 4000).ok).toBe(true);
    expect(sink(r).map((c) => `${c.from}>${c.to}:${c.by}`)).toEqual([
      'null>INTENT_READY:NEW',
      'INTENT_READY>BREATH_INHALE:signal_gate_allowed',
      'BREATH_INHALE>BREATH_HOLD_OR_READY:inhale_completed',
      'BREATH_HOLD_OR_READY>DEFERRED:user_continued',
      'DEFERRED>SPEAKING:turn_allowed',
      'SPEAKING>SPOKEN:speech_finished',
    ]);
    expect(r.ledger.want()).toEqual({ kind: 'none' });
    expect(r.ledger.getRecord(ref.candidate_id)?.timeline).toMatchObject({ decided_at: 1000, resolved_at: 4000 });
  });

  it('合図なしの条件: INTENT_READY から招待で直接話す', () => {
    const r = rig();
    const ref = created(r);
    const pid = (r.speech as FakeSpeech).prepare(ref);
    expect(r.ledger.startSpeech(ref.candidate_id, 1, pid, 'invitation', 1200).ok).toBe(true);
  });

  it.each([
    ['INTENT_READY → DEFERRED', 'DEFERRED', 'user_continued', 'invalid_transition'],
    ['原因の違う吸気', 'BREATH_INHALE', 'turn_allowed', 'cause_not_allowed'],
  ] as const)('不正な遷移は拒否し、状態を変えず、理由を candidate.rejected に残す: %s', (_n, to, cause, reason) => {
    const r = rig();
    const ref = created(r);
    expect(r.ledger.transition(ref.candidate_id, to, cause, 1100)).toMatchObject({ ok: false, reason });
    expect(r.ledger.get(ref.candidate_id)?.state).toBe('INTENT_READY');
    expect(rejects(r.sink)[0]).toMatchObject({
      source: 'code',
      operation: 'transition',
      current_state: 'INTENT_READY',
      requested_state: to,
      cause,
      reason,
      request_id: { value: null },
    });
  });

  it('終わった候補は動かせない', () => {
    const r = rig();
    const ref = created(r);
    r.ledger.transition(ref.candidate_id, 'WITHDRAWN', 'woz', 1100);
    const pid = (r.speech as FakeSpeech).prepare(ref);
    expect(r.ledger.startSpeech(ref.candidate_id, 1, pid, 'turn_allowed', 1200)).toMatchObject({
      ok: false,
      reason: 'invalid_transition',
      details: ['terminal_state'],
    });
    expect((r.speech as FakeSpeech).starts).toHaveLength(0);
  });

  it('SPEAKING は transition でなく startSpeech でだけ入る（D の版の照合を通すため）', () => {
    const r = rig();
    const ref = created(r);
    expect(r.ledger.transition(ref.candidate_id, 'SPEAKING', 'turn_allowed', 1100)).toMatchObject({
      ok: false,
      details: ['use_startSpeech'],
    });
  });

  it('知らない候補と、版の違う要求は拒否する', () => {
    const r = rig();
    const ref = created(r);
    expect(r.ledger.transition('c_9999', 'WITHDRAWN', 'woz', 1100)).toMatchObject({ reason: 'unknown_candidate' });
    expect(r.ledger.transition(ref.candidate_id, 'WITHDRAWN', 'woz', 1100, 2)).toMatchObject({ reason: 'version_mismatch' });
    expect(r.ledger.get(ref.candidate_id)?.state).toBe('INTENT_READY');
  });

  it('別の再生の終了報告では発話済みにしない（世代違い）', () => {
    const r = rig();
    const ref = created(r);
    const pid = (r.speech as FakeSpeech).prepare(ref);
    r.ledger.startSpeech(ref.candidate_id, 1, pid, 'turn_allowed', 1200);
    expect(r.ledger.finishSpeech(ref.candidate_id, pid + 7, 'speech_finished', 1300)).toMatchObject({
      ok: false,
      details: expect.arrayContaining(['playback_mismatch']),
    });
    expect(r.ledger.get(ref.candidate_id)?.state).toBe('SPEAKING');
  });

  it('D が開始を拒否したら状態を変えない（準備未完了）', () => {
    const r = rig();
    const ref = created(r);
    const pid = (r.speech as FakeSpeech).prepare(ref, false);
    expect(r.ledger.startSpeech(ref.candidate_id, 1, pid, 'turn_allowed', 1200)).toMatchObject({
      ok: false,
      reason: 'speech_start_refused',
      speech_refusal: 'not_ready',
    });
    expect(r.ledger.get(ref.candidate_id)?.state).toBe('INTENT_READY');
    expect(rejects(r.sink)[0]).toMatchObject({ operation: 'speech_start', details: ['not_ready', `audio_playback_id=${pid}`] });
  });
});

describe('版と PCM の一致', () => {
  it('REVISE は版を進め、状態を変えず、旧版の PCM を棄てる', () => {
    const r = rig();
    const speech = r.speech as FakeSpeech;
    const ref = created(r);
    r.ledger.transition(ref.candidate_id, 'BREATH_INHALE', 'signal_gate_allowed', 1100);
    const oldPid = speech.prepare(ref);
    const result = r.ledger.applyModelDecision(reviseD(ref, { rev: 12, span: '部長は追加で', ids: [2], utter: '部長に確認しますか？' }));
    expect(result).toMatchObject({ ok: true, ref: { candidate_version: 2 }, from: 'BREATH_INHALE', to: 'BREATH_INHALE' });
    expect(speech.discards).toEqual([{ candidate_id: ref.candidate_id, reason: 'candidate_revised', keep_version: 2 }]);
    expect(speech.prepared.has(oldPid)).toBe(false);
    expect(sink(r)[2]).toEqual({ id: ref.candidate_id, v: 2, from: 'BREATH_INHALE', to: 'BREATH_INHALE', by: 'REVISE' });
    expect(r.ledger.get(ref.candidate_id)).toMatchObject({ proposed_utterance: '部長に確認しますか？', evidence_segment_ids: [2] });
  });

  it('旧版の再生 ID で話し始めようとしても D の照合で拒否される', () => {
    const r = rig();
    const speech = r.speech as FakeSpeech;
    const ref = created(r);
    const oldPid = speech.prepare(ref);
    r.ledger.applyModelDecision(reviseD(ref, { rev: 12 }));
    // 古い版で要求すると E2a で止まる。
    expect(r.ledger.startSpeech(ref.candidate_id, 1, oldPid, 'turn_allowed', 1300)).toMatchObject({ reason: 'version_mismatch' });
    // 版は合っていても PCM が旧版なら D が拒否する。
    speech.prepared.set(oldPid, { ...ref, ready: true });
    expect(r.ledger.startSpeech(ref.candidate_id, 2, oldPid, 'turn_allowed', 1300)).toMatchObject({
      reason: 'speech_start_refused',
      speech_refusal: 'candidate_mismatch',
    });
    expect(speech.starts.at(-1)?.expected).toEqual({ candidate_id: ref.candidate_id, candidate_version: 2 });
  });

  it('WITHDRAW と期限切れはすべての版の PCM を棄てる', () => {
    const r = rig({ candidate_expiry_ms: 5000 });
    const speech = r.speech as FakeSpeech;
    const a = created(r);
    r.ledger.applyModelDecision(withdrawD(a, { rev: 12 }));
    const b = created(r, { rev: 13 });
    r.ledger.tick(1000 + 4999);
    expect(r.ledger.get(b.candidate_id)?.state).toBe('INTENT_READY');
    r.ledger.tick(1000 + 5000);
    expect(speech.discards).toEqual([
      { candidate_id: a.candidate_id, reason: 'candidate_withdrawn', keep_version: undefined },
      { candidate_id: b.candidate_id, reason: 'expired', keep_version: undefined },
    ]);
  });
});

describe('モデルの撤回（WITHDRAW）', () => {
  it('後続の発話の根拠で撤回し、撤回理由はモデル出力、区間は検証結果として残す', () => {
    const r = rig();
    const ref = created(r);
    const result = r.ledger.applyModelDecision(withdrawD(ref, { rev: 12, request_id: 'ini_w' }));
    expect(result).toMatchObject({ ok: true, to: 'WITHDRAWN', withdraw_evidence_segment_ids: { source: 'verified', value: [2] } });
    expect(r.ledger.getRecord(ref.candidate_id)?.withdraw).toEqual({
      source: 'model_decision',
      request_id: 'ini_w',
      withdraw_reason: { source: 'model_output', value: '本人が補足した' },
      evidence_segment_ids: { source: 'verified', value: [2], method: 'e2a_listed_segments_contain_span_after_candidate' },
    });
    expect(r.sink.ofType('candidate.state_changed')[1]).toMatchObject({ cause_source: 'model_decision', decision: 'WITHDRAW', request_id: 'ini_w' });
  });

  it('候補の根拠より前の発話を根拠にした撤回は採用しない', () => {
    const r = rig();
    const ref = created(r);
    const result = r.ledger.applyModelDecision(withdrawD(ref, { rev: 12, span: '来週の展示会', ids: [1] }));
    expect(result).toMatchObject({ ok: false, reason: 'withdraw_evidence_invalid', details: ['withdraw_evidence_not_after_candidate'] });
    expect(r.ledger.get(ref.candidate_id)?.state).toBe('INTENT_READY');
  });

  it('SPEAKING の候補には内容の判定を当てない', () => {
    const r = rig();
    const ref = created(r);
    const pid = (r.speech as FakeSpeech).prepare(ref);
    r.ledger.startSpeech(ref.candidate_id, 1, pid, 'turn_allowed', 1100);
    expect(r.ledger.applyModelDecision(withdrawD(ref, { rev: 12 }))).toMatchObject({ reason: 'state_not_applicable' });
    expect(r.ledger.applyModelDecision(reviseD(ref, { rev: 12 }))).toMatchObject({ reason: 'state_not_applicable' });
    expect(r.ledger.get(ref.candidate_id)?.state).toBe('SPEAKING');
  });
});

describe('判定の順序（古い transcript_revision の結果が新しい状態を上書きしない）', () => {
  it('REVISE（rev 14）の後に届いた rev 12 の KEEP／REVISE／WITHDRAW は棄てる', () => {
    const r = rig();
    const ref = created(r, { rev: 10 });
    const v2 = r.ledger.applyModelDecision(reviseD(ref, { rev: 14, utter: '新しい文' }));
    expect(v2.ok).toBe(true);
    const v2ref = { candidate_id: ref.candidate_id, candidate_version: 2 };
    for (const late of [keepD(v2ref, { rev: 12 }), reviseD(v2ref, { rev: 12, utter: '古い文' }), withdrawD(v2ref, { rev: 12 })]) {
      expect(r.ledger.applyModelDecision(late)).toMatchObject({ ok: false, reason: 'stale_transcript_revision' });
    }
    expect(r.ledger.get(ref.candidate_id)).toMatchObject({ candidate_version: 2, state: 'INTENT_READY', proposed_utterance: '新しい文' });
    expect(rejects(r.sink).map((e) => [e.operation, e.input_transcript_revision, e.applied_transcript_revision])).toEqual([
      ['KEEP', { value: 12 }, { value: 14 }],
      ['REVISE', { value: 12 }, { value: 14 }],
      ['WITHDRAW', { value: 12 }, { value: 14 }],
    ]);
  });

  it('NONE の拒否は operation=NONE で記録する（NEW と区別する）', () => {
    const r = rig();
    r.ledger.applyModelDecision(noneD({ rev: 20 }));
    expect(r.ledger.applyModelDecision(noneD({ rev: 18 }))).toMatchObject({ ok: false, reason: 'stale_transcript_revision' });
    expect(rejects(r.sink).at(-1)).toMatchObject({ operation: 'NONE', requested_state: null });
  });

  it('新しい NONE の後に届いた古い NEW は候補にしない', () => {
    const r = rig();
    r.ledger.applyModelDecision(noneD({ rev: 20 }));
    expect(r.ledger.applyModelDecision(newD({ rev: 18 }))).toMatchObject({ ok: false, reason: 'stale_transcript_revision' });
    expect(r.ledger.list()).toHaveLength(0);
    // 番号は消費しない。
    expect(created(r, { rev: 20 }).candidate_id).toBe('c_0001');
  });

  it('同じ revision の判定は受ける', () => {
    const r = rig();
    const ref = created(r, { rev: 10 });
    expect(r.ledger.applyModelDecision(keepD(ref, { rev: 10 })).ok).toBe(true);
  });

  it('同じ旧版を狙う2つの REVISE は、先に適用した方だけが通る（版違い）', () => {
    const r = rig();
    const ref = created(r, { rev: 10 });
    expect(r.ledger.applyModelDecision(reviseD(ref, { rev: 12, utter: '一つ目' })).ok).toBe(true);
    expect(r.ledger.applyModelDecision(reviseD(ref, { rev: 13, utter: '二つ目' }))).toMatchObject({
      reason: 'version_mismatch',
      details: ['expected=1', 'current=2'],
    });
    expect(r.ledger.get(ref.candidate_id)?.proposed_utterance).toBe('一つ目');
  });

  it('棄てた判定は順序の基準を進めない', () => {
    const r = rig();
    const ref = created(r, { rev: 10 });
    r.ledger.applyModelDecision(reviseD({ ...ref, candidate_version: 5 }, { rev: 30 }));
    expect(r.ledger.appliedTranscriptRevision()).toBe(10);
  });
});

describe('世代（segment_id）', () => {
  it('前の segment の入力から出た判定は棄てる', () => {
    const r = rig();
    const ref = created(r, { rev: 10 });
    const pid = (r.speech as FakeSpeech).prepare(ref);
    r.ledger.startSpeech(ref.candidate_id, 1, pid, 'turn_allowed', 1100);
    r.ledger.onSegmentChanged(1, 1100);
    expect(r.ledger.applyModelDecision(newD({ rev: 11, segment_id: 0 }))).toMatchObject({ reason: 'stale_segment' });
  });

  it('segment が変わると未発話の候補を撤回する（未校正の null は安全側の true）。SPEAKING は残す', () => {
    const r = rig({ max_active_candidates: 2 });
    const a = created(r);
    const b = created(r, { rev: 11 });
    const pid = (r.speech as FakeSpeech).prepare(b);
    r.ledger.startSpeech(b.candidate_id, 1, pid, 'turn_allowed', 1100);
    r.ledger.onSegmentChanged(1, 1100);
    expect(r.ledger.get(a.candidate_id)?.state).toBe('WITHDRAWN');
    expect(r.ledger.get(b.candidate_id)?.state).toBe('SPEAKING');
    expect(sink(r).find((c) => c.id === a.candidate_id && c.to === 'WITHDRAWN')?.by).toBe('expired');
  });

  it('false なら segment の変更では撤回しない', () => {
    const r = rig({ candidate_expires_on_segment_change: false });
    const a = created(r);
    r.ledger.onSegmentChanged(1, 1100);
    expect(r.ledger.get(a.candidate_id)?.state).toBe('INTENT_READY');
  });

  it('新しい segment の判定が先に届いたら segment を進める', () => {
    const r = rig();
    const a = created(r);
    r.ledger.applyModelDecision(noneD({ rev: 11, segment_id: 2 }));
    expect(r.ledger.segmentId()).toBe(2);
    expect(r.ledger.get(a.candidate_id)?.state).toBe('WITHDRAWN');
  });
});

describe('根拠の検証（追補1: 入力と照合できない根拠は採用しない）', () => {
  it.each([
    ['入力にない span', { span: '百万円の予算' }, 'evidence_not_in_input_stable_text'],
    ['存在しない区間 ID', { ids: [9] }, 'evidence_segment_id_unknown'],
    ['挙げた区間に span がない', { ids: [2] }, 'evidence_span_not_in_listed_segments'],
    ['区間 ID が空', { ids: [] }, 'evidence_segment_ids_empty'],
    ['短すぎる一致', { span: 'の' }, 'evidence_too_short'],
  ] as const)('%s', (_n, over, detail) => {
    const r = rig();
    const result = r.ledger.applyModelDecision(newD(over as Parameters<typeof newD>[0]));
    expect(result).toMatchObject({ ok: false, reason: 'evidence_invalid' });
    expect(!result.ok && result.details).toContain(detail);
    expect(r.ledger.list()).toHaveLength(0);
    expect(rejects(r.sink)[0]).toMatchObject({ candidate_id: { value: null }, operation: 'NEW', reason: 'evidence_invalid' });
  });

  it('入力にはあったが最新の安定テキストから消えた根拠と区間', () => {
    const r = rig();
    r.state.stable = [seg(2, '進めようと思っていて。でも部長は追加で出してもらえると')];
    const result = r.ledger.applyModelDecision(newD({}));
    expect(!result.ok && result.details).toEqual(
      expect.arrayContaining(['evidence_not_in_latest_stable_text', 'evidence_segment_id_not_in_latest']),
    );
  });

  it('発話文が空なら採用しない', () => {
    const r = rig();
    expect(r.ledger.applyModelDecision(newD({ utter: '  ' }))).toMatchObject({ reason: 'proposed_utterance_empty' });
  });

  it('REVISE の根拠も照合し、合わなければ版を進めない', () => {
    const r = rig();
    const ref = created(r);
    expect(r.ledger.applyModelDecision(reviseD(ref, { rev: 12, span: '言っていない' }))).toMatchObject({ reason: 'evidence_invalid' });
    expect(r.ledger.get(ref.candidate_id)?.candidate_version).toBe(1);
  });

  it('KEEP でも根拠が消えていればコード由来で撤回する', () => {
    const r = rig();
    const ref = created(r);
    r.state.stable = [seg(1, '来週の展示会ですが、予算は'), STABLE[1]!];
    expect(r.ledger.applyModelDecision(keepD(ref, { rev: 12 }))).toMatchObject({ ok: true, to: 'WITHDRAWN' });
    expect(sink(r)[1]).toMatchObject({ to: 'WITHDRAWN', by: 'evidence_lost' });
  });

  it('ASR の書き換えで根拠が消えたら sweepEvidence で撤回する', () => {
    const r = rig();
    const ref = created(r);
    r.ledger.sweepEvidence(1100);
    expect(r.ledger.get(ref.candidate_id)?.state).toBe('INTENT_READY');
    r.state.stable = [seg(1, '来週の展示会ですが、予算は')];
    r.ledger.sweepEvidence(1200);
    expect(r.ledger.get(ref.candidate_id)?.state).toBe('WITHDRAWN');
  });
});

describe('話の後に届いた NEW（E3 で調停するまでの規則: 記録して保留し、人が再開したら照合し直して候補にする）', () => {
  it('人が MIN_GAP 以上黙った後の NEW は候補にせず保留し、want は none のまま', () => {
    const r = rig();
    r.ledger.observeUserFloor(true, 0);
    r.ledger.observeUserFloor(false, 400);
    const result = r.ledger.applyModelDecision(newD({ at: 900, request_id: 'ini_late' }));
    expect(result).toMatchObject({ ok: false, reason: 'post_turn_new_held', held: true, ref: null });
    expect(r.ledger.want()).toEqual({ kind: 'none' });
    expect(r.ledger.heldPostTurn()?.decision.request_id).toBe('ini_late');
    expect(rejects(r.sink)[0]).toMatchObject({ held: true, reason: 'post_turn_new_held', candidate_id: { value: null } });
    expect(r.sink.ofType('candidate.state_changed')).toHaveLength(0);
  });

  it('黙ってから MIN_GAP 未満なら話の途中として候補にする', () => {
    const r = rig();
    r.ledger.observeUserFloor(false, 600);
    expect(r.ledger.applyModelDecision(newD({ at: 1099 })).ok).toBe(true);
  });

  it('人の発話の状態が未報告なら保留しない（配線の前と同じ動作）', () => {
    const r = rig();
    expect(r.ledger.applyModelDecision(newD({ at: 99999 })).ok).toBe(true);
  });

  it('人が話を再開したら（話の途中の間だった）保留を棄てず、根拠と順序を照合し直して候補にする', () => {
    const r = rig();
    r.ledger.observeUserFloor(false, 0);
    r.ledger.applyModelDecision(newD({ at: 1000, request_id: 'ini_pause' }));
    const promoted = r.ledger.observeUserFloor(true, 2000);
    expect(promoted).toMatchObject({ request_id: 'ini_pause', result: { ok: true, ref: { candidate_id: 'c_0001', candidate_version: 1 } } });
    expect(r.ledger.heldPostTurn()).toBeNull();
    expect(r.ledger.get('c_0001')).toMatchObject({ state: 'INTENT_READY', decided_at: 2000 });
    expect(r.sink.ofType('candidate.state_changed')).toMatchObject([
      { candidate_id: 'c_0001', from: null, to: 'INTENT_READY', cause_source: 'model_decision', decision: 'NEW', request_id: 'ini_pause' },
    ]);
    expect(rejects(r.sink).map((e) => e.reason)).toEqual(['post_turn_new_held']);
  });

  it('人が再開しても、照合に通らなければ（根拠の消失、順序の逆転）棄てて理由を残す', () => {
    const lost = rig();
    lost.ledger.observeUserFloor(false, 0);
    lost.ledger.applyModelDecision(newD({ at: 1000 }));
    lost.state.stable = [];
    expect(lost.ledger.observeUserFloor(true, 2000)).toMatchObject({ result: { ok: false, reason: 'evidence_invalid' } });
    expect(lost.ledger.list()).toHaveLength(0);
    expect(rejects(lost.sink).at(-1)).toMatchObject({ reason: 'evidence_invalid', operation: 'NEW' });

    const stale = rig();
    stale.ledger.observeUserFloor(false, 0);
    stale.ledger.applyModelDecision(newD({ at: 1000, rev: 10 }));
    stale.ledger.applyModelDecision(noneD({ at: 1100, rev: 12 }));
    expect(stale.ledger.observeUserFloor(true, 2000)).toMatchObject({ result: { ok: false, reason: 'stale_transcript_revision' } });
    expect(rejects(stale.sink).at(-1)).toMatchObject({ reason: 'stale_transcript_revision', details: ['promote'] });
    expect(stale.ledger.list()).toHaveLength(0);
  });

  it('人が再開しないまま通常応答が始まったら保留を棄てる。segment の変更でも棄てる', () => {
    for (const drop of [
      (r: ReturnType<typeof rig>) => r.ledger.onNormalResponseStarted(2000),
      (r: ReturnType<typeof rig>) => r.ledger.onSegmentChanged(1, 2000),
    ]) {
      const r = rig();
      r.ledger.observeUserFloor(false, 0);
      r.ledger.applyModelDecision(newD({ at: 1000 }));
      drop(r);
      expect(r.ledger.heldPostTurn()).toBeNull();
      expect(rejects(r.sink).at(-1)).toMatchObject({ reason: 'held_dropped', held: false, operation: 'held' });
    }
  });

  it('promoteHeld（E3 の入口）で、照合をやり直して候補にする', () => {
    const r = rig();
    r.ledger.observeUserFloor(false, 0);
    r.ledger.applyModelDecision(newD({ at: 1000 }));
    expect(r.ledger.promoteHeld(1500)).toMatchObject({ ok: true, ref: { candidate_id: 'c_0001' } });
    expect(r.ledger.get('c_0001')?.decided_at).toBe(1500);
  });

  it('promoteHeld でも根拠が消えていれば候補にしない', () => {
    const r = rig();
    r.ledger.observeUserFloor(false, 0);
    r.ledger.applyModelDecision(newD({ at: 1000 }));
    r.state.stable = [];
    expect(r.ledger.promoteHeld(1500)).toMatchObject({ ok: false, reason: 'evidence_invalid' });
  });
});

describe('期限と通常応答', () => {
  it('期限が null（未校正）なら時間では撤回しない', () => {
    const r = rig();
    const ref = created(r);
    r.ledger.tick(10_000_000);
    expect(r.ledger.get(ref.candidate_id)?.state).toBe('INTENT_READY');
  });

  it('期限は決定の時刻から数え、KEEP では延びない。SPEAKING は期限で撤回しない', () => {
    const r = rig({ candidate_expiry_ms: 3000, max_active_candidates: 2 });
    const a = created(r, { at: 1000 });
    r.ledger.applyModelDecision(keepD(a, { rev: 11, at: 3500 }));
    const b = created(r, { rev: 12, at: 1000 });
    const pid = (r.speech as FakeSpeech).prepare(b);
    r.ledger.startSpeech(b.candidate_id, 1, pid, 'turn_allowed', 1200);
    r.ledger.tick(4000);
    expect(r.ledger.get(a.candidate_id)?.state).toBe('WITHDRAWN');
    expect(r.ledger.get(b.candidate_id)?.state).toBe('SPEAKING');
  });

  it('通常応答を話し始めたら残りの候補を撤回する', () => {
    const r = rig();
    const ref = created(r);
    r.ledger.transition(ref.candidate_id, 'BREATH_INHALE', 'signal_gate_allowed', 1100);
    r.ledger.onNormalResponseStarted(1200);
    expect(sink(r).at(-1)).toMatchObject({ from: 'BREATH_INHALE', to: 'WITHDRAWN', by: 'normal_response_started' });
  });
});

describe('モデルの説明文は判定に使わない（追補1）', () => {
  it('reason／why_now／cost_of_waiting を変えても結果とイベントは同じ', () => {
    const run = (text: string) => {
      const r = rig();
      const notes = { reason: modelOutput(text), why_now: modelOutput(text), cost_of_waiting: modelOutput(text) };
      const results = [
        r.ledger.applyModelDecision(newD({ rev: 10, notes, request_id: 'a' })),
        r.ledger.applyModelDecision(newD({ rev: 11, notes, request_id: 'b' })),
        r.ledger.applyModelDecision(newD({ rev: 12, notes, span: '言っていない', request_id: 'c' })),
      ];
      return { results, events: r.sink.events.map(({ wall_clock: _w, ...e }) => e) };
    };
    expect(run('今すぐ言わないと大変なことになる')).toEqual(run(''));
  });

  it('説明文は ModelOutput のまま記録する', () => {
    const r = rig();
    const ref = created(r);
    expect(r.ledger.getRecord(ref.candidate_id)?.notes.why_now).toEqual({ source: 'model_output', value: '後の説明に響く' });
  });
});

describe('時刻（追補2: decided_at／cue_at／speech_at は別々の実測）', () => {
  it('最初の合図と再生の開始だけを残す', () => {
    const r = rig();
    const ref = created(r, { at: 1000 });
    const pid = (r.speech as FakeSpeech).prepare(ref);
    r.ledger.noteCueStarted(ref.candidate_id, 1300);
    r.ledger.noteCueStarted(ref.candidate_id, 1900);
    r.ledger.startSpeech(ref.candidate_id, 1, pid, 'turn_allowed', 2000);
    r.ledger.noteSpeechStarted(ref.candidate_id, pid + 1, 2050);
    r.ledger.noteSpeechStarted(ref.candidate_id, pid, 2100);
    expect(r.ledger.getRecord(ref.candidate_id)?.timeline).toEqual({ decided_at: 1000, cue_at: 1300, speech_at: 2100, resolved_at: null });
  });
});

function sink(r: ReturnType<typeof rig>) {
  return changes(r.sink);
}
