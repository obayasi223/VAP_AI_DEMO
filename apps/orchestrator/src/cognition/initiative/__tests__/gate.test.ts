import { describe, expect, it } from 'vitest';
import { checkEvidence, checkFreshness, checkTarget, checkWithdrawEvidence } from '../gate';
import type { AsrSegmentSnapshot } from '../transcript_view';

const seg = (asr_segment_id: number, stable_text: string): AsrSegmentSnapshot => ({
  asr_segment_id,
  segment_id: 0,
  stable_text,
  is_final: false,
  audio_frame_end: 0,
});
const segments = [seg(1, '来週の展示会ですが、予算は五十万円のまま'), seg(2, '進めようと思っていて。')];
const base = { input: segments, latest: segments };

describe('checkEvidence', () => {
  it('句読点と空白の違いは無視する', () => {
    const r = checkEvidence({ ...base, span: '展示会 です が 予算は', segment_ids: [1] });
    expect(r.ok).toBe(true);
  });
  it('入力にない根拠は棄却する', () => {
    const r = checkEvidence({ ...base, span: '百万円の予算', segment_ids: [1] });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reasons).toContain('evidence_not_in_input_stable_text');
  });
  it('存在しない区間番号は棄却する', () => {
    const r = checkEvidence({ ...base, span: '展示会', segment_ids: [9] });
    expect(!r.ok && r.reasons).toContain('evidence_segment_id_unknown');
  });
  it('挙げた区間に span が含まれなければ棄却する', () => {
    const r = checkEvidence({ ...base, span: '進めよう', segment_ids: [1] });
    expect(!r.ok && r.reasons).toContain('evidence_span_not_in_listed_segments');
  });
  it('区間をまたぐ span は両方の区間を挙げれば通る', () => {
    expect(checkEvidence({ ...base, span: 'のまま進めよう', segment_ids: [2, 1] })).toEqual({ ok: true, segment_ids: [1, 2] });
  });
  it('区間番号が空なら棄却する', () => {
    const r = checkEvidence({ ...base, span: '展示会', segment_ids: [] });
    expect(!r.ok && r.reasons).toContain('evidence_segment_ids_empty');
  });
  it('短すぎる一致は根拠にしない', () => {
    const r = checkEvidence({ ...base, span: 'の', segment_ids: [1] });
    expect(!r.ok && r.reasons).toContain('evidence_too_short');
  });
  it('入力にあっても最新の安定テキストから消えていれば棄却する', () => {
    const r = checkEvidence({
      input: segments,
      latest: [seg(1, '来週の展示会ですが'), seg(2, '進めようと思っていて。')],
      span: '五十万円',
      segment_ids: [1],
    });
    expect(!r.ok && r.reasons).toContain('evidence_not_in_latest_stable_text');
  });
});

describe('checkFreshness', () => {
  const limits = { max_new_stable_chars_since_input: 60, max_result_age_ms: 6000 };
  it('上限以内なら通る', () => {
    expect(checkFreshness({ ...limits, new_stable_chars_since_input: 60, age_ms: 6000 }).ok).toBe(true);
  });
  it('新規の安定文字数が上限を超えたら棄却する', () => {
    const r = checkFreshness({ ...limits, new_stable_chars_since_input: 61, age_ms: 0 });
    expect(!r.ok && r.reasons).toEqual(['stale_too_many_new_stable_chars']);
  });
  it('経過時間が上限を超えたら棄却する', () => {
    const r = checkFreshness({ ...limits, new_stable_chars_since_input: 0, age_ms: 6001 });
    expect(!r.ok && r.reasons).toEqual(['stale_result_too_old']);
  });
});

describe('checkTarget', () => {
  const shown = [{ candidate_id: 'c_1', candidate_version: 1 }];
  it('入力で示していない候補は棄却する', () => {
    expect(checkTarget('made_up', shown, null)).toEqual({ ok: false, reasons: ['target_candidate_not_in_input'] });
  });
  it('版が変わっていれば棄却する', () => {
    const r = checkTarget('c_1', shown, { candidate_id: 'c_1', candidate_version: 2 });
    expect(r).toEqual({ ok: false, reasons: ['target_candidate_version_changed'] });
  });
  it('解決済みなら棄却する', () => {
    expect(checkTarget('c_1', shown, null)).toEqual({ ok: false, reasons: ['target_candidate_resolved'] });
  });
});

describe('checkWithdrawEvidence', () => {
  it('候補の根拠より後ろの発話なら通る', () => {
    const r = checkWithdrawEvidence({ ...base, span: '進めようと思って', segment_ids: [2], candidate_evidence_span: '五十万円' });
    expect(r.ok).toBe(true);
  });
  it('候補の根拠より前の発話では撤回できない', () => {
    const r = checkWithdrawEvidence({ ...base, span: '来週の展示会', segment_ids: [1], candidate_evidence_span: '五十万円' });
    expect(r).toEqual({ ok: false, reasons: ['withdraw_evidence_not_after_candidate'] });
  });
  it('候補の根拠が入力に見つからなければ、後ろかを確かめられないので棄却する', () => {
    const r = checkWithdrawEvidence({ ...base, span: '進めようと思って', segment_ids: [2], candidate_evidence_span: '入力から落ちた古い区間' });
    expect(r).toEqual({ ok: false, reasons: ['candidate_evidence_not_in_input'] });
  });
});
